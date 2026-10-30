import { ASTBraceNode, ASTFunctionClass, ASTFunctionNode, ASTNodeBase, ASTTextNode, FunctionArgs, SourceSpan } from "../ASTtypes.js";
import { Diagnostic, ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
import { isLayoutAttachment, type LayoutAttachment, type LayoutBox, type LayoutPrepareContext } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { LoweringGroup } from "../../lowering/types.js";
import { type CallArgumentInfo, GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import { findRightParen } from "../../parser/parse-utils/call-utils.js";
import { findClosingQuote, quote } from "../../parser/parse-utils/string-utils.js";
import { ParserContext, skipSpaces } from "../../parser/parserContext.js";
import { paintRichLine, prepareRichLine, type PreparedRichLine, type RichTextRun } from "../../render/text.js";
import type { Painter, TextStyle } from "../../render/types.js";
import { isVisualTemporalNode, TemporalNodeBase, type VisualTemporalNode } from "../temporal.js";
import { lyricNameStyle, parseLyric, serializeLyric, VoiceLyricsAttachment } from "./lyrics.js";
import { VoicesFunction } from "./voices.js";

/** 无大括号时标签右侧的空隙，相对声部字号 */
const NAME_GAP_RATIO = 0.6;

export function voiceNameStyle(size: number, fontFamily: string): TextStyle {
    return {
        fontFamily,
        fontSize: size * 0.85,
        fill: "#000",
        textAlign: "right",
    };
}

interface VoiceLyricsGroup extends LoweringGroup {
    readonly nameHost: VoiceNameTemporal;
    readonly nodes: VisualTemporalNode[];
    readonly frames: LayoutAttachment[];
}

export class VoiceFunction extends ASTFunctionNode {
    static override def = {
        name: ["voice", "v"],
        description: "声部",
        details: `\
~~~jpfun
@voice({1 2 3}, 钢琴, 男=ha ha ha, 女=la la la)
~~~
- **额外参数**：每项为一行歌词；命名参数同时给出歌词行名，位置参数表示无行名。省略声部名但仍需歌词时，保留空位，如 \`@voice({1 2 3}, , ha ha ha)\`。

歌词可用引号包裹；调用 \`@voice\` 时歌词若含逗号须加引号。英文用空格或连字符 \`-\` 分词，用 \`@\` 留空。名称与歌词均支持 \`*斜体*\`、\`**粗体**\`、\`_下划线_\`、\`^上标^\`（可跨多个音符，如 \`*春眠不觉晓*\`）。

**简写**：\`N\` 声明音符行，\`L\` 声明歌词行，括号内的名称可省略：
~~~jpfun
N(钢琴): 1 2 3
L(男): ha ha ha
L: la la la
~~~
换行结束当前行，行末加 \`\\\` 可续行；\`L:\` 中可直接使用逗号。`,
        allowExtraArgs: true,
        extraArgType: "string" as const,
        args: [
            {
                type: "content" as const,
                description: "声部的音符内容",
                default: null,
            },
            {
                name: "name",
                description: "显示在左侧的声部名称，空值隐藏名称",
                type: "string" as const,
                default: "",
            },
            // 之后的参数都当作歌词参数
        ],
    };

    // 去糖第一阶段识别两个标签 这里先不消费换行符，因为 br 可能需要
    static override deSugarAtom(source: string, start: number, end: number) {
        if (source[start] !== "N" && source[start] !== "L") return null;
        let pos = start + 1;
        let name: SourceSpan = { start: pos, end: pos };
        if (source[pos] === "(") {
            // `X(name)` 提取括号
            const at = findRightParen(source, pos + 1, end);
            if (at < 0) return null;    // 没有找到匹配的右括号 不去糖
            name = { start: pos + 1, end: at };
            pos = at + 1;
        }
        if (source[pos++] !== ":") return null;   // `:` 之前不允许有空格
        // 识别具体内容
        if (source[start] === "N") {
            // 等到第二轮寻找该层级的终止符 \n 来确定内容范围
            const node: GrammarSugarNode = {
                kind: "sugar",
                data: {
                    class: VoiceFunction,
                    name,
                },
                span: { start, end: pos },
            };
            return { next: pos, node };
        }
        // 字符串收集
        pos = skipSpaces(source, pos, end);
        if (pos >= end) return null;    // 没有内容了 不去糖
        let lyric: SourceSpan;
        // 双引号才是字符串，单引号不是
        if (source[pos] === '"') {
            // 未闭合就不去糖，词法层每次击键都跑，不能抛
            const close = findClosingQuote(source, pos, end);
            if (close < 0) return null;
            lyric = { start: pos, end: close + 1 };
            pos = close + 1;
        } else {
            // 没有引号的 以换行符为界切分 预处理已经跳过了转义的换行符了
            const from = pos;
            while (pos < end && source[pos] !== "\n") pos++;
            lyric = { start: from, end: pos };
        }
        const node: GrammarSugarNode = {
            kind: "sugar",
            data: {
                class: VoiceFunction,
                lyric,
                name,
            },
            span: { start, end: pos },
        };
        return { next: pos, node };
    }

    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number, members?: VoiceFunction[]) {
        const n = nodes[at++] as GrammarSugarNode;
        if (n.data?.class !== VoiceFunction) return null;
        const parseStr = (span: SourceSpan) => (ctx.parseArgWithType(span, "string") as string | null) ?? "";
        if (n.data?.lyric !== void 0) {
            // 歌词 需要找到最近的voice节点并添加歌词
            let voiceNode: VoiceFunction | null = null;
            let voiceNodeAt = ctx.nodes.length - 1;
            for (; voiceNodeAt >= 0; voiceNodeAt--) {
                const n = ctx.nodes[voiceNodeAt];
                if (n instanceof ASTTextNode) {
                    if (!ctx.variables.strict) continue;   // 非严格模式下允许文本节点夹在N和L之间
                    // ParserContext.parseGrammar 处理后不会有空白字符
                    throw new ErrorDiagnostic(
                        "E_LYRICS_WITHOUT_VOICE_NOTES",
                        `strict 模式下，语法糖 'L:' 或 'L(name)' 必须跟在 @voice 的音符之后，但在其前面发现了未知文本`,
                        n.sourceSpan,
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
                    n.span,
                );
            }
            voiceNode.addLyric(parseStr(n.data.name), parseStr(n.data.lyric), n.span, ctx);
            ctx.nodes.length = voiceNodeAt + 1;   // 清除voiceNodeAt之后的TextNode 因为被夹在N和L之间
            // 消费后面可能的换行符 只消费一个
            if (at < nodes.length && typeof nodes[at] === "number" && ctx.source[nodes[at] as number] === "\n") at++;
            return at;
        }
        const name = parseStr(n.data.name);
        // 当前层的换行或 N/L/V 声明结束音符内容，不能把下一组吞进声部
        let breakAt = at;
        let endWithBr = 0;
        for (; breakAt < nodes.length; breakAt++) {
            const n = nodes[breakAt];
            if (typeof n === "number") {
                if (ctx.source[n] === "\n") {
                    // 换行符应该被 N: 消费
                    endWithBr = 1;
                    break;
                }
            } else if (n.kind === "sugar"
                && (n.data?.class === VoiceFunction || n.data?.class === VoicesFunction)) break;
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
        argMap.set("name", name);
        const newVoice = new VoiceFunction(span, argMap, ctx, null);

        // V 声明直接收集成员，最后统一组装，避免创建临时 voices
        if (members) {
            ctx.pushNode(newVoice);
            members.push(newVoice);
            return breakAt;
        }

        // 如果前面紧挨着 VoicesFunction | VoiceFunction 则直接加入
        let voicesNode: VoicesFunction | null = null;
        let voicesNodeAt = ctx.nodes.length - 1;
        let textBetween: ASTTextNode | null = null;
        ifCombine: for (; voicesNodeAt >= 0; voicesNodeAt--) {
            const n = ctx.nodes[voicesNodeAt];
            if (n instanceof ASTTextNode) {
                if (ctx.variables.strict) break;
                // 如果中间有换行符，直接说明是两个独立的 voice 组件，不能合并
                for (let i = n.sourceSpan.start; i < n.sourceSpan.end; i++) {
                    if (ctx.source[i] === "\n") break ifCombine;
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
                    end: n.sourceSpan.end,
                }, args, ctx, null);
                voicesNode.createdBySugar = true;
            }
            break;
        }
        if (voicesNode) {
            ctx.nodes[voicesNodeAt] = voicesNode;
            voicesNode.addVoice(newVoice);
            if (textBetween) {
                ctx.nodes.length = voicesNodeAt + 1;
                ctx.diagnostics.push(new WarningDiagnostic(
                    "W_VOICES_TEXT_BETWEEN",
                    `两个 @voice 之间有未知文本。当前处于非 strict 模式，会忽略该内容、合并为一个 @voices`,
                    textBetween.sourceSpan,
                ));
            }
        } else ctx.pushNode(newVoice);
        return breakAt;
    }

    content: ASTBraceNode;   // 声部内容
    name: string;   // 声部名称
    size: number;   // 声部的字体大小
    readonly font: string;
    lyrics: {
        name: string;
        tokens: RichTextRun[][];   // 分词后的歌词内容
    }[];
    override get children() { return [this.content]; }

    /**
     * voice 的音符内容仍按普通 sequence 进入全局时间列
     * 此处按需建立歌词作用域，并在内容前创建声部名对象
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
        if (this.lyrics.length > 0) {
            const group: VoiceLyricsGroup = {
                nameHost,
                nodes: [],
                frames: [],
                onTemporal(node) {
                    if (isVisualTemporalNode(node)) group.nodes.push(node);
                },
                onAttachment(attachment) {
                    if (isLayoutAttachment(attachment) && attachment.layer === "background") group.frames.push(attachment);
                },
            };
            ctx.beginLoweringGroup(this, group);
        }
        return [nameHost];
    }

    override loweringExit(ctx: LoweringContext) {
        if (this.lyrics.length > 0) {
            const { nodes, nameHost, frames } = ctx.endLoweringGroup<VoiceLyricsGroup>(this);
            ctx.addAttachment(new VoiceLyricsAttachment(nodes, nameHost, frames));
        }
        return [];
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        this.size = ctx.variables.fontsize;
        [this.content, this.name] = this.getArgValue(args, ctx) as [ASTBraceNode, string];
        this.content.parent = this;
        this.font = ctx.variables.font;
        args.delete(0);
        args.delete("name");
        args.delete(1);

        this.lyrics = [];
        for (const [key, value] of args) {
            if (typeof value === "string") {
                this.addLyric(key, value);
                continue;
            }
            const arg = value as CallArgumentInfo;
            const v = ctx.parseArgWithType(arg.valueSpan, "string", span.start);
            if (v === null) {
                ctx.diagnostics.push(new WarningDiagnostic(
                    "W_VOICE_INVALID_LYRIC",
                    "@voice 的歌词参数值解析失败, 参数[{key}]将被忽略",
                    arg.valueSpan,
                    { key },
                ));
            } else this.addLyric(key, v as string);
        }
    }

    addLyric(name: string | number, lyric: string, span: SourceSpan | null = null, ctx: ParserContext | null = null) {
        if (typeof name === "number") name = "";
        const tokens = parseLyric(lyric);
        if (tokens.length === 0 && ctx && span) {
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_EMPTY_LYRIC",
                "@voice的歌词{name}是空的",
                span,
                { name },
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

    override toString(source: string) {
        const parameters = [`${this.content.toString(source)},${quote(this.name)}`];
        for (const lyric of this.lyrics) {
            const text = serializeLyric(lyric.tokens);
            parameters.push(lyric.name ? `${lyric.name}=${text}` : text);
        }
        return `@voice(\n\t${parameters.join(",\n\t")}\n)`;
    }
}

export class VoiceNameTemporal extends TemporalNodeBase {
    declare ast: VoiceFunction;
    declare box: LayoutBox;

    /** 名称右侧为大括号预留的横向空间，0 表示不需要 */
    private readonly braceSpace: number;
    private preparedName: PreparedRichLine | null = null;

    constructor(ast: VoiceFunction, braceSpace: number) {
        super();
        this.ast = ast;
        this.braceSpace = braceSpace;
        this.mergeKey = -2;
        // 既没有名称、也不需要括号空间和标签列时只保留不可见的占位事件：
        // 它不进入可见对象，也不让空声部失去默认槽位高度
        if (ast.name || braceSpace > 0 || ast.lyrics.some(lyric => lyric.name)) this.initLayoutBox();
    }

    override prepareLayout(context: LayoutPrepareContext) {
        this.preparedName = this.ast.name
            ? prepareRichLine(this.ast.name, voiceNameStyle(this.ast.size, this.ast.font), context.textMeasurer)
            : null;
        // 声部名和歌词行名称共用这一列，列宽取其中最宽的一个
        let labelWidth = this.preparedName?.w ?? 0;
        const lyricStyle = lyricNameStyle(this.ast.size, this.ast.font);
        for (const lyric of this.ast.lyrics) {
            if (!lyric.name) continue;
            labelWidth = Math.max(labelWidth, prepareRichLine(lyric.name, lyricStyle, context.textMeasurer).w);
        }

        // 没有大括号时也要在标签右侧留出与内容分离的空隙
        const rightSpace = this.braceSpace > 0 ? this.braceSpace
            : labelWidth > 0 ? this.ast.size * NAME_GAP_RATIO : 0;

        // 对齐点放在标签右边界：同一列共享 `x + anchor`，因此长短不一的声部名会右对齐，
        // 括号空间统一落在对齐点右侧
        this.box.w = labelWidth + rightSpace;
        this.box.h = this.preparedName?.h ?? 0;
        this.box.anchor = labelWidth;
        this.box.visualAxis = this.box.h / 2;

        // 声部名与第一个音符之间需要稳定但可压缩的横向间距
        this.springConfig.alpha_R = 0.45;
    }

    override paint(painter: Painter) {
        if (!this.preparedName) return;
        paintRichLine(painter, this.preparedName, this.box.x + this.box.anchor, this.box.y + this.preparedName.baseline);
    }
}

export const VoiceNode: ASTFunctionClass = VoiceFunction;