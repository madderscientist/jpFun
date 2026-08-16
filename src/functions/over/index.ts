import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass, ASTTextNode, ASTLabelNode, ASTBraceNode } from "../ASTtypes.js";
import { ParserContext } from "../../parser/parserContext.js";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import { ErrorDiagnostic } from "../../diagnostic.js";
import {
    ColType,
    TemporalNodeBase,
    type LoweringResult,
} from "../../lowering/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import { layoutFragment, paintLayout, unionLayoutBoxes, type DocumentLayoutResult } from "../../layout/engine.js";
import type { LayoutBox, LayoutPassContext, LayoutPrepareContext } from "../../layout/types.js";
import type { Painter } from "../../render/types.js";

/**
 * 函数 up 的设计经历：
 * up 最初的设计是为了解决和弦的柱状音符，进一步拓展到会标记在音符上方的内容，比如小节线上方的小节号、音符上方的变速记号、番茄简谱里的音符注释
 * 于是含义变为了“空间纵向堆叠”。为了让功能更加强大，本来设计是允许 up 每个元素不限制类型的，想放什么就放什么，
 * 这就导致每个元素是独立渲染的，也就是谱中谱，作用域什么的都很复杂（跨作用域格外麻烦），我对实现效果也不满意
 * 而且有三个问题：
 * 1. 排版上不好对齐。只有一个元素可以直接用anchor进行对齐，而多个，甚至是嵌套，对齐锚点应该选择哪个呢？
 * 2. 时间上不好对齐。如果某个元素里面包含了多个事件，在 onTimeState 时应该如何处理？
 * 3. ColType 类型不好确定。如果每个元素都只有一个，那么 ColType 可以直接取最小值，但是如果某个元素里面有多个事件，那么 ColType 应该取哪个呢？
 *
 * ColType 属于一个时间位置，不属于任意大的 AST 子树。所以每个元素必须有以下接口：
 * - box
 * - t/T
 * - colType
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
        args: [],
    };

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
                const [member, ...rest] = ctx.trackedEvents(content, 0, track).columns.flat();
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

// 到底应该当成一个节点、隐藏内部，还是暴露？
// 暴露的话 layout model 是有机制的，但是在 lowering 的接口中返回不能是 columns，要这么做得修改机制
// 隐藏的话在什么时候进行暴露？
class OverNodeTemporal extends TemporalNodeBase {
    constructor(ast: OverFunction) {
        super();
        this.ast = ast;
        this.T = 1;
        this.t = 0;
        this.type = ColType.DEFAULT;
    }
}