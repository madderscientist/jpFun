import type { DocumentLayoutResult } from "../layout/engine.js";
import { layoutPageBounds, paintLayoutPages } from "./paint.js";
import { canvasFont } from "./text.js";
import type { PaintStyle, Painter, PathCommand, PathTransform, TextStyle } from "./types.js";

function tracePath(
    context: CanvasRenderingContext2D,
    commands: readonly PathCommand[],
    x: number = 0,
    y: number = 0,
    scaleX: number = 1,
    scaleY: number = 1,
) {
    context.beginPath();

    for (const command of commands) {
        if (command.op === "Z") {
            context.closePath();
            continue;
        }

        if (command.op === "M") {
            context.moveTo(x + command.x * scaleX, y + command.y * scaleY);
            continue;
        }

        if (command.op === "L") {
            context.lineTo(x + command.x * scaleX, y + command.y * scaleY);
            continue;
        }

        if (command.op === "Q") {
            context.quadraticCurveTo(
                x + command.cx * scaleX,
                y + command.cy * scaleY,
                x + command.x * scaleX,
                y + command.y * scaleY,
            );
            continue;
        }

        if (!("cx1" in command)) continue;
        context.bezierCurveTo(
            x + command.cx1 * scaleX,
            y + command.cy1 * scaleY,
            x + command.cx2 * scaleX,
            y + command.cy2 * scaleY,
            x + command.x * scaleX,
            y + command.y * scaleY,
        );
    }
}

/**
 * CanvasRenderingContext2D 的 Painter 适配器
 *
 * 本类不负责设置 canvas 像素尺寸和 devicePixelRatio
 * 调用方可以在构造前配置 context，再使用同一个布局结果绘制
 */
export class CanvasPainter implements Painter {
    constructor(private readonly context: CanvasRenderingContext2D) {}

    private beginOpacity(style?: PaintStyle | TextStyle): number | undefined {
        if (style?.opacity === void 0) return void 0;
        const previous = this.context.globalAlpha;
        this.context.globalAlpha = previous * style.opacity;
        return previous;
    }

    private endOpacity(previous: number | undefined) {
        if (previous !== void 0) this.context.globalAlpha = previous;
    }

    drawText(text: string, x: number, y: number, style: TextStyle) {
        const previousAlpha = this.beginOpacity(style);
        this.context.fillStyle = style.fill ?? "#000";
        this.context.font = canvasFont(style);
        this.context.textAlign = style.textAlign ?? "left";
        this.context.textBaseline = "alphabetic";
        this.context.fillText(text, x, y);
        this.endOpacity(previousAlpha);
    }

    drawLine(x1: number, y1: number, x2: number, y2: number, style?: PaintStyle) {
        const previousAlpha = this.beginOpacity(style);
        this.context.beginPath();
        this.context.moveTo(x1, y1);
        this.context.lineTo(x2, y2);
        this.context.strokeStyle = style?.stroke ?? style?.fill ?? "#000";
        this.context.lineWidth = style?.strokeWidth ?? 1;
        this.context.lineCap = "round";
        this.context.stroke();
        this.endOpacity(previousAlpha);
    }

    drawRect(x: number, y: number, w: number, h: number, style?: PaintStyle) {
        if (w < 0 || h < 0) return;

        const previousAlpha = this.beginOpacity(style);

        if (style?.fill) {
            this.context.fillStyle = style.fill;
            this.context.fillRect(x, y, w, h);
        }

        if (style?.stroke) {
            this.context.strokeStyle = style.stroke;
            this.context.lineWidth = style.strokeWidth ?? 1;
            this.context.lineJoin = "miter";
            this.context.strokeRect(x, y, w, h);
        }

        this.endOpacity(previousAlpha);
    }

    drawCircle(cx: number, cy: number, r: number, style?: PaintStyle) {
        if (r < 0) return;

        const previousAlpha = this.beginOpacity(style);
        this.context.beginPath();
        this.context.arc(cx, cy, r, 0, Math.PI * 2);

        const fill = style?.fill ?? "#000";
        if (fill && fill !== "none") {
            this.context.fillStyle = fill;
            this.context.fill();
        }

        if (style?.stroke) {
            this.context.strokeStyle = style.stroke;
            this.context.lineWidth = style.strokeWidth ?? 1;
            this.context.stroke();
        }

        this.endOpacity(previousAlpha);
    }

    drawPath(commands: readonly PathCommand[], style?: PaintStyle, transform?: PathTransform) {
        if (commands.length === 0) return;

        const previousAlpha = this.beginOpacity(style);
        tracePath(
            this.context,
            commands,
            transform?.x,
            transform?.y,
            transform?.scaleX,
            transform?.scaleY,
        );

        if (style?.fill) {
            this.context.fillStyle = style.fill;
            this.context.fill();
        }

        if (style?.stroke) {
            this.context.strokeStyle = style.stroke;
            this.context.lineWidth = style.strokeWidth ?? 1;
            this.context.lineCap = "round";
            this.context.lineJoin = "round";
            this.context.stroke();
        }

        this.endOpacity(previousAlpha);
    }
}

/** 使用 Canvas 后端把一个布局结果一次绘制到独立页面 context */
export function renderLayoutPagesToCanvas(
    result: DocumentLayoutResult,
    contexts: readonly CanvasRenderingContext2D[],
) {
    const pages = layoutPageBounds(result);
    if (contexts.length !== pages.length) {
        throw new Error(`Expected ${pages.length} page contexts, got ${contexts.length}`);
    }
    for (const [index, context] of contexts.entries()) {
        context.save();
        context.translate(-pages[index].x, -pages[index].y);
    }
    try {
        paintLayoutPages(result, contexts.map(context => new CanvasPainter(context)));
    } finally {
        for (const context of contexts) context.restore();
    }
}