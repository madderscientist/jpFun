import { ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
import { pathBounds } from "../../layout/path.js";
import { lineEntryX, lineRightX } from "../../layout/range.js";
import type { AttachmentLayoutContext, HorizontalLineView, LayoutAttachment } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { LoweringResult } from "../../lowering/types.js";
import type { Painter, PathCommand } from "../../render/types.js";
import {
    ASTFunctionNode, type ASTFunctionClass, type ASTNodeBase, type FunctionArgs,
    type ParserContext, type SourceSpan,
} from "../ASTtypes.js";
import { isVisualTemporalNode, type TemporalNodeBase, type VisualTemporalNode } from "../temporal.js";

// gliss 判断音高的准则是 resolvedMidi 属性
function findPitchNode(
    columns: readonly (readonly TemporalNodeBase[])[],
    node: VisualTemporalNode,
    host: VisualTemporalNode,
) {
    const check = (item?: TemporalNodeBase) =>
        typeof (item as { resolvedMidi?: unknown })?.resolvedMidi === "number"
            ? item as TemporalNodeBase & { resolvedMidi: number }
            : undefined;
    if ("resolvedMidi" in node) return check(node);
    for (let i = columns.findIndex(col => col.includes(host)) - 1; i >= 0; i--) {
        const previous = columns[i].find(item => item.track === host.track && "resolvedMidi" in item);
        if (previous) return check(previous);
    }
}

class GlissFunction extends ASTFunctionNode {
    static override def = {
        name: ["gliss"],
        description: "滑音连线",
        details: `\
~~~jpfun
1 -@a 5@b @gliss(a, b)
~~~
若附属对象无音高，将使用前面最近的同轨有音高对象的音高；播放时从起点音段按半音阶离散过渡至终点音高。`,
        allowExtraArgs: false,
        args: [
            { type: "label" as const, default: null, description: "一个端点的标签，先后按谱面时间确定" },
            { type: "label" as const, default: null, description: "另一个端点的标签" },
        ],
    };

    readonly from: ASTNodeBase;
    readonly to: ASTNodeBase;

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        [this.from, this.to] = this.getArgValue(args, ctx) as [ASTNodeBase, ASTNodeBase];
    }

    override loweringEnter(ctx: LoweringContext) {
        const from = ctx.getTemporalNodes(this.from).at(-1);
        const to = ctx.getTemporalNodes(this.to).at(-1);
        if (!from || !to || !isVisualTemporalNode(from) || !isVisualTemporalNode(to)) {
            throw new ErrorDiagnostic(
                "E_GLISS_ENDPOINT",
                "@gliss 的标签必须指向已生成且具有排版盒子的对象",
                this.sourceSpan
            );
        }
        const attachment = new GlissAttachment(from, to, this.sourceSpan);
        ctx.addAttachment(attachment);
        ctx.deferFinalize(result => attachment.finalize(result), 1);
        return [];
    }

    override toString(source: string) {
        const from = this.from instanceof ASTFunctionNode ? this.from.label : undefined;
        const to = this.to instanceof ASTFunctionNode ? this.to.label : undefined;
        return from && to ? `@gliss(${from}, ${to})` : source.slice(this.sourceSpan.start, this.sourceSpan.end);
    }
}

export const GlissNode: ASTFunctionClass = GlissFunction;

function layoutHost(node: VisualTemporalNode, line?: HorizontalLineView): VisualTemporalNode {
    while (node.foldedInto && isVisualTemporalNode(node.foldedInto) && (!line || line.columnOf(node) < 0)) {
        node = node.foldedInto;
    }
    return node;
}

class GlissAttachment implements LayoutAttachment {
    readonly layer = "foreground" as const;
    endPoints: [VisualTemporalNode, VisualTemporalNode];
    private direction: number | undefined;

    constructor(
        from: VisualTemporalNode,
        to: VisualTemporalNode,
        readonly sourceSpan: SourceSpan,
    ) {
        this.endPoints = [from, to];
    }

    finalize({ columns, diagnostics }: LoweringResult) {
        const [a, b] = this.endPoints;
        let fromHost = layoutHost(a);
        let toHost = layoutHost(b);
        if (fromHost.t.equals(toHost.t)) {
            throw new ErrorDiagnostic("E_GLISS_ORDER", "@gliss 两个端点不能位于同一时刻", this.sourceSpan);
        }
        if (fromHost.t.compare(toHost.t) > 0) {
            this.endPoints = [b, a];
            [fromHost, toHost] = [toHost, fromHost];
        }
        const [endpoint, target] = this.endPoints;
        const sourcePitchNode = findPitchNode(columns, endpoint, fromHost);
        const targetPitchNode = findPitchNode(columns, target, toHost);
        if (!sourcePitchNode || !targetPitchNode) {
            diagnostics.push(new WarningDiagnostic(
                "W_GLISS_NO_PITCH",
                "@gliss 端点没有可用音高",
                this.sourceSpan,
            ));
            return;
        }
        this.direction = Math.sign(targetPitchNode.resolvedMidi - sourcePitchNode.resolvedMidi);

        const emit = endpoint.emitPlayback;
        const targetMidi = targetPitchNode.resolvedMidi + (targetPitchNode.playbackState?.pitchShift ?? 0);
        endpoint.emitPlayback = emitter => {
            emit?.call(endpoint, emitter);
            const { start: glissStart, end: glissEnd } = emitter;
            emitter.defer(context => {
                for (let i = context.notes.length - 1; i >= 0; i--) {
                    const note = context.notes[i];
                    if (note.track !== emitter.track) continue;
                    if (!note.end.equals(glissEnd)) return;
                    context.transform(note, (_ctx, owned) => {
                        const item = owned.at(-1)!;
                        const startFrom = glissStart.compare(item.start) > 0 ? glissStart : item.start;
                        const steps = Math.abs(targetMidi - item.midi);
                        if (item.end.compare(startFrom) <= 0 || steps <= 1) return;
                        const dir = Math.sign(targetMidi - item.midi);
                        const step = item.end.clone().sub(startFrom).div(steps);
                        return [
                            ...owned.slice(0, -1),
                            ...Array.from({ length: steps }, (_, k) => ({
                                ...item,
                                start: k === 0 ? item.start.clone() : step.clone().mul(k).add(startFrom),
                                end: step.clone().mul(k + 1).add(startFrom),
                                midi: item.midi + k * dir,
                            })),
                        ];
                    });
                    return;
                }
            });
        };
    }

    /** 定位端点所在时间列，并为箭头登记水平留白 */
    prepareHorizontal(lines: HorizontalLineView[]) {
        const [endpoint, target] = this.endPoints;
        const fromLine = lines[endpoint.layoutLine];
        const toLine = lines[target.layoutLine];
        const from = fromLine && layoutHost(endpoint, fromLine);
        const to = toLine && layoutHost(target, toLine);
        const start = from ? fromLine.columnOf(from) : -1;
        const end = to ? toLine.columnOf(to) : -1;
        if (!fromLine || !toLine || start < 0 || end < 0 || (fromLine === toLine && end <= start)) {
            throw new ErrorDiagnostic(
                "E_GLISS_DOMAIN",
                "@gliss 的端点必须位于同一排版域的不同时间列",
                this.sourceSpan,
            );
        }
        const span = Math.max(endpoint.ast.size, target.ast.size) * 1.4;
        const right = from.box.w - from.box.anchor + span;
        // 只扩张求解器占位，不改变端点图形、附点位置或下一轮的 box
        fromLine.registerHorizontalLayoutHook(from, from, ({ columns }) => {
            // 留白作用于起点整列；取最大值，避免多条关系重复累加占位。
            for (const element of columns[start]) element.WR = Math.max(element.WR, right);
        });
        if (fromLine !== toLine) {
            const left = to.box.anchor + span;
            toLine.registerHorizontalLayoutHook(to, to, ({ columns }) => {
                for (const element of columns[end]) element.WL = Math.max(element.WL, left);
            });
        }
    }

    createGeometry(context: AttachmentLayoutContext) {
        const [from, to] = this.endPoints;
        const size = Math.max(from.ast.size, to.ast.size);
        const gap = size * 0.12;
        const dy = from.track === to.track ? (this.direction ?? 0) * size * 0.24 : 0;
        const start = { x: from.box.x + from.box.w + gap, y: from.box.y + from.box.visualAxis + dy };
        const end = {
            x: to.box.x - gap,
            y: from.track === to.track && this.direction === undefined && from.layoutLine === to.layoutLine
                ? start.y
                : to.box.y + to.box.visualAxis - dy,
        };
        const pairs = [[start, end, from.layoutLine, from.track] as const];
        if (from.layoutLine !== to.layoutLine) {
            const end1X = Math.max(start.x + size, lineRightX(context, from.layoutLine));
            const start2X = Math.min(end.x - size, lineEntryX(context, to.layoutLine, to.track, end.x));
            const w1 = end1X - start.x;
            const cut = dy * (1 - 2 * w1 / (w1 + end.x - start2X));
            pairs[0] = [start, { x: end1X, y: start.y - dy + cut }, from.layoutLine, from.track];
            pairs.push([{ x: start2X, y: end.y + dy + cut }, end, to.layoutLine, to.track]);
        } else if (end.x <= start.x) {
            throw new ErrorDiagnostic(
                "E_GLISS_SPACE",
                "@gliss 的端点之间没有可用的水平绘制空间",
                this.sourceSpan,
            );
        }
        const strokeWidth = size * 0.05;
        const commands: PathCommand[] = [];
        const regions = pairs.map(([s, e, line, track], i) => {
            const part: PathCommand[] = [{ op: "M", ...s }, { op: "L", ...e }];
            if (i === pairs.length - 1) {
                const angle = Math.atan2(e.y - s.y, e.x - s.x);
                const length = Math.min(size * 0.3, Math.hypot(e.x - s.x, e.y - s.y) * 0.35);
                const wing = (offset: number) => ({
                    x: e.x - length * Math.cos(angle + offset),
                    y: e.y - length * Math.sin(angle + offset),
                });
                part.push({ op: "M", ...wing(-Math.PI / 6) }, { op: "L", ...e }, { op: "L", ...wing(Math.PI / 6) });
            }
            commands.push(...part);
            const bounds = pathBounds(part);
            return {
                x: bounds.x - strokeWidth / 2, y: bounds.y - strokeWidth / 2,
                w: bounds.w + strokeWidth, h: bounds.h + strokeWidth, line, track,
            };
        });
        return {
            regions,
            // 跨轨连线不把整段高度算到起点轨，否则纵向求解会反复撑开两轨
            occupancy: from.track === to.track ? regions : [],
            paint: (painter: Painter) => {
                painter.drawPath(commands, { fill: "none", stroke: "#000", strokeWidth });
            },
        };
    }
}
