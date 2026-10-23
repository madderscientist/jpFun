import type { PaintStyle, Painter, PathCommand, PathTransform, TextStyle } from "./types.js";

/** Painter 没有变换栈，整体平移的几何只能逐条命令平移 */
export class TranslatingPainter implements Painter {
    constructor(
        private readonly target: Painter,
        private readonly dx: number,
        private readonly dy: number,
    ) {}

    drawText(text: string, x: number, y: number, style: TextStyle) {
        this.target.drawText(text, x + this.dx, y + this.dy, style);
    }

    drawLine(x1: number, y1: number, x2: number, y2: number, style?: PaintStyle) {
        this.target.drawLine(x1 + this.dx, y1 + this.dy, x2 + this.dx, y2 + this.dy, style);
    }

    drawRect(x: number, y: number, w: number, h: number, style?: PaintStyle) {
        this.target.drawRect(x + this.dx, y + this.dy, w, h, style);
    }

    drawCircle(cx: number, cy: number, r: number, style?: PaintStyle) {
        this.target.drawCircle(cx + this.dx, cy + this.dy, r, style);
    }

    drawPath(commands: readonly PathCommand[], style?: PaintStyle, transform?: PathTransform) {
        this.target.drawPath(commands, style, {
            x: (transform?.x ?? 0) + this.dx,
            y: (transform?.y ?? 0) + this.dy,
            scaleX: transform?.scaleX ?? 1,
            scaleY: transform?.scaleY ?? 1,
        });
    }
}
