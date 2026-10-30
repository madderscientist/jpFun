import type { GlyphMetrics, Painter, TextMeasurer, TextStyle } from "./types.js";

/** 未指定字体族时，普通文本使用的字体栈 */
export const DEFAULT_TEXT_FONT = "sans-serif";

/** 简谱数字及同类谱面数字使用的字体栈 */
export const JIANPU_NUMBER_FONT = "'Cascadia Mono', Consolas, 'Liberation Mono', 'Noto Sans Mono', monospace";

/** 富文本样式位掩码：四种内联样式正交叠加，通过异或翻转状态 */
const STYLE_BOLD = 1;
const STYLE_ITALIC = 2;
const STYLE_UNDERLINE = 4;
const STYLE_SUP = 8;

/** 同一行内具有相同样式掩码的连续纯文本片段 */
export interface RichTextRun {
    text: string;
    mask: number;
}

/** 向片段序列末尾追加字符；掩码相同时原地合并 */
export function appendRun(runs: RichTextRun[], text: string, mask: number): void {
    const last = runs.at(-1);
    if (last && last.mask === mask) last.text += text;
    else runs.push({ text, mask });
}

/**
 * 按状态机扫描 `**`、`*`、`_`、`^` 样式开关并逐字符回调 `(ch, mask, escaped)`。
 * 遇到标记即异或切换对应样式位；若未闭合则后续文本（含跨行、跨音符槽）持续保持该样式。
 */
export function scanMarkdown(
    source: string,
    onChar: (ch: string, mask: number, escaped: boolean) => void,
    escapable = "\\*_^",
): void {
    let mask = 0;
    for (let i = 0; i < source.length; i++) {
        const ch = String.fromCodePoint(source.codePointAt(i)!);
        i += ch.length - 1;
        if (ch === "\\" && i + 1 < source.length && escapable.includes(source[i + 1])) {
            onChar(source[++i], mask, true);
            continue;
        }
        if (ch === "*") { mask ^= source[i + 1] === "*" ? (i++, STYLE_BOLD) : STYLE_ITALIC; continue; }
        if (ch === "_") { mask ^= STYLE_UNDERLINE; continue; }
        if (ch === "^") { mask ^= STYLE_SUP; continue; }
        onChar(ch, mask, false);
    }
}

/** 解析多行富文本：单遍跨行扫描样式状态，遇换行切分为每行的片段列表 */
export function parseRichText(source: string): RichTextRun[][] {
    const lines: RichTextRun[][] = [[]];
    scanMarkdown(source, (ch, mask) => {
        if (ch === "\n") lines.push([]);
        else appendRun(lines.at(-1)!, ch, mask);
    });
    return lines;
}

/** 将前一片段与下一片段的样式掩码差值（`prevMask ^ nextMask`）还原为状态切换标记 */
export function markdownToggles(maskDiff: number): string {
    return (maskDiff & STYLE_BOLD ? "**" : "")
        + (maskDiff & STYLE_ITALIC ? "*" : "")
        + (maskDiff & STYLE_UNDERLINE ? "_" : "")
        + (maskDiff & STYLE_SUP ? "^" : "");
}

/** 上标相对基准字号的缩放比例与基线上移比例 */
const SUP_SCALE = 0.7;
const SUP_SHIFT = 0.35;

/** 单行富文本的完整排版结果，供布局与绘制阶段直接复用 */
export interface PreparedRichLine extends GlyphMetrics {
    runs: (RichTextRun & { style: TextStyle; w: number })[];
    style: TextStyle;
}

/**
 * 度量单行富文本（可传原始字符串或已解析片段）并汇总整行尺寸。
 * 行高 h 与 baseline 始终取基准字号（非上标）的度量，避免行内含有上标时导致同行基线错位。
 */
export function prepareRichLine(
    source: string | readonly RichTextRun[],
    baseStyle: TextStyle,
    measurer: TextMeasurer,
): PreparedRichLine {
    const runs: RichTextRun[] = [];
    if (typeof source === "string") scanMarkdown(source, (ch, mask) => appendRun(runs, ch, mask));
    else runs.push(...source);
    let totalW = 0;
    let lineMetrics: GlyphMetrics | undefined;
    const forceLeft = runs.length > 1 && baseStyle.textAlign && baseStyle.textAlign !== "left";
    const preparedRuns = runs.map(run => {
        const style: TextStyle = !forceLeft && (run.mask & (STYLE_BOLD | STYLE_ITALIC | STYLE_SUP)) === 0
            ? baseStyle
            : {
                ...baseStyle,
                ...(forceLeft ? { textAlign: "left" as const } : {}),
                ...(run.mask & STYLE_SUP ? { fontSize: baseStyle.fontSize * SUP_SCALE } : {}),
                ...(run.mask & STYLE_BOLD ? { fontWeight: "bold" } : {}),
                ...(run.mask & STYLE_ITALIC ? { fontStyle: "italic" } : {}),
            };
        const metrics = measurer.measureText(run.text, style);
        if ((run.mask & STYLE_SUP) === 0) lineMetrics ??= metrics;
        totalW += metrics.w;
        return { ...run, style, w: metrics.w };
    });
    lineMetrics ??= measurer.measureText("", baseStyle);
    return {
        runs: preparedRuns,
        style: baseStyle,
        w: runs.length ? totalW : lineMetrics.w,
        h: lineMetrics.h,
        baseline: lineMetrics.baseline,
    };
}

/**
 * 绘制已度量的单行富文本及其下划线装饰。
 * 单片段时保留原 textAlign 直接绘制；多片段时从整行左缘起按段累加推进，
 * 并将同一基线高度上相邻的下划线片段合并为单条连续线段。
 */
export function paintRichLine(
    painter: Painter,
    line: PreparedRichLine,
    x: number,
    baselineY: number,
): void {
    const { runs, style: baseStyle, w } = line;
    const { textAlign } = baseStyle;
    const leftX = textAlign === "center" ? x - w / 2 : textAlign === "right" ? x - w : x;
    const runY = (mask: number) => mask & STYLE_SUP ? baselineY - baseStyle.fontSize * SUP_SHIFT : baselineY;

    let cursorX = leftX;
    for (const run of runs) {
        painter.drawText(run.text, runs.length === 1 ? x : cursorX, runY(run.mask), run.style);
        cursorX += run.w;
    }

    // Canvas 2D 原生不支持 text-decoration，统一用 drawLine 绘制下划线以保证 SVG/Canvas 一致
    for (let i = 0, cursor = leftX; i < runs.length;) {
        const { mask, style, w: runW } = runs[i++];
        if (!(mask & STYLE_UNDERLINE)) { cursor += runW; continue; }
        let endX = cursor + runW;
        while (i < runs.length && (runs[i].mask & (STYLE_UNDERLINE | STYLE_SUP)) === (mask & (STYLE_UNDERLINE | STYLE_SUP))) {
            endX += runs[i++].w;
        }
        const y = runY(mask) + style.fontSize * 0.12;
        painter.drawLine(cursor, y, endX, y, {
            stroke: baseStyle.fill ?? "#000",
            strokeWidth: Math.max(1, style.fontSize * 0.06),
        });
        cursor = endX;
    }
}

/** Canvas 的 font 简写；测量与绘制必须用同一份，否则量到的不是将要画出的字形 */
export function canvasFont(style: TextStyle): string {
    const slant = style.fontStyle ? `${style.fontStyle} ` : "";
    return `${slant}${style.fontWeight ?? "normal"} ${style.fontSize}px ${style.fontFamily ?? DEFAULT_TEXT_FONT}`;
}

/** 默认文本测量保持确定性，不依赖浏览器和操作系统字体。 */
export class DefaultTextMeasurer implements TextMeasurer {
    measureText(text: string, style: TextStyle): GlyphMetrics {
        const size = style.fontSize;
        const monospaced = style.fontFamily?.toLowerCase().includes("mono") ?? false;
        let units = 0;

        for (const char of text) {
            units += char.charCodeAt(0) > 0x7f ? 1 : monospaced ? 0.62 : 0.58;
        }

        return {
            w: Math.max(units * size, size * 0.25),
            h: size,
            baseline: size * 0.8,
        };
    }
}

export const defaultTextMeasurer = new DefaultTextMeasurer();

/**
 * 用宿主的 Canvas 字体度量文本，使排版盒与实际绘制的字形一致。
 *
 * 只有宽度取真实值：h/baseline 保持 em 盒约定，换成真实字体盒会让行距和分页依赖平台字体。
 */
export class CanvasTextMeasurer implements TextMeasurer {
    private readonly widths = new Map<string, number>();

    constructor(private readonly context: CanvasRenderingContext2D) { }

    /**
     * 字体名称不变但实际资源变化时调用，例如 Web 字体加载完成后，旧缓存仍是回退字体的宽度。
     * 清理后宿主需重新编译、布局和绘制；切换字体族、字号、字重或斜体无需清理，它们已包含在缓存键中。
     */
    clearCache(): void {
        this.widths.clear();
    }

    measureText(text: string, style: TextStyle): GlyphMetrics {
        const font = canvasFont(style);
        const key = `${font}\u0000${text}`;
        let width = this.widths.get(key);
        if (width === undefined) {
            this.context.font = font;
            width = this.context.measureText(text).width;
            this.widths.set(key, width);
        }
        return {
            w: Math.max(width, style.fontSize * 0.25),
            h: style.fontSize,
            baseline: style.fontSize * 0.8,
        };
    }
}