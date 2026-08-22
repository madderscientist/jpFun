import { ErrorDiagnostic } from "../../diagnostic.js";
import { Fraction } from "../../fraction.js";
import type { AttachmentLayoutContext, LayoutAttachment, Rect } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { Track } from "../../lowering/track.js";
import {
    isVisualTemporalNode,
    type LoweringGroup,
    type LoweringResult,
    type TemporalNodeBase,
    type VisualTemporalNode,
} from "../../lowering/types.js";
import type { Painter, TextStyle } from "../../render/types.js";
import {
    ASTFunctionNode,
    type ASTFunctionClass,
    type ASTNodeBase,
    type FunctionArgs,
    type ParserContext,
    type SourceSpan,
} from "../ASTtypes.js";
import { JIANPU_NUMBER_FONT } from "../note/index.js";

/**
 * tuplet 的比例要等内容全部展开后才能推导，因此 enter 阶段只收集事件引用，
 * exit 阶段再根据完整作用域统一缩放。事件本身仍由普通 lowering 流程加入全局列。
 */
interface TupletLoweringGroup extends LoweringGroup {
    events: TemporalNodeBase[];
}

/**
 * 多连音是范围时值变换，不产生自己的 Temporal：
 * actual = 内容原总时值 / 最短正时值
 * 目标总时值 = 最短正时值 * normal
 */
class TupletFunction extends ASTFunctionNode {
    static override def = {
        name: ["tuplet"],
        description: "多连音",
        example: `@tuplet({1/23}, 4): 内容含5个最短时值单位，压缩到4倍最短单位的总时长，所以是八分音符的五连音，总时长为二分音符`,
        allowExtraArgs: false,
        args: [
            {
                type: "content" as const,
                default: null,
            },
            {
                name: "normal",
                type: "number" as const,
                default: null,
            },
        ],
    };

    static override loweringFinalize = (result: LoweringResult) => {
        for (const attachment of result.attachments) {
            if (attachment instanceof TupletLayoutAttachment) attachment.validate();
        }
    };

    readonly content: ASTNodeBase;
    readonly normal: number;

    override get children() { return [this.content]; }

    override timeFlowModel() {
        return {
            mode: "sequence" as const,
            children: [this.content],
        };
    }

    override loweringEnter(ctx: LoweringContext) {
        const events: TemporalNodeBase[] = [];
        const group: TupletLoweringGroup = {
            events,
            onTemporal(node) {
                // 此时不能改 T：actual 依赖整个作用域的最短值和总和。
                events.push(node);
            },
        };
        ctx.beginLoweringGroup(this, group);
        return [];
    }

    override loweringExit(ctx: LoweringContext, _track: Track, timeOffset: Fraction) {
        const group = ctx.endLoweringGroup(this) as TupletLoweringGroup;

        // 零时长控制事件不构成连音单位，但稍后仍要随整组移动其开始位置。
        const positive = group.events.filter(event => event.T.compare(0) > 0);
        if (positive.length === 0) {
            throw new ErrorDiagnostic(
                "E_TUPLET_EMPTY",
                "@tuplet 的内容必须产生至少一个正时值事件",
                this.sourceSpan,
            );
        }

        // 一个 tuplet 只拥有一个时间游标和一条括线；并行分支无法用这组语义表达。
        const track = positive[0].track;
        if (positive.some(event => event.track !== track)) {
            throw new ErrorDiagnostic(
                "E_TUPLET_PARALLEL_CONTENT",
                "@tuplet 的内容不能包含并行音轨",
                this.sourceSpan,
            );
        }

        // writtenTotal / shortest 必须精确为整数，该整数就是谱面上显示的 actual
        const shortest = positive[0].T.clone();
        const writtenTotal = new Fraction();
        for (const event of positive) {
            if (event.T.compare(shortest) < 0) shortest.copyFrom(event.T);
            writtenTotal.add(event.T);
        }

        const units = writtenTotal.clone().div(shortest);
        const actual = units.numerator;
        if (units.denominator !== 1 || actual < 2 || !Number.isSafeInteger(actual)) {
            throw new ErrorDiagnostic(
                "E_TUPLET_NON_INTEGRAL_UNITS",
                "@tuplet 的总时值必须是最短正时值的整数倍，且至少包含2个单位",
                this.sourceSpan,
            );
        }
        if (this.normal === actual) {
            throw new ErrorDiagnostic(
                "E_TUPLET_INVALID_RATIO",
                `@tuplet 的 normal 不能等于推导出的 actual (${actual})`,
                this.sourceSpan,
            );
        }

        // 以作用域最早时间为仿射缩放原点，不能直接缩放绝对 t，否则嵌套位置会漂移。
        let start = group.events[0].t;
        for (let i = 1; i < group.events.length; i++) {
            if (group.events[i].t.compare(start) < 0) start = group.events[i].t;
        }
        start = start.clone();

        // t、T 与 lowering 游标必须一起修改；后继节点才会从缩放后的组尾继续。
        const offset = new Fraction();
        for (const event of group.events) {
            offset.copyFrom(event.t).sub(start).mul(this.normal, actual);
            event.t.copyFrom(start).add(offset);
            event.T.mul(this.normal, actual);
        }
        timeOffset.copyFrom(start).add(shortest.mul(this.normal));

        // 括线只依附可见主体；时值缩放本身仍覆盖所有收集到的事件。
        const visible = positive.filter(isVisualTemporalNode);
        if (visible.length >= 2) {
            ctx.addLayoutAttachment(new TupletLayoutAttachment(visible, actual, this.sourceSpan));
        }
        return [];
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        const [content, normal] = this.getArgValue(args, ctx) as [ASTNodeBase, number];
        // normal 是目标包含的“最短时值单位数”，不是 QN 数，也不是显示的 actual。
        if (!Number.isSafeInteger(normal) || normal <= 0) {
            throw new ErrorDiagnostic(
                "E_TUPLET_INVALID_NORMAL",
                "@tuplet 的 normal 必须是正的安全整数",
                span,
            );
        }
        this.content = content;
        this.normal = normal;
        content.parent = this;
    }

    override toString(source: string) {
        return `@tuplet(${this.content.toString(source)}, ${this.normal})`;
    }
}

export const TupletNode: ASTFunctionClass = TupletFunction;

/**
 * 多连音括线是跨多个宿主的前景 attachment。lowering 冻结端点与 actual，
 * layout 根据最终宿主坐标测量数字和括线，paint 只回放已冻结的绝对几何。
 */
class TupletLayoutAttachment implements LayoutAttachment {
    box: Rect = { x: 0, y: 0, w: 0, h: 0 };
    layer = "foreground" as const;

    /** lowering 固化的连音语义；重复 layout 时保持不变 */
    private readonly endPoints: readonly VisualTemporalNode[];
    private readonly actual: number;
    private readonly sourceSpan: SourceSpan;

    /** 由端点最大字号冻结的绘制规格 */
    private readonly style: TextStyle;
    private readonly size: number;

    /** 当前 layout pass 计算出的绝对几何，供 paint 直接读取 */
    private lines: [x1: number, y1: number, x2: number, y2: number][] = [];
    private textX = 0;
    private textBaseline = 0;
    private strokeWidth = 1;

    constructor(endPoints: readonly VisualTemporalNode[], actual: number, sourceSpan: SourceSpan) {
        this.endPoints = endPoints;
        this.actual = actual;
        this.sourceSpan = sourceSpan;
        this.size = endPoints.reduce((size, endpoint) => Math.max(size, endpoint.ast.size), 0);
        this.style = {
            fontSize: this.size * 0.72,
            fontFamily: JIANPU_NUMBER_FONT,
            textAlign: "center",
            fill: "#000",
        };
    }

    validate() {
        const first = this.endPoints[0];
        // 当前实现只有单段括线，没有跨谱面行的首段/末段几何。
        if (this.endPoints.some(endpoint => endpoint.layoutLine !== first.layoutLine)) {
            throw new ErrorDiagnostic(
                "E_TUPLET_CROSS_LINE",
                "@tuplet 的内容不能跨越谱面行",
                this.sourceSpan,
            );
        }
    }

    layout(context: AttachmentLayoutContext) {
        const first = this.endPoints[0];
        const last = this.endPoints[this.endPoints.length - 1];

        // 括线覆盖首末主体的核心范围；没有 body 端口时回退到完整盒边界。
        const firstLeft = first.ports["body.left"]?.x ?? 0;
        const lastRight = last.ports["body.right"]?.x ?? last.box.w;
        let left = first.box.x + firstLeft;
        let right = last.box.x + lastRight;
        if (left > right) [left, right] = [right, left];

        // 数字位于跨度中心，水平线在数字两侧断开，并预留一个字号相关的空隙。
        const metrics = context.textMeasurer.measureText(String(this.actual), this.style);
        const center = (left + right) / 2;
        const textGap = this.size * 0.12;
        const hookHeight = this.size * 0.18;
        const hostGap = this.size * 0.14;
        // hostExtent 是相对轨道视觉轴的主体占用；转为绝对坐标后再向上放置括线。
        const axis = context.getVisualAxis(first.layoutLine, first.track);
        const hostTop = axis + (context.getHostExtent(first.layoutLine, first.track)?.top ?? 0);
        this.strokeWidth = Math.max(1, this.size * 0.055);
        const lineY = hostTop - hostGap - Math.max(hookHeight, metrics.h / 2);
        const hookBottom = lineY + hookHeight;
        this.textX = center;
        this.textBaseline = lineY - metrics.h / 2 + metrics.baseline;
        const textLeft = center - metrics.w / 2 - textGap;
        const textRight = center + metrics.w / 2 + textGap;
        // 先记录左右横线，再记录两端向下的短钩；短跨度允许省略横线但保留端钩
        this.lines = [];
        if (textLeft > left) this.lines.push([left, lineY, textLeft, lineY]);
        if (textRight < right) this.lines.push([textRight, lineY, right, lineY]);
        this.lines.push([left, lineY, left, hookBottom], [right, lineY, right, hookBottom]);

        // region 同时包含文字与描边，并声明 line/track 让纵向求解为括线腾出空间
        const halfStroke = this.strokeWidth / 2;
        const top = Math.min(lineY - metrics.h / 2, lineY - halfStroke);
        const bottom = Math.max(lineY + metrics.h / 2, hookBottom + halfStroke);
        return [{
            x: left - halfStroke,
            y: top,
            w: right - left + this.strokeWidth,
            h: bottom - top,
            line: first.layoutLine,
            track: first.track,
        }];
    }

    paint(painter: Painter) {
        const lineStyle = { stroke: "#000", strokeWidth: this.strokeWidth };
        for (const [x1, y1, x2, y2] of this.lines) {
            painter.drawLine(x1, y1, x2, y2, lineStyle);
        }
        painter.drawText(String(this.actual), this.textX, this.textBaseline, this.style);
    }
}