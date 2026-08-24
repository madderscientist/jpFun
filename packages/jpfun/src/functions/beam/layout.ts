import {
    isVisualTemporalNode,
    type LoweringResult,
    type TemporalNodeBase,
    type VisualTemporalNode,
} from "../../lowering/types.js";
import { ErrorDiagnostic } from "../../diagnostic.js";
import type { Track } from "../../lowering/track.js";
import type { SourceSpan } from "../../parser/types.js";
import type { Painter } from "../../render/types.js";
import type {
    AttachmentLayoutContext,
    HorizontalLineView,
    LayoutAttachment,
    LayoutHost,
    LayoutPoint,
} from "../../layout/types.js";
import {
    claimDivLine,
    divLinePortName,
    divLineRuns,
    divLineWidth,
} from "../div/index.js";

interface BeamLine {
    start: LayoutPoint;
    end: LayoutPoint;
    line: number;
    track: Track;
}

interface BeamSpan {
    left: LayoutPoint;
    right: LayoutPoint;
    line: number;
    track: Track;
    node: VisualTemporalNode;
}

/** 显式和自动分组共享同一个几何对象 */
export function createBeamLayoutAttachment(
    endPoints: TemporalNodeBase[],
    explicit: boolean,
    sourceSpan: SourceSpan,
): LayoutAttachment {
    return new BeamLayoutAttachment(endPoints, explicit, sourceSpan);
}

/** 显式 beam 必须严格连接最终同轨同谱面行中的相邻可见主体 */
export function validateExplicitBeamAttachments(result: LoweringResult) {
    const tracks = new Map<number, Map<Track, LayoutHost[]>>();

    for (const column of result.columns) {
        for (const node of column) {
            if (!isVisualTemporalNode(node)) continue;
            let lineTracks = tracks.get(node.layoutLine);
            if (!lineTracks) {
                lineTracks = new Map();
                tracks.set(node.layoutLine, lineTracks);
            }
            const sequence = lineTracks.get(node.track);
            if (sequence) sequence.push(node);
            else lineTracks.set(node.track, [node]);
        }
    }

    const positions = new Map<LayoutHost, { line: number; track: Track; index: number }>();
    for (const [line, lineTracks] of tracks) {
        for (const [track, sequence] of lineTracks) {
            for (let index = 0; index < sequence.length; index++) {
                positions.set(sequence[index], { line, track, index });
            }
        }
    }

    for (const attachment of result.attachments) {
        if (!(attachment instanceof BeamLayoutAttachment) || !attachment.explicit) continue;

        for (let i = 1; i < attachment.endPoints.length; i++) {
            const firstEndpoint = attachment.endPoints[i - 1];
            const secondEndpoint = attachment.endPoints[i];
            if (!isVisualTemporalNode(firstEndpoint) || !isVisualTemporalNode(secondEndpoint)) continue;
            const firstPosition = positions.get(firstEndpoint);
            const secondPosition = positions.get(secondEndpoint);
            const adjacent = firstEndpoint !== secondEndpoint
                && firstPosition !== undefined
                && secondPosition !== undefined
                && firstPosition.line === secondPosition.line
                && firstPosition.track === secondPosition.track
                && secondPosition.index === firstPosition.index + 1;
            if (adjacent) continue;

            throw new ErrorDiagnostic(
                "E_NON_ADJACENT_BEAM",
                "@beam 的端点必须按时间顺序连接同一轨道、同一谱面行中的相邻可见元素",
                attachment.sourceSpan,
            );
        }
    }
}

/** 自动分组在 loweringAugment 当下读取已经注册的显式 beam 端点 */
export function collectExplicitBeamEndpoints(
    attachments: readonly LayoutAttachment[],
): Set<TemporalNodeBase> {
    const result = new Set<TemporalNodeBase>();
    for (const attachment of attachments) {
        if (!(attachment instanceof BeamLayoutAttachment) || !attachment.explicit) continue;
        for (const endpoint of attachment.endPoints) result.add(endpoint);
    }
    return result;
}

class BeamLayoutAttachment implements LayoutAttachment {
    layer = "foreground" as const;

    readonly endPoints: TemporalNodeBase[];
    readonly explicit: boolean;
    readonly sourceSpan: SourceSpan;
    /** 端点字号不随布局变化，装饰尺寸可以一次算定 */
    private readonly fontSize: number;
    private readonly strokeWidth: number;

    constructor(endPoints: TemporalNodeBase[], explicit: boolean, sourceSpan: SourceSpan) {
        this.endPoints = endPoints;
        this.explicit = explicit;
        this.sourceSpan = sourceSpan;
        this.fontSize = endPoints.reduce(
            (size, endpoint) => isVisualTemporalNode(endpoint) ? Math.max(size, endpoint.ast.size) : size,
            0,
        );
        this.strokeWidth = divLineWidth(this.fontSize);
    }

    /** 同一 beam 组内的相邻元素使用更短的自然弹簧间距 */
    prepareHorizontal(context: HorizontalLineView[]) {
        const endPoints: ReadonlySet<unknown> = new Set(this.endPoints);

        for (const line of context) {
            for (const run of line.trackRuns.values()) {
                for (let i = 1; i < run.length; i++) {
                    const left = run[i - 1];
                    const right = run[i];
                    if (!endPoints.has(left) || !endPoints.has(right)) continue;
                    left.springConfig.alpha_R = (left.springConfig.alpha_R as number) * 0.8;
                    right.springConfig.alpha_L = (right.springConfig.alpha_L as number) * 0.8;
                }
            }
        }
    }

    createGeometry(context: AttachmentLayoutContext) {
        const lines = this.collectLines(context);
        const strokeWidth = this.strokeWidth;
        // 减时线永远水平，butt 端帽只在纵向占半个描边
        const regions = lines.map(line => ({
            x: Math.min(line.start.x, line.end.x),
            y: line.start.y - strokeWidth / 2,
            w: Math.abs(line.end.x - line.start.x),
            h: strokeWidth,
            line: line.line,
            track: line.track,
        }));
        return {
            regions,
            paint(painter: Painter) {
                for (const line of lines) {
                    painter.drawLine(
                        line.start.x,
                        line.start.y,
                        line.end.x,
                        line.end.y,
                        { stroke: "#000", strokeWidth },
                    );
                }
            },
        };
    }

    private absolutePort(node: VisualTemporalNode, name: string): LayoutPoint {
        const port = node.ports[name];
        return {
            x: node.box.x + port.x,
            y: node.box.y + port.y,
        };
    }

    private collectLines(context: AttachmentLayoutContext) {
        const lines: BeamLine[] = [];
        const available = this.endPoints.filter(isVisualTemporalNode);
        if (available.length < 2) return lines;

        for (const { level, from, to } of divLineRuns(available)) {
            const spans: BeamSpan[] = [];
            for (let i = from; i <= to; i++) {
                const node = available[i];
                spans.push({
                    left: this.absolutePort(node, divLinePortName(level, "left")),
                    right: this.absolutePort(node, divLinePortName(level, "right")),
                    line: node.layoutLine,
                    track: node.track,
                    node,
                });
            }
            this.addSystemLines(spans, context, level, lines);
        }

        // 显式关系允许连接没有 div 端口的任意可见对象
        if (lines.length === 0 && this.explicit) {
            const gap = this.fontSize * 0.12;
            const spans: BeamSpan[] = available.map(node => {
                const point = {
                    x: node.box.x + node.box.anchor,
                    y: node.box.y + node.box.h + gap,
                };
                return {
                    left: point,
                    right: point,
                    line: node.layoutLine,
                    track: node.track,
                    node,
                };
            });
            this.addSystemLines(spans, context, null, lines);
        }
        return lines;
    }

    /** 同一级减时线按谱面行拆开，跨行时连接到对应页面边界 */
    private addSystemLines(
        spans: BeamSpan[],
        context: AttachmentLayoutContext,
        connectedLevel: number | null,
        lines: BeamLine[],
    ) {
        const firstLine = Math.min(...spans.map(item => item.line));
        const lastLine = Math.max(...spans.map(item => item.line));
        const fallbackTrack = spans[0].track;
        const firstVisualAxis = context.getVisualAxis(spans[0].line, fallbackTrack);
        const visualAxisOffset = spans[0].left.y - firstVisualAxis;

        for (let line = firstLine; line <= lastLine; line++) {
            const current = spans
                .filter(item => item.line === line)
                .sort((left, right) => left.left.x - right.left.x);

            if (current.length === 0) {
                const visualAxis = context.getVisualAxis(line, fallbackTrack);
                const y = visualAxis + visualAxisOffset;
                lines.push({
                    start: { x: context.originX, y },
                    end: { x: context.originX + context.width, y },
                    line,
                    track: fallbackTrack,
                });
                continue;
            }

            const first = current[0];
            const last = current[current.length - 1];
            const y = first.left.y;
            const start = { x: first.left.x, y };
            const end = { x: last.right.x, y };
            if (line > firstLine) start.x = context.originX;
            if (line < lastLine) end.x = context.originX + context.width;
            if (start.x === end.x && firstLine === lastLine) continue;

            if (connectedLevel !== null) {
                for (const span of current) claimDivLine(span.node, connectedLevel);
            }

            lines.push({
                start,
                end,
                line,
                track: first.track,
            });
        }
    }
}