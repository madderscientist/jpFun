import { SourceSpan } from "../types";
import { Diagnostic } from "../diagnostic";

// 函数名：允许字母/下划线，以及符号别名（@/ @. @-）
const CALL_NAME_CHAR_RE = /[A-Za-z_./-]/;

/**
 * 表示解析到的函数/调用信息用于在源码中定位并提取调用体
 */
export interface CallInfo {
    name: string; // 调用名（不包含 `@` 前缀），例如 `note`、`set`
    start: number;  // 整个调用在源字符串中的起始索引（`@` 的位置）
    end: number;  // 整个调用在源字符串中的结束索引（右括号后一位）
    argRanges: SourceSpan[]; // 逗号分割后的参数列表 位置为参数的原始文本（未进一步解析、保留原始空白/转义/等号）
}

/**
 * `readCall` 的返回结果类型：解析到的 `call` 和 包含 `fatal` 错误信息（例如未闭合的调用）
 * 允许都存在，此时可以在fatal中存放警告
 */
export interface CallReadResult {
    call?: CallInfo;  // 成功解析到调用时包含调用信息
    fatal?: Diagnostic; // 遇到严重错误时包含错误信息，例如未闭合的调用
}

/**
 * 尝试在 `source` 的 `atPos` 位置读取一个以 `@` 开头的调用表达式，例如 `@name(...)`
 * @param source 原始文本
 * @param atPos `@` 字符的位置索引
 * @returns 如果成功解析到调用，返回包含调用信息的 `call`；如果遇到未闭合的括号等严重错误，返回 `fatal` 错误信息；否则返回空对象表示当前位置不是有效调用
 * 实现细节：
 * - 从 `atPos + 1` 读取字母/下划线/符号序列作为调用名
 * - 必须紧跟 `(` 才视为调用，否则返回空对象
 * - 解析括号内部直到找到与起始 `(` 匹配的 `)`，过程中：
 *   - 正确处理字符串字面量（支持转义）
 *   - 支持嵌套小括号 `(...)`，但被大括号 `{...}` 包裹的小括号不会影响外层匹配
 *   - 忽略大括号内的小括号深度变化
 * - 在顶层小括号内以逗号分割参数，记录每个参数的原始文本及其在 `source` 中的起始/结束位置
 * - 若找到匹配右括号，返回 `CallInfo`；否则返回 `fatal` 表示未闭合错误
 */
export function readCall(source: string, atPos: number): CallReadResult {
    // 读取调用名
    let i = atPos + 1;
    while (i < source.length && CALL_NAME_CHAR_RE.test(source[i])) i++;
    const name = source.slice(atPos + 1, i);

    if (!name) return {};  // 没有找到名称,非调用,可能是标签
    if (source[i] !== "(") return {}; // 必须紧接着一个左括号才是调用(因为小括号会作为其他语法)

    // 从左括号开始查找匹配的右括号，同时处理字符串与大括号
    const openPos = i;
    let parenDepth = 1;
    let braceDepth = 0;
    let quote: '"' | null = null;
    let escaped = false;

    // 参数相关
    const args: SourceSpan[] = [];
    let lastCommaPos = openPos + 1;

    for (i++; i < source.length; i++) {
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
            const r = trimRange(source, lastCommaPos, i);
            if (r.start < r.end) args.push(r);
            return {
                call: {
                    name,
                    start: atPos,
                    end: i + 1,
                    argRanges: args,
                }
            };
        } else if (ch === "," && parenDepth === 1 && braceDepth === 0) {
            // 在顶层小括号内遇到逗号，切分参数
            // 计算经 trim 后的参数的位置 即使为空也有位置信息
            args.push(trimRange(source, lastCommaPos, i));
            // 跳过逗号
            lastCommaPos = i + 1;
        }
    }

    // 遍历结束但没有找到匹配右括号 返回致命错误信息
    return {
        fatal: Diagnostic.error.UnterminatedCall(
            name, { start: atPos, end: source.length }
        )
    };
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

export function removeQuote(source: string): string {
    if (
        (source.startsWith('"') && source.endsWith('"')) ||
        (source.startsWith("'") && source.endsWith("'"))
    ) return source.slice(1, -1);
    return source;
}