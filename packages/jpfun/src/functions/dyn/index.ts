import { Diagnostic, ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
import type { Fraction } from "../../fraction.js";
import type { AttachmentLayoutContext, LayoutAttachment } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { Track } from "../../lowering/track.js";
import {
    isVisualTemporalNode,
    type TemporalNodeBase,
    type VisualTemporalNode,
} from "../temporal.js";
import type { LoweringResult } from "../../lowering/types.js";
import type { Painter } from "../../render/types.js";
import {
    ASTFunctionNode,
    type ASTFunctionClass,
    type ASTNodeBase,
    type FunctionArgs,
    type ParserContext,
    type SourceSpan,
} from "../ASTtypes.js";

interface VelocityRecord {
    node: TemporalNodeBase;
    host: TemporalNodeBase;
    velocity: number;
    increment: number;
}

function findRecordBoundary(records: readonly VelocityRecord[], time: Fraction, after = false): number {
    let low = 0;
    let high = records.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        const cmp = records[middle].host.t.compare(time);
        if (after ? cmp <= 0 : cmp < 0) low = middle + 1;
        else high = middle;
    }
    return low;
}

class DynFunction extends ASTFunctionNode {
    static override def = {
        name: ["dyn"],
        description: "渐强渐弱",
        details: `\
~~~jpfun
1 ^ $p 2@a 3 4@b
@dyn(a, b, 24)
~~~
端点须位于同一音轨、不同时间；变化量沿区间线性增加，叠加在每个音符原有力度上。本例从 \`a\` 到 \`b\` 渐强，终点增加 24 的力度。

端点也可标在增时线上。终点没有力度时，取同轨、不晚于终点的最后一个原始力度作为保持基准；找不到时给出警告并仅绘制。增时线延续的音符保持起音时的力度。`,
        allowExtraArgs: false,
        args: [
            { name: "from", description: "渐变起点的标签", type: "label" as const, default: null },
            { name: "to", description: "渐变终点的标签", type: "label" as const, default: null },
            { name: "dv", description: "力度变化量，正数渐强，负数渐弱", type: "number" as const, default: null },
        ],
    };

    static override loweringFinalize = (result: LoweringResult) => {
        const dynamics = result.attachments.filter(
            (attachment): attachment is DynAttachment => attachment instanceof DynAttachment,
        );
        if (dynamics.length === 0) return;

        // 仅收集存在 @dyn 的音轨上的记录，避免无关声部也分配包装对象与排序
        const recordsByTrack = new Map<Track, VelocityRecord[]>(dynamics.map(d => [d.track, []]));
        for (const nodes of result.astToTemporal.values()) {
            for (const node of nodes) {
                const velocity = node.playbackState?.velocity;
                if (velocity === undefined) continue;
                let host = node;
                while (host.foldedInto) host = host.foldedInto;
                recordsByTrack.get(host.track)?.push({ node, host, velocity, increment: 0 });
            }
        }
        for (const list of recordsByTrack.values()) {
            list.sort((left, right) => left.host.t.compare(right.host.t) || left.node.order - right.node.order);
        }

        // 先累计全部 dyn 的贡献，最后统一写回，避免声明顺序改变后续 dyn 读取的原始力度
        for (const dynamic of dynamics) {
            const records = recordsByTrack.get(dynamic.track)!;
            const endStart = findRecordBoundary(records, dynamic.toHost.t);
            const afterEnd = findRecordBoundary(records, dynamic.toHost.t, true);

            let endVelocity = dynamic.end.playbackState?.velocity;
            for (let i = endStart; endVelocity === undefined && i < afterEnd; i++) {
                if (records[i].host === dynamic.toHost) endVelocity = records[i].velocity;
            }
            endVelocity ??= records[afterEnd - 1]?.velocity;
            if (endVelocity === undefined) {
                result.diagnostics.push(new WarningDiagnostic(
                    "W_DYN_NO_VELOCITY",
                    "@dyn 终点及此前同轨没有可用的力度基准，仅绘制渐变线",
                    dynamic.sourceSpan,
                ));
                continue;
            }

            // 终点后保持完整增量，直到原始力度相对终点再次发生变化
            let stopIndex = records.length;
            for (let i = afterEnd; i < records.length; i++) {
                if (records[i].velocity !== endVelocity) {
                    stopIndex = findRecordBoundary(records, records[i].host.t);
                    break;
                }
            }
            const startIndex = findRecordBoundary(records, dynamic.fromHost.t);
            const duration = dynamic.toHost.t.clone().sub(dynamic.fromHost.t);

            for (let i = startIndex; i < stopIndex; i++) {
                const progress = i >= endStart ? 1
                    : records[i].host.t.clone().sub(dynamic.fromHost.t).div(duration).toNumber();
                records[i].increment += dynamic.dv * progress;
            }
        }

        for (const records of recordsByTrack.values()) {
            for (const record of records) {
                if (record.increment === 0) continue;
                const velocity = Math.max(1, Math.min(127, record.velocity + record.increment));
                record.node.playbackState = { ...record.node.playbackState, velocity };
            }
        }
    };

    readonly from: ASTNodeBase;
    readonly to: ASTNodeBase;
    readonly dv: number;
    readonly size: number;

    override loweringEnter(ctx: LoweringContext) {
        const from = ctx.getTemporalNodes(this.from).at(0);
        const to = ctx.getTemporalNodes(this.to).at(-1);
        if (!from || !to) {
            ctx.diagnostics.push(Diagnostic.warning.UnresolvedEndpoint("dyn", this.sourceSpan));
            return [];
        }
        let fromHost: TemporalNodeBase = from;
        let toHost: TemporalNodeBase = to;
        while (fromHost.foldedInto) fromHost = fromHost.foldedInto;
        while (toHost.foldedInto) toHost = toHost.foldedInto;
        if (!isVisualTemporalNode(fromHost) || !isVisualTemporalNode(toHost)) {
            ctx.diagnostics.push(Diagnostic.warning.UnresolvedEndpoint("dyn", this.sourceSpan));
            return [];
        }
        if (fromHost.track !== toHost.track) {
            throw new ErrorDiagnostic(
                "E_DYN_CROSS_TRACK",
                "@dyn 的两个端点必须位于同一音轨",
                this.sourceSpan,
            );
        }
        if (fromHost.t.equals(toHost.t)) {
            throw new ErrorDiagnostic(
                "E_DYN_ZERO_SPAN",
                "@dyn 的两个端点必须位于不同时间",
                this.sourceSpan,
            );
        }

        if (fromHost.t.compare(toHost.t) < 0) {
            ctx.addAttachment(new DynAttachment(this, to, fromHost, toHost));
        } else {
            ctx.addAttachment(new DynAttachment(this, from, toHost, fromHost));
        }
        return [];
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        const [from, to, inputDv] = this.getArgValue(args, ctx) as [ASTNodeBase, ASTNodeBase, number];
        let dv = inputDv;
        if (!Number.isFinite(dv) || dv === 0) {
            throw new ErrorDiagnostic(
                "E_DYN_INVALID_DELTA",
                "@dyn 的 dv 必须是非零有限数",
                span,
            );
        }
        dv = Math.max(-127, Math.min(127, dv));
        if (dv !== inputDv) {
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_DYN_DELTA_CLAMPED",
                "@dyn 的 dv 必须在 -127 到 127 之间，已被限制为 {dv}",
                span,
                { dv },
            ));
        }
        this.from = from;
        this.to = to;
        this.dv = dv;
        this.size = ctx.variables.fontsize;
    }

    override toString(source: string) {
        const name = (node: ASTNodeBase) => (node as ASTFunctionNode).label ?? node.toString(source);
        return `@dyn(${name(this.from)}, ${name(this.to)}, ${this.dv})`;
    }
}

export const DynNode: ASTFunctionClass = DynFunction;

interface HairpinRange {
    line: number;
    startX: number;
    endX: number;
}

class DynAttachment implements LayoutAttachment {
    readonly layer = "foreground" as const;

    constructor(
        private readonly ast: DynFunction,
        readonly end: TemporalNodeBase,
        readonly fromHost: VisualTemporalNode,
        readonly toHost: VisualTemporalNode,
    ) {}

    get sourceSpan() { return this.ast.sourceSpan; }
    get endPoints() { return [this.fromHost, this.toHost] as const; }
    get dv() { return this.ast.dv; }
    get track() { return this.fromHost.track; }

    createGeometry(context: AttachmentLayoutContext) {
        const fromLine = this.fromHost.layoutLine;
        const toLine = this.toHost.layoutLine;
        const endpoints = [this.fromHost, this.toHost] as const;
        const ranges: HairpinRange[] = [];
        let size = this.ast.size;

        for (let line = fromLine; line <= toLine; line++) {
            const columns = context.getRangeColumns(line, endpoints, this.track);
            if (!columns.some(column => column.length > 0)) continue;
            for (const column of columns) {
                for (const host of column) {
                    size = Math.max(size, host.ast.size);
                }
            }

            ranges.push({
                line,
                startX: line === fromLine ? this.fromHost.box.x : this.lineEntryX(context, line),
                endX: line === toLine
                    ? this.toHost.box.x + this.toHost.box.w
                    : this.lineRightX(context, line),
            });
        }

        // 允许左边超出一点
        for (const range of ranges) {
            if (range.line > fromLine) range.startX -= size / 4;
        }

        const strokeWidth = Math.max(0.75, size * 0.035);
        const valid = ranges.filter(range => range.startX !== range.endX);
        const total = valid.reduce((sum, range) => sum + Math.abs(range.endX - range.startX), 0);
        if (total === 0) return { regions: [], paint() {} };

        const aperture = size * 0.4;    // 最终开口高度
        const halfStroke = strokeWidth / 2;
        let covered = 0;
        const segments = valid.map(range => {
            const width = Math.abs(range.endX - range.startX);
            const start = covered / total;
            const end = (covered + width) / total;
            covered += width;
            const extent = context.getRangeExtents(range.line, endpoints, this.track);
            const axis = context.getVisualAxis(range.line, this.track);
            const hostTop = extent ? axis + extent.top : axis;
            return {
                line: range.line,
                startX: range.startX,
                endX: range.endX,
                lineY: hostTop - size * 0.62,
                startOpen: aperture * (this.dv > 0 ? start : 1 - start),
                endOpen: aperture * (this.dv > 0 ? end : 1 - end),
            };
        });

        return {
            regions: segments.map(segment => ({
                x: Math.min(segment.startX, segment.endX) - halfStroke,
                y: segment.lineY - Math.max(segment.startOpen, segment.endOpen) / 2 - halfStroke,
                w: Math.abs(segment.endX - segment.startX) + strokeWidth,
                h: Math.max(segment.startOpen, segment.endOpen) + strokeWidth,
                line: segment.line,
                track: this.track,
            })),
            paint(painter: Painter) {
                const style = { stroke: "#000", strokeWidth };
                for (const segment of segments) {
                    painter.drawLine(
                        segment.startX,
                        segment.lineY - segment.startOpen / 2,
                        segment.endX,
                        segment.lineY - segment.endOpen / 2,
                        style,
                    );
                    painter.drawLine(
                        segment.startX,
                        segment.lineY + segment.startOpen / 2,
                        segment.endX,
                        segment.lineY + segment.endOpen / 2,
                        style,
                    );
                }
            },
        };
    }

    private lineEntryX(context: AttachmentLayoutContext, line: number) {
        const host = context.lines[line].trackRuns.get(this.track)?.find(item => !item.T.isZero());
        return host?.box.x ?? context.originX;
    }

    private lineRightX(context: AttachmentLayoutContext, line: number) {
        const runs = context.lines[line].trackRuns;
        if (runs.size === 0) return context.originX + context.width;

        let right = context.originX;
        for (const run of runs.values()) {
            for (const host of run) right = Math.max(right, host.box.x + host.box.w);
        }
        return right;
    }
}
