/**
 * 符号自身坐标系与布局坐标系之间的换算
 *
 * `symbolBounds` 量出图元在符号自身坐标系里的固有包围盒，布局据此定 box；
 * `paintSymbol` 反过来把同一批图元放到最终 box 上。两者必须读同一份 bounds，
 * 否则墨迹会偏出框——符号原点不一定落在墨迹左上角。
 */

import type { LayoutBox, Rect } from "../../layout/types.js";
import type { PaintStyle, Painter, PathCommand } from "../../render/types.js";

/** 符号的一个图元；坐标在符号自身坐标系里，缩放由布局决定 */
export interface SymbolShape {
    readonly path?: readonly PathCommand[];
    readonly circle?: { readonly cx: number; readonly cy: number; readonly r: number };
    readonly style?: PaintStyle;
}

const DEFAULT_STYLE: PaintStyle = { fill: "#000" };

class Extent {
    min = Infinity;
    max = -Infinity;
    add(value: number) {
        if (value < this.min) this.min = value;
        if (value > this.max) this.max = value;
    }
}

function cubicAt(t: number, p0: number, p1: number, p2: number, p3: number, extent: Extent) {
    if (!(t > 0 && t < 1)) return;
    const u = 1 - t;
    extent.add(u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3);
}

/** 三次曲线的真实极值：导数是二次式，取区间内的驻点而不是控制点 */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number, extent: Extent) {
    extent.add(p0);
    extent.add(p3);
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;
    if (Math.abs(a) < 1e-12) {
        if (Math.abs(b) > 1e-12) cubicAt(-c / b, p0, p1, p2, p3, extent);
        return;
    }
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return;
    const root = Math.sqrt(discriminant);
    cubicAt((-b + root) / (2 * a), p0, p1, p2, p3, extent);
    cubicAt((-b - root) / (2 * a), p0, p1, p2, p3, extent);
}

function quadraticExtrema(p0: number, p1: number, p2: number, extent: Extent) {
    extent.add(p0);
    extent.add(p2);
    const denominator = p0 - 2 * p1 + p2;
    if (Math.abs(denominator) < 1e-12) return;
    const t = (p0 - p1) / denominator;
    if (!(t > 0 && t < 1)) return;
    const u = 1 - t;
    extent.add(u * u * p0 + 2 * u * t * p1 + t * t * p2);
}

/**
 * 按曲线真实极值求包围盒
 *
 * 用控制点会显著高估：延长记号的两段弧曾因此把声明高度撑大 33%，
 * 于是墨迹只占盒子的四分之三并且不居中。
 */
export function symbolBounds(shapes: readonly SymbolShape[]): Rect {
    const x = new Extent();
    const y = new Extent();
    for (const shape of shapes) {
        if (shape.circle) {
            x.add(shape.circle.cx - shape.circle.r);
            x.add(shape.circle.cx + shape.circle.r);
            y.add(shape.circle.cy - shape.circle.r);
            y.add(shape.circle.cy + shape.circle.r);
        }
        let cursorX = 0;
        let cursorY = 0;
        let startX = 0;
        let startY = 0;
        for (const command of shape.path ?? []) {
            if (command.op === "Z") {
                cursorX = startX;
                cursorY = startY;
                continue;
            }
            if (command.op === "C") {
                cubicExtrema(cursorX, command.cx1, command.cx2, command.x, x);
                cubicExtrema(cursorY, command.cy1, command.cy2, command.y, y);
            } else if (command.op === "Q") {
                quadraticExtrema(cursorX, command.cx, command.x, x);
                quadraticExtrema(cursorY, command.cy, command.y, y);
            } else {
                x.add(command.x);
                y.add(command.y);
                if (command.op === "M") {
                    startX = command.x;
                    startY = command.y;
                }
            }
            cursorX = command.x;
            cursorY = command.y;
        }
    }

    return Number.isFinite(x.min)
        ? { x: x.min, y: y.min, w: Math.max(1e-9, x.max - x.min), h: Math.max(1e-9, y.max - y.min) }
        : { x: 0, y: 0, w: 1e-9, h: 1e-9 };
}

export function paintSymbol(
    painter: Painter,
    shapes: readonly SymbolShape[],
    bounds: Rect,
    box: Readonly<LayoutBox>,
    scale: number,
) {
    const originX = box.x - bounds.x * scale;
    const originY = box.y - bounds.y * scale;
    for (const shape of shapes) {
        const style = shape.style ?? DEFAULT_STYLE;
        const scaled = style.strokeWidth === undefined
            ? style
            : { ...style, strokeWidth: style.strokeWidth * scale };
        if (shape.path) {
            painter.drawPath(shape.path, scaled, { x: originX, y: originY, scaleX: scale, scaleY: scale });
        }
        if (shape.circle) {
            painter.drawCircle(
                originX + shape.circle.cx * scale,
                originY + shape.circle.cy * scale,
                shape.circle.r * scale,
                scaled,
            );
        }
    }
}
