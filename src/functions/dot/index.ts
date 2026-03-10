import { FunctionDef, ASTNodeBase, ASTBraceNode, FunctionArgs, SourceSpan, ParserContext, CanonicalParser, ASTFunctionNode, ASTFunctionClass } from "../types";
import { ErrorDiagnostic } from "../../parser/diagnostic";

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

    static deSugar(parser: CanonicalParser, exec: boolean) {
        const ctx = parser.context;
        const source = ctx.source;
        // 检查 . 的数量
        let dotCnt = 0;
        let pos = parser.cursor;
        while (pos < parser.end && source[pos] === '.') {
            dotCnt++;
            pos++;
        }
        if (dotCnt === 0) return null;
        // 探查前一个节点是否可用 dot只探查前一个
        const prevNode = ctx.toConsume[ctx.toConsume.length - 1];
        if (!prevNode) return null;
        if (prevNode instanceof DotFunction) {
            if (exec) {
                // 已经是dot了 继续加深
                prevNode.n += dotCnt;
            }
        } else {
            const contentJudge = DotFunction.judgePositiveDurationNum(prevNode);
            if (contentJudge !== 1) return null;    // 只能有一个节点
            if (exec) {
                // 生成一个新的dot节点 包含这些内容并替换掉原来的内容
                const argMap: FunctionArgs = new Map();
                argMap.set(0, prevNode);
                argMap.set("n", dotCnt);
                const span = ASTBraceNode.getContentSpan(prevNode);
                span.end = pos;    // 扩展到斜杠的末尾
                const newDot = new DotFunction(
                    span,
                    argMap,
                    ctx,
                );
                ctx.toConsume[ctx.toConsume.length - 1] = newDot;
            }
        }
        return {
            next: pos,
            canConsumeNumber: 1,
        };
    };

    content: ASTNodeBase;
    n: number;
    get children() { return [this.content]; }

    get duration(): number {
        return this.content.duration * (2 - 0.5 ** this.n);
    }

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.content, this.n] = this.getArgValue(args, ctx) as [ASTNodeBase, number];
        const contentJudge = DotFunction.judgePositiveDurationNum(this.content);
        if (contentJudge !== 1) {
            throw new ErrorDiagnostic(
                "E_DOT_INVALID_CONTENT",
                `函数 @dot 只能接收 1个 有时长的元素，但找到了 ${contentJudge} 个`,
                sourceSpan
            );
        }
        this.content.parent = this;
    }

    toString(source: string): string {
        return `@dot(${this.content.toString(source)}, ${this.n})`;
    }

    // 判断有时长的叶节点数量
    static judgePositiveDurationNum(node: ASTNodeBase): number {
        let count = 0;
        const chs = node.children;
        if (chs) {
            for (const child of chs) count += DotFunction.judgePositiveDurationNum(child);
        } else count += node.duration > 0 ? 1 : 0;
        return count;
    }
}

export const DotNode: ASTFunctionClass = DotFunction;
