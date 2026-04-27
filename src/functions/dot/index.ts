import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes.js";
import { ErrorDiagnostic } from "../../parser/diagnostic.js";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import { deSugarRelationFunction } from "../../parser/parserContext.js";

class DotFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["dot", "."],
        description: "附点",
        example: `@dot(C1, 2): C1右侧创建2个点 仅接收一个可接收元素
语法糖：在音符后加斜杠'.'，可以多个
@dot(C1, 2) === C1..
@dot(C1 C2/ @dash(), 2) 报错 因为点只能接收一个元素
设置命名参数前缀: dot
`,
        allowExtraArgs: false,
        args: [
            {
                type: "content",
                default: null,
            },
            {
                name: "n",
                type: "number",
                default: 1,
            },
        ]
    };

    static deSugarAtom(source: string, start: number, end: number) {
        // 检查 . 的数量
        let dotCnt = 0;
        let pos = start;
        while (pos < end && source[pos] === '.') {
            dotCnt++;
            pos++;
        }
        if (dotCnt === 0) return null;
        // 对前一个节点的探查放到 deSugarRelation 中
        const node: GrammarSugarNode = {
            kind: "sugar",
            data: {
                class: DotFunction,
                n: dotCnt,
            },
            span: { start, end: pos },
        };
        return { next: pos, node };
    };

    static deSugarRelation: deSugarRelationFunction = (ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) => {
        const n = nodes[at++] as GrammarSugarNode;
        if (n.data?.class !== DotFunction) return null;
        // 向前找到第一个有效节点
        const prev = ASTFunctionNode.findLastFuncContentNode(ctx.nodes, ctx.nodes.length - 1);
        if (!prev) return at;   // 没有了 直接当作无效文本跳过
        if (prev instanceof DotFunction) {
            // 已经是dot了 继续加深
            prev.n += n.data.n;
            return at;
        }
        // 参数数量不校验 在构造函数里写
        const argMap: FunctionArgs = new Map();
        argMap.set(0, prev);
        argMap.set("n", n.data.n);
        const spanPrev = prev.sourceSpan;
        const node = new DotFunction({
            start: Math.min(spanPrev.start, n.span.start),
            end: Math.max(spanPrev.end, n.span.end),
        }, argMap, ctx, null);
        ctx.nodes.pop();    // 消耗掉prev
        ctx.pushNode(node);
        return at;
    }

    content: ASTNodeBase;
    n: number;
    get children() { return [this.content]; }
    timeFlowMode() { return "transparent" as const; }

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.content, this.n] = this.getArgValue(args, ctx) as [ASTNodeBase, number];
        const contentJudge = DotFunction.judgeTimeLeafNum(this.content);
        if (contentJudge !== 1) {
            throw new ErrorDiagnostic(
                "E_DOT_INVALID_CONTENT",
                `函数 @dot 只能接收 1个 有时长的元素，但找到了 ${contentJudge} 个`,
                sourceSpan
            );
        }
        this.content.parent = this;
        // 由于dot不满足多层叠加性，现在处理时间是在 src/semantic/build.ts 统计dot的数目进行的（有耦合）
        // 另一个思路是这里搜索子节点是否有dot，有则将自己的n加入进去并，本层换成braceNode，不耦合但破坏了AST原本的结构
    }

    toString(source: string): string {
        return `@dot(${this.content.toString(source)}, ${this.n})`;
    }

    // 判断有时长的叶节点数量
    static judgeTimeLeafNum(node: ASTNodeBase): number {
        let count = 0;
        const chs = node.children;
        if (chs) {  // 不是叶节点
            for (const child of chs) count += DotFunction.judgeTimeLeafNum(child);
        } else count += node.timeOffsetQN > 0 ? 1 : 0;
        return count;
    }
}

export const DotNode: ASTFunctionClass = DotFunction;