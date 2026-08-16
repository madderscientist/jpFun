import { ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes.js";
import { Diagnostic, ErrorDiagnostic } from "../../diagnostic.js";
import { parseNoteName } from "./noteNameFSM.js";
import { GrammarCallNodeTyped } from "../../parser/grammarType.js";
import type { LayoutBox, LayoutDecoration, LayoutPrepareContext } from "../../layout/types.js";
import type { Painter, TextStyle } from "../../render/types.js";
import { prepareAccidental, type PreparedAccidental } from "./accidentals.js";

class NoteFunction extends ASTFunctionNode {
    static override def = {
        name: ["note", "n"],
        description: "创建音符",
        example: `@note(name, acc, octave, color)
参数说明:
- name: [必填]音符名，可以是大写字母或者数字，不允许小写字母（会和降号冲突）。此参数写法有语法糖，见下。
- acc: [可选]的额外升降号字符串，例如 "##" 表示再升两个半音，"b" 表示再降一个半音。
- octave: [可选]八度，类型为数字。如果 name 是字母，则此项代表绝对八度；如果是数字，则此项代表相对八度。

语法糖：[音名][升降号][八度] 音名和升降号可以交换
例：A3# === @note(A3#) === @note(A, #, 3)
也支持 A99##bn 的写法。可以设置 note.octave 改变默认的绝对八度

支持 数字音名, 此时 octave 为相对八度
支持使用数字音名时使用相对八度，如 "1,," 代表在当前基准音（由上下文属性"1=?"决定）的基础上降低两倍八度，"1'" 代表在当前基准音的基础上提高一个八度
例：1#' === @note(1#') === @note(1, #, 1)。此时支持升降号写音名前面，如 #1'
`,
        allowExtraArgs: false,
        args: [
            {
                name: "name",
                type: "string" as const,
                default: null,
            },
            {
                name: "acc",
                type: "string" as const,
                default: "",
            },
            {   // 传递了就使用绝对音高
                name: "octave",
                type: "number" as const,
                default: 4, // 如果是数字则默认值为0 需要代码中区分
            },
            {
                name: "color",
                type: "string" as const,
                default: "#000",
            }
        ]
    };

    static override deSugarAtom(source: string, start: number, end: number) {
        const parseResult = parseNoteName(source, start, end);
        if (parseResult instanceof Diagnostic) return null;
        const argMap: FunctionArgs = new Map();
        argMap.set("name", parseResult.name);
        if (parseResult.octave) argMap.set("octave", parseResult.octave);
        if (parseResult.acc) argMap.set("acc", parseResult.acc);
        const node: GrammarCallNodeTyped = {
            kind: "call",
            typed: true,
            name: "note",
            args: argMap,
            span: { start, end: parseResult.next },
        };
        return { next: parseResult.next, node };
    }

    override labelable() { return this; }
    override loweringEnter() {
        return [new NoteTemporalNode(this)];
    }

    // 原始输入
    name: string;
    octave: number;
    acc: string;
    color: string;
    size: number;

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.name, this.acc, this.octave, this.color] = this.getArgValue(args, ctx) as [string, string, number, string];
        this.size = ctx.fontSize;
        // 创建时就固化参数值
        // 校验 note name
        const parseResult = parseNoteName(this.name);
        if (parseResult instanceof Diagnostic) {
            parseResult.span = sourceSpan;   // 定位到整个函数调用
            throw parseResult;
        }
        this.name = parseResult.name;
        // 校验octave
        const inputOctave = args.get("octave") ?? args.get(2);
        if (inputOctave !== void 0) {
            if (parseResult.octave !== null && parseResult.octave != inputOctave) throw new ErrorDiagnostic(
                "E_NOTE_OCTAVE_CONFLICT",
                `函数 @note 的参数 "octave" 与音符名称中的八度信息冲突: ${inputOctave} != ${parseResult.octave}`,
                sourceSpan
            );
        } else {
            // 没有传入octave 此时this.octave是字母模式下的默认值 仅在数字模式下才需要被覆盖
            if (!parseResult.absOctave) this.octave = parseResult.octave ?? 0;
        }
        // 补充acc
        if (parseResult.acc !== null) this.acc = parseResult.acc + this.acc;
    }

    override toString() {
        return `@n(${this.name}, ${this.acc}, ${this.octave}, ${this.color})`;
    }
}

export const NoteNode: ASTFunctionClass = NoteFunction;

import { ColType, TemporalNodeBase } from "../../lowering/types.js";
import { resolveLetterNameToJianpu, resolveNoteMidi } from "../../parser/parse-utils/note-utils.js";

interface PlacedAccidental {
    shape: PreparedAccidental;
    x: number;
    y: number;
}

function createNumberStyle(ast: NoteFunction): TextStyle {
    return {
        fontSize: ast.size,
        fontFamily: '"Cascadia Mono", Consolas, "Liberation Mono", "Noto Sans Mono", monospace',
        fontWeight: 400,
        textAlign: "center",
        fill: ast.color,
    };
}

class NoteTemporalNode extends TemporalNodeBase {
    declare ast: NoteFunction;
    declare box: LayoutBox;

    // 时间固化后的参数
    activeBpm: number | null = null;    // 用于播放的时候的速度
    resolvedMidi: number | null = null; // MIDI音高 name是数字则需要在onTimeState中基于当前调性偏移 播放的音高
    name: string;     // 数字
    acc: string;      // 升降号
    octave: number;   // 绝对值为点的个数

    /** prepareLayout 生成的局部升降号位置 */
    private accidentals: PlacedAccidental[] = [];

    /** 上八度点属于主体，下八度点通过通用装饰流排在其他下方符号之后 */
    private upperOctaveDotY: number[] = [];
    private lowerOctaveDotY: number[] = [];

    private octaveDotRadius = 0;
    private numberY = 0;

    constructor(ast: NoteFunction) {
        super();
        this.ast = ast;
        this.T = 1;
        this.t = 0;
        this.type = ColType.DEFAULT;
        this.name = ast.name;
        this.acc = ast.acc;
        this.octave = ast.octave;
        this.initLayoutBox();
    }

    override prepareLayout(context: LayoutPrepareContext) {
        this.accidentals.length = 0;
        this.upperOctaveDotY.length = 0;
        this.lowerOctaveDotY.length = 0;

        const { size, color } = this.ast;
        const numberStyle = createNumberStyle(this.ast);
        const mainMetrics = context.textMeasurer.measureText("0", numberStyle);

        // 升降号贴近数字左上角，但不参与数字中心 anchor 的计算
        // 缩小右侧间隔会在全局 anchor 不变时把升降号向右移动
        const accidentalGap = size * 0.01;
        const accidentalRaise = size * 0.24;
        const accidentalShapes: PreparedAccidental[] = [];

        // 把每个升降字符转换为 note 私有的局部路径
        for (const accidental of this.acc) {
            const shape = prepareAccidental(accidental, size * 0.82);
            if (shape) accidentalShapes.push(shape);
        }

        let accidentalWidth = 0;
        // 汇总升降号区域宽度，为数字单元保留固定起点
        for (const shape of accidentalShapes) {
            if (accidentalWidth > 0) accidentalWidth += accidentalGap;
            accidentalWidth += shape.w;
        }

        const dotCount = Math.abs(this.octave);
        this.octaveDotRadius = size * 0.065;
        const dotGap = size * 0.08;
        const dotStep = this.octaveDotRadius * 2 + dotGap;
        const octaveSpace = dotCount === 0
            ? 0
            : dotCount * this.octaveDotRadius * 2 + (dotCount - 1) * dotGap + dotGap;
        const topSpace = this.octave > 0 ? octaveSpace : 0;
        const mainX = accidentalWidth + (accidentalShapes.length > 0 ? accidentalGap : 0);
        const mainY = topSpace;

        this.box.w = mainX + mainMetrics.w;
        this.box.h = topSpace + mainMetrics.h;
        this.box.anchor = mainX + mainMetrics.w / 2;
        this.box.visualAxis = mainY + mainMetrics.h / 2;
        this.numberY = mainY + mainMetrics.baseline;

        // 升降号和附点参与完整盒布局，但不计入数字主体范围，减时线因此只画在数字下
        this.ports["body.left"] = { x: this.box.anchor - mainMetrics.w / 2, y: this.box.visualAxis };
        this.ports["body.right"] = { x: this.box.anchor + mainMetrics.w / 2, y: this.box.visualAxis };

        // 覆盖 dot 的默认“右边界 + 视觉轴”，让附点贴合数字字形的视觉位置
        this.ports["dot"] = {
            x: this.box.w,
            y: mainY + mainMetrics.h * 0.64,
        };

        // 升降号位于完整盒的左侧区域，但不会进入核心有效范围
        let accidentalX = 0;
        // 所有升降号按同一数字 baseline 排列在数字左侧
        for (const shape of accidentalShapes) {
            this.accidentals.push({
                shape,
                x: accidentalX,
                y: this.numberY - shape.baseline - accidentalRaise,
            });
            accidentalX += shape.w + accidentalGap;
        }

        if (this.octave > 0) {
            // 上八度点从靠近数字的位置向上依次排列
            for (let i = 0; i < dotCount; i++) {
                this.upperOctaveDotY.push(topSpace - dotGap - this.octaveDotRadius - i * dotStep);
            }
            return;
        }

        if (this.octave >= 0) return;

        const lowerDotHeight = dotCount * this.octaveDotRadius * 2 + (dotCount - 1) * dotGap;
        const lowerDots: LayoutDecoration = {
            below: {
                // order 只表达通用的由近到远顺序
                // 时值类装饰可以选择较小 order，下八度点选择较大 order
                order: 100,
                gap: dotGap,
                height: lowerDotHeight,
                place: y => {
                    // 下八度点从引擎分配的外层区域顶部向下排列
                    for (let i = 0; i < dotCount; i++) {
                        this.lowerOctaveDotY.push(y + this.octaveDotRadius + i * dotStep);
                    }
                },
            },
            paint: painter => {
                // 下八度点读取已经冻结的局部圆心位置
                for (const y of this.lowerOctaveDotY) {
                    painter.drawCircle(
                        this.box.x + this.box.anchor,
                        this.box.y + y,
                        this.octaveDotRadius,
                        { fill: color },
                    );
                }
            },
        };
        this.decorations.push(lowerDots);
    }

    override finalizeLayout() {
        this.ports["lyric"] = { x: this.box.anchor, y: this.box.h };
    }

    override paint(painter: Painter) {
        const color = this.ast.color;
        const numberStyle = createNumberStyle(this.ast);
        for (const accidental of this.accidentals) {
            painter.drawPath(
                accidental.shape.commands,
                { stroke: color, strokeWidth: accidental.shape.strokeWidth },
                {
                    x: this.box.x + accidental.x,
                    y: this.box.y + accidental.y,
                    scaleX: accidental.shape.w,
                    scaleY: accidental.shape.h,
                },
            );
        }

        if (this.name !== "8") {
            painter.drawText(
                this.name,
                this.box.x + this.box.anchor,
                this.box.y + this.numberY,
                numberStyle,
            );
        }

        // 上八度点属于主体绘制，不参与下方装饰流
        for (const y of this.upperOctaveDotY) {
            painter.drawCircle(
                this.box.x + this.box.anchor,
                this.box.y + y,
                this.octaveDotRadius,
                { fill: color },
            );
        }
    }

    override onTimeState(state: Record<string, any>) {
        const keySignature = typeof state.keySignature === "string" ? state.keySignature : "C4";
        this.activeBpm = Number(state.bpm) || 120;
        this.resolvedMidi = resolveNoteMidi(this.name, this.acc, this.octave, keySignature);
        // 数字音名本身就是简谱显示形式，直接保留原始数字和相对八度
        if (this.name >= "0" && this.name <= "9") {
            if (this.name === "0" || this.name >= "8") {
                this.octave = 0;
                this.acc = ""; // 0和8、9不显示升降号
            }
        } else {
            // 字母音名需要在当前调性下转换成简谱级数
            const jianpuPitch = resolveLetterNameToJianpu(this.name, this.acc, this.octave, keySignature);
            if (jianpuPitch) {
                this.name = jianpuPitch.renderName;
                this.acc = jianpuPitch.renderAcc;
                this.octave = jianpuPitch.renderOctave;
            }
        }
    }
}