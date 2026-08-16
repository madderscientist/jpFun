import { paintLayout, type DocumentLayoutResult } from "../layout/engine.js";
import type { PaintStyle, Painter, PathCommand, PathTransform, TextStyle } from "./types.js";

export interface SvgRenderOptions {
    padding?: number;       // viewBox 四周额外保留的空间
    background?: string;    // 可选背景颜色，默认透明
    idPrefix?: string;      // symbol id 前缀，用于同一页面放置多份 SVG
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

function safeId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * 把结构化路径命令转换为 SVG path data
 * symbol 定义保持 0 到 1 的局部坐标
 */
function pathCommandsToSvg(
    commands: readonly PathCommand[],
): string {
    const parts: string[] = [];

    for (const command of commands) {
        if (command.op === "Z") {
            parts.push("Z");
            continue;
        }

        if (command.op === "M" || command.op === "L") {
            parts.push(`${command.op}${number(command.x)} ${number(command.y)}`);
            continue;
        }

        if (command.op === "Q") {
            parts.push(
                `Q${number(command.cx)} ${number(command.cy)} `
                + `${number(command.x)} ${number(command.y)}`,
            );
            continue;
        }

        if (!("cx1" in command)) continue;
        parts.push(
            `C${number(command.cx1)} ${number(command.cy1)} `
            + `${number(command.cx2)} ${number(command.cy2)} `
            + `${number(command.x)} ${number(command.y)}`,
        );
    }

    return parts.join(" ");
}

function opacityAttribute(style?: PaintStyle): string {
    if (style?.opacity === void 0) return "";
    return ` opacity="${number(style.opacity)}"`;
}

/**
 * 生成独立 SVG 字符串的 Painter
 *
 * 带 transform 的局部路径会在 defs 中定义一次
 * 每个绘制位置只追加一个 use 元素；动态绝对路径仍直接输出 path
 */
export class SvgPainter implements Painter {
    private body: string[] = [];
    private definitions = new Map<string, { id: string; svg: string }>();
    private idPrefix: string;

    constructor(idPrefix: string = "jpfun") {
        this.idPrefix = safeId(idPrefix) || "jpfun";
    }

    drawText(text: string, x: number, y: number, style: TextStyle) {
        const family = style.fontFamily ?? "sans-serif";
        const weight = style.fontWeight ?? "normal";
        const fill = style.fill ?? "#000";
        const textAnchor = style.textAlign === "center"
            ? "middle"
            : style.textAlign === "right" ? "end" : "start";
        this.body.push(
            `<text x="${number(x)}" y="${number(y)}" `
            + `font-family="${escapeXml(family)}" font-size="${number(style.fontSize)}" `
            + `font-weight="${escapeXml(String(weight))}" text-anchor="${textAnchor}" `
            + `fill="${escapeXml(fill)}"`
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

        const d = pathCommandsToSvg(commands);
        const fill = style?.fill ?? "none";
        const stroke = style?.stroke ?? "none";
        const strokeWidth = style?.strokeWidth ?? 1;

        if (transform) {
            const pathId = this.ensurePathDefinition(d);
            this.body.push(
                `<use href="#${pathId}" `
                + `transform="translate(${number(transform.x)} ${number(transform.y)}) `
                + `scale(${number(transform.scaleX)} ${number(transform.scaleY)})" `
                + `fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" `
                + `stroke-width="${number(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" `
                + `vector-effect="non-scaling-stroke"${opacityAttribute(style)} />`,
            );
            return;
        }

        this.body.push(
            `<path d="${d}" `
            + `fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" `
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
        const defs = [...this.definitions.values()].map(definition => definition.svg).join("");
        const background = options.background
            ? `<rect x="${number(left)}" y="${number(top)}" width="${number(width)}" height="${number(height)}" fill="${escapeXml(options.background)}" />`
            : "";

        return `<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}" height="${number(height)}" `
            + `viewBox="${number(left)} ${number(top)} ${number(width)} ${number(height)}">`
            + `<defs>${defs}</defs>${background}${this.body.join("")}</svg>`;
    }

    private ensurePathDefinition(d: string): string {
        const existing = this.definitions.get(d);
        if (existing) return existing.id;

        const id = `${this.idPrefix}-path-${this.definitions.size + 1}`;
        this.definitions.set(d, {
            id,
            svg: `<path id="${id}" d="${d}" vector-effect="non-scaling-stroke" />`,
        });
        return id;
    }
}

/** 使用 SVG 后端绘制一个已经完成布局的文档 */
export function renderLayoutToSvg(
    result: DocumentLayoutResult,
    options: SvgRenderOptions = {},
): string {
    const painter = new SvgPainter(options.idPrefix);
    paintLayout(result, painter);
    return painter.toSvg(result.bounds, options);
}