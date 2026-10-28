import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass, type LengthValue } from "../ASTtypes.js";
import { ParserContext } from "../../parser/parserContext.js";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import { ErrorDiagnostic } from "../../diagnostic.js";
import {
    ANCHOR_KEY,
    DEFAULT_KEY,
    transferFunctionAddons,
    isVisualTemporalNode,
    TemporalNodeBase,
    type TimeState,
    type VisualTemporalNode,
} from "../temporal.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import { Fraction } from "../../fraction.js";
import type { Track } from "../../lowering/track.js";
import { getLayoutBounds, layoutLocalSequence } from "../../layout/engine.js";
import type { HorizontalLineView, LayoutBox, LayoutPrepareContext } from "../../layout/types.js";
import type { Painter } from "../../render/types.js";
import type { PlaybackEmitter } from "../../playback/types.js";

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

const FOLD_ARGS = [{
    name: "gap",
    namedOnly: true,
    type: "length" as const,
    default: { value: 0.12, unit: "em" as const },
    description: "相邻堆叠成员之间的间距",
}];

function formatStack(
    fn: "up" | "down",
    host: string,
    members: readonly ASTNodeBase[],
    gaps: readonly number[],
    source: string,
): string {
    let result = host;
    for (let start = 0; start < members.length;) {
        const gap = gaps[start];
        let end = start + 1;
        while (end < members.length && gaps[end] === gap) end++;
        const items = members.slice(start, end).map(item => item.toString(source));
        result = `@${fn}(${[result, ...items, `gap=${gap}px`].join(", ")})`;
        start = end;
    } return result;
}

/**
 * `@up` / `@down` 共用的折叠容器，不导出
 *
 * `contents[0]` 是宿主，其余向上；`belows` 全部向下。两个方向共用一个容器，
 * 所以混写的 `^` / `_` 会全部绑到同一个宿主，不需要括号分组。
 * 每个参数只能产生一个 VisualTemporalNode，外层统一承担对齐、时值和合列
 */
class FoldFunction extends ASTFunctionNode {
    declare static readonly side: FoldSide;

    contents: ASTNodeBase[] = [];
    belows: ASTNodeBase[] = [];
    aboveGaps: number[] = [];
    belowGaps: number[] = [];
    size: number;
    gap: number;

    /** 静态而不是实例字段：子类的字段初始化器晚于基类构造器，构造期读不到 */
    private get side(): FoldSide { return (this.constructor as typeof FoldFunction).side; }

    override get children(): ASTNodeBase[] {
        return this.belows.length ? [...this.contents, ...this.belows] : this.contents;
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        this.size = ctx.variables.fontsize;
        const [gap] = this.getArgValue(args, ctx) as [LengthValue];
        this.gap = ctx.length2px(gap);
        if (!Number.isFinite(this.gap) || this.gap < 0) {
            throw new ErrorDiagnostic("E_INVALID_FOLD_GAP", "@{fn} 的 gap 必须是非负有限长度", span, { fn: this.callName });
        }
        for (const [key, value] of args) {
            if (typeof key === "number") this.addContent(value as ASTNodeBase, this.side, ctx);
        }
    }

    /** 至少有一个成员能承载标签时，折叠体本身才能作为整体被标注 */
    override labelable() {
        return this.children.some(ASTFunctionNode.findLabelable) ? this : null;
    }

    /** 遇到另一个折叠体就展平到自己身上；返回 this 只是为了链式写法 */
    addContent(node: ASTNodeBase, side: FoldSide, ctx: ParserContext, gap: number = this.gap): FoldFunction {
        if (this.contents.length === 0) side = "above"; // 还没有宿主，来者即宿主
        if (node instanceof FoldFunction) return this.flatten(node, side, ctx, gap);
        if (side === "above") {
            if (this.contents.length > 0) this.aboveGaps.push(gap);
            this.contents.push(node);
        } else {
            this.belowGaps.push(gap);
            this.belows.push(node);
        }
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
                const columns = ctx.trackedEvents(content, new Fraction(), track);
                const member = columns.length === 1 && columns[0].length === 1 ? columns[0][0] : undefined;
                if (!member || !isVisualTemporalNode(member) || (member.addon?.breakBefore ?? 0) > 0) {
                    throw new ErrorDiagnostic(
                        "E_UP_INVALID_CHILD",
                        "@up 的每个参数必须恰好产生一个可见 Temporal，且不能换行或包含多声部结构",
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
        if (this.contents.length <= 1 && this.belows.length === 0) {
            return `@${this.callName}(${[...this.contents.map(c => c.toString(source)), `gap=${this.gap}px`].join(", ")})`;
        }
        const up = formatStack("up", this.contents[0].toString(source), this.contents.slice(1), this.aboveGaps, source);
        return formatStack("down", up, this.belows, this.belowGaps, source);
    }

    /**
     * 把另一个折叠容器并进自己：**接收者存活**，参数被掏空
     *
     * 跨度靠前的一方提供宿主，靠后的一方交出宿主、按连接算符的方向入列，其余成员各自
     * 保留方向。这条规则让 `1^2_3^4_5` 像 LaTeX 上下标那样全部绑到同一个宿主。
     *
     * 被掏空的一方必须撤销候选登记：空壳已不在 AST 里，留在表中会让 @tie() 取到孤儿端点。
     */
    private flatten(drop: FoldFunction, side: FoldSide, ctx: ParserContext, gap: number = this.gap): FoldFunction {
        // 成员顺序跟随源码；比较必须在 growSpan 之前
        const front: FoldFunction = drop.sourceSpan.start < this.sourceSpan.start ? drop : this;
        const back: FoldFunction = front === drop ? this : drop;
        const [backHost, ...backAbove] = back.contents;
        const hasHost = front.contents.length > 0;
        const demoted = backHost ? [backHost] : [];
        const demotedGap = hasHost && backHost ? [gap] : [];
        const above = !hasHost || side === "above";
        this.contents = [...front.contents, ...(above ? demoted : []), ...backAbove];
        this.belows = [...front.belows, ...(!above ? demoted : []), ...back.belows];
        this.aboveGaps = [...front.aboveGaps, ...(above ? demotedGap : []), ...back.aboveGaps];
        this.belowGaps = [...front.belowGaps, ...(!above ? demotedGap : []), ...back.belowGaps];
        for (const c of this.children) c.parent = this;
        this.growSpan(drop.sourceSpan);
        drop.contents.length = drop.belows.length = drop.aboveGaps.length = drop.belowGaps.length = 0;
        const stale = ctx.labelableNodes.lastIndexOf(drop);
        if (stale >= 0) ctx.labelableNodes.splice(stale, 1);
        return this;
    }

    /**
     * `this` 是发起调用的那个子类，所以方向和构造都从它取。子类必须写成
     * `UpFunction.desugar(...)` 这种带显式接收者的形式 —— 解析器是把
     * `deSugarRelation` 摘成游离函数引用来调的，`this` 到不了这里。
     */
    protected static desugar(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        const n = nodes[at++] as GrammarSugarNode;
        if (!(n.kind === "sugar" && n.data === this)) return null;
        const label = this.side === "above" ? "@up" : "@down";
        const leftNode = ctx.takeLeftOperand();
        if (!leftNode) throw new ErrorDiagnostic(
            "E_FOLD_NO_TARGET",
            "{fn}语法糖错误: 左边没有找到可叠加的目标",
            n.span, { fn: label }
        );
        const wrapper = new this({ ...n.span }, new Map(), ctx);
        const host = leftNode instanceof FoldFunction
            ? leftNode
            : wrapper.addContent(leftNode, "above", ctx);
        const next = ctx.consumeRightOperand(nodes, at, right => {
            // 右操作数可能已被 @tie() 等按引用取走（它就在刚才解析的剩余里），
            // 而新建的左包装无人引用，所以合并时让右边存活；接收者就是存活的那一方
            const merged = right instanceof FoldFunction
                ? right.flatten(host, this.side, ctx, wrapper.gap)
                : host.addContent(right, this.side, ctx, wrapper.gap);
            // 语法糖不走 pushNode，这里补登记；null 同样入表，和显式调用一样成为边界
            ctx.labelableNodes.push(merged.labelable());
            return merged;
        });
        if (next !== null) return next;
        throw new ErrorDiagnostic(
            "E_FOLD_NO_TARGET",
            "{fn}语法糖错误: 右边没有找到可叠加的目标",
            n.span, { fn: label }
        );
    }
}

class UpFunction extends FoldFunction {
    static override readonly side = "above" as const;

    static override def: FunctionDef = {
        name: ["up"],
        description: "把同一时间位置的可见对象向上堆叠",
        details: `\
~~~jpfun
@up(1, 3, 5, gap=0.12em)
~~~

第一个内容参数为宿主，其余依次叠在上方；所有成员共享宿主时值。仅命名参数 \`gap\` 指定相邻成员的间距。常用于和弦、速度记号和音符注释。

**简写**：\`1 ^ 3 ^ 5\`。复杂内容可用 \`{...}\` 包裹；需要独立节奏的并行分支时，使用 \`&\` / \`@stack\`。`,
        allowExtraArgs: true,
        extraArgType: "content" as const,
        args: FOLD_ARGS,
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
        details: `\
~~~jpfun
@down(1, $p, gap=0.12em)
~~~
第一个内容参数为宿主，其余依次叠在下方并共享其时值，仅命名参数 \`gap\` 指定相邻成员的间距，常用于力度等下方标记。

**简写**：\`1 _ $p\`。与 \`^\` 混写时共用同一宿主：\`1^2_3\` 将 \`2\` 放在 \`1\` 上方、\`3\` 放在下方。`,
        allowExtraArgs: true,
        extraArgType: "content" as const,
        args: FOLD_ARGS,
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

    /** 每个成员相对本盒顶部的纵向偏移，onPlaced 时同步为绝对坐标 */
    private readonly verticalOffsets: number[] = [];

    constructor(ast: FoldFunction, members: readonly VisualTemporalNode[]) {
        super();
        this.ast = ast;
        this.members = members;
        // members 按 ast.children 构建，而 children 是 [...contents, ...belows]
        this.aboveCount = ast.contents.length;

        const host = members[0];
        this.mergeKey = host && host.mergeKey !== host.order ? host.mergeKey : DEFAULT_KEY;
        // 普通组保留 `$p ^ 1` 的时值回退，专属组不借附属音符提前推进游标
        const fallback = this.mergeKey === DEFAULT_KEY || this.mergeKey === ANCHOR_KEY;
        if (!fallback && host) this.T.copyFrom(host.T);
        this.initLayoutBox();

        // 宿主决定折叠体的时值，它的修饰语义也随之成为整体的修饰，
        // 自动连梁等语义处理才能看到这个折叠体的节奏；
        // 随后外层 LoweringGroup 会在同一 addon 上继续累加
        const addon = host?.addon;
        if (addon) this.addon = { ...addon };

        for (const member of members) {
            if (fallback && this.T.isZero()) this.T.copyFrom(member.T);
            // 锚点仍优先：`| ^ @text(A)` 得保持小节线语义
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
    override onTimeState(state: TimeState) {
        const duration = this.T.clone();
        let offset: Fraction | void = undefined;
        let durationChanged = false;
        // 宿主写在最前面，标记写在它后面；标记先写入状态，宿主才读得到
        for (let i = this.members.length - 1; i >= 0; i--) {
            const member = this.members[i];
            // 堆叠在一起的成员共享同一个时值，由第一个成员决定；
            // 本来就没有时长的成员（标注、小节线等）保持 0，不会被拉长
            if (!member.T.isZero() && !this.T.isZero()) member.T.copyFrom(this.T);
            member.t.copyFrom(this.t);
            member.track = this.track;
            member.layoutLine = this.layoutLine;
            offset = member.onTimeState?.(state);
            durationChanged ||= !member.T.isZero() && !member.T.equals(duration);
        }
        const host = this.members[0];
        if (host && !host.T.isZero()) {
            this.T.copyFrom(host.T);
            if (durationChanged) {
                for (const member of this.members) {
                    if (!member.T.isZero()) member.T.copyFrom(this.T);
                }
            }
        } return offset;
    }

    override emitPlayback(emitter: PlaybackEmitter) {
        // 倒序发布，宿主（members[0]）最后：附属成员注册的局部变换因此作用到宿主
        for (let i = this.members.length - 1; i >= 0; i--) emitter.play(this.members[i]);
    }

    override prepareHorizontal(line: HorizontalLineView) {
        this.members[0]?.prepareHorizontal?.(line);
    }

    /**
     * 宿主留在轨道基线上，其余成员按书写顺序向上或向下叠放
     *
     * 成员不进入全局 columns，因此它们的准备、定位和绘制都由本节点负责；
     * 每个成员独立执行局部横排，宿主继承含框约束的占位，其余成员仍沿宿主锚点悬挂。
     */
    override prepareLayout(context: LayoutPrepareContext) {
        // lowering 期间修饰挂在折叠体上（augmenter 要看到整体节奏），渲染时交给宿主：
        // 减时线要落在它的数字与下八度点之间，而不是压在整个盒子下面
        if (this.members[0]) transferFunctionAddons(this, this.members[0]);
        const first = this.members[0];
        if (!first) {
            this.box.w = this.box.h = 0;
            this.box.anchor = this.box.visualAxis = 0;
            return;
        }
        this.box.w = layoutLocalSequence([first], context);
        for (let index = 1; index < this.members.length; index++) layoutLocalSequence([this.members[index]], context);

        this.springConfig = { ...first.springConfig };

        // 横向完全等于宿主：上下的标记（变速、注释、力度）常常比音符宽得多，
        // 让它们撑宽盒子会把右邻推开一大截；它们画在基线外侧，伸出盒外也不会碰撞
        const anchor = first.box.x + first.box.anchor;
        this.verticalOffsets.length = this.members.length;
        this.verticalOffsets[0] = 0;

        // 以宿主盒顶为 0，向上得到负坐标、向下得到正坐标，最后整体下移
        const firstBounds = getLayoutBounds(first);
        let top = firstBounds.y;
        for (let i = 1; i < this.aboveCount; i++) {
            const gap = this.ast.aboveGaps[i - 1];
            const bounds = getLayoutBounds(this.members[i]);
            this.verticalOffsets[i] = top - gap - bounds.y - bounds.h;
            top -= gap + bounds.h;
        }
        let bottom = firstBounds.y + firstBounds.h;
        for (let i = this.aboveCount; i < this.members.length; i++) {
            const gap = this.ast.belowGaps[i - this.aboveCount];
            const bounds = getLayoutBounds(this.members[i]);
            this.verticalOffsets[i] = bottom + gap - bounds.y;
            bottom += gap + bounds.h;
        }
        for (let i = 0; i < this.verticalOffsets.length; i++) this.verticalOffsets[i] -= top;

        this.box.h = bottom - top;
        this.box.anchor = anchor;
        // 宿主对齐轨道基线，两侧成员各自向外撑开行高
        this.box.visualAxis = first.box.visualAxis - top;

        // 端口：宿主代表整个折叠体，把它发布的端口原样上提，
        // 减时线、歌词等端口于是与普通音符完全一致，关系函数不需要认识 up
        const firstOffset = this.verticalOffsets[0];
        for (const name in first.ports) {
            const port = first.ports[name];
            this.ports[name] = { ...port, x: first.box.x + port.x, y: firstOffset + port.y };
        }

        // 代表成员没声明核心范围时退回它的整个盒子
        this.ports["body.left"] ??= { x: first.box.x, y: this.box.visualAxis };
        this.ports["body.right"] ??= { x: first.box.x + first.box.w, y: this.box.visualAxis };

        // 唯一的例外：连音线要接到最上面那个成员的顶部
        const topIndex = this.aboveCount - 1;
        const topOffset = this.verticalOffsets[topIndex];
        this.ports["tie.top"] = {
            x: anchor,
            y: topOffset + (this.members[topIndex].ports["tie.top"]?.y ?? getLayoutBounds(this.members[topIndex], true).y),
        };
    }

    /** 引擎每次改变本节点坐标后，按当前 anchor 与准备阶段的纵向偏移重算成员绝对坐标 */
    override onPlaced() {
        for (let i = 0; i < this.members.length; i++) {
            const member = this.members[i];
            member.box.x = this.box.x + this.box.anchor - member.box.anchor;
            member.box.y = this.box.y + this.verticalOffsets[i];
            member.onPlaced?.();
        }
    }

    override paint(painter: Painter) {
        for (const member of this.members) {
            member.paint(painter);
            for (const decoration of member.decorations) decoration.paint?.(painter);
        }
    }
}
