import { Diagnostic } from "../diagnostic.js";
import { resolveArgType, type paramType } from "../functions/ASTtypes.js";
import type { CallInfo, GrammarNode, SyntaxAnalysis, SyntaxToken, SyntaxTokenKind } from "./grammarType.js";
import { callArgName } from "./parse-utils/call-utils.js";
import { parseLength } from "./parse-utils/length-utils.js";
import { BOOL_RE, ParserContext } from "./parserContext.js";
import type { SourceSpan } from "./types.js";

/** 有函数参数契约时直接用声明类型；未知参数回落到真正的字面量解析器，不另写一套正则 */
function classifySyntaxValue(type: paramType | undefined, text: string): SyntaxTokenKind | undefined {
    if (type) return type === "content" ? undefined : type;
    if (BOOL_RE.test(text)) return "boolean";
    if (text.startsWith('"')) return "string";
    if (!isNaN(Number(text))) return "number";
    if (!(parseLength(text) instanceof Diagnostic)) return "length";
    return undefined;
}

/**
 * 编辑器语法视图：以词法层模式观察 parseGrammar，收集着色 token 与调用结构，不构造 AST
 * 节点按源码顺序发出、子区间就地递归，所以 tokens 有序且互不重叠，calls 按起点严格递增，无需排序；
 * 注释在预处理阶段已被掩码，最后从 commentSpans 归并回来
 */
export function collectSyntax(parser: ParserContext, commentSpans: SourceSpan[]): SyntaxAnalysis {
    const { source, functions } = parser;
    const tokens: SyntaxToken[] = [];
    const calls: CallInfo[] = [];

    // 词法层不构造 AST，识别阶段的 span 没有其他读写者，可直接引用
    const add = (kind: SyntaxTokenKind, span: SourceSpan | undefined) => {
        if (span && span.start < span.end) tokens.push({ kind, span });
    };
    /**
     * 把已识别的 GrammarNode 映射为源码 token；content/brace 在子上下文中继续递归，作用域深度随之加一
     * 总是返回 true 接管节点：输入途中的语法错误只记诊断，继续扫描以保留已识别的结构
     */
    const record = (node: GrammarNode, ctx: ParserContext): boolean => {
        if (node.kind === "brace") {
            add("punctuation", { start: node.span.start, end: node.span.start + 1 });
            const close = Math.min(source.length, node.span.end - 1);
            new ParserContext(ctx).parseGrammar(node.span.start + 1, close, record);
            if (source[close] === "}") add("punctuation", { start: close, end: close + 1 });
            return true;
        }
        if (node.kind === "label") {
            add("label", node.span);
            return true;
        }
        if (node.kind === "sugar" || node.typed) {
            if (Array.isArray(node.syntaxKind)) {
                for (const token of node.syntaxKind) add(token.kind, token.span);
            } else add(node.syntaxKind ?? "operator", node.span);
            return true;
        }

        // calls 只暴露源码结构，不带 grammar 阶段的字段
        const { kind, typed, syntaxKind, ...call } = node;
        calls.push(call);
        add("function", call.nameSpan);
        add("punctuation", call.openParenSpan);
        const def = functions.get(call.name.toLowerCase())?.def;
        for (let index = 0; index < call.args.length; index++) {
            const arg = call.args[index];
            add("property", arg.nameSpan);
            add("punctuation", arg.equalsSpan);
            const type = def && resolveArgType(def, callArgName(source, arg), index);
            if (type === "content") {
                new ParserContext(ctx).parseGrammar(arg.valueSpan.start, arg.valueSpan.end, record);
            } else {
                const valueKind = classifySyntaxValue(type, source.slice(arg.valueSpan.start, arg.valueSpan.end));
                if (valueKind) add(valueKind, arg.valueSpan);
            }
            add("punctuation", arg.commaSpan);
        }
        add("punctuation", call.closeParenSpan);
        return true;
    };

    parser.parseGrammar(0, source.length, record);
    return { tokens: interleaveComments(tokens, commentSpans), calls };
}

/** 线性归并注释；未裁剪的值（如歌词行）会跨过注释，在注释处切开，保证输出有序且互不重叠 */
function interleaveComments(tokens: SyntaxToken[], comments: SourceSpan[]): SyntaxToken[] {
    if (comments.length === 0) return tokens;
    const out: SyntaxToken[] = [];
    let c = 0;
    for (const token of tokens) {
        const { kind, span } = token;
        let start = span.start;
        for (; c < comments.length && comments[c].start < span.end; c++) {
            const comment = comments[c];
            if (start < comment.start) out.push({ kind, span: { start, end: comment.start } });
            out.push({ kind: "comment", span: comment });
            start = Math.max(start, comment.end);
        }
        if (start < span.end) out.push(start === span.start ? token : { kind, span: { start, end: span.end } });
    }
    for (; c < comments.length; c++) out.push({ kind: "comment", span: comments[c] });
    return out;
}
