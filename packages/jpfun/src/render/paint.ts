import type { DocumentLayoutResult } from "../layout/engine.js";
import type { PlacedAttachment, Rect } from "../layout/types.js";
import type { VisualTemporalNode } from "../functions/temporal.js";
import type { PaintGroup, PaintStyle, Painter, PathCommand, PathTransform, TextStyle } from "./types.js";

export function layoutPageBounds(result: DocumentLayoutResult): readonly Rect[] {
    return result.pages.length > 0
        ? result.pages.map(page => page.bounds)
        : [result.bounds];
}

/**
 * 绘制一个可见时值对象：主体后接装饰，整体放进 node.kind 分组
 *
 * up、grace、arpeggio 等容器绘制成员时也应调用它，成员的组因此嵌套在容器组内
 */
export function paintVisual(painter: Painter, node: VisualTemporalNode) {
    const kind = node.kind;
    if (kind) painter.beginGroup?.({ kind });
    node.paint(painter);
    for (const decoration of node.decorations) decoration.paint?.(painter);
    if (kind) painter.endGroup?.();
}

function paintAttachments(
    painter: Painter,
    attachments: readonly PlacedAttachment[],
    layer: PlacedAttachment["layer"],
) {
    for (const attachment of attachments) {
        if (attachment.layer !== layer) continue;
        const kind = attachment.kind;
        if (kind) painter.beginGroup?.({ kind });
        attachment.paint(painter);
        if (kind) painter.endGroup?.();
    }
}

/** 按固定层级把布局结果绘制到一个 Painter */
export function paintLayout(result: DocumentLayoutResult, painter: Painter) {
    paintAttachments(painter, result.attachments, "background");
    for (const node of result.objects) paintVisual(painter, node);
    paintAttachments(painter, result.attachments, "foreground");
}

class PagePainter implements Painter {
    /** 当前打开的分组，由外到内 */
    private readonly groups: PaintGroup[] = [];
    /** 页下标 → 该页已补开的层数；只记录有未结束分组的页，没有图元的页不开组 */
    private readonly opened = new Map<number, number>();

    constructor(
        private readonly pages: readonly Rect[],
        private readonly painters: readonly Painter[],
    ) {}

    beginGroup(group: PaintGroup) {
        this.groups.push(group);
    }

    endGroup() {
        const depth = this.groups.length;
        this.groups.pop();
        // 各页层数不超过 depth，等于 depth 的页才打开过这一组
        for (const [index, opened] of this.opened) {
            if (opened < depth) continue;
            this.painters[index].endGroup?.();
            if (depth > 1) this.opened.set(index, depth - 1);
            else this.opened.delete(index);
        }
    }

    private route(top: number, bottom: number, paint: (painter: Painter) => void) {
        let low = 0;
        let high = this.pages.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            const page = this.pages[middle];
            if (page.y + page.h < top) low = middle + 1;
            else high = middle;
        }
        const depth = this.groups.length;
        for (let index = low; index < this.pages.length && this.pages[index].y <= bottom; index++) {
            const painter = this.painters[index];
            const opened = this.opened.get(index) ?? 0;
            if (opened < depth) {
                for (let level = opened; level < depth; level++) painter.beginGroup?.(this.groups[level]);
                this.opened.set(index, depth);
            } paint(painter);
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
        let top = Infinity;
        let bottom = -Infinity;
        const include = (value: number) => {
            top = Math.min(top, value);
            bottom = Math.max(bottom, value);
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
        if (transform) {
            // 仿射变换单调，变换端点即可；scaleY 为负时上下互换
            const a = transform.y + top * transform.scaleY;
            const b = transform.y + bottom * transform.scaleY;
            top = Math.min(a, b);
            bottom = Math.max(a, b);
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