// 找到 } 的位置
export function readBrace(
    source: string,
    lBracePos: number,
    end: number,
): number {
    // 要求 source[lBracePos]==='{'（外部检验）
    let depth = 1;
    let quote: "'" | "\"" | null = null;
    let escaped = false;
    for (let i = lBracePos + 1; i < end; i++) {
        const ch = source[i];
        if (quote) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === "\"" || ch === "'") quote = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return i;
        }
    } return -1;
}