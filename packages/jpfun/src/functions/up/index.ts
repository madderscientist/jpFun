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

type FoldSide = "above" | "below";

/**
 * `@up` / `@down` 共用的折叠容器，不导出
 *
 * `contents[0]` 是宿主，其余向上；`belows` 全部向下。两个方向共用一个容器，
 * 所以混写的 `^` / `_` 会全部绑到同一个宿主，不需要括号分组。
 */
class FoldFunction extends ASTFunctionNode {
    declare static readonly side: FoldSide;

    contents: ASTNodeBase[] = [];
    belows: ASTNodeBase[] = [];
    size: number;

    /** 静态而不是实例字段：子类的字段初始化器晚于基类构造器，构造期读不到 */
    private get side(): FoldSide { return (this.constructor as typeof FoldFunction).side; }

    override get children(): ASTNodeBase[] {
        return this.belows.length ? [...this.contents, ...this.belows] : this.contents;
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        this.size = ctx.fontSize;
        for (const [, value] of args) {
            if (value instanceof ASTNodeBase) {
                this.addContent(value, this.side, ctx);
                continue;
            }
            const c = ctx.parseArgWithType((value as CallArgumentInfo).valueSpan, "content", span.start);
            if (c !== null) {
                this.addContent(c as ASTNodeBase, this.side, ctx);
            }
        }
    }

    /** 至少有一个成员能承载标签时，折叠体本身才能作为整体被标注 */
    override labelable() {
        return this.children.some(ASTFunctionNode.findLabelable) ? this : null;
    }

    /** 遇到另一个折叠体就展平到自己身上；返回 this 只是为了链式写法 */
    addContent(node: ASTNodeBase, side: FoldSide, ctx: ParserContext): FoldFunction {
        if (this.contents.length === 0) side = "above"; // 还没有宿主，来者即宿主
        if (node instanceof FoldFunction) return this.flatten(node, side, ctx);
        (side === "above" ? this.contents : this.belows).push(node);
        node.parent = this;
        this.growSpan(node.sourceSpan);
        return this;
    }

    growSpan(s: SourceSpan) {
        this.sourceSpan.start = Math.min(this.sourceSpan.start, s.start);
        this.sourceSpan.end = Math.max(this.sourceSpan.end, s.end);
    }

    /** 参数复用普通 hook，并收敛为单个可见 Temporal 成员 */
    override loweringEnter(ctx: LoweringContext, track: Track) {

        const members: VisualTemporalNode[] = [];
        // 成员不是外层分组的成员，折叠体才是；否则 voice 的歌词会按下标错位
        ctx.isolateFromLoweringGroups(() => {
            for (const content of this.children) {
                // 摊平所有时间列取全部事件，每个成员要求恰好一个
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

        return [new FoldTemporal(this, members)];
    }

    /** 混写方向时输出等价的嵌套形式，hover 的替换按钮才能生成合法代码 */
    override toString(source: string) {
        const above = this.contents.map(c => c.toString(source));
        if (this.belows.length === 0) return `@up(${above.join(", ")})`;
        const host = above.length > 1 ? `@up(${above.join(", ")})` : above[0];
        return `@down(${[host, ...this.belows.map(c => c.toString(source))].join(", ")})`;
    }

    /**
     * 把另一个折叠容器并进自己：**接收者存活**，参数被掏空
     *
     * 跨度靠前的一方提供宿主，靠后的一方交出宿主、按连接算符的方向入列，其余成员各自
     * 保留方向。这条规则让 `1^2_3^4_5` 像 LaTeX 上下标那样全部绑到同一个宿主。
     *
     * 被掏空的一方必须撤销候选登记：空壳已不在 AST 里，留在表中会让 @tie() 取到孤儿端点。
     */
    private flatten(drop: FoldFunction, side: FoldSide, ctx: ParserContext): FoldFunction {
        // 成员顺序跟随源码；比较必须在 growSpan 之前
        const front: FoldFunction = drop.sourceSpan.start < this.sourceSpan.start ? drop : this;
        const back: FoldFunction = front === drop ? this : drop;
        const [backHost, ...backAbove] = back.contents;
        const demoted = backHost ? [backHost] : [];
        const contents = [...front.contents, ...(side === "above" ? demoted : []), ...backAbove];
        const belows = [...front.belows, ...(side === "below" ? demoted : []), ...back.belows];
        this.contents = contents;
        this.belows = belows;
        for (const c of this.children) c.parent = this;
        this.growSpan(drop.sourceSpan);
        drop.contents = [];
        drop.belows = [];
        const stale = ctx.labelableNodes.indexOf(drop);
        if (stale >= 0) ctx.labelableNodes.splice(stale, 1);
        return this;
    }

    /**
     * 左操作数的取法同 stack；合并策略不同：折叠要让被引用的一方存活
     *
     * `this` 是发起调用的那个子类，所以方向和构造都从它取。子类必须写成
     * `UpFunction.desugar(...)` 这种带显式接收者的形式 —— 解析器是把
     * `deSugarRelation` 摘成游离函数引用来调的，`this` 到不了这里。
     */
    protected static desugar(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        const n = nodes[at++] as GrammarSugarNode;
        if (!(n.kind === "sugar" && n.data === this)) return null;
        const label = this.side === "above" ? "@up" : "@down";
        // 向前跳过文本节点，实现忽略中间内容的作用
        let left = ctx.nodes.length - 1;
        while (left >= 0 && ctx.nodes[left] instanceof ASTTextNode) left--;
        if (left < 0) {
            throw new ErrorDiagnostic(
                "E_FOLD_NO_TARGET",
                `${label}语法糖错误: 左边没有找到可叠加的目标`,
                n.span
            );
        }
        let leftNode: ASTNodeBase = ctx.nodes[left];
        /** 左操作数在 ctx.nodes 中的起点；只有这一段会被折叠体吞并，更早的节点必须保留 */
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
        // 左操作数收敛成一个折叠体，后续合并都在它身上进行
        const host = leftNode instanceof FoldFunction
            ? leftNode
            : new this(n.span, new Map(), ctx).addContent(leftNode, "above", ctx);
        // 找到下一个非文本节点 通过全量后续解析的方式进行 还是有些trick
        const storage = ctx.nodes;
        ctx.nodes = [];
        ctx.makeNodes(nodes, at);
        for (let i = 0; i < ctx.nodes.length; i++) {
            // 后向跳过文本节点 和上面保持一致
            const right = ctx.nodes[i];
            if (right instanceof ASTTextNode) continue;
            // 右操作数可能已被 @tie() 等按引用取走（它就在刚才解析的剩余里），
            // 而新建的左包装无人引用，所以合并时让右边存活；接收者就是存活的那一方
            const merged = right instanceof FoldFunction
                ? right.flatten(host, this.side, ctx)
                : host.addContent(right, this.side, ctx);
            storage.length = replaceFrom;
            storage.push(merged);
            while (++i < ctx.nodes.length) storage.push(ctx.nodes[i]);
            ctx.nodes = storage;
            // 语法糖不走 pushNode，这里补登记；null 同样入表，和显式调用一样成为边界
            ctx.labelableNodes.push(merged.labelable());
            return nodes.length;
        }
        throw new ErrorDiagnostic(
            "E_FOLD_NO_TARGET",
            `${label}语法糖错误: 右边没有找到可叠加的目标`,
            n.span
        );
    }
}

class UpFunction extends FoldFunction {
    static override readonly side = "above" as const;

    static override def: FunctionDef = {
        name: ["up"],
        description: "把同一时间位置的可见对象向上堆叠",
        example: `@up(content1, content2, ...)
语法糖: ^
{content1} ^ {content2} ^ ...
第一个参数是宿主，其余依次叠在它的上方，常用于和弦、变速记号、音符注释。
全体成员折叠成一个事件、共享宿主的时值；需要各自独立时值的并行分支请用 & / @stack。
`,
        allowExtraArgs: true,
        extraArgType: "content" as const,
        args: [],
    };

    static override deSugarAtom(source: string, start: number, _end: number) {
        if (source[start] !== "^") return null;
        const node: GrammarSugarNode = { kind: "sugar", data: UpFunction, span: { start, end: start + 1 } };
        return { next: start + 1, node };
    }

    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        return UpFunction.desugar(ctx, nodes, at);
    }
}

class DownFunction extends FoldFunction {
    static override readonly side = "below" as const;

    static override def: FunctionDef = {
        name: ["down"],
        description: "把同一时间位置的可见对象向下堆叠",
        example: `@down(content1, content2, ...)
语法糖: _
{content1} _ {content2} _ ...
第一个参数是宿主，其余依次叠在它的下方，常用于力度记号等写在音符下面的标记。
与 ^ 混写时全部绑到同一个宿主：1^2_3 表示 2 在上、3 在下。
`,
        allowExtraArgs: true,
        extraArgType: "content" as const,
        args: [],
    };

    static override deSugarAtom(source: string, start: number, _end: number) {
        if (source[start] !== "_") return null;
        const node: GrammarSugarNode = { kind: "sugar", data: DownFunction, span: { start, end: start + 1 } };
        return { next: start + 1, node };
    }

    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        return DownFunction.desugar(ctx, nodes, at);
    }
}

export const UpNode: ASTFunctionClass = UpFunction;
export const DownNode: ASTFunctionClass = DownFunction;

class FoldTemporal extends TemporalNodeBase {
    declare ast: FoldFunction;
    declare box: LayoutBox;

    readonly members: readonly VisualTemporalNode[];

    /** members[0] 是宿主，`[1, aboveCount)` 向上叠，`[aboveCount, end)` 向下叠 */
    private readonly aboveCount: number;

    /** 每个成员相对本盒左上角的局部偏移，onPlaced 时同步为绝对坐标 */
    private readonly offsets: LayoutPoint[] = [];

    constructor(ast: FoldFunction, members: readonly VisualTemporalNode[]) {
        super();
        this.ast = ast;
        this.members = members;
        // members 按 ast.children 构建，而 children 是 [...contents, ...belows]
        this.aboveCount = ast.contents.length;

        // 节奏由第一个有时值的成员决定；否则 `$p ^ 1` 这类写法会把整个折叠体压成零时长
        const lead = members.find(member => !member.T.isZero());
        if (lead) this.T.copyFrom(lead.T);
        this.mergeKey = DEFAULT_KEY;
        this.initLayoutBox();

        // 宿主决定折叠体的时值，它的修饰语义也随之成为整体的修饰，
        // 自动连梁等语义处理才能看到这个折叠体的节奏；
        // 随后外层 LoweringGroup 会在同一 addon 上继续累加
        const leadAddon = members[0]?.addon;
        if (leadAddon) this.addon = { ...leadAddon };

        for (const member of members) {
            // 只有锚点需要传上来：`| ^ @text(A)` 得保持小节线语义；
            // 成员不进全局 columns，它们自己的合并组对外没有意义
            if (member.mergeKey === ANCHOR_KEY) this.mergeKey = ANCHOR_KEY;
            // 时间同步在 onTimeState 里做，避免成员的时间被提前固化（后续时间可能会变）
            // 修饰已经提升到折叠体上，成员不再单独绘制，
            // 否则内部会出现多余的减时线或附点
            member.addon = void 0;
            // 成员不进入全局 columns，对外由折叠体代表：
            // beam 使用折叠体事件，tie 仍可沿 AST 索引读取被标注成员的具体几何
            member.foldedInto = this;
        }
    }

    /**
     * 成员共享全局时间状态，从写在最后的成员开始固化
     */
    override onTimeState(state: Record<string, any>) {
        // 宿主写在最前面，标记写在它后面；标记先写入状态，宿主才读得到
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
     * 宿主留在轨道基线上，其余成员按书写顺序向上或向下叠放
     *
     * 成员不进入全局 columns，因此它们的准备、定位和绘制都由本节点负责；
     * 准备直接复用引擎的 prepareLayoutHost，保证成员的装饰、端口与顶层对象完全一致。
     */
    override prepareLayout(context: LayoutPrepareContext) {
        this.offsets.length = 0;
        // lowering 期间修饰挂在折叠体上（augmenter 要看到整体节奏），渲染时交给宿主：
        // 减时线要落在它的数字与下八度点之间，而不是压在整个盒子下面
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

        // 横向完全等于宿主：上下的标记（变速、注释、力度）常常比音符宽得多，
        // 让它们撑宽盒子会把右邻推开一大截；它们画在基线外侧，伸出盒外也不会碰撞
        const anchor = first.box.anchor;
        const gap = this.ast.size * 0.12;
        for (const member of this.members) this.offsets.push({ x: anchor - member.box.anchor, y: 0 });

        // 以宿主盒顶为 0，向上得到负坐标、向下得到正坐标，最后整体下移
        let top = 0;
        for (let i = 1; i < this.aboveCount; i++) {
            top -= gap + this.members[i].box.h;
            this.offsets[i].y = top;
        }
        let bottom = first.box.h;
        for (let i = this.aboveCount; i < this.members.length; i++) {
            bottom += gap;
            this.offsets[i].y = bottom;
            bottom += this.members[i].box.h;
        }
        for (const offset of this.offsets) offset.y -= top;

        this.box.w = first.box.w;
        this.box.h = bottom - top;
        this.box.anchor = anchor;
        // 宿主对齐轨道基线，两侧成员各自向外撑开行高
        this.box.visualAxis = first.box.visualAxis - top;

        // 端口：宿主代表整个折叠体，把它发布的端口原样平移（它的 offset.x 恒为 0），
        // 减时线、歌词等端口于是与普通音符完全一致，关系函数不需要认识 up
        const firstOffset = this.offsets[0];
        for (const name in first.ports) {
            const port = first.ports[name];
            this.ports[name] = { x: port.x, y: firstOffset.y + port.y };
        }

        // 代表成员没声明核心范围时退回它的整个盒子
        this.ports["body.left"] ??= { x: 0, y: this.box.visualAxis };
        this.ports["body.right"] ??= { x: first.box.w, y: this.box.visualAxis };

        // 唯一的例外：连音线要接到最上面那个成员的顶部
        const topIndex = this.aboveCount - 1;
        const topOffset = this.offsets[topIndex];
        this.ports["tie.top"] = {
            x: anchor,
            y: topOffset.y + (this.members[topIndex].ports["tie.top"]?.y ?? 0),
        };
    }

    /** 引擎每次改变本节点坐标后，按准备阶段保存的局部偏移重算成员绝对坐标 */
    override onPlaced() {
        for (let i = 0; i < this.members.length; i++) {
            const offset = this.offsets[i];
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
