import { Diagnostic, ErrorDiagnostic } from "../../diagnostic.js";
import { unionLayoutBoxes } from "../../layout/engine.js";
import type { AttachmentLayoutContext, LayoutAttachment, LayoutRegion } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { LoweringResult } from "../../lowering/types.js";
import type { Painter, TextStyle } from "../../render/types.js";
import {
    ASTFunctionNode, type ASTFunctionClass, type ASTNodeBase, type FunctionArgs,
    type ParserContext, type SourceSpan,
} from "../ASTtypes.js";
import { isVisualTemporalNode, type TemporalNodeBase, type VisualTemporalNode } from "../temporal.js";

function outerHost(node: TemporalNodeBase): TemporalNodeBase {
    while (node.foldedInto) node = node.foldedInto;
    return node;
}

class OttavaFunction extends ASTFunctionNode {
    static override def = {
        name: ["ottava"],
        description: "八度号",
        details: `\
~~~jpfun
1@a 2 3 -@b | 4
@ottava(a, b, 1)
~~~
\`shift\` 为非零整数八度数，正数在上方标高八度号，负数在下方标低八度号，默认 \`1\`。标签使用谱面数字字体的斜体。`,
        allowExtraArgs: false,
        args: [
            {
                description: "起点标签",
                type: "label" as const,
                default: null
            },
            {
                description: "终点标签",
                type: "label" as const,
                default: null
            },
            {
                name: "shift",
                description: "非零整数八度数，正数为高，负数为低",
                type: "number" as const,
                default: 1
            },
        ],
    };

    static override loweringFinalize = (result: LoweringResult) => {
        const ottavasByTrack = new Map<TemporalNodeBase["track"], { start: TemporalNodeBase["t"]; end: TemporalNodeBase["t"]; shift: number }[]>();
        for (const attachment of result.attachments) {
            if (!(attachment instanceof OttavaAttachment)) continue;
            const [from, to] = attachment.endPoints;
            const entry = { start: from.t, end: to.t.clone().add(to.T), shift: attachment.ast.shift * 12 };
            const list = ottavasByTrack.get(from.track);
            if (list) list.push(entry);
            else ottavasByTrack.set(from.track, [entry]);
        }
        if (ottavasByTrack.size === 0) return;
        for (const list of ottavasByTrack.values()) {
            list.sort((left, right) => left.start.compare(right.start));
        }
        for (const nodes of result.astToTemporal.values()) {
            for (const node of nodes) {
                if (!node.playbackState) continue;
                const host = outerHost(node);
                const ottavas = ottavasByTrack.get(host.track);
                if (!ottavas) continue;
                let shift = 0;
                for (const ottava of ottavas) {
                    if (host.t.compare(ottava.start) < 0) break;
                    if (host.t.compare(ottava.end) < 0) {
                        shift += ottava.shift;
                    }
                }
                if (shift !== 0) {
                    node.playbackState = {
                        ...node.playbackState,
                        pitchShift: (node.playbackState.pitchShift ?? 0) + shift,
                    };
                }
            }
        }
    };

    readonly from: ASTNodeBase;
    readonly to: ASTNodeBase;
    readonly shift: number;
    readonly size: number;
    readonly font: string;

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        const [from, to, shift] = this.getArgValue(args, ctx) as [ASTNodeBase, ASTNodeBase, number];
        if (!Number.isSafeInteger(shift) || shift === 0 || !Number.isSafeInteger(shift * 12)) {
            throw new ErrorDiagnostic("E_OTTAVA_INVALID_SHIFT", "@ottava 的 shift 必须为可安全换算为半音的非零整数", span);
        }
        this.from = from;
        this.to = to;
        this.shift = shift;
        this.size = ctx.variables.fontsize;
        this.font = ctx.variables.numberfont;
    }

    override loweringEnter(ctx: LoweringContext) {
        const from = ctx.getTemporalNodes(this.from).at(0);
        const to = ctx.getTemporalNodes(this.to).at(-1);
        const head = from && outerHost(from);
        const tail = to && outerHost(to);
        if (!head || !tail || !isVisualTemporalNode(head) || !isVisualTemporalNode(tail)) {
            ctx.diagnostics.push(Diagnostic.warning.UnresolvedEndpoint("ottava", this.sourceSpan));
            return [];
        }
        if (head.track !== tail.track) {
            throw new ErrorDiagnostic("E_OTTAVA_CROSS_TRACK", "@ottava 的两个端点必须位于同一音轨", this.sourceSpan);
        }
        ctx.addAttachment(new OttavaAttachment(this, head, tail));
        return [];
    }

    override toString(source: string) {
        const name = (node: ASTNodeBase) =>
            (node instanceof ASTFunctionNode ? node.label : undefined) ?? node.toString(source);
        return `@ottava(${name(this.from)}, ${name(this.to)}, ${this.shift})`;
    }
}

export const OttavaNode: ASTFunctionClass = OttavaFunction;

class OttavaAttachment implements LayoutAttachment {
    readonly layer = "foreground" as const;

    constructor(
        readonly ast: OttavaFunction,
        private readonly from: VisualTemporalNode,
        private readonly to: VisualTemporalNode,
    ) {}

    get sourceSpan() { return this.ast.sourceSpan; }
    get endPoints() {
        return (this.from.t.compare(this.to.t) || this.from.order - this.to.order) > 0
            ? [this.to, this.from] as const : [this.from, this.to] as const;
    }

    createGeometry(context: AttachmentLayoutContext) {
        const endpoints = this.endPoints;
        const [from, to] = endpoints;
        const firstLine = from.layoutLine;
        const lastLine = to.layoutLine;
        if (context.lines[firstLine].columnOf(from) < 0 || context.lines[lastLine].columnOf(to) < 0) {
            return { regions: [], paint() {} };
        }

        const { size, font, shift } = this.ast;
        const above = shift > 0;
        const track = from.track;
        const strokeWidth = Math.max(0.75, size * 0.035);
        const lineStyle = { stroke: "#000", strokeWidth };
        const dash = size * 0.22;
        const dashStep = dash + size * 0.14;
        const halfStroke = strokeWidth / 2;
        const hook = size * 0.45;
        const gap = size * 0.2;
        const labelGap = size * 0.08;
        const text = String(Math.abs(shift) * 7 + 1);
        const style: TextStyle = {
            fontSize: size * 0.6,
            fontFamily: font,
            fontStyle: "italic",
            textAlign: "left",
            fill: "#000",
        };
        const metrics = context.textMeasurer.measureText(text, style);
        const labelTop = above ? -halfStroke : halfStroke - metrics.h;
        const labelY = labelTop + metrics.baseline;
        const draws = Array.from({ length: lastLine - firstLine + 1 }, (_, offset) => {
            const line = firstLine + offset;
            const first = line === firstLine;
            const last = line === lastLine;
            const runs = context.lines[line].trackRuns;
            let left = first ? from.box.x + (from.ports["body.left"]?.x ?? 0)
                : runs.get(track)?.find(host => !host.T.isZero())?.box.x ?? context.originX;
            let right = to.box.x + (to.ports["body.right"]?.x ?? to.box.w);
            if (!last) {
                right = context.originX + (runs.size === 0 ? context.width : 0);
                for (const run of runs.values()) {
                    for (const host of run) right = Math.max(right, host.box.x + host.box.w);
                }
            }
            if (left > right) [left, right] = [right, left];
            const lineStart = first ? left + metrics.w + labelGap : left;
            const part = (x: number, y: number, w: number, h: number): LayoutRegion => ({ x, y, w, h, line, track });
            const parts = lineStart < right
                ? [part(lineStart - halfStroke, -halfStroke, right - lineStart + strokeWidth, strokeWidth)] : [];
            if (first) parts.push(part(left, labelTop, metrics.w, metrics.h));
            if (last) parts.push(part(right - halfStroke, above ? -halfStroke : -hook - halfStroke,
                strokeWidth, hook + strokeWidth));
            const region = part(0, 0, 0, 0);
            unionLayoutBoxes(region, parts);

            let lineY = above ? Infinity : -Infinity;
            for (const part of parts) {
                for (const [lane, extent] of context.getHorizontalExtents(line, part.x, part.x + part.w)) {
                    const axis = context.getVisualAxis(line, lane);
                    lineY = above
                        ? Math.min(lineY, axis + extent.top - gap - part.y - part.h)
                        : Math.max(lineY, axis + extent.bottom + gap - part.y);
                }
            }
            if (!Number.isFinite(lineY)) {
                const extent = context.getRangeExtents(line,
                    first || last ? endpoints : undefined, track);
                const axis = context.getVisualAxis(line, track);
                lineY = above
                    ? axis + (extent?.top ?? 0) - gap - (region.y + region.h)
                    : axis + (extent?.bottom ?? 0) + gap - region.y;
            }
            for (const part of parts) part.y += lineY;
            region.y += lineY;
            return { left, right, lineStart, lineY, first, last, parts, region };
        });

        return {
            regions: draws.map(draw => draw.region),
            occupancy: draws.flatMap(draw => draw.parts),
            paint(painter: Painter) {
                for (const draw of draws) {
                    const { left, right, lineStart, lineY, first, last } = draw;
                    for (let x = lineStart; x < right; x += dashStep) {
                        painter.drawLine(x, lineY, Math.min(x + dash, right), lineY, lineStyle);
                    }
                    if (first) painter.drawText(text, left, lineY + labelY, style);
                    if (last) {
                        painter.drawLine(right, lineY, right, lineY + (above ? hook : -hook), lineStyle);
                    }
                }
            },
        };
    }
}
