import type { DocumentLayoutResult } from "../layout/engine.js";
import type { Rect } from "../layout/types.js";
import type { PaintStyle, Painter, PathCommand, PathTransform, TextStyle } from "./types.js";

export function layoutPageBounds(result: DocumentLayoutResult): readonly Rect[] {
    return result.pages.length > 0
        ? result.pages.map(page => page.bounds)
        : [result.bounds];
}

/** 按固定层级把布局结果绘制到一个 Painter */
export function paintLayout(result: DocumentLayoutResult, painter: Painter) {
    for (const attachment of result.attachments) {
        if (attachment.layer === "background") attachment.paint(painter);
    }
    for (const node of result.objects) {
        node.paint(painter);
        for (const decoration of node.decorations) decoration.paint(painter);
    }
    for (const attachment of result.attachments) {
        if (attachment.layer === "foreground") attachment.paint(painter);
    }
}

class PagePainter implements Painter {
    constructor(
        private readonly pages: readonly Rect[],
        private readonly painters: readonly Painter[],
    ) {}

    private route(top: number, bottom: number, paint: (painter: Painter) => void) {
        let low = 0;
        let high = this.pages.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            const page = this.pages[middle];
            if (page.y + page.h < top) low = middle + 1;
            else high = middle;
        }
        for (let index = low; index < this.pages.length && this.pages[index].y <= bottom; index++) {
            paint(this.painters[index]);
        }
    }

    drawText(text: string, x: number, y: number, style: TextStyle) {
        this.route(y, y, painter => painter.drawText(text, x, y, style));
    }

    drawLine(x1: number, y1: number, x2: number, y2: number, style?: PaintStyle) {
        const halfStroke = (style?.strokeWidth ?? 1) / 2;
        this.route(
            Math.min(y1, y2) - halfStroke,
            Math.max(y1, y2) + halfStroke,
            painter => painter.drawLine(x1, y1, x2, y2, style),
        );
    }

    drawRect(x: number, y: number, w: number, h: number, style?: PaintStyle) {
        const halfStroke = style?.stroke ? (style.strokeWidth ?? 1) / 2 : 0;
        this.route(y - halfStroke, y + Math.max(0, h) + halfStroke, painter => {
            painter.drawRect(x, y, w, h, style);
        });
    }

    drawCircle(cx: number, cy: number, r: number, style?: PaintStyle) {
        const halfStroke = style?.stroke ? (style.strokeWidth ?? 1) / 2 : 0;
        const radius = Math.max(0, r) + halfStroke;
        this.route(cy - radius, cy + radius, painter => painter.drawCircle(cx, cy, r, style));
    }

    drawPath(commands: readonly PathCommand[], style?: PaintStyle, transform?: PathTransform) {
        if (commands.length === 0) return;
        const y = transform
            ? (value: number) => transform.y + value * transform.scaleY
            : (value: number) => value;
        let top = Infinity;
        let bottom = -Infinity;
        const include = (value: number) => {
            const transformed = y(value);
            top = Math.min(top, transformed);
            bottom = Math.max(bottom, transformed);
        };
        for (const command of commands) {
            if (command.op === "Z") continue;
            if (command.op === "Q") include(command.cy);
            if (command.op === "C") {
                include(command.cy1);
                include(command.cy2);
            }
            include(command.y);
        }
        if (!Number.isFinite(top)) return;
        const halfStroke = style?.stroke ? (style.strokeWidth ?? 1) / 2 : 0;
        this.route(top - halfStroke, bottom + halfStroke, painter => {
            painter.drawPath(commands, style, transform);
        });
    }
}

/** 用一个代理 Painter 把一次完整绘制分发到多个页面 Painter */
export function paintLayoutPages(result: DocumentLayoutResult, painters: readonly Painter[]) {
    const pages = layoutPageBounds(result);
    if (painters.length !== pages.length) {
        throw new Error(`Expected ${pages.length} page painters, got ${painters.length}`);
    }
    paintLayout(result, new PagePainter(pages, painters));
}