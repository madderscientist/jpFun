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
    readonly circle?: { readonly cx: number; readonly cy: number; readonly r: number };
    /** 横向偏移，用来把同一份字形重复拼成 ff、ppp 这类由字母组成的符号 */
    readonly dx?: number;
    readonly style: PaintStyle;
}

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
        if (shape.circle) {
            const { cx, cy, r } = shape.circle;
            merge(cx + dx - r, cy - r, 2 * r, 2 * r);
        }
        if (shape.path?.length) {
            const rect = pathBounds(shape.path);
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
        const scaled = style.strokeWidth === undefined
            ? style
            : { ...style, strokeWidth: style.strokeWidth * scale };
        const x = originX + (shape.dx ?? 0) * scale;
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
