/**
 * 预处理模块：
 * - 目标1：处理 `%` 行注释（直到换行），但不影响字符串中的 `%`
 * - 目标2：输出 lineStarts，供诊断信息把一维 offset 转为 行/列
 * - 目标3：保持索引稳定：注释内容替换为空格，长度不变，换行保留
 *
 * 设计约束：
 * - 尽量单次扫描（O(n)）
 * - 尽量少分配：不逐字符拼接字符串，而是按“原文片段 + 空格片段”组装
 */
const CHAR_LF = 10;
const CHAR_CR = 13;
const CHAR_QUOTE_SINGLE = 39;
const CHAR_QUOTE_DOUBLE = 34;
const CHAR_BACKSLASH = 92;
const CHAR_PERCENT = 37;

/**
 * 返回指定长度的空格字符串。
 *
 * 由于注释替换会频繁创建空格串，直接 `repeat` 会产生大量临时对象。
 * 使用长度 -> 字符串缓存，可以显著减少重复分配。
 */
const SPACE_CACHE = new Map<number, string>();
function getSpaces(length: number): string {
    let cached = SPACE_CACHE.get(length);
    if (cached === undefined) {
        cached = " ".repeat(length);
        SPACE_CACHE.set(length, cached);
    }
    return cached;
}

/**
 * 对源码做“注释掩码 + 行起点提取”。
 *
 * 返回值：
 * - maskedSource：注释内容被等长空格替换后的文本
 * - lineStarts：每一行起始 offset（第1行固定为0）
 *
 * 关键行为：
 * - `%` 仅在“非字符串上下文”触发注释
 * - 注释范围是 `%` 到换行前（`\n` 或 `\r\n`）
 * - `\r\n` 会被识别为一次换行，lineStarts 记录下一位置
 * - 若整段源码没有注释，直接返回原字符串，避免不必要的 join
 */
export function preprocessSource(source: string): { maskedSource: string; lineStarts: number[] } {
    // lineStarts[0]=0 表示第一行从 offset 0 开始
    const lineStarts: number[] = [0];
    // 按片段组装，避免逐字符拼接
    const chunks: string[] = [];

    // 上一个尚未拷贝进 chunks 的起始位置
    let lastCopyStart = 0;
    // 当前是否在字符串内（0=不在，其他值为当前引号字符编码）
    let inQuote: number = 0;
    // 字符串内转义状态，仅在 inQuote!=0 时有意义
    let escaped = false;
    // 是否出现过注释；没有注释时可直接返回原字符串
    let hasComment = false;

    // i 手动推进，便于统一处理 CRLF / 注释扫描
    for (let i = 0; i < source.length;) {
        const ch = source.charCodeAt(i);
        // 统一处理换行，同时构建 lineStarts
        if (ch === CHAR_CR) {
            if (i + 1 < source.length && source.charCodeAt(i + 1) === CHAR_LF) {
                // Windows 换行：\r\n 视作一个换行点
                lineStarts.push(i += 2);
                if (escaped) escaped = false;
            } else {
                // 兼容单独 \r
                lineStarts.push(i += 1);
                if (escaped) escaped = false;
            }
            continue;
        }
        if (ch === CHAR_LF) {
            // Unix 换行：\n
            lineStarts.push(i += 1);
            if (escaped) escaped = false;
            continue;
        }

        // 字符串内部：只处理转义与闭合，不识别注释
        if (inQuote !== 0) {
            if (escaped) escaped = false;
            else if (ch === CHAR_BACKSLASH) escaped = true;
            else if (ch === inQuote) inQuote = 0;
            i++; continue;
        }

        // 进入字符串（支持单引号与双引号）
        if (ch === CHAR_QUOTE_SINGLE || ch === CHAR_QUOTE_DOUBLE) {
            inQuote = ch;
            i++; continue;
        }

        // 非字符串上下文下，遇到 % 进入注释模式
        if (ch === CHAR_PERCENT) {
            hasComment = true;
            // 先把注释前的原文片段入栈
            if (lastCopyStart < i) chunks.push(source.slice(lastCopyStart, i));
            const commentStart = i++;
            // 注释吃到行尾（不包含换行）
            while (i < source.length) {
                const c = source.charCodeAt(i);
                if (c === CHAR_CR || c === CHAR_LF) break;
                i++;
            }
            // 用等长空格替换注释文本，确保后续 offset 全部稳定
            chunks.push(getSpaces(i - commentStart));
            // 下一段原文从当前 i 继续
            lastCopyStart = i;
            continue;
        } i++;
    }
    // 无注释则直接返回原文，避免一次 join 成本
    if (!hasComment) return { maskedSource: source, lineStarts };
    // 收尾：补上最后一段未入栈原文
    if (lastCopyStart < source.length) chunks.push(source.slice(lastCopyStart));
    // 将“原文片段 + 空格片段”拼接成最终掩码文本
    return { maskedSource: chunks.join(""), lineStarts };
}
