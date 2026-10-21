/**
 * 符号自身坐标系与布局坐标系之间的换算
 *
 * `symbolBounds` 量出图元在符号自身坐标系里的固有包围盒，布局据此定 box；
 * `paintSymbol` 反过来把同一批图元放到最终 box 上。两者必须读同一份 bounds，
 * 否则墨迹会偏出框——符号原点不一定落在墨迹左上角。
 */

import { pathBounds } from "../../layout/path.js";
import type { LayoutBox, Rect } from "../../layout/types.js";
import type { PaintStyle, Painter, PathCommand } from "../../render/types.js";

/** 符号的一个图元；坐标在符号自身坐标系里，缩放由布局决定 */
export interface SymbolShape {
    readonly path?: readonly PathCommand[];
    readonly line?: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };
    readonly circle?: { readonly cx: number; readonly cy: number; readonly r: number };
    /** 横向偏移，用来把同一份字形重复拼成 ff、ppp 这类由字母组成的符号 */
    readonly dx?: number;
    readonly style: PaintStyle;
}

// 固定字形路径不可原地修改；共享路径的重复片段只求一次曲线极值
const pathBoundsCache = new WeakMap<readonly PathCommand[], Rect>();

/** 全体图元的并集；宽高钳到正数，否则纯横线或纯竖线的符号会让缩放比例除零 */
export function symbolBounds(shapes: readonly SymbolShape[]): Rect {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const merge = (x: number, y: number, w: number, h: number) => {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + w);
        bottom = Math.max(bottom, y + h);
    };
    for (const shape of shapes) {
        const dx = shape.dx ?? 0;
        if (shape.line) {
            const { x1, y1, x2, y2 } = shape.line;
            const halfStroke = (shape.style.strokeWidth ?? 1) / 2;
            merge(Math.min(x1, x2) + dx - halfStroke, Math.min(y1, y2) - halfStroke,
                Math.abs(x2 - x1) + halfStroke * 2, Math.abs(y2 - y1) + halfStroke * 2);
        }
        if (shape.circle) {
            const { cx, cy, r } = shape.circle;
            const stroke = shape.style.stroke && shape.style.stroke !== "none"
                ? (shape.style.strokeWidth ?? 1) / 2 : 0;
            const outer = r + stroke;
            merge(cx + dx - outer, cy - outer, 2 * outer, 2 * outer);
        }
        if (shape.path?.length) {
            const rect = pathBoundsCache.get(shape.path) ?? pathBounds(shape.path);
            pathBoundsCache.set(shape.path, rect);
            merge(rect.x + dx, rect.y, rect.w, rect.h);
        }
    }

    return Number.isFinite(left)
        ? { x: left, y: top, w: Math.max(1e-9, right - left), h: Math.max(1e-9, bottom - top) }
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
        const style = shape.style;
        const strokeWidth = style.strokeWidth ?? (shape.line || shape.circle ? 1 : undefined);
        const scaled = strokeWidth === undefined
            ? style
            : { ...style, strokeWidth: strokeWidth * scale };
        const x = originX + (shape.dx ?? 0) * scale;
        if (shape.line) {
            const { x1, y1, x2, y2 } = shape.line;
            painter.drawLine(x + x1 * scale, originY + y1 * scale,
                x + x2 * scale, originY + y2 * scale,
                scaled);
        }
        if (shape.path) {
            painter.drawPath(shape.path, scaled, { x, y: originY, scaleX: scale, scaleY: scale });
        }
        if (shape.circle) {
            painter.drawCircle(
                x + shape.circle.cx * scale,
                originY + shape.circle.cy * scale,
                shape.circle.r * scale,
                scaled,
            );
        }
    }
}
