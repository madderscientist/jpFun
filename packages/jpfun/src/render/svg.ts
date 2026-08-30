import type { DocumentLayoutResult } from "../layout/engine.js";
import { layoutPageBounds, paintLayoutPages } from "./paint.js";
import { DEFAULT_TEXT_FONT } from "./text.js";
import type { PaintStyle, Painter, PathCommand, PathTransform, TextStyle } from "./types.js";

export interface SvgRenderOptions {
    padding?: number;       // viewBox 四周额外保留的空间
    background?: string;    // 可选背景颜色，默认透明
}

function number(value: number): string {
    if (!Number.isFinite(value)) return "0";
    return String(Math.round(value * 1000) / 1000);
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/**
 * 把结构化路径命令转换为 SVG path data
 * 可选缩放和平移用于直接生成最终坐标
 */
function pathCommandsToSvg(
    commands: readonly PathCommand[],
    transform?: PathTransform,
): string {
    const parts: string[] = [];
    const x = transform
        ? (value: number) => number(transform.x + value * transform.scaleX)
        : number;
    const y = transform
        ? (value: number) => number(transform.y + value * transform.scaleY)
        : number;

    for (const command of commands) {
        if (command.op === "Z") {
            parts.push("Z");
            continue;
        }

        if (command.op === "M" || command.op === "L") {
            parts.push(`${command.op}${x(command.x)} ${y(command.y)}`);
            continue;
        }

        if (command.op === "Q") {
            parts.push(
                `Q${x(command.cx)} ${y(command.cy)} `
                + `${x(command.x)} ${y(command.y)}`,
            );
            continue;
        }

        if (!("cx1" in command)) continue;
        parts.push(
            `C${x(command.cx1)} ${y(command.cy1)} `
            + `${x(command.cx2)} ${y(command.cy2)} `
            + `${x(command.x)} ${y(command.y)}`,
        );
    }

    return parts.join(" ");
}

function opacityAttribute(style?: PaintStyle): string {
    if (style?.opacity === void 0) return "";
    return ` opacity="${number(style.opacity)}"`;
}

/** 生成独立 SVG 字符串的 Painter；路径直接输出最终坐标 */
export class SvgPainter implements Painter {
    private body: string[] = [];

    drawText(text: string, x: number, y: number, style: TextStyle) {
        const family = style.fontFamily ?? DEFAULT_TEXT_FONT;
        const weight = style.fontWeight ?? "normal";
        const fill = style.fill ?? "#000";
        const textAnchor = style.textAlign === "center"
            ? "middle"
            : style.textAlign === "right" ? "end" : "start";
        this.body.push(
            `<text x="${number(x)}" y="${number(y)}" `
            + `font-family="${escapeXml(family)}" font-size="${number(style.fontSize)}" `
            + `font-weight="${escapeXml(String(weight))}" text-anchor="${textAnchor}" `
            + `fill="${escapeXml(fill)}" xml:space="preserve"`
            + `${opacityAttribute(style)}>${escapeXml(text)}</text>`,
        );
    }

    drawLine(x1: number, y1: number, x2: number, y2: number, style?: PaintStyle) {
        const stroke = style?.stroke ?? style?.fill ?? "#000";
        const strokeWidth = style?.strokeWidth ?? 1;
        this.body.push(
            `<line x1="${number(x1)}" y1="${number(y1)}" `
            + `x2="${number(x2)}" y2="${number(y2)}" `
            + `stroke="${escapeXml(stroke)}" stroke-width="${number(strokeWidth)}" stroke-linecap="round"`
            + `${opacityAttribute(style)} />`,
        );
    }

    drawRect(x: number, y: number, w: number, h: number, style?: PaintStyle) {
        const fill = style?.fill ?? "none";
        const stroke = style?.stroke ?? "none";
        const strokeWidth = style?.strokeWidth ?? 1;
        this.body.push(
            `<rect x="${number(x)}" y="${number(y)}" `
            + `width="${number(Math.max(0, w))}" height="${number(Math.max(0, h))}" `
            + `fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${number(strokeWidth)}"`
            + `${opacityAttribute(style)} />`,
        );
    }

    drawCircle(cx: number, cy: number, r: number, style?: PaintStyle) {
        const fill = style?.fill ?? "#000";
        const stroke = style?.stroke ?? "none";
        const strokeWidth = style?.strokeWidth ?? 1;
        this.body.push(
            `<circle cx="${number(cx)}" cy="${number(cy)}" `
            + `r="${number(Math.max(0, r))}" fill="${escapeXml(fill)}" `
            + `stroke="${escapeXml(stroke)}" stroke-width="${number(strokeWidth)}"`
            + `${opacityAttribute(style)} />`,
        );
    }

    drawPath(commands: readonly PathCommand[], style?: PaintStyle, transform?: PathTransform) {
        if (commands.length === 0) return;

        const d = pathCommandsToSvg(commands, transform);
        const fill = style?.fill ?? "none";
        const stroke = style?.stroke ?? "none";
        const strokeWidth = style?.strokeWidth ?? 1;
        this.body.push(
            `<path d="${d}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" `
            + `stroke-width="${number(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"`
            + `${opacityAttribute(style)} />`,
        );
    }

    toSvg(
        bounds: DocumentLayoutResult["bounds"],
        options: SvgRenderOptions = {},
    ): string {
        const padding = Math.max(0, options.padding ?? 0);
        const left = bounds.x - padding;
        const top = bounds.y - padding;
        const width = Math.max(1, bounds.w + padding * 2);
        const height = Math.max(1, bounds.h + padding * 2);
        const background = options.background
            ? `<rect x="${number(left)}" y="${number(top)}" width="${number(width)}" height="${number(height)}" fill="${escapeXml(options.background)}" />`
            : "";

        return `<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}" height="${number(height)}" `
            + `viewBox="${number(left)} ${number(top)} ${number(width)} ${number(height)}">`
            + `${background}${this.body.join("")}</svg>`;
    }
}

/** 使用 SVG 后端把一个布局结果绘制成独立页面 */
export function renderLayoutPagesToSvg(
    result: DocumentLayoutResult,
    options: SvgRenderOptions = {},
): string[] {
    const bounds = layoutPageBounds(result);
    const painters = bounds.map(() => new SvgPainter());
    paintLayoutPages(result, painters);
    return painters.map((painter, index) => painter.toSvg(bounds[index], options));
}