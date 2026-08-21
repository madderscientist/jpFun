import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass, ASTTextNode, ASTLabelNode, ASTBraceNode } from "../ASTtypes.js";
import { ParserContext } from "../../parser/parserContext.js";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
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

    /** 和弦自己会产生 UpTemporal，标签直接指向整个和弦（内部没有 note 时也能标注） */
    override labelable() { return this; }

    static override deSugarAtom(source: string, start: number, _end: number) {
        if (source[start] === '^') {
            const node: GrammarSugarNode = {
                kind: "sugar",
                data: UpFunction,
                span: { start, end: start + 1 },
            }; return { next: start + 1, node };
        } return null;
    }

    // 这段代码同 stack
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
        let overNode: any = left >= 0 ? ctx.nodes[left] : null;
        if (overNode === null) {
            throw new ErrorDiagnostic(
                "UP_NO_TARGET",
                "@up语法糖错误: 左边没有找到可叠加的目标",
                n.span
            );
        }
        /** 左操作数在 ctx.nodes 中的起点；只有这一段会被 up 吞并，更早的节点必须保留 */
        let replaceFrom = left;
        // 对 label 的特判: 目标变为label到被标记的节点范围内的所有节点
        if (overNode instanceof ASTLabelNode) {
            const tgt = overNode.parent;
            for (let j = left - 1; j >= 0; j--) {
                if (ctx.nodes[j] === tgt) {
                    overNode = new ASTBraceNode({
                        start: tgt.sourceSpan.start,
                        end: overNode.sourceSpan.end,
                    }, ctx.nodes.slice(j, left + 1), null);
                    replaceFrom = j;
                    break;
                }
            }
        }
        if (!(overNode instanceof UpFunction)) {
            const newNode = new UpFunction(n.span, new Map(), ctx);
            newNode.addContent(overNode);
            overNode = newNode;
        }
        // 找到下一个非文本节点 通过全量后续解析的方式进行 还是有些trick
        const storage = ctx.nodes;
        ctx.nodes = [];
        ctx.makeNodes(nodes, at);
        for (let i = 0; i < ctx.nodes.length; i++) {
            // 后向跳过文本节点 和上面保持一致
            const right = ctx.nodes[i];
            if (right instanceof ASTTextNode) continue;
            (overNode as UpFunction).addContent(right);
            storage.length = replaceFrom;
            storage.push(overNode);
            while (++i < ctx.nodes.length) storage.push(ctx.nodes[i]);
            ctx.nodes = storage;
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
                this.addContent(value);
                continue;
            }
            const c = ctx.parseArgWithType((value as SourceSpan).start, (value as SourceSpan).end, "content", span.start);
            if (c !== null) {
                this.addContent(c as ASTNodeBase);
            }
        }
    }

    addContent(node: ASTNodeBase) {
        if (node instanceof UpFunction) this.combine(node);
        else {
            this.contents.push(node);
            node.parent = this;
            const s = node.sourceSpan;
            this.sourceSpan.start = Math.min(this.sourceSpan.start, s.start);
            this.sourceSpan.end = Math.max(this.sourceSpan.end, s.end);
        }
    }

    override toString(source: string) {
        return `@up(${this.contents.map(c => c.toString(source)).join(", ")})`;
    }

    combine(ano: UpFunction): UpFunction {
        this.sourceSpan.start = Math.min(this.sourceSpan.start, ano.sourceSpan.start);
        this.sourceSpan.end = Math.max(this.sourceSpan.end, ano.sourceSpan.end);
        for (const c of ano.contents) c.parent = this;
        this.contents.push(...ano.contents);
        ano.contents.length = 0;
        return this;
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
            // 堆叠在一起的成员共享同一个时值，由第一个成员决定；
            // 本来就没有时长的成员（标注、小节线等）保持 0，不会被拉长
            if (!member.T.isZero()) member.T.copyFrom(this.T);
            // 修饰已经提升到和弦上，成员不再单独绘制，
            // 否则和弦内部会出现多余的减时线或附点
            member.addon = void 0;
            // 成员不进入全局 columns，对外由和弦代表：
            // 写在成员上的标签因此能直接做 @beam / @tie 的端点
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