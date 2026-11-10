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
            i = findClosingQuote(source, i, end);
            if (i < 0) break;
        } else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) return i;
    } return -1;
}