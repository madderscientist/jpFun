import { ErrorDiagnostic } from "../../diagnostic.js";
import { prepareLayoutHost } from "../../layout/engine.js";
import type { LayoutBox, LayoutPoint, LayoutPrepareContext } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import { Fraction } from "../../fraction.js";
import type { Track } from "../../lowering/track.js";
import {
    isVisualTemporalNode,
    TemporalNodeBase,
    type VisualTemporalNode,
} from "../../lowering/types.js";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import { ParserContext } from "../../parser/parserContext.js";
import type { Painter, PathCommand } from "../../render/types.js";
import {
    ASTBraceNode,
    ASTFunctionClass,
    ASTFunctionNode,
    ASTLabelNode,
    ASTNodeBase,
    ASTTextNode,
    FunctionArgs,
    FunctionDef,
    SourceSpan,
} from "../ASTtypes.js";
import { createBeamLayoutAttachment } from "../beam/layout.js";
import { DIV_ADDON_KEY } from "../div/index.js";

/** 倚音相对宿主的字号比例 */
const GRACE_SCALE = 0.7;
/**
 * 肩线端口：要在这个盒子上方叠东西的人，应该从哪条线开始
 *
 * 普通音符不发布它，读取方退化成盒顶即可（倚音本来就该避开上八度点）；
 * 复合节点发布它，指向自己内部那个真正承载节奏的音符的顶边。
 */
const SHOULDER_PORT = "shoulder";

type GraceSide = "pre" | "post";

/**
 * 递归缩小一棵子树里所有已冻结的字号
 *
 * 字号在 parse 时就冻结进各具体函数的 size 字段，而「谁是倚音」要到关系去糖时才知道，
 * 所以只能在此刻回头改。这发生在 parse 进行中，不违反「AST parse 后只读」。
 */
function scaleFontSize(node: ASTNodeBase, factor: number) {
    const sized = node as { size?: number };
    if (typeof sized.size === "number") sized.size *= factor;
    for (const child of node.children ?? []) scaleFontSize(child, factor);
}

class GraceFunction extends ASTFunctionNode {
    static override def: FunctionDef = {
        name: ["grace"],
        description: "倚音",
        example: `前倚音: @grace(宿主, 倚音, side=pre) 后倚音: @grace(宿主, 倚音, side=post)
语法糖：'>' 与 '<'，箭头永远指向宿主
2>1     前倚音：2 是 1 的倚音，画在 1 的左上角
1<2     后倚音：2 是 1 的倚音，画在 1 的右上角
{3 2}>1 多个倚音用大括号括起来
1>2>3   允许嵌套：1 是 2 的倚音，2 是 3 的倚音
倚音默认就是八分音符（自带一条减时线），再写 '/' 变成十六分音符`,
        allowExtraArgs: true,
        args: [
            {
                name: "host",
                type: "content" as const,
                default: null,
            },
            {
                name: "grace",
                type: "content" as const,
                default: null,
            },
            {
                name: "side",
                type: "string" as const,
                default: "pre",
            }
        ],
    };

    override labelable() { return ASTFunctionNode.findLabelable(this.host); }

    static override deSugarAtom(source: string, start: number, _end: number) {
        let char = source[start];
        switch (char) {
            case '>': char = "pre"; break;
            case '<': char = "post"; break;
            default: return null;
        }
        return {
            next: start + 1,
            node: {
                kind: "sugar",
                data: {
                    class: GraceFunction,
                    side: char as GraceSide
                },
                span: { start, end: start + 1 }
            } as GrammarSugarNode
        };
    }

    // 取左右操作数的流程同 stack / up
    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        const n = nodes[at++] as GrammarSugarNode;
        if (n.kind !== "sugar" || n.data?.class !== GraceFunction) return null;
        const side: GraceSide = n.data.side;

        // 找上一个非文本节点 实现忽略中间内容的作用
        let left = ctx.nodes.length - 1;
        while (left >= 0 && ctx.nodes[left] instanceof ASTTextNode) left--;
        if (left < 0) {
            throw new ErrorDiagnostic(
                "E_GRACE_NO_TARGET",
                "@grace语法糖错误: 左边没有找到目标",
                n.span,
            );
        }
        let leftNode: ASTNodeBase = ctx.nodes[left];
        /** 左操作数在 ctx.nodes 中的起点；只有这一段会被 grace 吞并 */
        let replaceFrom = left;
        // 对 label 的特判: 目标变为label到被标记的节点范围内的所有节点
        if (leftNode instanceof ASTLabelNode) {
            let tgt: ASTNodeBase | null = leftNode.target;
            while (tgt && !ctx.nodes.includes(tgt)) tgt = tgt.parent;
            for (let j = left - 1; j >= 0; j--) {
                if (ctx.nodes[j] === tgt) {
                    leftNode = new ASTBraceNode({
                        start: tgt.sourceSpan.start,
                        end: leftNode.sourceSpan.end,
                    }, ctx.nodes.slice(j, left + 1), null);
                    replaceFrom = j;
                    break;
                }
            }
        }

        // 找到下一个非文本节点 通过全量后续解析的方式进行
        const storage = ctx.nodes;
        ctx.nodes = [];
        ctx.makeNodes(nodes, at);
        for (let i = 0; i < ctx.nodes.length; i++) {
            const right = ctx.nodes[i];
            if (right instanceof ASTTextNode) continue;

            // '<' 的倚音在右侧，右结合的解析结果本来就是嵌套语义，不必像 '>' 那样重排
            const node = side === "pre"
                ? GraceFunction.attachPre(leftNode, right, n.span, ctx)
                : GraceFunction.create(ctx, n.span, "post", leftNode, right);

            storage.length = replaceFrom;
            storage.push(node);
            while (++i < ctx.nodes.length) storage.push(ctx.nodes[i]);
            ctx.nodes = storage;
            return nodes.length;
        }
        throw new ErrorDiagnostic(
            "E_GRACE_NO_TARGET",
            "@grace语法糖错误: 右边没有找到目标",
            n.span,
        );
    }

    host: ASTNodeBase;
    grace: ASTNodeBase;
    side: GraceSide = "pre";
    size: number;

    /**
     * `A > B`：前倚音必须左结合，而右操作数是把后续全部解析完才取的，
     * 所以 `1>2>3` 到这里已经成了 `1>(2>3)`。把 A 插回链条最深处就能恢复为 `(1>2)>3`
     */
    private static attachPre(
        left: ASTNodeBase,
        right: ASTNodeBase,
        span: SourceSpan,
        ctx: ParserContext,
    ): ASTNodeBase {
        if (right instanceof GraceFunction && right.side === "pre") {
            // 找到最深层的 pre
            let deepest = right;
            let depth = 1;
            while (deepest.grace instanceof GraceFunction && deepest.grace.side === "pre") {
                deepest = deepest.grace;
                depth++;
            }
            const argMap: FunctionArgs = new Map();
            argMap.set(0, deepest.grace);
            argMap.set(1, left);
            const scale = GRACE_SCALE ** depth;
            const inner = new GraceFunction(span, argMap, ctx, null, GRACE_SCALE * scale);
            inner.size *= scale;
            deepest.setGrace(inner, 1);  // inner 内部已按深度缩放，不能再缩
            return right;
        }
        return GraceFunction.create(ctx, span, "pre", right, left);
    }

    private static create(
        ctx: ParserContext,
        span: SourceSpan,
        side: GraceSide,
        host: ASTNodeBase,
        grace: ASTNodeBase,
    ): ASTNodeBase {
        const argMap: FunctionArgs = new Map();
        argMap.set(0, host);
        argMap.set(1, grace);
        argMap.set("side", side);
        return new GraceFunction(span, argMap, ctx);
    }

    /** 宿主在前：findActiveDivs 下潜子树时要先命中宿主的 @div，而不是倚音的 */
    override get children(): ASTNodeBase[] {
        const out: ASTNodeBase[] = [];
        if (this.host) out.push(this.host);
        if (this.grace) out.push(this.grace);
        return out;
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null, scale: number = GRACE_SCALE) {
        super(span, parent);
        this.size = ctx.fontSize;

        [this.host, this.grace, this.side] = this.getArgValue(args, ctx) as [ASTNodeBase, ASTNodeBase, GraceSide];
        if (this.side !== "pre" && this.side !== "post") {
            throw new ErrorDiagnostic(
                "E_GRACE_INVALID_SIDE",
                "@grace 的 side 参数必须是 'pre' 或 'post'",
                span,
            );
        }
        this.adopt(this.host);
        this.setGrace(this.grace, scale);
        this.size = ctx.fontSize;
    }

    setGrace(node: ASTNodeBase, factor: number = GRACE_SCALE) {
        scaleFontSize(node, factor);
        this.grace = node;
        this.adopt(node);
    }

    private adopt(node: ASTNodeBase) {
        node.parent = this;
        this.sourceSpan.start = Math.min(this.sourceSpan.start, node.sourceSpan.start);
        this.sourceSpan.end = Math.max(this.sourceSpan.end, node.sourceSpan.end);
    }

    /** 倚音与宿主各自收敛成可见 Temporal，然后整体折叠进一个复合节点 */
    override loweringEnter(ctx: LoweringContext, track: Track) {
        if (!this.host || !this.grace) {
            throw new ErrorDiagnostic(
                "E_GRACE_MISSING_ARGS",
                "@grace 需要同时给出宿主和倚音",
                this.sourceSpan,
            );
        }

        let graces: VisualTemporalNode[] = [];
        let host: VisualTemporalNode | null = null;
        // 成员不是外层分组的成员，复合节点才是；否则 voice 的歌词会按下标错位
        ctx.isolateFromLoweringGroups(() => {
            const order = this.side === "pre"
                ? [this.grace!, this.host!]
                : [this.host!, this.grace!];
            for (const content of order) {
                const events = ctx.trackedEvents(content, new Fraction(), track).flat();
                const visible = events.filter(isVisualTemporalNode);
                // 并行分支的纵向关系由引擎解 Track 树，而折叠成员进不了引擎
                if (events.some(event => event.track !== track))
                    throw new ErrorDiagnostic(
                        "E_GRACE_PARALLEL_CONTENT",
                        "@grace 的内容不能包含多声部结构（& / @voices）；要在倚音里叠音请用 ^",
                        content.sourceSpan,
                    );
                if (content === this.host) {
                    if (visible.length !== 1 || visible.length !== events.length) {
                        throw new ErrorDiagnostic(
                            "E_GRACE_INVALID_HOST",
                            "@grace 的宿主必须恰好产生一个可见 Temporal",
                            content.sourceSpan,
                        );
                    }
                    host = visible[0];
                } else {
                    if (visible.length === 0 || visible.length !== events.length) {
                        throw new ErrorDiagnostic(
                            "E_GRACE_INVALID_CONTENT",
                            "@grace 的倚音必须只产生可见 Temporal，且至少一个",
                            content.sourceSpan,
                        );
                    }
                    graces = visible;
                }
            }
        });

        const composite = new GraceTemporal(this, host!, graces, this.side);
        // 倚音同段无条件全部相连，只被零时长标记切断，所以 grace 一定认识 beam，允许耦合
        // 折叠成员不进全局时间列，autobeam 看不到它们，要手动调用且强制连接
        for (const run of composite.graceRuns) {
            if (run.length < 2) continue;
            ctx.addLayoutAttachment(createBeamLayoutAttachment([...run], false, this.grace.sourceSpan));
        }
        return [composite];
    }

    override toString(source: string) {
        const host = this.host?.toString(source) ?? "";
        const grace = this.grace?.toString(source) ?? "";
        return `@grace(${host}, ${grace}, side=${this.side})`;
    }
}

export const GraceNode: ASTFunctionClass = GraceFunction;

//==== 倚音线 ====
// 固定形状的小钩，起点在最靠近宿主的那个倚音的 anchor、盒底边（后倚音镜像），
// 尺寸只跟倚音字号有关，不随倚音到宿主的距离变化。
const HOOK_COMMANDS: readonly PathCommand[] = [
    { op: "M", x: 0, y: 0 },
    { op: "C", cx1: -0.01, cy1: 0.26, cx2: 0.14, cy2: 0.42, x: 0.29, y: 0.36 },
];
const HOOK_WIDTH = 0.07;
/** 倚音块底边到宿主顶边的视觉间隙；倚音线会探进这段空间指向宿主 */
const GRACE_RISE = 0.18;
/** 倚音向宿主借时值的上限，防止宿主被偷光 */
const MAX_STEAL_RATIO = 0.75;


/** 倚音复合体：宿主与倚音都折叠在这一个盒子里，对外只是一个可见事件 */
export class GraceTemporal extends TemporalNodeBase {
    declare ast: GraceFunction;
    declare box: LayoutBox;

    readonly host: VisualTemporalNode;
    readonly graces: readonly VisualTemporalNode[];
    /** 承担节奏的倚音成员，按零时长标记切段；同段视觉上首尾相接，无条件连成一束减时线 */
    readonly graceRuns: readonly (readonly VisualTemporalNode[])[];
    readonly side: GraceSide;

    /** 成员相对本盒左上角的局部偏移，onPlaced 时同步为绝对坐标 */
    private hostOffset: LayoutPoint = { x: 0, y: 0 };
    private graceOffsets: LayoutPoint[] = [];
    /** 倚音线起点，同样是局部偏移 */
    private hookOrigin: LayoutPoint | null = null;

    constructor(
        ast: GraceFunction,
        host: VisualTemporalNode,
        graces: readonly VisualTemporalNode[],
        side: GraceSide,
    ) {
        super();
        this.ast = ast;
        this.host = host;
        this.graces = graces;
        this.side = side;

        this.T.copyFrom(host.T);
        this.mergeKey = host.mergeKey;
        this.initLayoutBox();

        // 宿主携带整体节奏，它的修饰暂时成为复合体的修饰，自动连梁才看得到
        if (host.addon) this.addon = { ...host.addon };
        host.addon = void 0;
        // 成员不进入全局 columns，对外由复合体代表：写在成员上的标签仍可做关系端点
        host.foldedInto = this;

        const runs: VisualTemporalNode[][] = [];
        let run: VisualTemporalNode[] = [];
        for (const grace of graces) {
            grace.foldedInto = this;
            // 调号、速度这类零时长标记不承担节奏，还会在视觉上把倚音串切断
            if (grace.T.isZero()) {
                if (run.length > 0) runs.push(run);
                run = [];
                continue;
            }
            run.push(grace);
            // 倚音默认就是八分音符：补一条减时线，书面时值随之减半
            const addon = grace.addon = { ...grace.addon };
            addon[DIV_ADDON_KEY] = (Number(addon[DIV_ADDON_KEY]) || 0) + 1;
            grace.T.divPow2();
        }
        if (run.length > 0) runs.push(run);
        this.graceRuns = runs;
    }

    /** 成员共享全局时间状态，按发声顺序固化 */
    override onTimeState(state: Record<string, any>) {
        // 同步时间的修改。比如tuplet修改的是GraceTemporal.T，这里要把它传给成员
        this.host.T.copyFrom(this.T);
        const members = this.side === "pre"
            ? [...this.graces, this.host]
            : [this.host, ...this.graces];
        for (const member of members) {
            member.t.copyFrom(this.t);
            member.track = this.track;
            member.layoutLine = this.layoutLine;
            member.onTimeState?.(state);
        }
    }

    /**
     * 播放时倚音从宿主借走的时值（前倚音从开头、后倚音从末尾）
     *
     * 比例 = 倚音字面总时值 / 四分音符，而四分音符 T=1，所以直接累加成员的 T。
     * 基准取宿主经过 div 与 dot 后的实际时值；延时线是独立事件、tie 不改 T，天然不计入。
     */
    get stealTime(): number {
        const written = this.graces.reduce((sum, grace) => sum + grace.T.toNumber(), 0);
        return Math.min(written, MAX_STEAL_RATIO) * this.T.toNumber();
    }

    /**
     * 宿主留在轨道基线上，倚音整体抬到它的左上或右上角
     *
     * 倚音成员之间自己紧排，不参与横向弹簧；整块的宽度计入复合盒，
     * 因此左右邻居会被固有宽度推开，不会在空间紧张时被压穿。
     */
    override prepareLayout(context: LayoutPrepareContext) {
        // lowering 期间修饰挂在复合体上（augmenter 要看到整体节奏），渲染时交给宿主：
        // 减时线要落在宿主数字与下八度点之间，而不是压在整个倚音盒下面
        if (this.addon) {
            this.host.addon = this.addon;
            this.addon = void 0;
        }
        for (const grace of this.graces) prepareLayoutHost(grace, context);
        prepareLayoutHost(this.host, context);

        const em = this.ast.size;
        const graceEm = em * GRACE_SCALE;
        const memberGap = graceEm * 0.16;
        const sideGap = graceEm * 0.2;
        const rise = graceEm * GRACE_RISE;

        let graceWidth = 0;
        let graceAxis = 0;
        let graceHeight = 0;
        // 倚音之间按视觉轴对齐，否则带下八度点的成员会把数字顶得比旁边高
        for (const grace of this.graces) graceAxis = Math.max(graceAxis, grace.box.visualAxis);
        this.graceOffsets = this.graces.map(grace => {
            const x = graceWidth;
            graceWidth += grace.box.w + memberGap;
            const y = graceAxis - grace.box.visualAxis;
            graceHeight = Math.max(graceHeight, y + grace.box.h);
            return { x, y };
        });
        if (this.graces.length > 0) graceWidth -= memberGap;

        // 倚音贴着宿主的肩线而不是宿主盒顶：宿主本身也是复合体时，
        // 肩线由它转发上来，所以两侧倚音会落在同一高度而不是层层叠高
        const shoulder = this.host.ports[SHOULDER_PORT]?.y ?? 0;
        const graceTop = shoulder - rise - graceHeight;
        const lift = Math.max(0, -graceTop);
        const graceX = this.side === "pre" ? 0 : this.host.box.w + sideGap;
        this.hostOffset = {
            x: this.side === "pre" ? graceWidth + sideGap : 0,
            y: lift,
        };
        for (const offset of this.graceOffsets) {
            offset.x += graceX;
            offset.y += graceTop + lift;
        }

        this.box.w = this.host.box.w + sideGap + graceWidth;
        this.box.h = lift + this.host.box.h;
        this.box.anchor = this.hostOffset.x + this.host.box.anchor;
        this.box.visualAxis = lift + this.host.box.visualAxis;

        // 端口原样上提：减时线、歌词、连音线都接到宿主上，关系函数不需要认识倚音
        for (const name in this.host.ports) {
            const port = this.host.ports[name];
            this.ports[name] = {
                x: this.hostOffset.x + port.x,
                y: this.hostOffset.y + port.y,
            };
        }
        // 宿主没有肩线时它自己的盒顶就是肩线；有则上面那轮转发已经带偏移抬好了
        this.ports[SHOULDER_PORT] ??= { x: this.box.anchor, y: this.hostOffset.y };

        // 钩形曲线挂在靠近宿主的那个倚音成员下方，零时长标记不承接它
        const near = this.side === "pre"
            ? this.graceRuns.at(-1)?.at(-1)
            : this.graceRuns[0]?.[0];
        this.hookOrigin = near ? {
            x: this.graceOffsets[this.graces.indexOf(near)].x + near.box.anchor,
            y: graceTop + lift + graceHeight,
        } : null;
    }

    /** 引擎每次改变本节点坐标后，按准备阶段保存的局部偏移重算成员绝对坐标 */
    override onPlaced() {
        this.host.box.x = this.box.x + this.hostOffset.x;
        this.host.box.y = this.box.y + this.hostOffset.y;
        this.host.onPlaced?.();

        this.graces.forEach((grace, i) => {
            grace.box.x = this.box.x + this.graceOffsets[i].x;
            grace.box.y = this.box.y + this.graceOffsets[i].y;
            grace.onPlaced?.();
        });
    }

    override paint(painter: Painter) {
        for (const member of [this.host, ...this.graces]) {
            member.paint(painter);
            for (const decoration of member.decorations) decoration.paint(painter);
        }

        if (!this.hookOrigin) return;
        const graceEm = this.ast.size * GRACE_SCALE;
        const hookOrigin = this.hookOrigin;
        const dir = this.side === "pre" ? 1 : -1;
        painter.drawPath(
            HOOK_COMMANDS,
            { stroke: "#000", strokeWidth: Math.max(0.8, graceEm * HOOK_WIDTH) },
            {
                x: this.box.x + hookOrigin.x,
                y: this.box.y + hookOrigin.y,
                scaleX: graceEm * dir,
                scaleY: graceEm,
            },
        );
    }
}
