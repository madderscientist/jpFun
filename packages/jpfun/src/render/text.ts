import type { GlyphMetrics, TextMeasurer, TextStyle } from "./types.js";

/** 未指定字体族时，普通文本使用的字体栈 */
export const DEFAULT_TEXT_FONT = "sans-serif";

/** 简谱数字及同类谱面数字使用的字体栈 */
export const JIANPU_NUMBER_FONT = '"Cascadia Mono", Consolas, "Liberation Mono", "Noto Sans Mono", monospace';

/** Canvas 的 font 简写；测量与绘制必须用同一份，否则量到的不是将要画出的字形 */
export function canvasFont(style: TextStyle): string {
    return `${style.fontWeight ?? "normal"} ${style.fontSize}px ${style.fontFamily ?? DEFAULT_TEXT_FONT}`;
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