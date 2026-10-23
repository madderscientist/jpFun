import { ErrorDiagnostic } from "../../diagnostic.js";
import type { Fraction } from "../../fraction.js";
import { pathBounds } from "../../layout/path.js";
import type { HorizontalLineView, LayoutAttachment } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { LoweringGroup } from "../../lowering/types.js";
import type {
    PlaybackNote,
    PlaybackOrigin,
    PlaybackSpan,
    PlaybackTransform,
} from "../../playback/types.js";
import type { Painter, PathCommand } from "../../render/types.js";
import {
    ASTFunctionNode,
    type ASTFunctionClass,
    type ASTNodeBase,
    type FunctionArgs,
    type ParserContext,
    type SourceSpan,
} from "../ASTtypes.js";
import { isVisualTemporalNode, type TemporalNodeBase, type VisualTemporalNode } from "../temporal.js";

const MAX_SUBNOTES = 256;

function callName(node: TemporalNodeBase): string {
    return node.ast instanceof ASTFunctionNode ? node.ast.callName : "";
}

function isDash(node: TemporalNodeBase): boolean {
    return callName(node) === "dash";
}

function isAudibleNote(item: PlaybackSpan): item is PlaybackNote {
    return "midi" in item;
}

function collectNoteAxes(node: VisualTemporalNode, axes: number[] = []): number[] {
    if ("host" in node && isVisualTemporalNode(node.host as TemporalNodeBase)) {
        return collectNoteAxes(node.host as VisualTemporalNode, axes);
    }
    if ("members" in node && Array.isArray(node.members)) {
        for (const member of node.members as VisualTemporalNode[]) collectNoteAxes(member, axes);
        return axes;
    }
    if (typeof (node as { resolvedMidi?: unknown }).resolvedMidi === "number"
        || (node.ast as { name?: unknown }).name === "9") {
        axes.push(node.box.y + node.box.visualAxis);
    }
    return axes;
}

function visualCenterY(node: VisualTemporalNode): number {
    const axes = collectNoteAxes(node);
    return axes.length > 0
        ? (Math.min(...axes) + Math.max(...axes)) / 2
        : node.box.y + node.box.visualAxis;
}

function collectVisitSpans(
    list: readonly PlaybackSpan[],
    target: TemporalNodeBase,
    endAt?: Fraction,
): PlaybackSpan[] {
    let targetOrigin: PlaybackOrigin | undefined;
    const matched: PlaybackSpan[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
        const item = list[i];
        if (item.origins.at(-1)!.node.track !== target.track) continue;
        const origin = item.origins.find(entry => entry.node === target);
        if (!targetOrigin) {
            if (!origin) continue;
            if (endAt && !item.end.equals(endAt)) return [];
            targetOrigin = origin;
        } else if (origin !== targetOrigin) {
            break;
        }
        if (endAt && !item.end.equals(endAt)) return [];
        matched.push(item);
    }
    return matched;
}

function singleTremoloTransform(n: number): PlaybackTransform {
    const rate = 1 << n;
    return (_context, owned) => {
        const result: PlaybackNote[] = [];
        for (const note of owned) {
            const duration = note.end.clone().sub(note.start);
            const count = Math.min(MAX_SUBNOTES, Math.max(2, Math.round(duration.toNumber() * rate)));
            const step = duration.div(count);
            for (let i = 0; i < count; i++) {
                const start = step.clone().mul(i).add(note.start);
                result.push({
                    ...note,
                    start,
                    end: start.clone().add(step),
                });
            }
        }
        return result;
    };
}

class TremoloFunction extends ASTFunctionNode {
    static override def = {
        name: ["tremolo"],
        description: "震音（同音震音与双音交替震音）",
        details: `\
~~~jpfun
@tremolo(5, n=3)
@tremolo({#5,^7, 2^4}, n=3)
~~~
- **单音震音**：内容为单个音符或和弦（后可接增时线 \`-\`），斜杠记在最末元素右下角，播放时按 \`1 / 2^n\` 四分音符时值同音重复。
- **双音震音**：内容为两个同轨、等时值的相邻音符或和弦，斜杠记在两音之间，播放时在两音总时值内按 \`1 / 2^n\` 四分音符时值交替发声。`,
        allowExtraArgs: false,
        args: [
            { type: "content" as const, default: null, description: "单个音符（可带增时线）或两个等时值的音符/和弦" },
            { name: "n", type: "number" as const, default: 3, description: "斜杠数量，取 1..3 的整数" },
        ],
    };

    readonly content: ASTNodeBase;
    readonly n: number;
    override get children() { return [this.content]; }
    override timeFlowModel() { return { children: [this.content], mode: "sequence" as const }; }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        const [content, n] = this.getArgValue(args, ctx) as [ASTNodeBase, number];
        if (!Number.isSafeInteger(n) || n < 1 || n > 3) {
            throw new ErrorDiagnostic(
                "E_TREMOLO_INVALID_N",
                "@tremolo 的斜杠数 n 必须是 1 到 3 的整数",
                span,
            );
        }
        this.content = content;
        this.n = n;
        content.parent = this;
    }

    override loweringEnter(ctx: LoweringContext) {
        for (let ancestor = this.parent; ancestor; ancestor = ancestor.parent) {
            if (ancestor instanceof TremoloFunction) {
                throw new ErrorDiagnostic(
                    "E_TREMOLO_CONTENT",
                    "@tremolo 不能嵌套 @tremolo",
                    this.sourceSpan,
                );
            }
        }
        const group: TremoloGroup = {
            nodes: [],
            onTemporal(node) { group.nodes.push(node); },
        };
        ctx.beginLoweringGroup(this, group);
        return [];
    }

    override loweringExit(ctx: LoweringContext) {
        const { nodes } = ctx.endLoweringGroup(this) as TremoloGroup;
        if (nodes.some(node => (node.addon?.breakBefore ?? 0) > 0)) {
            throw new ErrorDiagnostic(
                "E_TREMOLO_CROSS_LINE",
                "@tremolo 不支持跨谱面行",
                this.sourceSpan,
            );
        }
        const visual = nodes.filter(isVisualTemporalNode);
        if (visual.length === 0 || visual.some(node => node.T.compare(0) <= 0 || callName(node) === "rest")) {
            throw new ErrorDiagnostic(
                "E_TREMOLO_CONTENT",
                "@tremolo 的内容必须是单个音符（可带增时线）或两个等时值的音符/和弦",
                this.sourceSpan,
            );
        }
        const track = visual[0].track;
        if (visual.some(node => node.track !== track)) {
            throw new ErrorDiagnostic(
                "E_TREMOLO_CROSS_TRACK",
                "@tremolo 的内容必须位于同一音轨",
                this.sourceSpan,
            );
        }
        const isSingle = !isDash(visual[0]) && visual.slice(1).every(isDash);
        const isPair = visual.length === 2 && !isDash(visual[0]) && !isDash(visual[1]);
        if (!isSingle && !isPair) {
            throw new ErrorDiagnostic(
                "E_TREMOLO_CONTENT",
                "@tremolo 的内容必须是单个音符（可带增时线）或两个等时值的音符/和弦",
                this.sourceSpan,
            );
        }

        const attachment = new TremoloAttachment(visual, this);
        ctx.addAttachment(attachment);
        ctx.deferFinalize(() => attachment.finalize());
        const anchorHost = isSingle ? visual.at(-1)! : visual[0];
        const prepare = anchorHost.prepareHorizontal;
        anchorHost.prepareHorizontal = line => {
            prepare?.call(anchorHost, line);
            attachment.registerHorizontal(line);
        };
        return [];
    }

    override toString(source: string) {
        return `@tremolo(${this.content.toString(source)}, n=${this.n})`;
    }
}

export const TremoloNode: ASTFunctionClass = TremoloFunction;

interface TremoloGroup extends LoweringGroup {
    nodes: TemporalNodeBase[];
}

class TremoloAttachment implements LayoutAttachment {
    readonly layer = "foreground" as const;
    readonly endPoints: readonly VisualTemporalNode[];
    get sourceSpan() { return this.owner.sourceSpan; }

    constructor(
        private readonly nodes: readonly VisualTemporalNode[],
        private readonly owner: TremoloFunction,
    ) {
        const isSingle = nodes.length === 1 || isDash(nodes[1]);
        this.endPoints = isSingle ? [nodes.at(-1)!] : [nodes[0], nodes[1]];
    }

    finalize() {
        const { nodes, owner, endPoints } = this;
        const single = endPoints.length === 1;
        const line = nodes[0].layoutLine;
        if (nodes.some(node => node.layoutLine !== line)) {
            throw new ErrorDiagnostic(
                "E_TREMOLO_CROSS_LINE",
                "@tremolo 不支持跨谱面行",
                owner.sourceSpan,
            );
        }
        if (collectNoteAxes(nodes[0]).length === 0 || (!single && collectNoteAxes(nodes[1]).length === 0)) {
            throw new ErrorDiagnostic(
                "E_TREMOLO_CONTENT",
                "@tremolo 的目标必须包含发声音符",
                owner.sourceSpan,
            );
        }
        if (single) {
            const target = nodes[0];
            const transform = singleTremoloTransform(owner.n);
            const emit = target.emitPlayback;
            target.emitPlayback = emitter => {
                emit?.call(target, emitter);
                emitter.defer(context => {
                    for (const span of collectVisitSpans(context.spans, target)) {
                        if (isAudibleNote(span)) context.transform(span, transform);
                    }
                });
            };
            return;
        }

        const [first, second] = nodes;
        if (!first.T.equals(second.T)) throw new ErrorDiagnostic(
            "E_TREMOLO_DURATION_MISMATCH",
            "@tremolo 双音震音的两个目标时值必须相等",
            owner.sourceSpan,
        );
        const emitSecond = second.emitPlayback;
        second.emitPlayback = emitter => {
            emitSecond?.call(second, emitter);
            const secondStart = emitter.start.clone();
            const secondEnd = emitter.end.clone();
            emitter.defer(context => {
                const firstSpans = collectVisitSpans(context.spans, first, secondStart);
                const secondSpans = collectVisitSpans(context.spans, second);
                if (firstSpans.length === 0 || secondSpans.length === 0) return;

                let minStart = firstSpans[0].start;
                for (let i = 1; i < firstSpans.length; i++) {
                    if (firstSpans[i].start.compare(minStart) < 0) minStart = firstSpans[i].start;
                }
                const t0 = minStart.clone();
                const t2 = secondEnd;
                const total = t2.clone().sub(t0);
                const pairs = Math.min(
                    MAX_SUBNOTES / 2,
                    Math.max(2, Math.round(total.toNumber() * (1 << (owner.n - 1)))),
                );
                const step = total.clone().div(pairs * 2);

                const slice = (divisor: number, extendTail: boolean): PlaybackTransform => (_ctx, owned) => owned.flatMap(item => {
                    const baseEnd = item.end.compare(t2) > 0 ? t2 : item.end;
                    const sliceStep = baseEnd.clone().sub(item.start).div(divisor);
                    const out: PlaybackNote[] = [];
                    for (let k = 0; k < pairs; k++) {
                        const start = sliceStep.clone().mul(2 * k).add(item.start);
                        const end = extendTail && k === pairs - 1 && item.end.compare(t2) > 0
                            ? item.end.clone()
                            : start.clone().add(sliceStep);
                        out.push({ ...item, start, end });
                    }
                    return out;
                });

                const evenTransform = slice(pairs * 2, false);
                const oddTransform = slice(pairs * 2 - 1, true);
                for (const span of firstSpans) {
                    span.start.copyFrom(t0);
                    span.end.copyFrom(t2);
                    if (isAudibleNote(span)) context.transform(span, evenTransform);
                }
                for (const span of secondSpans) {
                    span.start.copyFrom(t0).add(step);
                    span.end.copyFrom(t2);
                    if (isAudibleNote(span)) context.transform(span, oddTransform);
                }
            });
        };
    }

    registerHorizontal(line: HorizontalLineView) {
        if (this.endPoints.length === 1) {
            const host = this.endPoints[0];
            if (line.columnOf(host) < 0) return;
            const size = host.ast.size;
            const space = host.box.w - host.box.anchor + size * 0.6;
            line.registerHorizontalLayoutHook(host, host, ({ columns, start }) => {
                for (const element of columns[start]) {
                    if (element.box !== host.box) continue;
                    element.WR = Math.max(element.WR, space);
                }
            });
            return;
        }

        const [from, to] = this.endPoints;
        const start = line.columnOf(from);
        const end = line.columnOf(to);
        if (start < 0 || end < 0) return;
        if (end <= start || line.trackIndexOf(to) !== line.trackIndexOf(from) + 1) {
            throw new ErrorDiagnostic(
                "E_TREMOLO_ADJACENT",
                "@tremolo 双音震音的两个端点必须在同一谱面行相邻",
                this.owner.sourceSpan,
            );
        }
        const size = Math.max(from.ast.size, to.ast.size);
        const right = from.box.w - from.box.anchor + size * 0.84;
        line.registerHorizontalLayoutHook(from, to, ({ columns }) => {
            for (const element of columns[start]) element.WR = Math.max(element.WR, right);
        });
    }

    createGeometry() {
        const { n } = this.owner;
        const host = this.endPoints[0];
        let size = host.ast.size;
        let left: number;
        let right: number;
        let centerY: number;
        let rise: number;
        let stepY: number;

        if (this.endPoints.length === 1) {
            left = host.box.x + host.box.w + size * 0.1;
            right = left + size * 0.34;
            centerY = host.box.y + host.box.visualAxis + size * 0.14;
            rise = size * 0.18;
            stepY = size * 0.12;
        } else {
            const [from, to] = this.endPoints;
            size = Math.max(from.ast.size, to.ast.size);
            const gap = size * 0.12;
            const availLeft = from.box.x + from.box.w + gap;
            const availRight = to.box.x - gap;
            if (availRight <= availLeft) {
                throw new ErrorDiagnostic(
                    "E_TREMOLO_SPACE",
                    "@tremolo 的端点之间没有可用的水平绘制空间",
                    this.owner.sourceSpan,
                );
            }
            const spanX = Math.min(availRight - availLeft, size * 1.2);
            const midX = (availLeft + availRight) / 2;
            left = midX - spanX / 2;
            right = midX + spanX / 2;
            centerY = (visualCenterY(from) + visualCenterY(to)) / 2;
            rise = Math.min(size * 0.26, Math.max(size * 0.16, spanX * 0.32));
            stepY = size * 0.13;
        }

        const strokeWidth = Math.max(1, size * 0.06);
        const commands = buildSlashCommands(n, left, right, centerY, rise, stepY);
        const bounds = pathBounds(commands);
        const region = {
            x: bounds.x - strokeWidth / 2,
            y: bounds.y - strokeWidth / 2,
            w: bounds.w + strokeWidth,
            h: bounds.h + strokeWidth,
            line: host.layoutLine,
            track: host.track,
        };
        return {
            regions: [region],
            paint(painter: Painter) {
                painter.drawPath(commands, { fill: "none", stroke: "#000", strokeWidth });
            },
        };
    }
}

function buildSlashCommands(
    n: number,
    left: number,
    right: number,
    centerY: number,
    rise: number,
    stepY: number,
): PathCommand[] {
    const commands: PathCommand[] = [];
    for (let i = 0; i < n; i++) {
        const midY = centerY + (i - (n - 1) / 2) * stepY;
        commands.push(
            { op: "M", x: left, y: midY + rise / 2 },
            { op: "L", x: right, y: midY - rise / 2 },
        );
    }
    return commands;
}
