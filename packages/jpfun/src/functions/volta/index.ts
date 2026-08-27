import type {
    AttachmentLayoutContext,
    HorizontalLineView,
    LayoutAttachment,
    LayoutHost,
} from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { Track } from "../../lowering/track.js";
import {
    ANCHOR_KEY,
    isVisualTemporalNode,
    type TemporalNodeBase,
    type VisualTemporalNode,
} from "../../lowering/types.js";
import type { Painter, TextStyle } from "../../render/types.js";
import type { PlaybackColumnOf, PlaybackFlow, PlaybackFlowHook } from "../../playback/types.js";
import { repeatPass } from "../bar/index.js";
import {
    ASTFunctionNode,
    type ASTFunctionClass,
    type ASTNodeBase,
    type FunctionArgs,
    type ParserContext,
    type SourceSpan,
} from "../ASTtypes.js";
import { Diagnostic, ErrorDiagnostic } from "../../diagnostic.js";

class VoltaFunction extends ASTFunctionNode {
    static override def = {
        name: ["volta"],
        description: "反复房子",
        example: `@volta(from, to, pass, ...) 只在指定遍数演奏的一段区间
from 和 to 是区间首末音符的标签，因此房子可以横跨谱面行
pass 是遍数：整段谱面演奏到第几遍时才播这里，必填正整数
再写几个遍数就是几遍共用一个房子，顺序随意，标签按升序写成 1.2.

|: 1 2 | 3@a 4@b :| 5@c 6@d | 7
@volta(a, b, 1)  @volta(c, d, 2)`,
        allowExtraArgs: true,
        extraArgType: "number" as const,
        args: [
            {   // 本来设计是函数包裹，但这样实现不了跨行的房子，所以改为关系型
                name: "from",
                type: "label" as const,
                default: null,
            },
            {
                name: "to",
                type: "label" as const,
                default: null,
            },
            {
                // 不给默认值：房子上的数字本来就是谱面的一部分，漏写会让整段被静默跳过
                name: "pass",
                type: "number" as const,
                default: null,
            },
        ],
    };

    readonly from: ASTNodeBase;
    readonly to: ASTNodeBase;
    /** 进入本房子的遍数，升序去重 */
    readonly passes: readonly number[];
    /** 区间没有可见宿主时括线的尺寸基准 */
    readonly size: number;

    /** volta 不推进时间，只把 AST 端点解析成稳定的 temporal 引用 */
    override loweringEnter(ctx: LoweringContext) {
        let from = ctx.getTemporalNodes(this.from).at(0);
        let to = ctx.getTemporalNodes(this.to).at(-1);
        while (from?.foldedInto) from = from.foldedInto;
        while (to?.foldedInto) to = to.foldedInto;
        if (!from || !to) {
            ctx.diagnostics.push(Diagnostic.warning.UnresolvedEndpoint("volta", this.sourceSpan));
            return [];
        }
        ctx.addAttachment(new VoltaAttachment(this, from, to));
        return [];
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        const [from, to, pass] = this.getArgValue(args, ctx) as [ASTNodeBase, ASTNodeBase, number];
        // 第一个遍数走 def.args，其余的落在 extraArgType 里，按位置索引取
        const passes = new Set([pass]);
        for (let i = 3; args.has(i); i++) passes.add(args.get(i) as number);
        this.from = from;
        this.to = to;
        this.passes = [...passes].sort((a, b) => a - b);
        this.size = ctx.fontSize;
        if (this.passes.some(value => !Number.isSafeInteger(value) || value <= 0)) {
            throw new ErrorDiagnostic(
                "E_VOLTA_INVALID_PASS",
                "@volta 的遍数必须是正整数",
                span,
            );
        }
    }

    override toString(source: string) {
        const name = (node: ASTNodeBase) => (node as ASTFunctionNode).label ?? node.toString(source);
        return `@volta(${name(this.from)}, ${name(this.to)}, ${this.passes.join(", ")})`;
    }
}

export const VoltaNode: ASTFunctionClass = VoltaFunction;

/** 取 ANCHOR 列的几何宿主 */
function barIn(column: readonly LayoutHost[] | undefined) {
    if (column?.[0]?.mergeKey !== ANCHOR_KEY) return undefined;
    return column[0];
}

class VoltaAttachment implements LayoutAttachment, PlaybackFlow {
    layer = "foreground" as const;

    /** 首末端点列最上方的对象、区间最大字号与紧邻的小节线，横向准备时填入 */
    private head?: LayoutHost;
    private tail?: LayoutHost;
    private span = 0;
    private leftBar?: LayoutHost;
    private rightBar?: LayoutHost;
    /** 逐行记下覆盖列内各轨的最高点，相对该轨视觉轴；轴要等纵向求解才知道 */
    private readonly topsByLine: Map<Track, number>[] = [];

    constructor(
        private readonly ast: VoltaFunction,
        readonly from: TemporalNodeBase,
        readonly to: TemporalNodeBase,
    ) {}

    get passes() { return this.ast.passes; }
    get sourceSpan(): SourceSpan { return this.ast.sourceSpan; }

    /** 房子只决定跳不跳过本列；遍数怎么数、什么时候回跳都归小节线 */
    playbackFlow(columnOf: PlaybackColumnOf): PlaybackFlowHook | undefined {
        const from = columnOf(this.from);
        const to = columnOf(this.to);
        if (from === undefined || to === undefined) return;
        const start = Math.min(from, to);
        const end = Math.max(from, to);
        return {
            range: [start, end],
            // 这里还是会和 bar 耦合。但只有bar有反复功能，不值得抽取为系统机制
            run: cursor => this.passes.includes(repeatPass(cursor, start))
                ? undefined
                : { kind: "jump", column: end + 1 },
        };
    }

    prepareHorizontal(lines: HorizontalLineView[]) {
        if (!isVisualTemporalNode(this.from) || !isVisualTemporalNode(this.to)) return;
        const locate = (node: VisualTemporalNode) => {
            const view = lines[node.layoutLine];
            return { line: node.layoutLine, view, column: view.columnOf(node) };
        };
        // 两个标签谁写在前面不一定，按谱面顺序摆正
        let [from, to] = [locate(this.from), locate(this.to)];
        if (from.line > to.line || (from.line === to.line && from.column > to.column)) {
            [from, to] = [to, from];
        }
        if (from.column < 0 || to.column < 0) return;

        this.head = from.view.columns[from.column][0];
        this.tail = to.view.columns[to.column][0];
        this.leftBar = barIn(from.view.columns[from.column - 1]);
        this.rightBar = barIn(to.view.columns[to.column + 1]);

        this.span = 0;
        this.topsByLine.length = 0;
        // 括线盖住的是：首行从起点列向右、末行向左到终点列、中间行整行
        for (let line = from.line; line <= to.line; line++) {
            const view = lines[line];
            const start = line === from.line ? from.column : 0;
            const end = line === to.line ? to.column : view.columns.length - 1;
            const tops = new Map<Track, number>();
            for (let column = start; column <= end; column++) {
                const hosts = view.columns[column];
                this.span = Math.max(this.span, hosts[0].ast.size);
                // 此刻 visualAxis 已冻结，纵向求解后 box.y 就是 该轨视觉轴 - visualAxis
                for (const host of hosts) {
                    const top = -host.box.visualAxis;
                    const known = tops.get(host.track);
                    if (known === undefined || top < known) tops.set(host.track, top);
                }
            }
            this.topsByLine.push(tops);
        }
    }

    createGeometry(context: AttachmentLayoutContext) {
        const { head, tail, leftBar, rightBar } = this;
        if (!head || !tail) return { regions: [], paint() {} };
        const firstLine = head.layoutLine;
        const lastLine = tail.layoutLine;

        const size = this.span || this.ast.size;
        const style: TextStyle = {
            fontSize: size * 0.6,
            textAlign: "left",
            fill: "#000",
        };
        const text = this.ast.passes.map(pass => `${pass}.`).join("");
        const metrics = context.textMeasurer.measureText(text, style);
        const strokeWidth = Math.max(1, size * 0.055);
        const halfStroke = strokeWidth / 2;
        const hook = metrics.h * 1.2;
        // 标签在下折钩的高度里垂直居中
        const textY = (hook - metrics.h) / 2 + metrics.baseline;

        // 中间行可能没有本房子的可见对象，仍要补满，所以按行号连续遍历
        const draws = Array.from({ length: lastLine - firstLine + 1 }, (_, offset) => {
            const line = firstLine + offset;

            // 跨行断开的那一侧一直画到页边，接上下一行
            const left = line !== firstLine ? context.originX
                : leftBar?.layoutLine === line ? leftBar.box.x + leftBar.box.anchor + 5 // 5是防止前后房子竖线重合
                    : head.box.x + (head.ports["body.left"]?.x ?? 0);
            const right = line !== lastLine ? context.originX + context.width
                : rightBar?.layoutLine === line ? rightBar.box.x + rightBar.box.anchor
                    : tail.box.x + (tail.ports["body.right"]?.x ?? tail.box.w);

            let topTrack = head.track;
            let hostTop = Infinity;
            for (const [track, top] of this.topsByLine[offset]) {
                const y = context.getVisualAxis(line, track) + top;
                if (y < hostTop) {
                    topTrack = track;
                    hostTop = y;
                }
            }
            // 整行空白时没有主体可以参照，退到轨道轴上
            if (hostTop === Infinity) hostTop = context.getVisualAxis(line, topTrack);
            return { left, right, lineY: hostTop - size * 0.2 - hook, line, track: topTrack };
        });

        return {
            regions: draws.map(({ left, right, lineY, line, track }) => ({
                x: left - halfStroke,
                y: lineY - halfStroke,
                w: right - left + strokeWidth,
                h: hook + strokeWidth,
                line,
                track,
            })),
            paint(painter: Painter) {
                const lineStyle = { stroke: "#000", strokeWidth };
                for (const { left, right, lineY, line } of draws) {
                    painter.drawLine(left, lineY, right, lineY, lineStyle);
                    // 只有房子真正开始和结束的那一端才下折
                    if (line === firstLine) {
                        painter.drawLine(left, lineY, left, lineY + hook, lineStyle);
                        painter.drawText(text, left + size * 0.15, lineY + textY + 2, style);
                    }
                    if (line === lastLine) painter.drawLine(right, lineY, right, lineY + hook, lineStyle);
                }
            },
        };
    }
}
