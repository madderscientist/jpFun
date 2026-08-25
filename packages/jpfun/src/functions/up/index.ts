import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass, ASTTextNode, ASTLabelNode, ASTBraceNode } from "../ASTtypes.js";
import { ParserContext } from "../../parser/parserContext.js";
import { GrammarNode, GrammarSugarNode, type CallArgumentInfo } from "../../parser/grammarType.js";
import { ErrorDiagnostic } from "../../diagnostic.js";
import {
    ANCHOR_KEY,
    DEFAULT_KEY,
    isVisualTemporalNode,
    TemporalNodeBase,
    type VisualTemporalNode,
} from "../../lowering/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import { Fraction } from "../../fraction.js";
import type { Track } from "../../lowering/track.js";
import { prepareLayoutHost } from "../../layout/engine.js";
import type { LayoutBox, LayoutPoint, LayoutPrepareContext } from "../../layout/types.js";
import type { Painter } from "../../render/types.js";

/**
 * 函数 up 的设计经历：
 * up 最初的设计是为了解决和弦的柱状音符，进一步拓展到会标记在音符上方的内容，比如小节线上方的小节号、音符上方的变速记号、番茄简谱里的音符注释
 * 于是含义变为了“空间纵向堆叠”。为了让功能更加强大，本来设计是允许 up 每个元素不限制类型的，想放什么就放什么，
 * 这就导致每个元素是独立渲染的，也就是谱中谱，作用域什么的都很复杂（跨作用域格外麻烦），我对实现效果也不满意
 * 而且有三个问题：
 * 1. 排版上不好对齐。只有一个元素可以直接用anchor进行对齐，而多个，甚至是嵌套，对齐锚点应该选择哪个呢？
 * 2. 时间上不好对齐。如果某个元素里面包含了多个事件，在 onTimeState 时应该如何处理？
 * 3. 合并组不好确定。如果某个元素里面有多个事件，该取哪个的 mergeKey 呢？
 *
 * mergeKey 属于一个时间位置，不属于任意大的 AST 子树。所以每个元素必须有以下接口：
 * - box
 * - t/T
 * - mergeKey
 * - onTimeState
 *
 * 此时 up 的每个元素就只允许为一个 VisualTemporalNode，不再需要处理子内容了
 */

class UpFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["up"],
        description: "把同一时间位置的可见对象向上堆叠",
        example: `@up(content1, content2, ...)
语法糖: ^
{content1} ^ {content2} ^ ...
表示content1和content2在时间上完全重叠，通常用于和声等需要对齐的场景。可以有任意多个参数，至少需要两个参数。
`,
        allowExtraArgs: true,
        extraArgType: "content" as const,
        args: [],
    };

    /** 至少有一个成员能承载标签时，和弦本身才能作为整体被标注 */
    override labelable() {
        return this.contents.some(ASTFunctionNode.findLabelable) ? this : null;
    }

    static override deSugarAtom(source: string, start: number, _end: number) {
        if (source[start] === '^') {
            const node: GrammarSugarNode = {
                kind: "sugar",
                data: UpFunction,
                span: { start, end: start + 1 },
            }; return { next: start + 1, node };
        } return null;
    }

    // 左操作数的取法同 stack；合并策略不同：up 要让被引用的一方存活
    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        const n = nodes[at++] as GrammarSugarNode;
        if (!(n.kind === "sugar" && n.data === UpFunction)) return null;
        // 找上一个非文本节点 实现忽略中间内容的作用
        // 另一个做法是如果上一个不是可用节点就报错
        let left = ctx.nodes.length - 1;
        for (; left >= 0; left--) {
            if (ctx.nodes[left] instanceof ASTTextNode) continue;
            break;
        }
        let leftNode: ASTNodeBase | null = left >= 0 ? ctx.nodes[left] : null;
        if (leftNode === null) {
            throw new ErrorDiagnostic(
                "UP_NO_TARGET",
                "@up语法糖错误: 左边没有找到可叠加的目标",
                n.span
            );
        }
        /** 左操作数在 ctx.nodes 中的起点；只有这一段会被 up 吞并，更早的节点必须保留 */
        let replaceFrom = left;
        // 对 label 的特判: 目标变为label到被标记的节点范围内的所有节点
        if (leftNode instanceof ASTLabelNode) {
            const labelNode = leftNode;
            let tgt: ASTNodeBase | null = labelNode.target;
            // 在本层这个节点位于哪里（标签节点可能被wrap）
            while (tgt && !ctx.nodes.includes(tgt)) tgt = tgt.parent;
            for (let j = left - 1; j >= 0; j--) {
                if (ctx.nodes[j] === tgt) {
                    leftNode = new ASTBraceNode({
                        start: tgt.sourceSpan.start,
                        end: labelNode.sourceSpan.end,
                    }, ctx.nodes.slice(j, left + 1), null);
                    replaceFrom = j;
                    break;
                }
            }
        }
        // 左操作数收敛成一个 up，后续合并都在它身上进行
        const host = leftNode instanceof UpFunction
            ? leftNode
            : new UpFunction(n.span, new Map(), ctx).addContent(leftNode, ctx);
        // 找到下一个非文本节点 通过全量后续解析的方式进行 还是有些trick
        const storage = ctx.nodes;
        ctx.nodes = [];
        ctx.makeNodes(nodes, at);
        for (let i = 0; i < ctx.nodes.length; i++) {
            // 后向跳过文本节点 和上面保持一致
            const right = ctx.nodes[i];
            if (right instanceof ASTTextNode) continue;
            // 右操作数可能已被 @tie() 等按引用取走（它就在刚才解析的剩余里），
            // 而新建的左包装无人引用，所以合并时让右边存活
            const merged = right instanceof UpFunction
                ? UpFunction.flatten(right, host, ctx)
                : host.addContent(right, ctx);
            storage.length = replaceFrom;
            storage.push(merged);
            while (++i < ctx.nodes.length) storage.push(ctx.nodes[i]);
            ctx.nodes = storage;
            // 语法糖不走 pushNode，这里补登记；null 同样入表，和显式 @up(...) 一样成为边界
            ctx.labelableNodes.push(merged.labelable());
            return nodes.length;
        }
        throw new ErrorDiagnostic(
            "UP_NO_TARGET",
            "@up语法糖错误: 右边没有找到可叠加的目标",
            n.span
        );
    }

    contents: ASTNodeBase[] = [];
    size: number;
    override get children(): ASTNodeBase[] { return this.contents; }

    /** up 的参数复用普通 hook，并收敛为单个可见 Temporal 成员 */
    override loweringEnter(ctx: LoweringContext, track: Track) {

        const members: VisualTemporalNode[] = [];
        // 成员不是外层分组的成员，和弦才是；否则 voice 的歌词会按下标错位
        ctx.isolateFromLoweringGroups(() => {
            for (const content of this.contents) {
                // 摊平所有时间列取全部事件，和弦要求恰好一个
                const [member, ...rest] = ctx.trackedEvents(content, new Fraction(), track).flat();
                if (!member || rest.length > 0 || !isVisualTemporalNode(member)) {
                    throw new ErrorDiagnostic(
                        "E_UP_INVALID_CHILD",
                        "@up 的每个参数必须恰好产生一个可见 Temporal，且不能包含多声部结构",
                        content.sourceSpan,
                    );
                }
                members.push(member);
            }
        });

        return [new UpTemporal(this, members)];
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        this.size = ctx.fontSize;
        for (const [, value] of args) {
            if (value instanceof ASTNodeBase) {
                this.addContent(value, ctx);
                continue;
            }
            const c = ctx.parseArgWithType((value as CallArgumentInfo).valueSpan, "content", span.start);
            if (c !== null) {
                this.addContent(c as ASTNodeBase, ctx);
            }
        }
    }

    /** 遇到另一个 up 就展平；返回存活的那个，调用者必须改用返回值 */
    addContent(node: ASTNodeBase, ctx: ParserContext): UpFunction {
        if (node instanceof UpFunction) return UpFunction.flatten(this, node, ctx);
        this.contents.push(node);
        node.parent = this;
        this.growSpan(node.sourceSpan);
        return this;
    }

    override toString(source: string) {
        return `@up(${this.contents.map(c => c.toString(source)).join(", ")})`;
    }

    private growSpan(s: SourceSpan) {
        this.sourceSpan.start = Math.min(this.sourceSpan.start, s.start);
        this.sourceSpan.end = Math.max(this.sourceSpan.end, s.end);
    }

    /**
     * 展平两个 up：drop 的成员并入 keep 后变成空壳，必须同时撤销它的候选登记 ——
     * 空壳已不在 AST 里，留在表中会让 @tie() 取到解析不出 Temporal 的孤儿端点。
     */
    private static flatten(keep: UpFunction, drop: UpFunction, ctx: ParserContext): UpFunction {
        for (const c of drop.contents) c.parent = keep;
        // 成员顺序跟随源码；比较必须在 growSpan 之前
        if (drop.sourceSpan.start < keep.sourceSpan.start) keep.contents.unshift(...drop.contents);
        else keep.contents.push(...drop.contents);
        keep.growSpan(drop.sourceSpan);
        drop.contents.length = 0;
        const stale = ctx.labelableNodes.indexOf(drop);
        if (stale >= 0) ctx.labelableNodes.splice(stale, 1);
        return keep;
    }
}

export const UpNode: ASTFunctionClass = UpFunction;

class UpTemporal extends TemporalNodeBase {
    declare ast: UpFunction;
    declare box: LayoutBox;

    readonly members: readonly VisualTemporalNode[];

    /** 每个成员相对本盒左上角的局部偏移，onPlaced 时同步为绝对坐标 */
    private readonly offsets: LayoutPoint[] = [];

    constructor(ast: UpFunction, members: readonly VisualTemporalNode[]) {
        super();
        this.ast = ast;
        this.members = members;

        if (members[0]) this.T.copyFrom(members[0].T);
        this.mergeKey = DEFAULT_KEY;
        this.initLayoutBox();

        // 第一个成员决定和弦的时值，它的修饰语义也随之成为整个和弦的修饰，
        // 自动连梁等语义处理才能看到这个和弦的节奏；
        // 随后外层 LoweringGroup 会在同一 addon 上继续累加
        const leadAddon = members[0]?.addon;
        if (leadAddon) this.addon = { ...leadAddon };

        for (const member of members) {
            // 只有锚点需要传上来：`| ^ @text(A)` 得保持小节线语义；
            // 成员不进全局 columns，它们自己的合并组对外没有意义
            if (member.mergeKey === ANCHOR_KEY) this.mergeKey = ANCHOR_KEY;
            // 时间同步在 onTimeState 里做，避免成员的时间被提前固化（后续时间可能会变）
            // 修饰已经提升到和弦上，成员不再单独绘制，
            // 否则和弦内部会出现多余的减时线或附点
            member.addon = void 0;
            // 成员不进入全局 columns，对外由和弦代表：
            // beam 使用和弦事件，tie 仍可沿 AST 索引读取被标注成员的具体几何
            member.foldedInto = this;
        }
    }

    /**
     * 成员共享全局时间状态，从最上面的成员开始固化
     */
    override onTimeState(state: Record<string, any>) {
        // 一般而言，最下面的成员是主体、上面的是标记，标记先写入主体才读得到
        for (let i = this.members.length - 1; i >= 0; i--) {
            const member = this.members[i];
            // 堆叠在一起的成员共享同一个时值，由第一个成员决定；
            // 本来就没有时长的成员（标注、小节线等）保持 0，不会被拉长
            if (!member.T.isZero()) member.T.copyFrom(this.T);
            member.t.copyFrom(this.t);
            member.track = this.track;
            member.layoutLine = this.layoutLine;
            member.onTimeState?.(state);
        }
    }

    /**
     * 第一个成员留在轨道基线上，其余成员按书写顺序依次向上叠放
     *
     * 成员不进入全局 columns，因此它们的准备、定位和绘制都由本节点负责；
     * 准备直接复用引擎的 prepareLayoutHost，保证成员的装饰、端口与顶层对象完全一致。
     */
    override prepareLayout(context: LayoutPrepareContext) {
        this.offsets.length = 0;
        // lowering 期间修饰挂在和弦上（augmenter 要看到整体节奏），渲染时交给最下面的成员：
        // 减时线要落在它的数字与下八度点之间，而不是压在整个和弦盒下面
        if (this.addon && this.members[0]) {
            this.members[0].addon = this.addon;
            this.addon = void 0;
        }
        for (const member of this.members) prepareLayoutHost(member, context);

        const first = this.members[0];
        if (!first) {
            this.box.w = this.box.h = 0;
            this.box.anchor = this.box.visualAxis = 0;
            return;
        }

        // 横向完全等于代表成员：上方的标记（变速、注释）常常比音符宽得多，
        // 让它们撑宽盒子会把右邻推开一大截；它们画在基线上方，伸出盒外也不会碰撞
        const anchor = first.box.anchor;

        // 纵向：以第一个成员的盒顶为 0 向上堆叠得到负坐标，最后整体下移
        const gap = this.ast.size * 0.12;
        let cursor = 0;
        for (const member of this.members) {
            if (member !== first) cursor -= gap + member.box.h;
            this.offsets.push({ x: anchor - member.box.anchor, y: cursor });
        }
        const top = cursor; // 堆叠严格向上，最后一个成员就是最高点
        for (const offset of this.offsets) offset.y -= top;

        this.box.w = first.box.w;
        this.box.h = first.box.h - top;
        this.box.anchor = anchor;
        // 和弦用最下面的成员对齐轨道基线，上方成员只向上撑开行高
        this.box.visualAxis = first.box.visualAxis - top;

        // 端口：最下面的成员代表整个和弦，把它发布的端口原样上提（它的 offset.x 恒为 0），
        // 减时线、歌词等端口于是与普通音符完全一致，关系函数不需要认识 up
        const firstOffset = this.offsets[0];
        for (const name in first.ports) {
            const port = first.ports[name];
            this.ports[name] = { x: port.x, y: firstOffset.y + port.y };
        }

        // 代表成员没声明核心范围时退回它的整个盒子
        this.ports["body.left"] ??= { x: 0, y: this.box.visualAxis };
        this.ports["body.right"] ??= { x: first.box.w, y: this.box.visualAxis };

        // 唯一的例外：连音线要接到和弦顶部
        const lastOffset = this.offsets[this.offsets.length - 1];
        this.ports["tie.top"] = {
            x: anchor,
            y: lastOffset.y + (this.members[this.members.length - 1].ports["tie.top"]?.y ?? 0),
        };
    }

    /** 引擎每次改变本节点坐标后，按准备阶段保存的局部偏移重算成员绝对坐标 */
    override onPlaced() {
        for (let i = 0; i < this.members.length; i++) {
            const offset = this.offsets[i];
            if (!offset) continue;
            const member = this.members[i];
            member.box.x = this.box.x + offset.x;
            member.box.y = this.box.y + offset.y;
            member.onPlaced?.();
        }
    }

    override paint(painter: Painter) {
        for (const member of this.members) {
            member.paint(painter);
            for (const decoration of member.decorations) decoration.paint(painter);
        }
    }
}
