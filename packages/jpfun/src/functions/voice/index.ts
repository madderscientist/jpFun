import { ASTNodeBase, ASTBraceNode, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass, ASTTextNode } from "../ASTtypes.js";
import { Diagnostic, ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
import { findRightParen, removeQuote } from "../../parser/parse-utils/call-utils.js";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import { ParserContext, skipSpaces } from "../../parser/parserContext.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import {
    ColType,
    isVisualTemporalNode,
    TemporalNodeBase,
} from "../../lowering/types.js";
import type { ArrangeFn, Extent, Track } from "../../lowering/track.js";
import type {
    AttachmentLayoutContext,
    LayoutAttachment,
    LayoutBox,
    LayoutPrepareContext,
    LayoutRegion,
    Rect,
} from "../../layout/types.js";
import type { Painter, PathCommand, TextStyle } from "../../render/types.js";

const WHITEPACE_RE = /\s/;

/**
 * voices 块在宿主基线上局部居中：首末两条 voice 基线的中点对齐宿主轴
 *
 * 居中只看**基线**，不看成员的整体视觉边界，也不取所有基线的算术平均值。
 * 因此嵌套的 stack、歌词、装饰只会撑开相邻基线的间距和行高，
 * 不会把整个块相对于主旋律的语义中心挪走。
 *
 * 本行没有实质高度的成员（空声部，或内容都在上一行）仍然占一个默认高度的槽位，
 * 声部数量因而保持稳定，居中结果也不会因为某一声部没写东西而跳变。
 */
function makeVoicesArrange(emptySlotHeight: number): ArrangeFn {
    const half = emptySlotHeight / 2;
    return (_host, members, gap) => {
        const extents: Extent[] = members.map(member =>
            member && member.bottom - member.top > 1e-6 ? member : { top: -half, bottom: half });
        const offsets: number[] = [];
        let y = 0;
        for (let i = 0; i < extents.length; i++) {
            if (i > 0) y += extents[i - 1].bottom + gap - extents[i].top;
            offsets.push(y);
        }
        const center = (offsets[0] + offsets[offsets.length - 1]) / 2;
        return offsets.map((offset, i) => ({ offset: offset - center, extent: extents[i] }));
    };
}

class VoiceFunction extends ASTFunctionNode {
    static override def = {
        name: ["voice", "v"],
        description: "声部",
        example: `@voice({}, name, 歌词1名=歌词1, 歌词2名=歌词2, ...)
第一个参数为音符内容，第二个参数为写在最左侧的声部名称(可不填)；
命名参数为歌词左侧的名称和内容，可以任意多个。也可以是位置参数，表示不需要名称。
例:
@voice({C1 D1 E1}, 钢琴, 男=ha ha ha, 女=la la la)
@voice({C1 D1 E1}, , ha ha ha, 女="la la la") 表示音符和第一个歌词都没有名称
歌词可以被引号包裹，如果包含逗号等歧义字符一定需要引号
语法糖：
N(name): C1 D1 E1
L(name): ha ha ha...
L: ...
前面可以有任意空白，但最后换行表示结束。歌词此时允许有逗号而不加引号
如果一定要换行，最后加上'\\'
英文歌词用空格和连字符'-'分词，用'@'占位
`,
        allowExtraArgs: true,
        extraArgType: "string" as const,
        args: [
            {
                type: "content" as const,
                default: null,
            },
            {
                name: "name",
                type: "string" as const,
                default: "",
            },
            // 之后的参数都当作歌词参数
        ],
    };

    // 去糖第一阶段识别两个标签 这里先不消费换行符，因为 br 可能需要
    static override deSugarAtom(source: string, start: number, end: number) {
        if (source[start] !== 'N' && source[start] !== 'L') return null;
        let pos = start + 1;
        let name = '';
        if (source[pos] === '(') {
            // `X(name)` 提取括号
            const at = findRightParen(source, pos + 1, end);
            if (at < 0) return null;    // 没有找到匹配的右括号 不去糖
            name = removeQuote(source.slice(pos + 1, at).trim());
            pos = at + 1;
        }
        if (source[pos++] !== ':') return null;   // `:` 之前不允许有空格
        // 识别具体内容
        if (source[start] === 'N') {
            // 等到第二轮寻找该层级的终止符 \n 来确定内容范围
            const node: GrammarSugarNode = {
                kind: "sugar",
                data: {
                    class: VoiceFunction,
                    name,
                },
                span: { start, end: pos },
            }; return { next: pos, node };
        } else {
            // 字符串收集
            let lystart = pos = skipSpaces(source, pos, end);
            if (pos >= end) return null;    // 没有内容了 不去糖
            let lyend = end;
            const quote = source[pos];
            // 双引号才是字符串，单引号不是
            if (quote === '"') {
                // 有引号的 直接以引号为界切分
                lystart = ++pos;
                let escaped = false;
                for (; pos < end; pos++) {
                    const ch = source[pos];
                    if (escaped) escaped = false;
                    else if (ch === "\\") escaped = true;
                    else if (ch === quote) break;
                }
                if (pos >= end) throw Diagnostic.error.UnterminatedString({
                    start: lystart - 1, end
                });
                lyend = pos++;  // 跳过结尾引号
            } else {
                // 没有引号的 以换行符为界切分 预处理已经跳过了转义的换行符了
                for (; pos < end; pos++) {
                    if (source[pos] === '\n') break;
                } lyend = pos;
            }
            const node: GrammarSugarNode = {
                kind: "sugar",
                data: {
                    class: VoiceFunction,
                    lyric: source.slice(lystart, lyend).trim(),
                    name,
                },
                span: { start, end: pos },
            }; return { next: pos, node };
        }
    }

    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        const n = nodes[at++] as GrammarSugarNode;
        if (n.data?.class !== VoiceFunction) return null;
        if (n.data?.lyric !== void 0) {
            // 歌词 需要找到最近的voice节点并添加歌词
            let voiceNode: VoiceFunction | null = null;
            let voiceNodeAt = ctx.nodes.length - 1;
            for (; voiceNodeAt >= 0; voiceNodeAt--) {
                const n = ctx.nodes[voiceNodeAt];
                if (n instanceof ASTTextNode) {
                    if (!ctx.strict) continue;   // 非严格模式下允许文本节点夹在N和L之间
                    // ParserContext.parseGrammar 处理后不会有空白字符
                    throw new ErrorDiagnostic(
                        "E_LYRICS_WITHOUT_VOICE_NOTES",
                        `strict 模式下，语法糖 'L:' 或 'L(name)' 必须跟在 @voice 的音符之后，但在其前面发现了未知文本`,
                        n.sourceSpan
                    );
                }
                if (n instanceof VoiceFunction) voiceNode = n;
                else if (n instanceof VoicesFunction) voiceNode = n.voices.at(-1) ?? null;
                break;
            }
            if (voiceNode === null) {
                throw new ErrorDiagnostic(
                    "E_LYRICS_WITHOUT_VOICE_NOTES",
                    `语法糖 'L:' 或 'L(name):' 必须跟在 @voice（或 N:）之后，但没有找到符合要求的 voice；请检查语法或直接使用 @voice 函数`,
                    n.span
                );
            }
            voiceNode.addLyric(n.data.name, n.data.lyric, n.span, ctx);
            ctx.nodes.length = voiceNodeAt + 1;   // 清除voiceNodeAt之后的TextNode 因为被夹在N和L之间
            // 消费后面可能的换行符 只消费一个
            if (at < nodes.length && typeof nodes[at] === "number" && ctx.source[nodes[at] as number] === '\n') at++;
            return at;
        }
        // 音符 向后找到第一个 \n 或下一个 voice 组件
        let breakAt = at;
        let endWithBr = 0;
        for (; breakAt < nodes.length; breakAt++) {
            const n = nodes[breakAt];
            if (typeof n === "number") {
                if (ctx.source[n] === '\n') {
                    // 换行符应该被 N: 消费
                    endWithBr = 1;
                    break;
                }
            } else if (n.kind === "sugar" && n.data?.class === VoiceFunction) break;
        }
        // 解析后面的内容 得到 VoiceFunction
        const newCtx = new ParserContext(ctx);
        const slicedNodes = nodes.slice(at, breakAt);   // 防止子解析越界
        breakAt += endWithBr;   // 不让子内容有换行符
        newCtx.makeNodes(slicedNodes);
        if (newCtx.nodes.length === 0) {
            throw Diagnostic.error.EmptyContent("voice", "content", n.span);
        }
        const span: SourceSpan = { start: n.span.start, end: newCtx.nodes.at(-1)!.sourceSpan.end };
        const argMap: FunctionArgs = new Map();
        if (newCtx.nodes.length === 1 && newCtx.nodes[0] instanceof ASTBraceNode) argMap.set(0, newCtx.nodes[0]);
        // 复制一份：voice 的 span 之后会被歌词撑大，内容 brace 不该跟着长
        else argMap.set(0, new ASTBraceNode({ ...span }, newCtx.nodes));
        argMap.set("name", n.data.name);
        const newVoice = new VoiceFunction(span, argMap, ctx, null);

        // 如果前面紧挨着 VoicesFunction | VoiceFunction 则直接加入
        let voicesNode: VoicesFunction | null = null;
        let voicesNodeAt = ctx.nodes.length - 1;
        let textBetween: ASTTextNode | null = null;
        ifCombine: for (; voicesNodeAt >= 0; voicesNodeAt--) {
            const n = ctx.nodes[voicesNodeAt];
            if (n instanceof ASTTextNode) {
                if (ctx.strict) break;
                // 如果中间有换行符，直接说明是两个独立的 voice 组件，不能合并
                for (let i = n.sourceSpan.start; i < n.sourceSpan.end; i++) {
                    if (ctx.source[i] === '\n') break ifCombine;
                }
                textBetween = n;
                continue;
            }
            if (n instanceof VoicesFunction) {
                if (!n.createdBySugar) break;   // 不会合并到函数创建的 voices 中
                voicesNode = n;
            } else if (n instanceof VoiceFunction) {
                const args: FunctionArgs = new Map();
                args.set(0, n);
                voicesNode = new VoicesFunction({
                    start: n.sourceSpan.start,
                    end: n.sourceSpan.end
                }, args, ctx, null);
                voicesNode.createdBySugar = true;
            } break;
        }
        if (voicesNode) {
            ctx.nodes[voicesNodeAt] = voicesNode;
            voicesNode.addVoice(newVoice);
            if (textBetween) {
                ctx.nodes.length = voicesNodeAt + 1;
                ctx.diagnostics.push(new WarningDiagnostic(
                    "W_VOICES_TEXT_BETWEEN",
                    `两个 @voice 之间有未知文本。当前处于非 strict 模式，会忽略该内容、合并为一个 @voices`,
                    textBetween.sourceSpan
                ));
            }
        } else ctx.pushNode(newVoice);
        return breakAt;
    }

    content: ASTBraceNode;   // 声部内容
    name: string;   // 声部名称
    size: number;   // 声部的字体大小
    lyrics: {
        name: string,
        tokens: string[]   // 分词后的歌词内容
    }[];
    override get children() { return [this.content]; }
    override timeFlowModel() {
        return {
            children: this.children,
            mode: "sequence" as const,
        };
    }

    /**
     * voice 的音符内容仍按普通 sequence 进入全局时间列
     * 此处只建立歌词作用域，并按需在内容前创建声部名对象
     */
    override loweringEnter(ctx: LoweringContext) {

        // 无名声部也要产出一个（不可见的）名称事件，才能保证同一个 voices 块内
        // 每个成员的列结构完全一致，从而把所有声部名归并到同一列
        const parent = this.parent;
        // 多声部时同时在名称右侧预留大括号的横向空间
        const braceSpace = parent instanceof VoicesFunction && parent.voices.length > 1
            ? parent.braceSpace
            : 0;
        const nameHost = new VoiceNameTemporal(this, braceSpace);

        // 收集范围内的
        const temporalMembers: TemporalNodeBase[] = [];
        ctx.beginLoweringGroup(this, {
            attachment: new VoiceLyricsAttachment(temporalMembers, nameHost),
                onTemporal(node) {
                    temporalMembers.push(node);
                },
        });

        return [nameHost];
    }

    override loweringExit(ctx: LoweringContext) {
        ctx.endLoweringGroup(this);
        return [];
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        this.size = ctx.fontSize;
        [this.content, this.name] = this.getArgValue(args, ctx) as [ASTBraceNode, string];
        this.content.parent = this;
        args.delete(0);
        args.delete("name");
        args.delete(1);

        this.lyrics = [];
        for (const [key, value] of args) {
            if (typeof value === "string") {
                this.addLyric(key, value);
                continue;
            }
            const v = ctx.parseArgWithType((value as SourceSpan).start, (value as SourceSpan).end, "string", span.start);
            if (v === null) {
                ctx.diagnostics.push(new WarningDiagnostic(
                    "W_VOICE_INVALID_LYRIC",
                    `@voice 的歌词参数值解析失败, 参数[${key}]将被忽略`,
                    value as SourceSpan
                ));
            } else this.addLyric(key, v as string);
        }
    }

    addLyric(name: string | number, lyric: string, span: SourceSpan | null = null, ctx: ParserContext | null = null) {
        if (typeof name === "number") name = "";
        const tokens = VoiceFunction.parseLyric(lyric as string);
        if (tokens.length === 0 && ctx && span) {
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_EMPTY_LYRIC",
                `@voice的歌词${name}是空的`,
                span
            ));
        }
        this.lyrics.push({ name, tokens });
        if (span) {
            // 歌词是成节点之后才补上来的，祖先的 span 得一起长，否则按源码位置查节点会漏掉歌词那几行
            for (let node: ASTNodeBase | null = this; node; node = node.parent) {
                node.sourceSpan.start = Math.min(span.start, node.sourceSpan.start);
                node.sourceSpan.end = Math.max(span.end, node.sourceSpan.end);
            }
        }
    }

    static parseLyric(value: string): string[] {
        const result: string[] = [];
        let lastPos = 0;
        for (let i = 0; i < value.length; i++) {
            const ch = value[i];
            if (WHITEPACE_RE.test(ch)) {
                if (i > lastPos) result.push(value.slice(lastPos, i));
                lastPos = i + 1;
            } else if (ch === "-") {
                // 如果前面有内容 则把-放到前一个词里
                if (i > lastPos) {
                    result.push(value.slice(lastPos, i + 1));
                    lastPos = i + 1;
                } else lastPos = i;    // 把-放到下一个词里
            } else if (ch === "@") {
                if (i > lastPos) result.push(value.slice(lastPos, i + 1));
                result.push('');
                lastPos = i + 1;
            } else if (ch.charCodeAt(0) > 0x7F) {
                // 遇到中文等非ASCII字符 直接切分成单个字符
                if (i > lastPos) result.push(value.slice(lastPos, i));
                result.push(ch);
                lastPos = i + 1;
            }
        }
        if (lastPos < value.length) result.push(value.slice(lastPos));
        return result;
    }

    override toString(source: string) {
        const notes = this.content.toString(source);
        const lyricStrs = this.lyrics.map(lyric => {
            let lyricstr = lyric.tokens.map(token => token.length === 0 ? "@" : token).join(" ");
            if (lyricstr.includes(",") || lyricstr.includes("\n")) lyricstr = `"${lyricstr.replace(/"/g, '\\"')}"`;
            return `${lyric.name ? `${lyric.name}=${lyricstr}` : lyricstr}`;
        });
        return `@voice(\n\t${notes},${this.name},\n\t${lyricStrs.join(",\n\t")}\n)`;
    }
}

class VoicesFunction extends ASTFunctionNode {
    static override def = {
        name: ["voices", "vs"],
        description: "多个声部",
        example: `@voices(
    @voice({C1 D1 E1}, 钢琴, 男=ha ha ha),
    @voice({C2 D2 E2}, , "la la la")
)
语法糖：当多个 voice 用 voice 的语法糖写在一起时，会自动创建一个 voices 组件包裹它们。
例：
N(钢琴): C1 D1 E1
L(男): ha ha ha
N: C2 D2 E2
L: la la la
`,
        allowExtraArgs: true,
        extraArgType: "content" as const,
        args: []
    };

    voices: VoiceFunction[];
    createdBySugar: boolean = false;    // 不同创建方式的不能合并
    readonly size: number;              // parse 期冻结的字号，px
    /** 声部名右侧为大括号预留的横向空间 */
    readonly braceSpace: number;
    /** 闭包捕获 parse 期冻结的字号，用来决定空声部槽位的默认高度（1em） */
    private readonly arrange: ArrangeFn;
    override get children() { return this.voices; }
    override timeFlowModel() {
        return {
            children: this.children,
            mode: "parallel" as const,
            tracks: {
                laneKey: `voices/${this.voices.length}`,
                hostIndex: null,    // 宿主不是成员：第一个 voice 也必须拥有独立轨道
                arrange: this.arrange,
            },
        };
    }

    /** 收集本块产生的声部名事件，退出时注册左侧大括号 */
    override loweringEnter(ctx: LoweringContext) {
        const names: VoiceNameTemporal[] = [];
        ctx.beginLoweringGroup(this, {
            attachment: new VoicesBraceAttachment(names, this),
            onTemporal(node) {
                if (node instanceof VoiceNameTemporal) names.push(node);
            },
        });
        return [];
    }

    override loweringExit(ctx: LoweringContext) {
        ctx.endLoweringGroup(this);
        return [];
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        this.voices = [];
        this.size = ctx.fontSize;
        this.braceSpace = ctx.fontSize;
        this.arrange = makeVoicesArrange(ctx.fontSize);
        for (const [, value] of args) {
            if (value instanceof ASTNodeBase) {
                if (value instanceof VoiceFunction) this.addVoice(value);
                else {
                    throw new ErrorDiagnostic(
                        "E_VOICES_INVALID_CHILD",
                        `@voices 的参数必须是 @voice 函数，但发现了其他类型 ${value.constructor.name}`,
                        value instanceof ASTNodeBase ? value.sourceSpan : span
                    );
                } continue;
            }
            // 是用 SourceSpan 体现的原始参数
            const v = ctx.parseArgWithType((value as SourceSpan).start, (value as SourceSpan).end, "content", span.start);
            if (v instanceof VoiceFunction) this.addVoice(v);
            else {
                throw new ErrorDiagnostic(
                    "E_VOICES_INVALID_CHILD",
                    `@voices 的参数必须是 @voice 函数，但发现了其他类型 ${v?.constructor.name}`,
                    value as SourceSpan
                );
            }
        }
        if (this.voices.length === 0) {
            throw new ErrorDiagnostic(
                "E_VOICES_EMPTY",
                `@voices 必须至少包含一个 @voice 函数`,
                span
            );
        }
    }

    addVoice(v: VoiceFunction) {
        this.voices.push(v);
        v.parent = this;
        this.sourceSpan.start = Math.min(v.sourceSpan.start, this.sourceSpan.start);
        this.sourceSpan.end = Math.max(v.sourceSpan.end, this.sourceSpan.end);
    }

    toString(source: string) {
        const voicelines = Array<string>(this.voices.length);
        for (let i = 0; i < this.voices.length; i++) {
            const part = this.voices[i].toString(source).replace(/^/gm, "\t");
            voicelines[i] = part;
        }
        return `@voices(\n${voicelines.join(",\n")}\n)`;
    }
}

export const VoiceNode: ASTFunctionClass = VoiceFunction;
export const VoicesNode: ASTFunctionClass = VoicesFunction;

/** 歌词与歌词行名称相对声部字号的字号 */
const LYRIC_SIZE_RATIO = 0.82;

/** 无大括号时标签右侧的空隙，相对声部字号 */
const NAME_GAP_RATIO = 0.6;

/** 歌词行名称的宽度决定标签列宽度，因此声部名事件和歌词附件必须用同一个样式测量 */
function lyricNameStyle(size: number): TextStyle {
    return {
        fontSize: size * LYRIC_SIZE_RATIO,
        fill: "#000",
        fontWeight: 600,
    };
}

class VoiceNameTemporal extends TemporalNodeBase {
    declare ast: VoiceFunction;
    declare box: LayoutBox;

    /** 名称右侧为大括号预留的横向空间，0 表示不需要 */
    private readonly braceSpace: number;
    private textBaselineY = 0;

    constructor(ast: VoiceFunction, braceSpace: number) {
        super();
        this.ast = ast;
        this.braceSpace = braceSpace;
        this.T = 0;
        // 同一个 voices 块里每个成员都会产生本事件，列结构对称，
        // 因此可以安全地归并成一列并右对齐；
        // 独立的 @voice 与相邻分支不对称，必须单独成列，否则会把同时刻的音符挤到下一列
        this.type = ast.parent instanceof VoicesFunction ? ColType.DEFAULT : ColType.SINGLE;
        // 既没有名称、也不需要括号空间和标签列时只保留不可见的占位事件：
        // 它不进入可见对象，也不让空声部失去默认槽位高度
        if (ast.name || braceSpace > 0 || ast.lyrics.some(lyric => lyric.name)) this.initLayoutBox();
    }

    override prepareLayout(context: LayoutPrepareContext) {
        const metrics = this.ast.name
            ? context.textMeasurer.measureText(this.ast.name, this.style)
            : { w: 0, h: 0, baseline: 0 };
        // 声部名和歌词行名称共用这一列，列宽取其中最宽的一个
        let labelWidth = metrics.w;
        for (const lyric of this.ast.lyrics) {
            if (!lyric.name) continue;
            const lyricMetrics = context.textMeasurer.measureText(lyric.name, lyricNameStyle(this.ast.size));
            labelWidth = Math.max(labelWidth, lyricMetrics.w);
        }

        // 没有大括号时也要在标签右侧留出与内容分离的空隙
        const rightSpace = this.braceSpace > 0 ? this.braceSpace
            : labelWidth > 0 ? this.ast.size * NAME_GAP_RATIO : 0;

        // 对齐点放在标签右边界：同一列共享 `x + anchor`，因此长短不一的声部名会右对齐，
        // 括号空间统一落在对齐点右侧
        this.box.w = labelWidth + rightSpace;
        this.box.h = metrics.h;
        this.box.anchor = labelWidth;
        this.box.visualAxis = metrics.h / 2;
        this.textBaselineY = metrics.baseline;

        // 声部名与第一个音符之间需要稳定但可压缩的横向间距
        this.springConfig.alpha_R = 0.45;
    }

    private get style(): TextStyle {
        return {
            fontSize: this.ast.size * 0.85,
            fill: "#000",
            fontWeight: 600,
            textAlign: "right",
        };
    }

    override paint(painter: Painter) {
        if (!this.ast.name) return;
        painter.drawText(this.ast.name, this.box.x + this.box.anchor, this.box.y + this.textBaselineY, this.style);
    }
}

/** 括线端头的小钩；单位尺寸，绘制时按粗竖线宽度缩放并上下镜像 */
const BRACE_HOOK_REACH = 2.33;
const BRACE_HOOK_DROP = 1.17;
const BRACE_HOOK_BASE = 0.34;
const BRACE_HOOK_COMMANDS: readonly PathCommand[] = [
    { op: "M", x: 0, y: 0 },
    { op: "L", x: 0, y: -BRACE_HOOK_BASE },
    {
        op: "C",
        cx1: BRACE_HOOK_REACH * 0.421, cy1: -BRACE_HOOK_BASE + BRACE_HOOK_DROP * 0.077,
        cx2: BRACE_HOOK_REACH * 0.733, cy2: -BRACE_HOOK_BASE + BRACE_HOOK_DROP * 0.346,
        x: BRACE_HOOK_REACH, y: -BRACE_HOOK_BASE + BRACE_HOOK_DROP,
    },
    { op: "L", x: BRACE_HOOK_REACH * 0.929, y: -BRACE_HOOK_BASE + BRACE_HOOK_DROP },
    {
        op: "C",
        cx1: BRACE_HOOK_REACH * 0.696, cy1: -BRACE_HOOK_BASE + BRACE_HOOK_DROP * 0.535,
        cx2: BRACE_HOOK_REACH * 0.328, cy2: -BRACE_HOOK_BASE + BRACE_HOOK_DROP * 0.352,
        x: 0, y: 0,
    },
    { op: "Z" },
];

/**
 * 画在声部名与音符之间的多声部括线
 *
 * 由一条粗竖线、一条略向内收的细竖线和两端的小钩组成。
 * 纵向跨度直接取首末声部名事件的视觉轴（无名声部的占位盒高度为 0，其 y 就是轨道视觉轴），
 * 因此不需要反查任何轨道信息。
 */
class VoicesBraceAttachment implements LayoutAttachment {
    box: Rect = { x: 0, y: 0, w: 0, h: 0 };
    layer = "background" as const;

    private readonly names: VoiceNameTemporal[];
    private readonly ast: VoicesFunction;
    private bars: { x: number; y: number; w: number; h: number }[] = [];
    private hooks: { x: number; y: number; scale: number; dir: -1 | 1 }[] = [];

    constructor(names: VoiceNameTemporal[], ast: VoicesFunction) {
        this.names = names;
        this.ast = ast;
    }

    layout() {
        this.bars = [];
        this.hooks = [];
        if (this.names.length < 2) return [];

        const first = this.names[0].box;
        const last = this.names[this.names.length - 1].box;
        const em = this.ast.size;
        const top = first.y + first.visualAxis - em * 0.5;
        const bottom = last.y + last.visualAxis + em * 0.5;
        if (bottom - top < 1e-6) return [];

        // 各部分尺寸都以粗竖线宽度为单位，比例取自常见简谱软件的括线
        const stem = Math.max(2.5, em * 0.19);
        const reach = stem * BRACE_HOOK_REACH;
        const drop = stem * BRACE_HOOK_DROP;
        const x = first.x + first.anchor + this.ast.braceSpace * 0.3 + stem / 2;

        this.bars = [
            { x: x - stem / 2, y: top, w: stem, h: bottom - top },
            {
                x: x + stem * 1.33 - stem * 0.165,
                y: top + stem * 0.67,
                w: stem * 0.33,
                h: bottom - top - stem * 1.34,
            },
        ];
        this.hooks = [
            { x, y: top, scale: stem, dir: -1 },
            { x, y: bottom, scale: stem, dir: 1 },
        ];

        // 括线画在声部名左侧的空白里，只参与画布边界，不抢任何轨道的纵向空间
        return [{
            x: x - stem / 2,
            y: top - drop,
            w: reach + stem / 2,
            h: bottom - top + drop * 2,
        }];
    }

    paint(painter: Painter) {
        for (const bar of this.bars) {
            painter.drawRect(bar.x, bar.y, bar.w, bar.h, { fill: "#000" });
        }
        for (const hook of this.hooks) {
            painter.drawPath(
                BRACE_HOOK_COMMANDS,
                { fill: "#000" },
                { x: hook.x, y: hook.y, scaleX: hook.scale, scaleY: hook.scale * hook.dir },
            );
        }
    }
}

/** 一段已经定位好的歌词文本，同时就是报给引擎的占用区域 */
interface PreparedLyricText extends LayoutRegion {
    text: string;          // 最终绘制的 token 或歌词行名称
    style: TextStyle;      // 当前文本使用的字体和颜色
    textBaselineY: number; // 字体 baseline 距文本盒顶部的距离
}

class VoiceLyricsAttachment implements LayoutAttachment {
    box: Rect = { x: 0, y: 0, w: 0, h: 0 };
    layer = "foreground" as const;

    /** lowering 会持续向这个数组加入 voice 内容产生的 temporal */
    private temporalMembers: TemporalNodeBase[];
    /** 同一个 voice 的声部名事件，歌词行名称向它的对齐点右对齐 */
    private nameHost: VoiceNameTemporal;
    private preparedText: PreparedLyricText[] = [];

    constructor(temporalMembers: TemporalNodeBase[], nameHost: VoiceNameTemporal) {
        this.temporalMembers = temporalMembers;
        this.nameHost = nameHost;
    }

    layout(context: AttachmentLayoutContext) {
        this.updateGeometry(context);
        // 同一行同一轨的多行歌词由引擎合并成一段占用
        return this.preparedText;
    }

    paint(painter: Painter) {
        for (const item of this.preparedText) {
            painter.drawText(item.text, item.x, item.y + item.textBaselineY, item.style);
        }
    }

    private updateGeometry(context: AttachmentLayoutContext) {
        const { lyrics, size } = this.nameHost.ast;
        this.preparedText.length = 0;

        const targets = this.temporalMembers
            .filter(isVisualTemporalNode)
            .filter(node => node.ports?.["lyric"]);
        if (targets.length === 0 || lyrics.length === 0) return;

        // 每个 system+track 的歌词共用一条基线
        // 装饰高度先汇总为下边界，不进入单个 token 的 y 计算
        const contentBottom = new Map<number, Map<Track, number>>();
        for (const target of targets) {
            let byTrack = contentBottom.get(target.layoutLine);
            if (!byTrack) contentBottom.set(target.layoutLine, byTrack = new Map());
            const bottom = target.box.y + target.box.h;
            byTrack.set(target.track, Math.max(byTrack.get(target.track) ?? bottom, bottom));
        }

        const fontSize = size * LYRIC_SIZE_RATIO;
        const rowGap = size * 0.24;
        const firstRowGap = size * 0.32;
        const lyricStyle: TextStyle = { fontSize, fill: "#000" };
        const nameStyle = lyricNameStyle(size);
        const baselineOffset = context.textMeasurer.measureText("M", lyricStyle).baseline + firstRowGap;
        const baselineOf = (bottom: number, row: number) => bottom + baselineOffset + row * (fontSize + rowGap);

        // 歌词行名称与声部名共用左侧那一列，因此只出现在声部名所在的那一行
        const { box: labelBox, layoutLine: labelLine, track: labelTrack } = this.nameHost;
        const labelBottom = contentBottom.get(labelLine)?.get(labelTrack);

        for (let row = 0; row < lyrics.length; row++) {
            const lyric = lyrics[row];

            for (let i = 0; i < lyric.tokens.length && i < targets.length; i++) {
                const text = lyric.tokens[i];
                const target = targets[i];
                const bottom = contentBottom.get(target.layoutLine)?.get(target.track);
                if (!text || bottom === undefined) continue;

                const metrics = context.textMeasurer.measureText(text, lyricStyle);
                this.preparedText.push({
                    text,
                    style: lyricStyle,
                    textBaselineY: metrics.baseline,
                    x: target.box.x + target.ports["lyric"].x - metrics.w / 2,
                    y: baselineOf(bottom, row) - metrics.baseline,
                    w: metrics.w,
                    h: metrics.h,
                    line: target.layoutLine,
                    track: target.track,
                });
            }

            if (!lyric.name || !labelBox || labelBottom === undefined) continue;

            const metrics = context.textMeasurer.measureText(lyric.name, nameStyle);
            this.preparedText.push({
                text: lyric.name,
                style: nameStyle,
                textBaselineY: metrics.baseline,
                x: labelBox.x + labelBox.anchor - metrics.w,
                y: baselineOf(labelBottom, row) - metrics.baseline,
                w: metrics.w,
                h: metrics.h,
                line: labelLine,
                track: labelTrack,
            });
        }
    }
}