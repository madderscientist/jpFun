import type { DocumentLayoutResult } from "../layout/engine.js";
import { layoutPageBounds, paintLayoutPages } from "./paint.js";
import { DEFAULT_TEXT_FONT, JIANPU_NUMBER_FONT } from "./text.js";
import type { PaintGroup, PaintStyle, Painter, PathCommand, PathTransform, TextStyle } from "./types.js";

export interface SvgRenderOptions {
    background?: string;    // 可选背景颜色，默认透明
}

function number(value: number): string {
    if (!Number.isFinite(value)) return "0";
    return String(Math.round(value * 1000) / 1000);
}

const XML_SPECIAL_CHARS = /[&<>"]/;

function escapeXml(value: string): string {
    if (!XML_SPECIAL_CHARS.test(value)) return value;
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

const DEFAULT_SVG_FONT_ATTR = escapeXml(JIANPU_NUMBER_FONT);

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

/** 生成独立 SVG 字符串的 Painter；路径直接输出最终坐标 */
export class SvgPainter implements Painter {
    private body: string[] = [];
    /** 未结束分组的开标签在 body 中的下标 */
    private groupStarts: number[] = [];

    beginGroup(group: PaintGroup) {
        this.groupStarts.push(this.body.length);
        this.body.push(`<g data-kind="${escapeXml(group.kind)}">`);
    }

    endGroup() {
        const start = this.groupStarts.pop();
        if (start === undefined) return;
        // 组内没有图元时连开标签一起删掉，内层空组已先被删除
        if (this.body.length === start + 1) this.body.pop();
        else this.body.push("</g>");
    }

    drawText(text: string, x: number, y: number, style: TextStyle) {
        const family = style.fontFamily ?? DEFAULT_TEXT_FONT;
        const weight = style.fontWeight ?? "normal";
        const fill = style.fill ?? "#000";
        const textAnchor = style.textAlign === "center"
            ? "middle"
            : style.textAlign === "right" ? "end" : "start";
        this.body.push(
            `<text x="${number(x)}" y="${number(y)}"`
            + (family !== JIANPU_NUMBER_FONT ? ` font-family="${escapeXml(family)}"` : "")
            + ` font-size="${number(style.fontSize)}"`
            + (weight !== "normal" ? ` font-weight="${escapeXml(String(weight))}"` : "")
            + (textAnchor !== "start" ? ` text-anchor="${textAnchor}"` : "")
            + (style.fontStyle && style.fontStyle !== "normal" ? ` font-style="${escapeXml(style.fontStyle)}"` : "")
            + (fill !== "#000" ? ` fill="${escapeXml(fill)}"` : "")
            + (/\s/.test(text) ? ` xml:space="preserve"` : "")
            + `>${escapeXml(text)}</text>`,
        );
    }

    drawLine(x1: number, y1: number, x2: number, y2: number, style?: PaintStyle) {
        const stroke = style?.stroke ?? style?.fill ?? "#000";
        const strokeWidth = style?.strokeWidth ?? 1;
        this.body.push(
            `<line x1="${number(x1)}" y1="${number(y1)}" `
            + `x2="${number(x2)}" y2="${number(y2)}" `
            + `stroke="${escapeXml(stroke)}" stroke-width="${number(strokeWidth)}" stroke-linecap="round" />`,
        );
    }

    drawRect(x: number, y: number, w: number, h: number, style?: PaintStyle) {
        const fill = style?.fill ?? "none";
        const stroke = style?.stroke ?? "none";
        const strokeWidth = style?.strokeWidth ?? 1;
        this.body.push(
            `<rect x="${number(x)}" y="${number(y)}" `
            + `width="${number(Math.max(0, w))}" height="${number(Math.max(0, h))}"`
            + (fill !== "#000" ? ` fill="${escapeXml(fill)}"` : "")
            + (stroke !== "none" ? ` stroke="${escapeXml(stroke)}" stroke-width="${number(strokeWidth)}"` : "")
            + ` />`,
        );
    }

    drawCircle(cx: number, cy: number, r: number, style?: PaintStyle) {
        const fill = style?.fill ?? "#000";
        const stroke = style?.stroke ?? "none";
        const strokeWidth = style?.strokeWidth ?? 1;
        this.body.push(
            `<circle cx="${number(cx)}" cy="${number(cy)}" `
            + `r="${number(Math.max(0, r))}"`
            + (fill !== "#000" ? ` fill="${escapeXml(fill)}"` : "")
            + (stroke !== "none" ? ` stroke="${escapeXml(stroke)}" stroke-width="${number(strokeWidth)}"` : "")
            + ` />`,
        );
    }

    drawPath(commands: readonly PathCommand[], style?: PaintStyle, transform?: PathTransform) {
        if (commands.length === 0) return;

        const d = pathCommandsToSvg(commands, transform);
        const fill = style?.fill ?? "none";
        const stroke = style?.stroke ?? "none";
        const strokeWidth = style?.strokeWidth ?? 1;
        this.body.push(
            `<path d="${d}"`
            + (fill !== "#000" ? ` fill="${escapeXml(fill)}"` : "")
            + (stroke !== "none"
                ? ` stroke="${escapeXml(stroke)}" stroke-width="${number(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"`
                : "")
            + ` />`,
        );
    }

    toSvg(
        bounds: DocumentLayoutResult["bounds"],
        options: SvgRenderOptions = {},
    ): string {
        const left = bounds.x;
        const top = bounds.y;
        const width = Math.max(1, bounds.w);
        const height = Math.max(1, bounds.h);
        const background = options.background
            ? `<rect x="${number(left)}" y="${number(top)}" width="${number(width)}" height="${number(height)}" fill="${escapeXml(options.background)}" />`
            : "";

        return `<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}" height="${number(height)}" `
            + `viewBox="${number(left)} ${number(top)} ${number(width)} ${number(height)}" `
            + `font-family="${DEFAULT_SVG_FONT_ATTR}" font-weight="normal" fill="#000">`
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