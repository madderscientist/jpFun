import type { SourceSpan } from "./types.js";
import { findClosingQuote } from "./parse-utils/string-utils.js";

/**
 * 预处理核心模块（单次扫描）：
 * 1. 构建 lineStarts（用于 offset -> 行列映射）
 * 2. 处理 `%` 行注释：仅在非字符串上下文触发，注释文本等长替换为空格；引号必须配对才算字符串
 * 3. 处理行尾连续反斜杠：
 *    - 设行尾连续 `\` 个数为 n；
 *    - 第 1/3/5... 个 `\` 替换为空格，第 2/4/6... 个保留；
 *    - 若 n 为奇数，则该行换行符也替换为空格（续行）
 */
const CHAR_LF = 10;
const CHAR_CR = 13;
const CHAR_TAB = 9;
const CHAR_VTAB = 11;
const CHAR_FF = 12;
const CHAR_SPACE = 32;
const CHAR_NBSP = 160;
const CHAR_OGHAM_SPACE_MARK = 5760;
const CHAR_NARROW_NO_BREAK_SPACE = 8239;
const CHAR_MEDIUM_MATHEMATICAL_SPACE = 8287;
const CHAR_IDEOGRAPHIC_SPACE = 12288;
const CHAR_BOM = 65279;
const CHAR_QUOTE_DOUBLE = 34;
const CHAR_BACKSLASH = 92;
const CHAR_PERCENT = 37;

// 掩码几乎都是短注释和续行反斜杠，长的既少重复又要一直占着内存，所以只缓存短的
const MAX_CACHED_SPACES = 32;
const SHORT_SPACES: string[] = [];
function getSpaces(length: number): string {
    if (length > MAX_CACHED_SPACES) return " ".repeat(length);
    return SHORT_SPACES[length] ??= " ".repeat(length);
}

/**
 * 判断 非换行空白
 * 说明：CR/LF 由主循环单独处理，这里只负责可被“行尾回看”忽略的空白
 */
function isNonLineWhitespace(ch: number): boolean {
    // 热路径优先处理 ASCII
    if (ch === CHAR_SPACE || ch === CHAR_TAB || ch === CHAR_VTAB || ch === CHAR_FF) return true;
    if (ch < 128) return false;
    return (
        ch === CHAR_NBSP ||
        ch === CHAR_OGHAM_SPACE_MARK ||
        (ch >= 8192 && ch <= 8202) ||
        ch === CHAR_NARROW_NO_BREAK_SPACE ||
        ch === CHAR_MEDIUM_MATHEMATICAL_SPACE ||
        ch === CHAR_IDEOGRAPHIC_SPACE ||
        ch === CHAR_BOM
    );
}

export function preprocessSource(source: string): {
    maskedSource: string;
    lineStarts: number[];
    commentSpans: SourceSpan[];
} {
    const sourceLength: number = source.length;
    const lineStarts: number[] = [0];
    const commentSpans: SourceSpan[] = [];

    // 扁平区间表：[start0, end0, start1, end1, ...]
    // 约束：按起点递增写入；相邻/重叠区间会就地合并，减少后续 chunks 数量
    const replaceRanges: number[] = [];
    const pushReplaceRange = (start: number, end: number): void => {
        if (start >= end) return;
        const n = replaceRanges.length;
        if (n >= 2 && start <= replaceRanges[n - 1]) {
            if (end > replaceRanges[n - 1]) replaceRanges[n - 1] = end;
            return;
        }
        replaceRanges.push(start, end);
    };

    const pushTailBackslashMask = (runStart: number, runCount: number): void => {
        if (runCount <= 0) return;
        const runEnd = runStart + runCount;
        for (let p = runStart; p < runEnd; p += 2) pushReplaceRange(p, p + 1);
    };

    /**
     * 扫描状态说明：
     * - inQuote：0=不在字符串；其他值为当前引号字符码
     * - escaped：仅在字符串内有效，表示上一个字符是 `\`
     * - pendingCommentStart：>=0 表示已遇到 `%`，等待到行尾/EOF 收口注释
     * - lastSignificantIndex：当前行最后一个“非换行空白”字符位置
     * - tailBackslashRunStart/tailBackslashRunCount：
     *   当前行末尾候选连续 `\` 片段（允许后面跟空白），用于换行处一次性判定
     */
    let inQuote: number = 0;
    let noPairedQuoteAfter: boolean = false;
    let escaped: boolean = false;
    let pendingCommentStart: number = -1;
    let lastSignificantIndex: number = -1;
    let tailBackslashRunStart: number = -1;
    let tailBackslashRunCount: number = 0;

    const updateLineTailState = (index: number, ch: number): void => {
        if (ch === CHAR_BACKSLASH) {
            if (tailBackslashRunCount > 0 && lastSignificantIndex + 1 === index) tailBackslashRunCount++;
            else {
                tailBackslashRunStart = index;
                tailBackslashRunCount = 1;
            }
            lastSignificantIndex = index;
            return;
        }
        tailBackslashRunStart = -1;
        tailBackslashRunCount = 0;
        lastSignificantIndex = index;
    };

    for (let i = 0; i < sourceLength;) {
        const ch = source.charCodeAt(i);

        // 换行是行内规则的结算点：先处理行尾 `\`，再收口注释，最后决定是否吃换行
        if (ch === CHAR_CR || ch === CHAR_LF) {
            const newlineWidth = ch === CHAR_CR && i + 1 < sourceLength && source.charCodeAt(i + 1) === CHAR_LF ? 2 : 1;
            lineStarts.push(i + newlineWidth);

            // 顺序必须保证区间起点递增：行尾反斜杠 < 注释 < 换行
            const isOddBackslashRun = (tailBackslashRunCount & 1) === 1;
            pushTailBackslashMask(tailBackslashRunStart, tailBackslashRunCount);
            if (pendingCommentStart >= 0) {
                pushReplaceRange(pendingCommentStart, i);
                commentSpans.push({ start: pendingCommentStart, end: i });
                pendingCommentStart = -1;
            }
            if (isOddBackslashRun) pushReplaceRange(i, i + newlineWidth);

            // 新行重置行内状态
            lastSignificantIndex = -1;
            tailBackslashRunStart = -1;
            tailBackslashRunCount = 0;
            escaped = false;
            i += newlineWidth;
            continue;
        }

        // 字符串内仅处理转义与闭合；不识别注释
        if (inQuote !== 0) {
            if (escaped) escaped = false;
            else if (ch === CHAR_BACKSLASH) escaped = true;
            else if (ch === inQuote) inQuote = 0;

            if (!isNonLineWhitespace(ch)) updateLineTailState(i, ch);
            i++;
            continue;
        }

        if (ch === CHAR_QUOTE_DOUBLE) {
            // 配对才算字符串，否则一个孤立引号会让后文的 `%` 全部失去注释语义
            // 一次前瞻失败即证明剩余源码里没有可配对的引号，置位后不再前瞻，整体仍是 O(n)
            if (!noPairedQuoteAfter) {
                if (findClosingQuote(source, i, sourceLength) < 0) noPairedQuoteAfter = true;
                else inQuote = ch;
            }
            updateLineTailState(i, ch);
            i++;
            continue;
        }

        // 非字符串上下文下，`%` 到行尾是注释；直接跳到换行，减少无效判断
        if (ch === CHAR_PERCENT) {
            pendingCommentStart = i;
            i++;
            while (i < sourceLength) {
                const c = source.charCodeAt(i);
                if (c === CHAR_CR || c === CHAR_LF) break;
                i++;
            }
            continue;
        }

        if (!isNonLineWhitespace(ch)) updateLineTailState(i, ch);
        i++;
    }

    // EOF 边界：
    // - 注释若未收口，收到文件末尾
    // - 行尾连续 `\` 即使没有换行，也执行“隔位空格化”规则（无续行替换）
    pushTailBackslashMask(tailBackslashRunStart, tailBackslashRunCount);
    if (pendingCommentStart >= 0) {
        pushReplaceRange(pendingCommentStart, sourceLength);
        commentSpans.push({ start: pendingCommentStart, end: sourceLength });
    }

    // 无替换快路径：直接复用原字符串
    if (replaceRanges.length === 0) return { maskedSource: source, lineStarts, commentSpans };

    // 分段组装，避免 O(n^2) 拼接
    const chunks: string[] = [];
    let lastCopyStart = 0;
    for (let i = 0; i < replaceRanges.length; i += 2) {
        const start = replaceRanges[i];
        const end = replaceRanges[i + 1];
        if (lastCopyStart < start) chunks.push(source.slice(lastCopyStart, start));
        chunks.push(getSpaces(end - start));
        lastCopyStart = end;
    }
    if (lastCopyStart < sourceLength) chunks.push(source.slice(lastCopyStart));

    return { maskedSource: chunks.join(""), lineStarts, commentSpans };
}
