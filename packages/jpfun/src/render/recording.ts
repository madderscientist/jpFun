import type { PaintStyle, Painter, PathCommand, PathTransform, TextStyle } from "./types.js";

export type RecordedPaintCommand =
    | { kind: "text"; text: string; x: number; y: number; style: TextStyle }
    | { kind: "line"; x1: number; y1: number; x2: number; y2: number; style?: PaintStyle }
    | { kind: "rect"; x: number; y: number; w: number; h: number; style?: PaintStyle }
    | { kind: "circle"; cx: number; cy: number; r: number; style?: PaintStyle }
    | { kind: "path"; commands: PathCommand[]; style?: PaintStyle };

/**
 * 记录通用绘制命令而不产生图像
 *
 * 主要用于后端契约测试、导出中间表示和调试
 * 输入已经是布局完成后的绝对坐标
 */
export class RecordingPainter implements Painter {
    commands: RecordedPaintCommand[] = [];

    drawText(text: string, x: number, y: number, style: TextStyle) {
        this.commands.push({
            kind: "text",
            text,
            x, y,
            style,
        });
    }

    drawLine(x1: number, y1: number, x2: number, y2: number, style?: PaintStyle) {
        this.commands.push({
            kind: "line",
            x1, y1,
            x2, y2,
            style,
        });
    }

    drawRect(x: number, y: number, w: number, h: number, style?: PaintStyle) {
        this.commands.push({
            kind: "rect",
            x, y, w, h,
            style,
        });
    }

    drawCircle(cx: number, cy: number, r: number, style?: PaintStyle) {
        this.commands.push({
            kind: "circle",
            cx, cy, r,
            style,
        });
    }

    drawPath(commands: readonly PathCommand[], style?: PaintStyle, transform?: PathTransform) {
        this.commands.push({
            kind: "path",
            commands: commands.map(command => transformPathCommand(command, transform)),
            style,
        });
    }
}

function transformPathCommand(command: PathCommand, transform?: PathTransform): PathCommand {
    if (!transform || command.op === "Z") return { ...command };

    const x = (value: number) => transform.x + value * transform.scaleX;
    const y = (value: number) => transform.y + value * transform.scaleY;
    if (command.op === "M" || command.op === "L") {
        return { op: command.op, x: x(command.x), y: y(command.y) };
    }
    if (command.op === "Q") {
        return {
            op: "Q",
            cx: x(command.cx),
            cy: y(command.cy),
            x: x(command.x),
            y: y(command.y),
        };
    }
    if (command.op === "C") {
        return {
            op: "C",
            cx1: x(command.cx1),
            cy1: y(command.cy1),
            cx2: x(command.cx2),
            cy2: y(command.cy2),
            x: x(command.x),
            y: y(command.y),
        };
    }
    return { ...command };
}