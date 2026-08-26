import { TemporalNodeBase } from "../../lowering/types.js";
import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, LengthValue, ParserContext, SourceSpan } from "../ASTtypes.js";
import { Diagnostic, ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
import { parseNoteName } from "../note/noteNameFSM.js";
import { acc2Offset, NoteNameMap, tonality2Midi } from "../../parser/parse-utils/note-utils.js";
import { paintAccidental, placeAccidentals, type PlacedAccidental } from "../note/accidentals.js";
import { JIANPU_NUMBER_FONT } from "../../render/text.js";
import type { LayoutBox, LayoutPrepareContext } from "../../layout/types.js";
import type { Painter, TextStyle } from "../../render/types.js";

/**
 * 把宽松的调性写法收敛成 tonality2Midi 认得的 [音名][最多一个 #b][绝对八度]
 *
 * 本来就合法就原样返回，彻底读不懂返回 null
 * `C###` 这种超过一个变音记号的写法按实际音高换字母（→ D#4），落在黑键上则跟随原来的升降方向拼写
 */
function normalizeTonality(tonality: string): string | null {
    try {
        tonality2Midi(tonality, 4);
        return tonality;
    } catch { /* 落到下面归一化 */ }

    const parsed = parseNoteName(tonality.replace(/^[a-g]/, letter => letter.toUpperCase()));
    if (parsed instanceof Diagnostic) return null;
    const pitchClass = NoteNameMap[parsed.name];
    if (pitchClass === undefined) return null;

    const offset = acc2Offset(parsed.acc ?? "", false);
    const octave = parsed.absOctave ? parsed.octave ?? 4 : 4 + (parsed.octave ?? 0);
    const midi = (octave + 1) * 12 + pitchClass + offset;
    // NoteNameMap 里同一音高的升号拼写在前、降号在后，正好用来挑方向；数字音名不参与拼写
    const spellings = Object.keys(NoteNameMap).filter(name =>
        NoteNameMap[name] === ((midi % 12) + 12) % 12 && /^[A-G]/.test(name));
    return (offset < 0 ? spellings.at(-1)! : spellings[0]) + (Math.floor(midi / 12) - 1);
}

class KeyFunction extends ASTFunctionNode {
    static override def = {
        name: ["key", "1"],
        description: "设置时间线上的 1= 调性基准",
        example: `@1(C4) 或 @key(F#3)
它不会修改 parser 的局部变量，而是在时间固化阶段影响其后的数字音名解释
画出来的记号只含音名和升降号，不含八度；通常叠在音符上方书写：1 ^ @1(F#)`,
        allowExtraArgs: false,
        args: [
            {
                name: "tonality",
                type: "string" as const,
                default: null,
            },
            {
                name: "size",
                type: "length" as const,
                default: {
                    value: 1,
                    unit: "em",
                } as LengthValue,
            },
        ],
    };

    tonality: string;
    size: number;
    /** 只用于绘制：音名与升降号，八度不上谱 */
    readonly displayName: string;
    readonly displayAcc: string;

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [tonality, size] = this.getArgValue(args, ctx) as [string, LengthValue];
        this.tonality = tonality;
        this.size = ctx.length2px(size);

        const normalized = normalizeTonality(tonality);
        if (normalized !== tonality) {
            if (ctx.strict) throw new ErrorDiagnostic(
                "E_KEY_TONALITY",
                `@key 无法解析调性 "${tonality}"`,
                sourceSpan
            );
            this.tonality = normalized ?? 'C4';
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_KEY_TONALITY",
                `@key 的调性 "${tonality}" 不是规范写法，已自动切换到 ${this.tonality}`,
                sourceSpan,
            ));
        }
        // 归一化保证了格式是 [音名][最多一个 #b][八度]
        this.displayName = this.tonality[0];
        this.displayAcc = this.tonality[1] === "#" || this.tonality[1] === "b" ? this.tonality[1] : "";
    }

    override loweringEnter() {
        return [new KeyTemporalNode(this)];
    }

    override toString() {
        return `@1(${this.tonality})`;
    }
}

export const KeyNode: ASTFunctionClass = KeyFunction;

const PREFIX = "1=";

class KeyTemporalNode extends TemporalNodeBase {
    declare ast: KeyFunction;
    declare box: LayoutBox;

    private accidentals: PlacedAccidental[] = [];
    private nameX = 0;
    private textBaselineY = 0;

    /** 字号在解析时已经固化，样式随之不再变 */
    private readonly style: TextStyle;

    constructor(ast: KeyFunction) {
        super();
        this.ast = ast;
        this.style = {
            fontSize: ast.size,
            fontFamily: JIANPU_NUMBER_FONT,
            fill: "#000",
        };
        this.initLayoutBox();
    }

    override onTimeState(state: Record<string, any>) {
        state.keySignature = this.ast.tonality;
    }

    override prepareLayout(context: LayoutPrepareContext) {
        const size = this.ast.size;
        const style = this.style;
        const prefix = context.textMeasurer.measureText(PREFIX, style);
        const name = context.textMeasurer.measureText(this.ast.displayName, style);

        const accidentalGap = size * 0.02;
        const { placed, right, top } = placeAccidentals(
            this.ast.displayAcc, size, prefix.w, prefix.baseline, accidentalGap,
        );
        this.accidentals = placed;

        // 升降号抬高后可能高过文字，整块下移把它装回盒子里
        const shift = -top;
        for (const p of placed) p.y += shift;

        this.nameX = right;
        this.textBaselineY = shift + prefix.baseline;
        this.box.w = right + name.w;
        this.box.h = shift + Math.max(prefix.h, name.h);
        // 与 @text 同规则：对齐点在第一个字符的中心
        this.box.anchor = context.textMeasurer.measureText(PREFIX[0], style).w / 2;
        this.box.visualAxis = this.box.h / 2;
    }

    override paint(painter: Painter) {
        const style = this.style;
        painter.drawText(PREFIX, this.box.x, this.box.y + this.textBaselineY, style);
        for (const placed of this.accidentals) paintAccidental(painter, placed, this.box, "#000");
        painter.drawText(
            this.ast.displayName,
            this.box.x + this.nameX,
            this.box.y + this.textBaselineY,
            style,
        );
    }
}
