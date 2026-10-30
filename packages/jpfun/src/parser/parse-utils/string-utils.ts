/**
 * 字符串字面量的唯一规则来源：预处理、`@text` 糖、`L:` 歌词糖共用
 * 扫描与反转义必须互为镜像，否则会出现“扫得对、还原错”
 */
import { Diagnostic } from "../../diagnostic.js";

/** 找与 quotePos 处开引号配对的闭引号；找不到返回 -1 */
export function findClosingQuote(source: string, quotePos: number, end: number): number {
    for (let i = quotePos + 1; i < end; i++) {
        if (source[i] === "\\") i++;
        else if (source[i] === '"') return i;
    } return -1;
}

/** 剥掉成对的双引号（若有）并解码编码/定界级转义（`\"`、`\\`、`\uXXXX`）；其余 `\X` 原样保留给具体函数解析 */
export function parseString(source: string): string | Diagnostic {
    const quoted = source.length >= 2 && source.startsWith('"') && source.endsWith('"');
    const raw = quoted ? source.slice(1, -1) : source;
    let diagnostic: Diagnostic | undefined;
    // 连同不完整转义一起匹配以便诊断；替换结果不会被再次扫描
    const text = raw.replace(/\\(u.{0,4}|.)/gs, (escape, body: string, offset: number) => {
        if (body === '"' || body === "\\") return body;
        if (body[0] !== "u") return escape;
        if (!/^u[0-9a-f]{4}$/i.test(body)) {
            const start = offset + (quoted ? 1 : 0);
            diagnostic ??= Diagnostic.warning.InvalidUnicodeEscape({ start, end: start + escape.length });
            return escape;
        }
        return String.fromCharCode(Number.parseInt(body.slice(1), 16));
    });
    return diagnostic ?? text;
}

/** 生成双引号包裹的 jpFun 源码，仅转义反斜杠和双引号；与 JSON.stringify 不同，保留真实换行和制表符 */
export function quote(value: string) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}