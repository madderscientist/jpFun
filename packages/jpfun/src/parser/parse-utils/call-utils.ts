import { SourceSpan } from "../types.js";
import type { CallArgumentInfo, CallInfo } from "../grammarType.js";

// 函数名：允许字母/下划线，以及符号别名（@/ @. @-）
const CALL_NAME_CHAR_RE = /[A-Za-z0-9_./-]/;

/**
 * 尝试在 `source` 的 `atPos` 位置读取一个以 `@` 开头的调用表达式，例如 `@name(...)`
 * @param source 原始文本
 * @param atPos `@` 字符的位置索引
 * @param end 当前 ParserContext 允许读取的右边界，不能越过 content/brace 的解析范围
 * @returns 不是调用时返回 null；未闭合时仍返回 CallInfo，并用缺失的 closeParenSpan 表示 partial call
 * 实现细节：
 * - 从 `atPos + 1` 读取字母/下划线/符号序列作为调用名
 * - 必须紧跟 `(` 才视为调用，否则返回空对象
 * - 解析括号内部直到找到与起始 `(` 匹配的 `)`，过程中：
 *   - 正确处理字符串字面量（支持转义）
 *   - 支持嵌套小括号 `(...)`，但被大括号 `{...}` 包裹的小括号不会影响外层匹配
 *   - 忽略大括号内的小括号深度变化
 * - 在顶层小括号内以逗号分割参数，记录每个参数的原始文本及其在 `source` 中的起始/结束位置
 * - 若找到匹配右括号，记录 closeParenSpan；否则在 end 处结束，让上层决定诊断/恢复策略
 */
export function readCall(source: string, atPos: number, end: number): CallInfo | null {
    // 读取调用名
    let i = atPos + 1;
    while (i < end && CALL_NAME_CHAR_RE.test(source[i])) i++;
    const name = source.slice(atPos + 1, i);

    if (!name) return null;  // 没有找到名称,非调用,可能是标签
    if (i >= end || source[i] !== "(") return null; // 必须紧接着一个左括号才是调用(因为小括号会作为其他语法)

    // 从左括号开始查找匹配的右括号，同时处理字符串与大括号
    const openPos = i;
    let parenDepth = 1;
    let braceDepth = 0;
    let quote: '"' | null = null;
    let escaped = false;

    // 参数相关
    const argInfo: CallArgumentInfo[] = [];
    let lastCommaPos = openPos + 1;

    // 按照 `key = value` 或者 `value` 的模式匹配各个token的span
    // keepEmpty=true 用于保留 @func(,key=val) 这种情况的空参数
    const pushArg = (end: number, commaPos?: number, keepEmpty: boolean = false) => {
        const span = trimRange(source, lastCommaPos, end);
        if (!keepEmpty && span.start >= span.end) return;
        const equals = findTopLevelEquals(source, span.start, span.end);
        const nameSpan = equals > span.start ? trimRange(source, span.start, equals) : undefined;
        const valueSpan = equals > span.start ? trimRange(source, equals + 1, span.end) : span;
        argInfo.push({
            span,
            valueSpan,
            nameSpan,
            equalsSpan: equals > span.start ? { start: equals, end: equals + 1 } : undefined,
            commaSpan: commaPos === undefined ? undefined : { start: commaPos, end: commaPos + 1 },
        });
    };

    const callInfo = (end: number, closeParenSpan?: SourceSpan): CallInfo => ({
        name,
        span: { start: atPos, end },
        nameSpan: { start: atPos, end: openPos },
        openParenSpan: { start: openPos, end: openPos + 1 },
        closeParenSpan,
        args: argInfo,
    });

    for (i++; i < end; i++) {
        const ch = source[i];
        // 同 `splitArgsWithRanges` 跳过引号
        if (quote) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"') {
            quote = ch;
            continue;
        }

        // 忽略大括号内的小括号 防止大括号内小括号的不闭合影响外部
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
        else if (ch === "(" && braceDepth === 0) parenDepth++;
        else if (ch === ")" && braceDepth === 0) {
            if (--parenDepth) continue; // 还未回到顶层，继续寻找
            // 剩余参数 如果为空就不添加
            pushArg(i);
            return callInfo(i + 1, { start: i, end: i + 1 });
        } else if (ch === "," && parenDepth === 1 && braceDepth === 0) {
            // 在顶层小括号内遇到逗号，切分参数
            pushArg(i, i, true);    // 即使为空也有位置信息
            // 跳过逗号
            lastCommaPos = i + 1;
        }
    }

    // 未闭合调用仍保留已有结构；ParserContext 根据 closeParenSpan 生成诊断
    pushArg(end);
    return callInfo(end);
}

const SPACE_RE = /\s/;
export function trimRange(source: string, start: number, end: number): SourceSpan {
    let s = start;
    let e = end;
    while (s < e && SPACE_RE.test(source[s])) s += 1;
    while (e > s && SPACE_RE.test(source[e - 1])) e -= 1;
    return { start: s, end: e };
}

export function findTopLevelEquals(text: string, start: number = 0, end: number = text.length): number {
    let parenDepth = 0;
    let braceDepth = 0;
    let quote: '"' | null = null;
    let escaped = false;
    for (let i = start; i < end; i++) {
        const ch = text[i];
        if (quote) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"') quote = ch;
        // 依旧忽略大括号里面的小括号
        else if (ch === "(" && braceDepth === 0) parenDepth++;
        else if (ch === ")" && braceDepth === 0) parenDepth = Math.max(0, parenDepth - 1);
        else if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
        else if (ch === "=" && parenDepth === 0 && braceDepth === 0) return i;
    } return -1;
}

// 不管大括号 适用于小括号里传递字符串但没加引号的情况
export function findRightParen(source: string, start: number, end: number): number {
    let parenDepth = 1;
    let quote: '"' | null = null;
    let escaped = false;
    for (let i = start; i < end; i++) {
        const ch = source[i];
        if (quote) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"') quote = ch;
        else if (ch === "(") parenDepth++;
        else if (ch === ")") {
            if (--parenDepth === 0) return i;
        }
    } return -1;
}