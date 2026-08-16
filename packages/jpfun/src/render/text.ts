import type { GlyphMetrics, TextMeasurer, TextStyle } from "./types.js";

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