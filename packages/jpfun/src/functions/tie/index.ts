import { ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass, type LengthValue } from "../ASTtypes.js";
import type { CallArgumentInfo } from "../../parser/grammarType.js";
import { Diagnostic, ErrorDiagnostic } from "../../diagnostic.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import {
    isVisualTemporalNode,
    type VisualTemporalNode,
} from "../../lowering/types.js";
import { pathBounds } from "../../layout/path.js";
import type {
    AttachmentLayoutContext,
    LayoutAttachment,
    LayoutPoint,
    Rect,
} from "../../layout/types.js";
import type { Painter, PathCommand } from "../../render/types.js";
import type {
    PlaybackDraftNoteOffEvent,
    PlaybackDraftNoteOnEvent,
} from "../../playback/event.js";
import type {
    PlaybackHookContext,
    PlaybackRelation,
} from "../../playback/types.js";
import type { Track } from "../../lowering/track.js";

/** 三次贝塞尔控制点的抬高系数：两个控制点同高时，实际弧高恰好是抬高的 3/4 */
const CUBIC_LIFT = 4 / 3;
/** 弧带中部最大厚度与字号之比 */
const THICKNESS_RATIO = 0.09;

class TieFunction extends ASTFunctionNode {
    static override def = {
        name: ["tie"],
        description: "连音线",
        example: `@tie(label1, label2, ..., height=0.5em)
    将端点依次连接；同行用一条弧线，跨行拆成分段连接；若不传端点则找最近的`,
        allowExtraArgs: true,
        extraArgType: "label" as const,
        args: []
    };

    endPoints: ASTNodeBase[] = [];
    readonly height: number;

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        let height = ctx.fontSize * 0.5;
        for (const [key, value] of args) {
            if (key === "height") {
                const length = ctx.parseArgWithType(
                    (value as CallArgumentInfo).valueSpan,
                    "length", sourceSpan.start
                ) as LengthValue | null;
                if (length) height = Math.max(0, ctx.length2px(length));
                continue;
            }
            const v = value instanceof ASTFunctionNode
                ? value
                : ctx.parseArgWithType((value as CallArgumentInfo).valueSpan, "label", sourceSpan.start);
            if (v !== null) this.endPoints.push(v as ASTFunctionNode);
        }
        // 数目不足，则找最近的；用 unshift 而不是按下标赋值，否则空洞会让 length 虚高、骗过下面的校验
        let k = ctx.labelableNodes.length - 1;
        while (this.endPoints.length < 2 && k >= 0) {
            const candidate = ctx.labelableNodes[k--];
            if (!candidate || this.endPoints.includes(candidate)) continue;
            this.endPoints.unshift(candidate);
        }
        if (this.endPoints.length < 2) throw new ErrorDiagnostic("E_NOT_ENOUGH_ARGS", "@tie 连音线需要至少两个端点", sourceSpan);
        this.height = height;
    }

    /**
     * tie 不推进时间
     * lowering 只把 AST 端点解析成稳定的 temporal 对象引用
     */
    override loweringEnter(ctx: LoweringContext) {
        const endPoints: VisualTemporalNode[] = [];
        for (const ast of this.endPoints) {
            const temporal = ctx.getTemporalNodes(ast).at(-1);
            if (!temporal || !isVisualTemporalNode(temporal)) continue;
            endPoints.push(temporal);
        }

        if (endPoints.length < 2) {
            ctx.diagnostics.push(Diagnostic.warning.UnresolvedEndpoint("tie", this.sourceSpan));
            return [];
        }
        ctx.addAttachment(new TieLayoutAttachment(endPoints, this.height, this.sourceSpan));
        return [];
    }

    override toString(source: string) {
        return `@tie(${this.endPoints.map(p => `${(p as ASTFunctionNode).label ?? 'anon'}:[${p.toString(source)}]`).join(", ")})`;
    }
}

export const TieNode: ASTFunctionClass = TieFunction;

interface TieSegment extends Rect {
    commands: PathCommand[];
    line: number;
    track: Track;
}

/** 二次贝塞尔在某一维上的内部极值 */
function quadExtremum(p0: number, p1: number, p2: number): number | null {
    const d = p0 - 2 * p1 + p2;
    if (Math.abs(d) < 1e-9) return null;
    const t = (p0 - p1) / d;
    if (t <= 0 || t >= 1) return null;
    const u = 1 - t;
    return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

class TieLayoutAttachment implements LayoutAttachment, PlaybackRelation {
    layer = "foreground" as const;
    readonly sourceSpan: SourceSpan;

    readonly endPoints: VisualTemporalNode[];
    private readonly height: number;
    /** 弧带中部厚度；两端收尖到 0。端点字号不随布局变化，可以一次算定 */
    private readonly thickness: number;

    constructor(endPoints: VisualTemporalNode[], height: number, sourceSpan: SourceSpan) {
        this.endPoints = endPoints;
        this.height = height;
        this.sourceSpan = sourceSpan;
        const size = endPoints.reduce(
            (current, endpoint) => Math.max(current, endpoint.ast.size),
            0,
        );
        this.thickness = Math.max(1.2, size * THICKNESS_RATIO);
    }

    /**
    * 只有同轨、同音、演奏时间连续的事件对才合并，其余 tie 纯视觉
     *
    * 反复会让同一个端点产生多个事件对，所以按首端点的每一个 NoteOn 各串一条链。
     */
    applyPlayback(context: PlaybackHookContext) {
        const noteOns = () => context.events
            .filter((event): event is PlaybackDraftNoteOnEvent => event.kind === "note-on");
        const noteOff = (noteId: number) => context.events
            .find((event): event is PlaybackDraftNoteOffEvent =>
                event.kind === "note-off" && event.noteId === noteId);
        for (const head of noteOns().filter(note =>
            note.origins.some(origin => origin.node === this.endPoints[0]))) {
            for (let i = 1; i < this.endPoints.length; i++) {
                const end = noteOff(head.noteId);
                if (!end) break;
                const next = noteOns().find(note => note.noteId !== head.noteId
                    && note.origins.some(origin => origin.node === this.endPoints[i])
                    && note.track === head.track
                    && note.midi === head.midi
                    && end.at.equals(note.at));
                if (!next) break;
                const nextOff = noteOff(next.noteId);
                if (!nextOff) break;
                head.sourceSpans.push(...next.sourceSpans);
                for (const origin of next.origins) {
                    if (!head.origins.includes(origin)) head.origins.push(origin);
                }
                nextOff.noteId = head.noteId;
                nextOff.origins = [...head.origins];
                context.events.splice(0, context.events.length,
                    ...context.events.filter(event => event !== end && event !== next));
            }
        }
    }

    createGeometry(context: AttachmentLayoutContext) {
        const segments = this.createSegments(context);
        const regions = segments.map(({ commands, ...region }) => region);
        const occupancy = segments.map(segment => {
            // 只申报主体上方那一段，下半截由主体自己占；本行没有主体时就只有弧带本身
            const hostExtent = context.getHostExtent(segment.line, segment.track);
            const bottom = hostExtent
                ? Math.max(segment.y, context.getVisualAxis(segment.line, segment.track) + hostExtent.top)
                : segment.y + segment.h;
            return {
                x: segment.x,
                y: segment.y,
                w: segment.w,
                h: bottom - segment.y,
                line: segment.line,
                track: segment.track,
            };
        });
        return {
            regions,
            occupancy,
            paint(painter: Painter) {
                for (const segment of segments) {
                    // 弧带本身就是闭合轮廓，直接填充就能得到两端收尖、中部较粗的乐谱弧线
                    painter.drawPath(segment.commands, { fill: "#000" });
                }
            },
        };
    }

    private absolutePort(node: VisualTemporalNode, name: string): LayoutPoint {
        const port = node.ports[name];
        if (port) {
            return {
                x: node.box.x + port.x,
                y: node.box.y + port.y,
            };
        }

        return {
            x: node.box.x + node.box.anchor,
            y: node.box.y,
        };
    }

    /** 根据端点固化后的行号选择同行弧线或跨行分段。 */
    private createSegments(context: AttachmentLayoutContext) {
        const segments: TieSegment[] = [];

        for (let i = 1; i < this.endPoints.length; i++) {
            let startNode = this.endPoints[i - 1];
            let endNode = this.endPoints[i];
            // 标签书写顺序不保证时间顺序，先按谱面行升序规范化
            if (startNode.layoutLine > endNode.layoutLine) [startNode, endNode] = [endNode, startNode];

            const start = this.absolutePort(startNode, "tie.top");
            const end = this.absolutePort(endNode, "tie.top");

            if (startNode.layoutLine === endNode.layoutLine) {
                const startTop = context.getVisualAxis(startNode.layoutLine, startNode.track)
                    + (context.getHostExtent(startNode.layoutLine, startNode.track)?.top ?? 0);
                const endTop = context.getVisualAxis(endNode.layoutLine, endNode.track)
                    + (context.getHostExtent(endNode.layoutLine, endNode.track)?.top ?? 0);
                segments.push(this.arcSegment(
                    start,
                    end,
                    startNode.layoutLine,
                    startTop <= endTop ? startNode.track : endNode.track,
                ));
                continue;
            }

            // 首行先起弧，再沿水平段延伸到当前谱面行最右侧
            segments.push(this.openingSegment(
                start,
                context.originX + context.width,
                this.plateauY(context, startNode.layoutLine, startNode.track, start.y),
                startNode.layoutLine,
                startNode.track,
            ));

            // 中间行可能没有任何可见对象，仍然需要逐行补一段水平线
            for (let line = startNode.layoutLine + 1; line < endNode.layoutLine; line++) {
                segments.push(this.horizontalSegment(
                    context.originX,
                    context.originX + context.width,
                    this.plateauY(context, line, startNode.track),
                    line,
                    startNode.track,
                ));
            }

            // 末行从最左侧进入，经过水平段后落弧到终点
            segments.push(this.closingSegment(
                context.originX,
                end,
                this.plateauY(context, endNode.layoutLine, endNode.track, end.y),
                endNode.layoutLine,
                endNode.track,
            ));
        }
        return segments;
    }

    /** 沿用普通端点的抬高量，但基准至少是当前 Track 的最高主体。 */
    private plateauY(
        context: AttachmentLayoutContext,
        line: number,
        track: Track,
        endpointY: number = Infinity,
    ) {
        const axis = context.getVisualAxis(line, track);
        const hostTop = context.getHostExtent(line, track)?.top ?? 0;
        return Math.min(endpointY, axis + hostTop) - this.height;
    }

    /** 一条三次贝塞尔的外缘配上反向内缘，得到两端收尖、中部最厚的乐谱弧线 */
    private arcSegment(
        startInput: LayoutPoint,
        endInput: LayoutPoint,
        line: number,
        track: Track,
    ) {
        let start = startInput;
        let end = endInput;
        if (start.x > end.x) [start, end] = [end, start];

        const run = (end.x - start.x) * 0.25;
        const leftX = start.x + run;
        const rightX = end.x - run;
        const lift = this.height * CUBIC_LIFT;
        const inner = Math.max(0, lift - this.thickness * CUBIC_LIFT);

        const commands: PathCommand[] = [
            { op: "M", x: start.x, y: start.y },
            { op: "C", cx1: leftX, cy1: start.y - lift, cx2: rightX, cy2: end.y - lift, x: end.x, y: end.y },
            { op: "C", cx1: rightX, cy1: end.y - inner, cx2: leftX, cy2: start.y - inner, x: start.x, y: start.y },
            { op: "Z" },
        ];

        return makeSegment(commands, line, track);
    }

    /** 跨行首段：从端点起弧，随后水平延伸到右边界 */
    private openingSegment(
        start: LayoutPoint,
        right: number,
        plateauY: number,
        line: number,
        track: Track,
    ) {
        const span = Math.max(0, right - start.x);
        const run = Math.min(this.height * 1.2, span * 0.4);
        const curveX = start.x + run;
        const controlX = start.x + run * 0.45;
        const bottom = plateauY + this.thickness;

        return makeSegment([
            { op: "M", x: start.x, y: start.y },
            { op: "Q", cx: controlX, cy: plateauY, x: curveX, y: plateauY },
            { op: "L", x: right, y: plateauY },
            { op: "L", x: right, y: bottom },
            { op: "L", x: curveX, y: bottom },
            { op: "Q", cx: controlX, cy: bottom, x: start.x, y: start.y },
            { op: "Z" },
        ], line, track);
    }

    /** 跨行末段：从左边界水平进入，最后落弧到端点 */
    private closingSegment(
        left: number,
        end: LayoutPoint,
        plateauY: number,
        line: number,
        track: Track,
    ) {
        const span = Math.max(0, end.x - left);
        const run = Math.min(this.height * 1.2, span * 0.4);
        const curveX = end.x - run;
        const controlX = end.x - run * 0.45;
        const bottom = plateauY + this.thickness;

        return makeSegment([
            { op: "M", x: left, y: plateauY },
            { op: "L", x: curveX, y: plateauY },
            { op: "Q", cx: controlX, cy: plateauY, x: end.x, y: end.y },
            { op: "Q", cx: controlX, cy: bottom, x: curveX, y: bottom },
            { op: "L", x: left, y: bottom },
            { op: "Z" },
        ], line, track);
    }

    private horizontalSegment(
        left: number,
        right: number,
        y: number,
        line: number,
        track: Track,
    ) {
        return makeSegment([
            { op: "M", x: left, y },
            { op: "L", x: right, y },
            { op: "L", x: right, y: y + this.thickness },
            { op: "L", x: left, y: y + this.thickness },
            { op: "Z" },
        ], line, track);
    }
}

function makeSegment(
    commands: PathCommand[],
    line: number,
    track: Track,
): TieSegment {
    return { commands, line, track, ...pathBounds(commands) };
}