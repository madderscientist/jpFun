import { FunctionDef, ASTNodeBase, TokenNode, ASTBraceNode, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass, deSugarFunction } from "../types";
import { Diagnostic, ErrorDiagnostic, WarningDiagnostic } from "../../parser/diagnostic";
import { findRightParen, removeQuote } from "../../parser/parse-utils/call-utils";
import { CanonicalParser, skipSpaces } from "../../parser/canonicalParser";

const WHITEPACE_RE = /\s/;

class VoiceFunction extends ASTFunctionNode {
    static def: FunctionDef = {
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
                type: "content",
                default: null,
            },
            {
                name: "name",
                type: "string",
                default: "",
            },
            // 之后的参数都当作歌词参数
        ],
    };

    // 由于解析有些复杂 不管exec，总是执行，失败则报错
    static deSugar(parser: CanonicalParser, exec: boolean) {
        const ctx = parser.context;
        const source = ctx.source;
        let pos = parser.cursor;
        if (pos >= parser.end - 1) return null;
        let name = '';
        // 识别音符参数
        if (source[pos] === 'N') {
            pos++;
            if (source[pos] === '(') {
                // `N(name)` 提取括号
                const at = findRightParen(source, pos + 1, parser.end);
                if (at < 0) return null;    // 没有找到匹配的右括号 不去糖
                name = removeQuote(source.slice(pos + 1, at).trim());
                pos = at + 1;
            }
            if (source[pos] !== ':') return null;   // `:` 之前不允许有空格
            // 开始正式解析后面内容 头插一个遇到换行符就结束的语法糖 后面不允许 return null 了
            let realEnd = pos + 1;
            const subparser = new CanonicalParser(ctx, realEnd, parser.end);
            const subDesugar: deSugarFunction = (p, e) => {
                const s = p.context.source;
                if (s[p.cursor] === '\n') {
                    realEnd = p.cursor;   // 记录实际结束位置
                    return {
                        next: p.end,   // 直接跳到末尾结束解析
                        canConsumeNumber: p.context.toConsume.length,   // 直接消费掉所有之前解析的节点
                    }
                } return null;
            }
            subparser.context.deSugarFns = [subDesugar, ...subparser.context.deSugarFns];
            subparser.context.diagnostics = [];
            const success = subparser.parse();
            if (!success) { // 解析失败 理应不去糖 但是为了告诉用户错误，需要执行去糖并报错
                ctx.diagnostics.push(...subparser.context.diagnostics);
                throw void 0;   // throw能让外部的parser捕获并停止解析
            } else {
                let tc = subparser.context.toConsume;
                if (tc.length === 0) {  // 什么都没有，直接报错
                    const err = Diagnostic.error.EmptyContent("voice", "content", { start: pos + 1, end: realEnd });
                    ctx.diagnostics.push(err);
                    throw err;
                }
                if (tc.length === 1 && tc[0] instanceof ASTBraceNode) tc = tc[0].content;
                const argMap: FunctionArgs = new Map();
                argMap.set(0, new ASTBraceNode({ start: pos + 1, end: realEnd }, tc));
                argMap.set(1, name);
                const newVoice = new VoiceFunction(
                    { start: parser.cursor, end: realEnd }, argMap, ctx, null
                );
                ctx.pushNewNode(newVoice);
                pos = realEnd;
            }
        } else if (source[pos] === 'L') {
            pos++;
            if (source[pos] === '(') {
                // `L(name)` 提取括号
                const at = findRightParen(source, pos + 1, parser.end);
                if (at < 0) return null;
                name = removeQuote(source.slice(pos + 1, at).trim());
                pos = at + 1;
            }
            if (source[pos] !== ':') return null;
            // 后面不允许 return null 了
            // 检查上一个是不是 VoiceFunction
            let voiceNode: VoiceFunction | null = null;
            for (let k = ctx.toConsume.length - 1; k >= 0; k--) {
                const n = ctx.toConsume[k];
                if (n instanceof TokenNode) continue;   // 跳过空白等无意义节点
                if (n instanceof VoiceFunction) voiceNode = n;
                break;
            }
            if (voiceNode === null) {
                const err = new ErrorDiagnostic(
                    "E_LYRICS_WITHOUT_VOICE_NOTES",
                    `语法糖 'L:' 或 'L(name)' 必须跟在 @voice 的音符之后，但没有找到符合要求的 voice；请检查语法或直接使用 @voice 函数`,
                    { start: parser.cursor, end: pos }
                );
                ctx.diagnostics.push(err);
                throw err;
            }
            // 跳过空格后查找引号
            let lystart = pos = skipSpaces(source, pos + 1, parser.end);
            let lyend = parser.end;
            if (pos < parser.end) {
                if (source[pos] === '"' || source[pos] === "'") {
                    // 有引号的 直接以引号为界切分
                    const quote = source[pos];
                    lystart = ++pos;
                    let escaped = false;
                    let q: "'" | '"' | null = null;
                    for (; pos < parser.end; pos++) {
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
                    if (pos >= parser.end) {
                        const err = Diagnostic.error.UnterminatedString({
                            start: lystart - 1, end: parser.end
                        });
                        ctx.diagnostics.push(err);
                        throw err;
                    }
                    lyend = pos++;  // 跳过结尾引号
                } else {
                    // 没有引号的 以换行符为界切分 需要跳过转义后的换行符
                    for (; pos < parser.end; pos++) {
                        if (source[pos] === '\n') break;
                        if (source[pos] === '\\') {
                            pos++;
                            if (pos >= parser.end) break;
                        }
                    } lyend = pos;
                }
            }
            voiceNode.addLyric(name, source.slice(lystart, lyend).trim(), {
                start: lystart, end: lyend
            }, parser.context);
        } else return null;
        return {
            next: pos,
            canConsumeNumber: 0,
        }
    }

    content: ASTBraceNode;   // 声部内容
    name: string;   // 声部名称
    lyrics: {
        name: string,
        tokens: string[]   // 分词后的歌词内容
    }[];
    get children() { return [this.content]; }

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.content, this.name] = this.getArgValue(args, ctx) as [ASTBraceNode, string];
        this.content.parent = this;
        args.delete(0);
        args.delete("name");
        args.delete(1);

        this.lyrics = [];
        for (const [key, value] of args) this.addLyric(key, value as string);
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

    toString(source: string): string {
        const notes = this.content.toString(source);
        return `@voice(\n\t${notes},${this.name},\n\t${this.lyrics.map(lyric => {
            let lyricstr = lyric.tokens.map(token => token.length === 0 ? "@" : token).join(" ");
            if (lyricstr.includes(",") || lyricstr.includes("\n")) lyricstr = `"${lyricstr.replace(/"/g, '\\"')}"`;
            return `${lyric.name ? `${lyric.name}=${lyricstr}` : lyricstr}`;
        }).join(",\n\t")}\n)`;
    }
}

export const VoiceNode: ASTFunctionClass = VoiceFunction;