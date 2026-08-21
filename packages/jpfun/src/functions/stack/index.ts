import { ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass, ASTTextNode, ASTBraceNode, ASTLabelNode } from "../ASTtypes.js";
import { ParserContext } from "../../parser/parserContext.js";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import { ErrorDiagnostic } from "../../diagnostic.js";
import type { MeasureFn, PlaceFn, TrackPlacement } from "../../lowering/track.js";

/**
 * 临时伴奏紧贴主旋律，用比系统级行距更小的间隙
 * 间隙作用在盒边界之间，因此即使很小也不会互相穿模
 */
const GAP_RATIO = 0.4;

const placeAbove: PlaceFn = (host, group, gap) =>
    host.top - gap * GAP_RATIO - group.bottom;

/**
 * stack 的成员在局部坐标中按书写顺序自下而上排列
 */
const measureAbove: MeasureFn = (members, gap) => {
    const step = gap * GAP_RATIO;
    const placements: (TrackPlacement | null)[] = [];
    let cursor = 0;
    for (const extent of members) {
        // 临时伴奏在本行没有内容就不占位，避免共用音轨白白抬高行高
        if (!extent) {
            placements.push(null);
            continue;
        }
        const offset = cursor - extent.bottom;
        placements.push({ offset, extent });
        cursor = offset + extent.top - step;
    }
    return placements;
};

/**
 * 同一宿主上的所有 stack 共用同一批音轨（laneKey 固定），
 * 因此一行里先后出现的多段临时伴奏落在同一条基线上，不会上下抖动。
 * hostIndex 取默认的 0：第一个成员就地留在宿主轨，保证旋律主线不被 @stack 打断。
 */
const STACK_TRACKS = {
    laneKey: "stack",
    measure: measureAbove,
    place: placeAbove,
};

class StackFunction extends ASTFunctionNode {
    static override def = {
        name: ["stack"],
        description: "临时多声部",
        example: `@stack(content1, content2, ...)
语法糖: &
{content1} & {content2} & ...
表示content1和content2在时间上完全重叠，通常用于和声等需要对齐的场景。可以有任意多个参数，至少需要两个参数。
`,
        allowExtraArgs: true,
        extraArgType: "content" as const,
        args: [],
    };

    static override deSugarAtom(source: string, start: number, _end: number) {
        if (source[start] === '&') {
            const node: GrammarSugarNode = {
                kind: "sugar",
                data: StackFunction,
                span: { start, end: start + 1 },
            }; return { next: start + 1, node };
        } return null;
    }

    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        const n = nodes[at++] as GrammarSugarNode;
        if (!(n.kind === "sugar" && n.data === StackFunction)) return null;
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
                "E_STACK_NO_TARGET",
                "@stack语法糖错误: 左边没有找到可叠加的目标",
                n.span
            );
        }
        /** 左操作数在 ctx.nodes 中的起点；只有这一段会被 stack 吞并，更早的节点必须保留 */
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
        if (!(overNode instanceof StackFunction)) {
            const newNode = new StackFunction(n.span, new Map(), ctx);
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
            (overNode as StackFunction).addContent(right);
            storage.length = replaceFrom;
            storage.push(overNode);
            while (++i < ctx.nodes.length) storage.push(ctx.nodes[i]);
            ctx.nodes = storage;
            return nodes.length;
        }
        throw new ErrorDiagnostic(
            "E_STACK_NO_TARGET",
            "@stack语法糖错误: 右边没有找到可叠加的目标",
            n.span
        );
    }

    contents: ASTNodeBase[] = [];
    override get children() { return this.contents; }
    override timeFlowModel() {
        return {
            children: this.contents,
            mode: "parallel" as const,
            tracks: STACK_TRACKS,
        };
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
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
        if (node instanceof StackFunction) this.combine(node);
        else {
            this.contents.push(node);
            node.parent = this;
            const s = node.sourceSpan;
            this.sourceSpan.start = Math.min(this.sourceSpan.start, s.start);
            this.sourceSpan.end = Math.max(this.sourceSpan.end, s.end);
        }
    }

    override toString(source: string) {
        const contentStrs = this.contents.map(c => c.toString(source)).join(',\n');
        return `@stack(\n  ${contentStrs.split('\n').join('\n  ')}\n)`;
    }

    combine(ano: StackFunction): StackFunction {
        this.sourceSpan.start = Math.min(this.sourceSpan.start, ano.sourceSpan.start);
        this.sourceSpan.end = Math.max(this.sourceSpan.end, ano.sourceSpan.end);
        for (const c of ano.contents) c.parent = this;
        this.contents.push(...ano.contents);
        ano.contents.length = 0;
        return this;
    }
}

export const StackNode: ASTFunctionClass = StackFunction;