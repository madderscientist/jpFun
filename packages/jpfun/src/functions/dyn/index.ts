import { Diagnostic, ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
import type { AttachmentLayoutContext, LayoutAttachment } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
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

class DynFunction extends ASTFunctionNode {
    static override def = {
        name: ["dyn"],
        description: "渐强渐弱",
        example: `@dyn(from, to, dv) 在两个标签之间线性改变力度
from、to 必须位于同一音轨且时间不同
dv 为正时渐强，为负时渐弱；变化量叠加在每个音符原有力度上

1 ^ $p 2@a 3 4@b
@dyn(a, b, 24)`,
        allowExtraArgs: false,
        args: [
            { name: "from", type: "label" as const, default: null },
            { name: "to", type: "label" as const, default: null },
            { name: "dv", type: "number" as const, default: null },
        ],
    };

    static override loweringFinalize = (result: LoweringResult) => {
        const dynamics = result.attachments.filter(
            (attachment): attachment is DynAttachment => attachment instanceof DynAttachment,
        );
        if (dynamics.length === 0) return;

        // astToTemporal 包含不进入全局 columns 的和弦、倚音成员；host 只用于统一时间和音轨
        const records: VelocityRecord[] = [];
        for (const nodes of result.astToTemporal.values()) {
            for (const node of nodes) {
                const velocity = node.playbackState?.velocity;
                if (velocity === undefined) continue;
                let host = node;
                while (host.foldedInto) host = host.foldedInto;
                records.push({ node, host, velocity, increment: 0 });
            }
        }
        records.sort((left, right) => left.host.t.compare(right.host.t) || left.node.order - right.node.order);

        // 先累计全部 dyn 的贡献，最后统一写回，避免声明顺序改变后续 dyn 读取的原始力度
        for (const dynamic of dynamics) {
            const endVelocity = dynamic.end.playbackState?.velocity
                ?? records.find(record => record.host === dynamic.toHost)?.velocity;
            if (endVelocity === undefined) throw new Error("@dyn end endpoint has no velocity-bearing member");

            // 终点后保持完整增量，直到原始力度相对终点再次发生变化
            const stop = records.find(record =>
                record.host.track === dynamic.track
                && record.host.t.compare(dynamic.toHost.t) > 0
                && record.velocity !== endVelocity,
            )?.host.t;
            const duration = dynamic.toHost.t.clone().sub(dynamic.fromHost.t);

            for (const record of records) {
                if (record.host.track !== dynamic.track) continue;
                const fromStart = record.host.t.compare(dynamic.fromHost.t);
                if (fromStart < 0 || (stop && record.host.t.compare(stop) >= 0)) continue;
                const progress = record.host.t.compare(dynamic.toHost.t) >= 0
                    ? 1
                    : record.host.t.clone().sub(dynamic.fromHost.t).div(duration).toNumber();
                record.increment += dynamic.dv * progress;
            }
        }

        for (const record of records) {
            if (record.increment === 0) continue;
            const velocity = Math.max(1, Math.min(127, record.velocity + record.increment));
            record.node.playbackState = { ...record.node.playbackState, velocity };
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
                `@dyn 的 dv 必须在 -127 到 127 之间，已被限制为 ${dv}`,
                span,
            ));
        }
        this.from = from;
        this.to = to;
        this.dv = dv;
        this.size = ctx.fontSize;
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
    columns: readonly [from: number, to: number];
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
    get dv() { return this.ast.dv; }
    get track() { return this.fromHost.track; }

    createGeometry(context: AttachmentLayoutContext) {
        const locate = (host: VisualTemporalNode) => {
            const view = context.lines[host.layoutLine];
            return { line: host.layoutLine, view, column: view?.columnOf(host) ?? -1 };
        };
        const from = locate(this.fromHost);
        const to = locate(this.toHost);
        if (!from.view || !to.view || from.column < 0 || to.column < 0) {
            return { regions: [], paint() {} };
        }

        const ranges: HairpinRange[] = [];
        let size = this.ast.size;

        for (let line = from.line; line <= to.line; line++) {
            const view = context.lines[line];
            const start = line === from.line ? from.column : 0;
            const end = line === to.line ? to.column : view.columns.length - 1;
            let firstColumn = -1;
            let lastColumn = -1;

            for (let column = start; column <= end; column++) {
                for (const host of view.columns[column]) {
                    if (host.track !== this.track) continue;
                    firstColumn = firstColumn < 0 ? column : firstColumn;
                    lastColumn = column;
                    size = Math.max(size, host.ast.size);
                }
            }
            if (firstColumn < 0) continue;

            ranges.push({
                line,
                startX: line === from.line ? this.fromHost.box.x : this.lineEntryX(context, line),
                endX: line === to.line
                    ? this.toHost.box.x + this.toHost.box.w
                    : this.lineRightX(context, line),
                columns: [firstColumn, lastColumn],
            });
        }

        // 允许左边超出一点
        for (const range of ranges) {
            if (range.line > from.line) range.startX -= size / 4;
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
            const extent = context.getRangeExtents(range.line, range.columns).get(this.track);
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
