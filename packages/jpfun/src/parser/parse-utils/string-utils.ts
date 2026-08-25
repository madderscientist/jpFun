/**
 * 字符串字面量的唯一规则来源：预处理、`@text` 糖、`L:` 歌词糖共用
 * 扫描与反转义必须互为镜像，否则会出现“扫得对、还原错”
 */

/** 找与 quotePos 处开引号配对的闭引号；找不到返回 -1 */
export function findClosingQuote(source: string, quotePos: number, end: number): number {
    for (let i = quotePos + 1; i < end; i++) {
        if (source[i] === "\\") i++;
        else if (source[i] === '"') return i;
    } return -1;
}

/** 剥掉成对的双引号并反转义 `\X` -> `X`；裸参数没走转义扫描，原样返回 */
export function removeQuote(source: string): string {
    if (source.length < 2 || !source.startsWith('"') || !source.endsWith('"')) return source;
    return source.slice(1, -1).replace(/\\(.)/gs, "$1");
}
