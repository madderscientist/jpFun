import { ASTNodeBase, ASTBraceNode, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass, ASTTextNode } from "../ASTtypes.js";
import { Diagnostic, ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
import { findRightParen, removeQuote } from "../../parser/parse-utils/call-utils.js";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import { ParserContext, skipSpaces } from "../../parser/parserContext.js";

const WHITEPACE_RE = /\s/;

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
            if (quote === '"' || quote === "'") {
                // 有引号的 直接以引号为界切分
                lystart = ++pos;
                let escaped = false;
                let q: "'" | '"' | null = null;
                for (; pos < end; pos++) {
                    const ch = source[pos];
                    if (q) {
                        if (escaped) escaped = false;
                        else if (ch === "\\") escaped = true;
                        else if (ch === q) q = null;
                        continue;
                    }
                    if (ch === quote) break;
                    if (ch === '"' || ch === "'") q = ch;
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
                    const err = new ErrorDiagnostic(
                        "E_LYRICS_WITHOUT_VOICE_NOTES",
                        `strict 模式下，语法糖 'L:' 或 'L(name)' 必须跟在 @voice 的音符之后，但在其前面发现了未知文本`,
                        n.sourceSpan
                    );
                    ctx.diagnostics.push(err);
                    throw err;
                }
                if (n instanceof VoiceFunction) voiceNode = n;
                else if (n instanceof VoicesFunction) voiceNode = n.voices.at(-1) ?? null;
                break;
            }
            if (voiceNode === null) {
                const err = new ErrorDiagnostic(
                    "E_LYRICS_WITHOUT_VOICE_NOTES",
                    `语法糖 'L:' 或 'L(name):' 必须跟在 @voice（或 N:）之后，但没有找到符合要求的 voice；请检查语法或直接使用 @voice 函数`,
                    n.span
                );
                ctx.diagnostics.push(err);
                throw err;
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
            const e = Diagnostic.error.EmptyContent("voice", "content", n.span);
            ctx.diagnostics.push(e);
            throw e;
        }
        const argMap: FunctionArgs = new Map();
        if (newCtx.nodes.length === 1 && newCtx.nodes[0] instanceof ASTBraceNode) argMap.set(0, newCtx.nodes[0]);
        else argMap.set(0, new ASTBraceNode(n.span, newCtx.nodes));
        argMap.set("name", n.data.name);
        const newVoice = new VoiceFunction({
            start: n.span.start,
            end: breakAt < nodes.length ? (nodes[breakAt] as number) : ctx.source.length
        }, argMap, ctx, null);

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
            this.sourceSpan.start = Math.min(span.start, this.sourceSpan.start);
            this.sourceSpan.end = Math.max(span.end, this.sourceSpan.end);
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
        args: []
    };

    voices: VoiceFunction[];
    createdBySugar: boolean = false;    // 不同创建方式的不能合并
    override get children() { return this.voices; }
    override timeFlowModel() {
        return {
            children: this.children,
            mode: "sequence" as const,
        };
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        this.voices = [];
        for (const [, value] of args) {
            if (value instanceof ASTNodeBase) {
                if (value instanceof VoiceFunction) this.addVoice(value);
                else {
                    const err = new ErrorDiagnostic(
                        "E_VOICES_INVALID_CHILD",
                        `@voices 的参数必须是 @voice 函数，但发现了其他类型 ${value.constructor.name}`,
                        value instanceof ASTNodeBase ? value.sourceSpan : span
                    );
                    ctx.diagnostics.push(err);
                    throw err;
                } continue;
            }
            // 是用 SourceSpan 体现的原始参数
            const v = ctx.parseArgWithType((value as SourceSpan).start, (value as SourceSpan).end, "content", span.start);
            if (v instanceof VoiceFunction) this.addVoice(v);
            else {
                const err = new ErrorDiagnostic(
                    "E_VOICES_INVALID_CHILD",
                    `@voices 的参数必须是 @voice 函数，但发现了其他类型 ${v?.constructor.name}`,
                    value as SourceSpan
                );
                ctx.diagnostics.push(err);
                throw err;
            }
        }
        if (this.voices.length === 0) {
            const err = new ErrorDiagnostic(
                "E_VOICES_EMPTY",
                `@voices 必须至少包含一个 @voice 函数`,
                span
            );
            ctx.diagnostics.push(err);
            throw err;
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