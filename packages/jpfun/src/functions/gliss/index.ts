import { ErrorDiagnostic, WarningDiagnostic, type Diagnostic } from "../../diagnostic.js";
import { pathBounds } from "../../layout/path.js";
import type { HorizontalLineView, LayoutAttachment } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { Painter, PathCommand } from "../../render/types.js";
import {
    ASTFunctionNode, type ASTFunctionClass, type ASTNodeBase, type FunctionArgs,
    type ParserContext, type SourceSpan,
} from "../ASTtypes.js";
import { isVisualTemporalNode, type TemporalNodeBase, type VisualTemporalNode } from "../temporal.js";

// gliss 判断音高的准则是 resolvedMidi 属性
function pitchOf(node: object): number | undefined {
    const { resolvedMidi } = node as { resolvedMidi?: unknown };
    return typeof resolvedMidi === "number" ? resolvedMidi : undefined;
}

class GlissFunction extends ASTFunctionNode {
    static override def = {
        name: ["gliss"],
        description: "滑音连线",
        details: `\
~~~jpfun
1 -@a 5@b @gliss(a, b)
~~~
若附属对象无音高，将使用前面最近的的同轨有音高对象的音高`,
        allowExtraArgs: false,
        args: [
            {
                type: "label" as const,
                default: null,
                description: "一个端点的标签，先后按谱面时间确定"
            },
            {
                type: "label" as const,
                default: null,
                description: "另一个端点的标签"
            },
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
        ctx.addAttachment(new GlissAttachment(from, to, this.sourceSpan, ctx.diagnostics));
        return [];
    }

    override toString(source: string) {
        const from = this.from instanceof ASTFunctionNode ? this.from.label : undefined;
        const to = this.to instanceof ASTFunctionNode ? this.to.label : undefined;
        return from && to ? `@gliss(${from}, ${to})` : source.slice(this.sourceSpan.start, this.sourceSpan.end);
    }
}

export const GlissNode: ASTFunctionClass = GlissFunction;

function layoutHost(node: TemporalNodeBase, line?: HorizontalLineView): TemporalNodeBase {
    while (node.foldedInto && (!line || !isVisualTemporalNode(node) || line.columnOf(node) < 0)) node = node.foldedInto;
    return node;
}

class GlissAttachment implements LayoutAttachment {
    readonly layer = "foreground" as const;
    readonly endPoints: readonly [VisualTemporalNode, VisualTemporalNode];
    private direction: number | undefined;
    private warned = false;

    constructor(
        readonly from: VisualTemporalNode,
        readonly to: VisualTemporalNode,
        readonly sourceSpan: SourceSpan,
        private readonly diagnostics: Diagnostic[],
    ) {
        this.endPoints = [from, to];
    }

    private get orderedEndpoints() {
        const [a, b] = this.endPoints;
        const fromHost = layoutHost(a);
        const toHost = layoutHost(b);
        const { sourceSpan } = this;
        if (fromHost.t.equals(toHost.t))
            throw new ErrorDiagnostic(
                "E_GLISS_ORDER",
                "@gliss 两个端点不能位于同一时刻",
                sourceSpan
            );
        if (fromHost.layoutLine !== toHost.layoutLine)
            throw new ErrorDiagnostic(
                "E_GLISS_CROSS_LINE",
                "@gliss 不支持跨谱面行",
                sourceSpan
            );
        return fromHost.t.compare(toHost.t) > 0 ? [b, a] as const : [a, b] as const;
    }

    /** 定位端点所在时间列，按需解析音高，并为箭头登记水平留白 */
    prepareHorizontal(lines: HorizontalLineView[]) {
        const [endpoint, target] = this.orderedEndpoints;
        const { sourceSpan } = this;
        // 找到同时包含两个端点宿主的谱面行，折叠端点按当前行映射到宿主
        for (const [index, line] of lines.entries()) {
            const from = layoutHost(endpoint, line);
            const to = layoutHost(target, line);
            if (!isVisualTemporalNode(from) || !isVisualTemporalNode(to)) continue;
            const start = line.columnOf(from);
            const end = line.columnOf(to);
            if (start < 0 || end < 0) continue;
            if (start >= end) break;
            const resolvePitch = (node: VisualTemporalNode, column: number) => {
                if ("resolvedMidi" in node) return pitchOf(node);
                const track = layoutHost(node, line).track;
                // 当前行找不到时继续查找前面的谱面行，不要求时值连续
                for (let i = index; i >= 0; i--) {
                    const columns = lines[i].columns;
                    // 从端点前一列倒查同轨对象；首个带音高属性的对象即终止搜索，空值也不跳过
                    for (let j = i === index ? column - 1 : columns.length - 1; j >= 0; j--) {
                        const previous = columns[j].find(item => item.track === track && "resolvedMidi" in item);
                        if (previous) return pitchOf(previous);
                    }
                }
            };
            const sourcePitch = resolvePitch(endpoint, start);
            const targetPitch = resolvePitch(target, end);
            this.direction = sourcePitch === undefined || targetPitch === undefined
                ? undefined : Math.sign(targetPitch - sourcePitch);
            if (this.direction === undefined && !this.warned) {
                this.diagnostics.push(new WarningDiagnostic(
                    "W_GLISS_NO_PITCH",
                    "@gliss 端点没有可用音高",
                    sourceSpan,
                ));
                this.warned = true; // prepareHorizontal 不一定只执行一次 所以要防抖
            }
            const right = from.box.w - from.box.anchor + this.size * 1.4;
            // 只扩张求解器占位，不改变端点图形、附点位置或下一轮的 box
            line.registerHorizontalLayoutHook(from, to, ({ columns }) => {
                // 留白作用于起点整列；取最大值，避免多条关系重复累加占位。
                for (const element of columns[start]) element.WR = Math.max(element.WR, right);
            });
            return;
        }
        throw new ErrorDiagnostic(
            "E_GLISS_DOMAIN",
            "@gliss 的端点必须位于同一排版域的不同时间列",
            this.sourceSpan
        );
    }

    private get size() {
        return Math.max(this.from.ast.size, this.to.ast.size);
    }

    createGeometry() {
        // 子域附件可能直接进入几何测量，未经过 prepareHorizontal
        const [from, to] = this.orderedEndpoints;
        const size = this.size;
        const gap = size * 0.12;
        const start = { x: from.box.x + from.box.w + gap, y: from.box.y + from.box.visualAxis };
        const end = { x: to.box.x - gap, y: to.box.y + to.box.visualAxis };
        if (from.track === to.track) {
            if (this.direction === undefined) {
                end.y = start.y;
            } else {
                start.y += this.direction * size * 0.24;
                end.y -= this.direction * size * 0.24;
            }
        }
        if (end.x <= start.x) {
            throw new ErrorDiagnostic(
                "E_GLISS_SPACE",
                "@gliss 的端点之间没有可用的水平绘制空间",
                this.sourceSpan
            );
        }
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const length = Math.min(size * 0.3, Math.hypot(end.x - start.x, end.y - start.y) * 0.35);
        const wing = (offset: number) => ({
            x: end.x - length * Math.cos(angle + offset),
            y: end.y - length * Math.sin(angle + offset),
        });
        const commands: PathCommand[] = [
            { op: "M", ...start }, { op: "L", ...end },
            { op: "M", ...wing(-Math.PI / 6) }, { op: "L", ...end },
            { op: "L", ...wing(Math.PI / 6) },
        ];
        const strokeWidth = size * 0.05;
        const bounds = pathBounds(commands);
        const region = {
            x: bounds.x - strokeWidth / 2, y: bounds.y - strokeWidth / 2,
            w: bounds.w + strokeWidth, h: bounds.h + strokeWidth,
        };
        return {
            regions: [{ ...region, line: from.layoutLine, track: from.track }],
            // 跨轨连线不把整段高度算到起点轨，否则纵向求解会反复撑开两轨
            occupancy: from.track === to.track ? [{ ...region, line: from.layoutLine, track: from.track }] : [],
            paint: (painter: Painter) => {
                painter.drawPath(commands, { fill: "none", stroke: "#000", strokeWidth });
            },
        };
    }
}
