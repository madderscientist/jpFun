import { ASTNodeBase, ASTTextNode, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes.js";
import { Diagnostic, ErrorDiagnostic } from "../../diagnostic.js";
import { parseNoteName } from "./noteName.js";
import { GrammarCallNodeTyped, type GrammarNode, type GrammarSugarNode } from "../../parser/grammarType.js";
import type { LayoutBox, LayoutDecoration, LayoutPrepareContext } from "../../layout/types.js";
import { getLayoutBounds } from "../../layout/engine.js";
import type { Painter, TextStyle } from "../../render/types.js";
import { paintAccidental, placeAccidentals, type PlacedAccidental } from "./accidentals.js";
import type { LoweringResult } from "../../lowering/types.js";
import type { AccidentalMemory, AccidentalReading } from "../../lowering/accidentalMemory.js";
import { rewriteNotes, selects, type NoteTransform, type SourceEdit } from "./source-transform.js";

export type { NoteTransform, SourceEdit } from "./source-transform.js";

/**
 * 根据同一源码的 lowering 生成局部修改；传入 ranges 时只处理完整落入任一选区的音符。
 * 乐谱中有开启 carry 的数字音名时，升降半音需要 relower 重新降级比对并补记
 */
export function transformNotes(source: string, lowering: LoweringResult, operation: NoteTransform,
    ranges?: readonly SourceSpan[], relower?: (source: string) => LoweringResult): SourceEdit[] {
    const notes = transformableNotes(lowering);
    const carried = notes.find(note => note.ast.carry && /^[1-7]$/.test(note.ast.name));
    if (!operation.startsWith("semitone") || !carried) return rewriteNotes(source, notes, operation, ranges);
    if (!relower) throw new ErrorDiagnostic("E_NOTE_TRANSFORM", "乐谱开启了 carry，升降半音需要重新降级", carried.ast.sourceSpan);
    return pinnedSemitone(source, notes, operation, ranges, relower);
}

function transformableNotes(lowering: LoweringResult) {
    const error = lowering.diagnostics.find(item => item instanceof ErrorDiagnostic);
    if (error) throw error;
    const notes = [...lowering.astToTemporal.values()].flat()
        .filter((node): node is NoteTemporalNode => node instanceof NoteTemporalNode);
    const invalid = lowering.diagnostics.find(item => notes.some(note =>
        item.span.start < note.ast.sourceSpan.end && item.span.end > note.ast.sourceSpan.start));
    if (invalid) throw invalid;
    return notes;
}

/** 按 AST 分组并按源码位置排序；同一 AST 的多个实例保持降级顺序 */
function byAst(notes: readonly NoteTemporalNode[]) {
    const groups = new Map<ASTNodeBase, NoteTemporalNode[]>();
    for (const note of notes) groups.set(note.ast, [...groups.get(note.ast) ?? [], note]);
    return [...groups.values()].sort((a, b) => a[0].ast.sourceSpan.start - b[0].ast.sourceSpan.start);
}

/**
 * 升降半音后重新降级，给读法变了的音补写显式记号，直到除选中音 ±1 之外所有音高不变。
 * 每轮只补每个 (小节, 键) 中读谱顺序第一个不一致的音，后面的音可能因此恢复，所以补记最少。
 * 补记的音只读自己的记号，每轮至少新增一个固定点，最多 音符数 + 1 轮。
 */
function pinnedSemitone(source: string, notes: readonly NoteTemporalNode[], operation: NoteTransform,
    ranges: readonly SourceSpan[] | undefined, relower: (source: string) => LoweringResult): SourceEdit[] {
    const delta = operation === "semitone-up" ? 1 : -1;
    const old = byAst(notes);
    const want = old.map(group => group.map(note =>
        note.resolvedMidi === null ? null : note.resolvedMidi + (selects(ranges, note.ast.sourceSpan) ? delta : 0)));
    function fail(span = old[0][0].ast.sourceSpan): never {
        throw new ErrorDiagnostic("E_NOTE_TRANSFORM", "无法在保持其他音高不变的前提下升降半音", span);
    }
    const pins = new Map<ASTNodeBase, string>();
    for (let round = 0; round <= old.length; round++) {
        const edits = rewriteNotes(source, notes, operation, ranges, pins);
        let fresh: NoteTemporalNode[][];
        try { fresh = byAst(transformableNotes(relower(applyEdits(source, edits)))); } catch { return fail(); }
        if (fresh.length !== old.length) fail();
        const misses: [ASTNodeBase, NoteTemporalNode, number, AccidentalReading][] = [];
        for (const [index, group] of fresh.entries()) {
            const ast = old[index][0].ast;
            if (group.length !== want[index].length) fail(ast.sourceSpan);
            for (const [instance, node] of group.entries()) {
                const target = want[index][instance];
                if (node.resolvedMidi === target) continue;
                // 已补记的音只读自己的记号，仍不一致就无解
                if (target === null || !node.carrySlot || !/^[1-7]$/.test(node.ast.name) || pins.has(ast)) fail(ast.sourceSpan);
                misses.push([ast, node, target, node.carrySlot]);
            }
        }
        if (!misses.length) return edits;
        // 按读谱顺序：显式 @grace(1, {1 1}, side=pre) 的宿主写在前、读在后
        const firsts = new Map<object, Set<string>>();
        for (const [ast, node, target, { bar, key }] of misses.sort((a, b) => a[3].seq - b[3].seq)) {
            const keys = firsts.get(bar) ?? new Set<string>();
            if (keys.has(key)) continue;
            firsts.set(bar, keys.add(key));
            const offset = target - resolveNoteMidi(node.name, "", node.octave, node.keySignature)!;
            const acc = offsetToAccidental(offset) || "n";
            // 同一 AST 的多个实例要求不同记号时无解
            if ((pins.get(ast) ?? acc) !== acc) fail(ast.sourceSpan);
            pins.set(ast, acc);
        }
    }
    return fail();
}

function applyEdits(source: string, edits: readonly SourceEdit[]) {
    for (const edit of [...edits].reverse()) source = source.slice(0, edit.span.start) + edit.text + source.slice(edit.span.end);
    return source;
}

const JE_OCTAVE_OFFSET = "note.jeOctaveOffset";

class NoteFunction extends ASTFunctionNode {
    static override def = {
        name: ["note", "n"],
        description: "创建音符",
        details: `\
~~~jpfun
@note(A, acc=#, octave=3, color=#c33)
~~~
**简写**：数字音名按“升降号、音名、相对八度”书写；字母音名按“音名、升降号、绝对八度”书写。\`1,,\` 比当前调性基准低两个八度，\`1'\` 高一个八度。
- 简写的升降号完全由自身决定，省略时为空，不继承 \`@set(note.acc=...)\`；显式调用省略 \`acc\` 时仍继承默认值
- \`A#3\` 等价于 \`@note(A, #, 3)\`，默认 \`acc\` 为空时也等价于 \`@note(A#3)\`
- \`#1'\` 等价于 \`@note(1, #, 1)\`，默认 \`acc\` 为空时也等价于 \`@note("#1'")\`
- 支持组合升降号，如 \`A##bn99\`；无歧义时也接受后置写法，如 \`A3#\`、\`6#,,\`
- 升降号后紧跟数字时归入下一音符：\`6#3\` 解析为 \`6\` 和 \`#3\`
- 末尾加 \`!\` 等价于 \`force=true\`：\`C4!\` 等价于 \`@note(C, "", 4, force=true)\``,
        allowExtraArgs: false,
        args: [
            {
                name: "name",
                description: "数字音名或大写字母音名，可自带升降号与八度，末尾的 `!` 等价于 `force=true`；`0` / `Z` 为休止符，`8` 为隐形占位，`9` / `X` 为节拍记号，后三类不显示升降号和八度点",
                type: "string" as const,
                default: null,
            },
            {
                name: "acc",
                description: "额外升降号，`##` 再升两个半音，`b` 再降一个半音",
                type: "string" as const,
                default: "",
            },
            {   // 传递了就使用绝对音高
                name: "octave",
                description: "字母音名使用绝对八度；数字音名使用相对八度，省略时为 0",
                type: "number" as const,
                default: 4, // 如果是数字则默认值为0 需要代码中区分
            },
            {
                name: "color",
                description: "音符颜色，使用 CSS 颜色值",
                type: "string" as const,
                default: "#000",
            },
            {
                name: "carry",
                namedOnly: true,
                description: "小节内变音延续：数字音名按本小节前文读谱，字母音名自动省略或补记变音号",
                type: "boolean" as const,
                default: false,
            },
            {
                name: "force",
                description: "强制显示实际生效的变音号，不改变音高，没有变音时显示还原号；简写为音名末尾的 `!`",
                type: "boolean" as const,
                default: false,
            },
        ]
    };

    static override deSugarAtom(source: string, start: number, end: number) {
        // JE 谱兼容
        let jeOffset = 0;
        switch (source[start]) {
            case "(":
            case "]":
                jeOffset = -1;
                break;
            case "[":
            case ")":
                jeOffset = 1;
                break;
        }
        if (jeOffset) return {
            next: start + 1,
            node: {
                kind: "sugar" as const,
                data: { jeOffset },
                span: { start, end: start + 1 },
                syntaxKind: "punctuation" as const,
            },
        };
        // 解析音符名
        const parseResult = parseNoteName(source, start, end, false);
        if (!parseResult) return null;
        // 末尾的 `!` 是 force=true 的简写；没写时继承 @set(note.force=...)
        const force = parseResult.next < end && source[parseResult.next] === "!";
        const next = parseResult.next + (force ? 1 : 0);
        const argMap: FunctionArgs = new Map();
        argMap.set("name", parseResult.name);
        if (parseResult.octave !== null) argMap.set("octave", parseResult.octave);
        argMap.set("acc", parseResult.acc ?? "");   // 必须覆盖不然会用到 set 的默认值
        if (force) argMap.set("force", true);
        const node: GrammarCallNodeTyped = {
            kind: "call",
            typed: true,
            name: "note",
            args: argMap,
            span: { start, end: next },
            syntaxKind: "atom",
        };
        return { next, node };
    }

    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        const node = nodes[at] as GrammarSugarNode;
        const jeOffset = node.data?.jeOffset;
        if (typeof jeOffset !== "number") return null;
        ctx.variables[JE_OCTAVE_OFFSET] = (ctx.variables[JE_OCTAVE_OFFSET] ?? 0) + jeOffset;
        // JE 谱兼容：保留括号源码，并让关系语法糖像跳过普通文本一样跳过它。
        ctx.nodes.push(new ASTTextNode(node.span));
        return at + 1;
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
    carry: boolean;
    force: boolean;
    size: number;
    readonly font: string;
    readonly weight: number;

    // JE 八度偏移量
    jeOctaveOffset: number;
    // 源码改写时判断是否需要覆盖默认升降号
    readonly hasDefaultAcc: boolean;
    // 去糖时判断是否需要写明 carry、force
    readonly hasDefaultCarry: boolean;
    readonly hasDefaultForce: boolean;

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        this.hasDefaultAcc = Boolean(ctx.variables["note.acc"]);
        this.hasDefaultCarry = Boolean(ctx.variables["note.carry"]);
        this.hasDefaultForce = Boolean(ctx.variables["note.force"]);
        [this.name, this.acc, this.octave, this.color, this.carry, this.force] =
            this.getArgValue(args, ctx) as [string, string, number, string, boolean, boolean];
        this.font = ctx.variables.numberfont;
        this.weight = ctx.variables.numberweight;
        this.size = ctx.variables.fontsize;
        // 创建时就固化参数值
        // name 末尾的 `!` 同简写，等价于 force=true；carry 仅命名，所以 force 的位置下标是 4
        if (this.name.endsWith("!")) {
            if ((args.get("force") ?? args.get(4)) === false) throw new ErrorDiagnostic(
                "E_NOTE_FORCE_CONFLICT",
                '函数 @note 的参数 "force=false" 与音符名称末尾的 "!" 冲突',
                sourceSpan,
            );
            this.name = this.name.slice(0, -1);
            this.force = true;
        }
        // 校验 note name
        const parseResult = parseNoteName(this.name);
        if (parseResult instanceof Diagnostic) {
            parseResult.span = sourceSpan;   // 定位到整个函数调用
            throw parseResult;
        }
        if (parseResult.next !== this.name.length) throw new ErrorDiagnostic(
            "E_WRONG_NOTE_NAME",
            '函数 @note 的参数 [0]:"name" 格式错误: 无法解析尾部 "{tail}"',
            sourceSpan,
            { tail: this.name.slice(parseResult.next) },
        );
        this.name = parseResult.name === "X" ? "9" : parseResult.name === "Z" ? "0" : parseResult.name;
        // 校验octave
        const inputOctave = args.get("octave") ?? args.get(2);
        if (inputOctave !== void 0) {
            if (parseResult.octave !== null && parseResult.octave != inputOctave) throw new ErrorDiagnostic(
                "E_NOTE_OCTAVE_CONFLICT",
                '函数 @note 的参数 "octave" 与音符名称中的八度信息冲突: {inputOctave} != {noteOctave}',
                sourceSpan,
                { inputOctave: String(inputOctave), noteOctave: parseResult.octave },
            );
        } else {
            // 没有单独传入 octave 时，优先采用音名中的八度；数字音名缺省为相对 0。
            if (parseResult.octave !== null) this.octave = parseResult.octave;
            else if (!parseResult.absOctave) this.octave = 0;
        }
        this.jeOctaveOffset = ctx.variables[JE_OCTAVE_OFFSET] ?? 0;
        // 补充acc
        if (parseResult.acc !== null) this.acc = parseResult.acc + this.acc;
    }

    override toString() {
        // 外层开启过时写明，避免 false 去糖后继承外层的 true
        const carry = this.carry || this.hasDefaultCarry ? `, carry=${this.carry}` : "";
        const force = this.force || this.hasDefaultForce ? `, force=${this.force}` : "";
        return `@n(${this.name}, ${this.acc || '""'}, ${this.octave}, ${this.color}${carry}${force})`;
    }
}

export const NoteNode: ASTFunctionClass = NoteFunction;

import { DEFAULT_KEY, DEFAULT_TONALITY, DEFAULT_VELOCITY, TemporalNodeBase, type TimeState } from "../temporal.js";
import type { PlaybackEmitter } from "../../playback/types.js";
import {
    acc2Offset,
    createDiatonicTranspose,
    offsetToAccidental,
    resolveLetterNameToJianpu,
    resolveNoteMidi,
} from "../../parser/parse-utils/note-utils.js";

// 8 是隐形占位，9 是固定打击音的节拍记号，空串表示不绘制
const NOTE_GLYPH: Record<string, string> = { "8": "", "9": "X" };

class NoteTemporalNode extends TemporalNodeBase {
    declare ast: NoteFunction;
    declare box: LayoutBox;

    // 时间固化后的参数
    resolvedMidi: number | null = null; // 按调性解析的记谱音高，不含播放偏移
    keySignature = DEFAULT_TONALITY;    // 用于转调时记录大环境
    transposeDiatonic: ((steps: number) => number) | undefined;
    name: string;     // 数字
    acc: string;      // 升降号
    octave: number;   // 绝对值为点的个数
    displayAcc?: string;            // carry 开启的字母音名或 force 推导出的显示记号；undefined 表示按 acc 显示
    carrySlot?: AccidentalReading;  // 本音在变音记忆中的位置

    /** prepareLayout 生成的局部升降号位置 */
    private accidentals: PlacedAccidental[] = [];

    /** 字号和颜色在解析时已经固化，样式随之不再变 */
    private readonly numberStyle: TextStyle;

    private numberY = 0;

    constructor(ast: NoteFunction) {
        super();
        this.ast = ast;
        this.T.set(1);
        this.mergeKey = DEFAULT_KEY;
        this.name = ast.name;
        this.acc = ast.acc;
        this.octave = ast.octave + ast.jeOctaveOffset;
        this.numberStyle = {
            fontSize: ast.size,
            fontFamily: ast.font,
            fontWeight: ast.weight,
            textAlign: "center",
            fill: ast.color,
        };
        this.initLayoutBox();
    }

    override prepareLayout(context: LayoutPrepareContext) {
        const { size, color } = this.ast;
        const mainMetrics = context.textMeasurer.measureText("0", this.numberStyle);

        this.numberY = mainMetrics.baseline;

        // 升降号盒直接紧挨数字盒左缘，按同一 baseline 排在数字左侧
        const { placed, right: mainX } = placeAccidentals(this.displayAcc ?? this.acc, size, 0, this.numberY);
        this.accidentals = placed;

        this.box.w = mainX + mainMetrics.w;
        this.box.h = mainMetrics.h;
        this.box.anchor = mainX + mainMetrics.w / 2;
        this.box.visualAxis = mainMetrics.h / 2;

        // 升降号和附点参与完整盒布局，但不计入数字主体范围，减时线因此只画在数字下
        this.ports["body.left"] = { x: this.box.anchor - mainMetrics.w / 2, y: this.box.visualAxis };
        this.ports["body.right"] = { x: this.box.anchor + mainMetrics.w / 2, y: this.box.visualAxis };
        this.ports["shoulder"] = { x: this.box.anchor, y: 0 };
        // 下方装饰从数字基线附近起排，不把 em 盒底部的留白算作可见正文。
        this.ports["decoration.below"] = { x: this.box.anchor, y: this.numberY + size * 0.04 };

        // 覆盖 dot 的默认“右边界 + 视觉轴”，让附点贴合数字字形的视觉位置
        this.ports["dot"] = {
            x: this.box.w,
            y: mainMetrics.h * 0.64,
        };

        const dotCount = Math.abs(this.octave);
        if (dotCount === 0) return;
        const above = this.octave > 0;
        const dotRadius = size * 0.075;
        const dotGap = size * 0.08;
        const dotStep = dotRadius * 2 + dotGap;
        const dotStyle = { fill: color };
        let dotY = 0;
        const height = dotCount * dotRadius * 2 + (dotCount - 1) * dotGap;
        const dots: LayoutDecoration = {
            [above ? "above" : "below"]: {
                // order 只表达通用的由近到远顺序
                // 时值类装饰可以选择较小 order，下八度点选择较大 order
                order: 100,
                gap: dotGap,
                height,
                place: (y: number) => { dotY = y; },
            },
            paint: painter => {
                // 每列八度点共用一个装饰，上方从靠近数字的位置向外绘制
                for (let i = 0; i < dotCount; i++) {
                    const y = above ? dotY + height - dotRadius - i * dotStep : dotY + dotRadius + i * dotStep;
                    painter.drawCircle(
                        this.box.x + this.box.anchor,
                        this.box.y + y,
                        dotRadius,
                        dotStyle,
                    );
                }
            },
        };
        this.decorations.push(dots);
    }

    override finalizeLayout() {
        this.ports["lyric"] = { x: this.box.anchor, y: this.box.h };
        this.ports["tie.top"] = {
            x: this.box.anchor,
            y: getLayoutBounds(this, true).y - this.box.y - this.ast.size * 0.1,
        };
    }

    override paint(painter: Painter) {
        const color = this.ast.color;
        for (const accidental of this.accidentals) paintAccidental(painter, accidental, this.box, color);

        const glyph = NOTE_GLYPH[this.name] ?? this.name;
        if (glyph) {
            painter.drawText(
                glyph,
                this.box.x + this.box.anchor,
                this.box.y + this.numberY,
                this.numberStyle,
            );
        }
    }

    /** 固化记谱位置的音高、力度和音色，并保留基于该调性的相对移调能力 */
    override onTimeState(state: TimeState) {
        const keySignature = this.keySignature = state.keySignature;
        this.playbackState = { velocity: state.velocity, program: state.program };
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
        this.transposeDiatonic = createDiatonicTranspose(this.name, this.octave, keySignature);
        this.applyAccidentals(state.accidentals);
    }

    /**
     * 以显示出来的记号写入记忆；carry 下数字音名没写记号时沿用前文，字母音名按前文省略或补记。
     * force 只改显示：写出实际生效的记号，没有变音时显示还原号。前文要到列末按时间先后结算
     */
    private applyAccidentals(memory: AccidentalMemory) {
        const midi = this.resolvedMidi;
        if (midi === null || !/^[1-7]$/.test(this.name)) return;
        memory.read(this.track, `${this.name}:${this.octave}`, reading => {
            const { prior } = this.carrySlot = reading;
            const digit = /^[1-7]$/.test(this.ast.name);
            const carried = this.ast.carry && digit && !this.acc;
            const offset = carried ? prior : acc2Offset(this.acc);
            if (carried) this.resolvedMidi = midi + prior;
            const shown = offsetToAccidental(offset) || "n";
            if (this.ast.force) this.displayAcc = shown;
            else if (this.ast.carry && !digit) this.displayAcc = offset === prior ? "" : shown;
            return this.displayAcc ?? this.acc ? offset : undefined;
        });
    }

    /** 发布完整音段或无声区间，实际 NoteOn/NoteOff 留到声音展开完成后生成 */
    override emitPlayback(emitter: PlaybackEmitter) {
        const percussion = this.ast.name === "9";
        const midi = percussion ? 37 : this.resolvedMidi;
        const shift = percussion ? 0 : this.playbackState?.pitchShift ?? 0;
        const transpose = this.transposeDiatonic;
        if (emitter.end.compare(emitter.start) <= 0) return;
        // 休止符和占位符也要保留结构边界，速度效果与后续延长才能覆盖这段时间。
        if (midi === null) {
            emitter.span({ start: emitter.start, end: emitter.end });
            return;
        }
        // 这里只提供发声属性；轨道、来源和最终音符身份由核心统一补齐。
        emitter.note({
            start: emitter.start,
            end: emitter.end,
            midi: midi + shift,
            velocity: this.playbackState?.velocity ?? DEFAULT_VELOCITY,
            ...(percussion ? { percussion: true as const }
                : { transpose: shift && transpose ? steps => transpose(steps) + shift : transpose }),
        });
    }
}