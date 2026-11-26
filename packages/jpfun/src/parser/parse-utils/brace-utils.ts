import { findClosingQuote } from "./string-utils.js";

// 找到 } 的位置
export function readBrace(
    source: string,
    lBracePos: number,
    end: number,
): number {
    // 要求 source[lBracePos]==='{'（外部检验）
    let depth = 1;
    for (let i = lBracePos + 1; i < end; i++) {
        const ch = source[i];
        if (ch === '"') {
            // 孤立引号按普通字符，与预处理“配对才算字符串”一致
            const q = findClosingQuote(source, i, end);
            if (q >= 0) i = q;
        } else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) return i;
    } return -1;
}