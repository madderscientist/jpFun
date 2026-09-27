import type { PaintStyle, Painter, PathCommand, PathTransform, TextStyle } from "./types.js";

/** Painter 没有变换栈，整体平移的几何只能逐条命令平移 */
export class TranslatingPainter implements Painter {
    private readonly target: Painter;
    private readonly dx: number;
    private readonly dy: number;

    constructor(target: Painter, dx: number, dy: number) {
        this.target = target;
        this.dx = dx;
        this.dy = dy;
    }

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
        if (transform) {
            const moved: PathTransform = { ...transform, x: transform.x + this.dx, y: transform.y + this.dy };
            this.target.drawPath(commands, style, moved);
            return;
        }
        this.target.drawPath(commands.map(command => this.translateCommand(command)), style);
    }

    private translateCommand(command: PathCommand): PathCommand {
        switch (command.op) {
            case "Z": return command;
            case "Q": return {
                op: "Q",
                cx: command.cx + this.dx, cy: command.cy + this.dy,
                x: command.x + this.dx, y: command.y + this.dy,
            };
            case "C": return {
                op: "C",
                cx1: command.cx1 + this.dx, cy1: command.cy1 + this.dy,
                cx2: command.cx2 + this.dx, cy2: command.cy2 + this.dy,
                x: command.x + this.dx, y: command.y + this.dy,
            };
            default: return { op: command.op, x: command.x + this.dx, y: command.y + this.dy };
        }
    }
}
