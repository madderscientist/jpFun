import { Diagnostic, ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
import type { Fraction } from "../../fraction.js";
import { lineEntryX, lineRightX } from "../../layout/range.js";
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
import { dynamicMarkVelocity } from "../symbol/symbols/dynamics.js";
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
}

/**
 * 同轨按最终时间排序的力度快照与力度记号
 * increments 是已结算的增量；offset/slope 是待结算的 offset + slope × t 增量的差分数组
 */
interface TrackVelocities {
    records: VelocityRecord[];
    marks: VelocityRecord[];
    /** records[i] 之后第一个力度不同的下标 */
    runEnd: Int32Array;
    times: Float64Array;
    increments: Float64Array;
    offset: Float64Array;
    slope: Float64Array;
}

const clampVelocity = (velocity: number) => Math.max(1, Math.min(127, velocity));

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

function addIncrement(track: TrackVelocities, start: number, end: number, offset: number, slope = 0) {
    if (start >= end) return;
    track.offset[start] += offset;
    track.offset[end] -= offset;
    track.slope[start] += slope;
    track.slope[end] -= slope;
}

/** 在 [from, endStart) 的音符上叠加从 0 线性变化到 delta 的增量 */
function addRamp(track: TrackVelocities, dynamic: DynAttachment, endStart: number, delta: number) {
    const from = dynamic.fromHost.t;
    const slope = delta / dynamic.toHost.t.clone().sub(from).toNumber();
    addIncrement(track, findRecordBoundary(track.records, from), endStart, -slope * from.toNumber(), slope);
}

/** 把差分数组结算进 increments，并按可听范围限幅 */
function settle({ records, times, increments, offset, slope }: TrackVelocities) {
    let a = 0;
    let k = 0;
    for (let i = 0; i < records.length; i++) {
        a += offset[i];
        k += slope[i];
        const velocity = records[i].velocity;
        increments[i] = clampVelocity(velocity + increments[i] + a + k * times[i]) - velocity;
    }
    offset.fill(0);
    slope.fill(0);
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
端点须位于同一音轨、不同时间；变化量沿区间线性增加，叠加在每个音符原有力度上，并保持到下一个力度记号。本例从 \`a\` 到 \`b\` 渐强，终点增加 24 的力度。

终点同一时刻有力度记号时，以该记号为目标线性过渡，不再叠加 \`dv\`。

端点也可标在增时线上。终点没有力度时，取同轨、不晚于终点的最后一个原始力度作为保持基准；找不到时给出警告并仅绘制。增时线延续的音符保持起音时的力度。`,
        allowExtraArgs: false,
        args: [
            { name: "from", description: "渐变起点的标签", type: "label" as const, default: null },
            { name: "to", description: "渐变终点的标签", type: "label" as const, default: null },
            { name: "dv", description: "力度变化量，正数渐强，负数渐弱", type: "number" as const, default: null },
        ],
    };

    private static loweringFinalize(result: LoweringResult) {
        const dynamics = result.attachments.filter(
            (attachment): attachment is DynAttachment => attachment instanceof DynAttachment && attachment.orient(),
        );
        if (dynamics.length === 0) return;

        // 仅收集存在 @dyn 的音轨上的记录，避免无关声部也分配包装对象与排序
        const lists = new Map<Track, { records: VelocityRecord[]; marks: VelocityRecord[] }>(
            dynamics.map(d => [d.track, { records: [], marks: [] }]),
        );
        for (const nodes of result.astToTemporal.values()) {
            for (const node of nodes) {
                const host = node.rootHost;
                const list = lists.get(host.track);
                if (!list) continue;
                const velocity = node.playbackState?.velocity;
                if (velocity !== undefined) list.records.push({ node, host, velocity });
                const mark = dynamicMarkVelocity(node);
                if (mark !== undefined) list.marks.push({ node, host, velocity: mark });
            }
        }
        const byTime = (left: VelocityRecord, right: VelocityRecord) =>
            left.host.t.compare(right.host.t) || left.node.order - right.node.order;
        const tracks = new Map<Track, TrackVelocities>();
        for (const [track, { records, marks }] of lists) {
            records.sort(byTime);
            marks.sort(byTime);
            const length = records.length;
            const runEnd = new Int32Array(length);
            for (let i = length - 1; i >= 0; i--) {
                runEnd[i] = i + 1 < length && records[i + 1].velocity === records[i].velocity ? runEnd[i + 1] : i + 1;
            }
            tracks.set(track, {
                records,
                marks,
                runEnd,
                times: Float64Array.from(records, record => record.host.t.toNumber()),
                increments: new Float64Array(length),
                offset: new Float64Array(length + 1),
                slope: new Float64Array(length + 1),
            });
        }

        // 先结算没有终点记号的渐变；以记号为目标的渐变要从这些增量生效后的力度出发
        const targeted: [DynAttachment, number][] = [];
        for (const dynamic of dynamics) {
            const track = tracks.get(dynamic.track)!;
            const { records, marks, runEnd } = track;
            const to = dynamic.toHost.t;
            const endStart = findRecordBoundary(records, to);
            const afterEnd = findRecordBoundary(records, to, true);
            if (afterEnd === 0) {
                result.diagnostics.push(new WarningDiagnostic(
                    "W_DYN_NO_VELOCITY",
                    "@dyn 终点及此前同轨没有可用的力度基准，仅绘制渐变线",
                    dynamic.sourceSpan,
                ));
                continue;
            }
            const mark = marks[findRecordBoundary(marks, to, true) - 1];
            if (mark?.host.t.equals(to)) {
                // 同刻的记号与折叠成员先后不定，以终点最后取样的力度为目标
                const sampled = records[afterEnd - 1];
                targeted.push([dynamic, sampled.host.t.equals(to) ? sampled.velocity : mark.velocity]);
                continue;
            }

            // 保持到下一个力度记号（同值重写也算）或原始力度变化（兼顾其他写入力度的函数）
            let stopIndex = runEnd[afterEnd - 1];
            if (stopIndex < records.length) stopIndex = findRecordBoundary(records, records[stopIndex].host.t);
            const nextMark = marks[findRecordBoundary(marks, to, true)];
            if (nextMark) stopIndex = Math.min(stopIndex, findRecordBoundary(records, nextMark.host.t));
            addRamp(track, dynamic, endStart, dynamic.dv);
            addIncrement(track, endStart, stopIndex, dynamic.dv);
        }
        for (const track of tracks.values()) settle(track);

        for (const [dynamic, target] of targeted) {
            const track = tracks.get(dynamic.track)!;
            const last = findRecordBoundary(track.records, dynamic.toHost.t) - 1;
            if (last < 0) continue;
            addRamp(track, dynamic, last + 1, target - track.records[last].velocity - track.increments[last]);
        }
        for (const track of tracks.values()) {
            settle(track);
            track.records.forEach((record, i) => {
                // 容差吸收差分累加的浮点误差，避免半整数被算成略小于 .5
                const velocity = Math.round(record.velocity + track.increments[i] + 1e-9);
                if (velocity !== record.velocity) record.node.playbackState = { ...record.node.playbackState, velocity };
            });
        }
    }
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
        const fromHost = from.rootHost;
        const toHost = to.rootHost;
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
        // 此时的先后已可信（插入偏移只推后后续列）；同刻端点留到时间固化后再判断
        const order = fromHost.t.compare(toHost.t);
        ctx.addAttachment(order > 0
            ? new DynAttachment(this, toHost, fromHost, false)
            : new DynAttachment(this, fromHost, toHost, order === 0));
        ctx.deferFinalize(DynFunction.loweringFinalize);
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
    readonly kind = "dyn";
    readonly layer = "foreground" as const;

    constructor(
        private readonly ast: DynFunction,
        public fromHost: VisualTemporalNode,
        public toHost: VisualTemporalNode,
        /** lowering 时两端同刻，方向要等时间固化后才能确定 */
        private readonly unordered: boolean,
    ) {}

    /**
     * 按最终时间确定方向，返回是否影响播放
     * 倚音序列等局部时间轴上的渐变会投影到同一宿主时刻，只绘制
     */
    orient() {
        const cmp = this.fromHost.t.compare(this.toHost.t);
        if (cmp === 0 && this.unordered) {
            throw new ErrorDiagnostic("E_DYN_ZERO_SPAN", "@dyn 的两个端点必须位于不同时间", this.sourceSpan);
        }
        if (cmp > 0) [this.fromHost, this.toHost] = [this.toHost, this.fromHost];
        return cmp !== 0;
    }

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
                startX: line === fromLine ? this.fromHost.box.x : lineEntryX(context, line, this.track),
                endX: line === toLine
                    ? this.toHost.box.x + this.toHost.box.w
                    : lineRightX(context, line),
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
}
