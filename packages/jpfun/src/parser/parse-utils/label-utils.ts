// 标签停止: 遇到 { } ( ) , 空白
const LABEL_STOP_RE = /\s|\(|\)|\{|\}|,/;

export function readLabel(source: string, at: number, end: number): { label: string; next: number } | null {
    // 标签必须以@开头 由外部检验
    // if (at >= end || source[at] !== "@") return null;
    let i = at + 1;
    // 寻找标签末尾
    while (i < end && !LABEL_STOP_RE.test(source[i])) i++;
    // 标签不能为空
    if (i <= at + 1) return null;
    return {
        label: source.slice(at + 1, i),
        next: i,
    };
}