import { FunctionDef, ASTNodeBase, ASTBraceNode, FunctionArgs, SourceSpan, ParserContext, CanonicalParser, ASTFunctionNode, ASTFunctionClass } from "../types";
import { Diagnostic, ErrorDiagnostic } from "../../parser/diagnostic";

class DivFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["div", "/"],
        description: "减时线",
        example: `@div(C1, 2): C1下方创建2根减时线
@/({C1 C2 @dash()}, 3): C1、C2和增时线下方创建3根减时线并连接
语法糖：在音符后加斜杠'/'，可以多个
@div(C1, 2) === C1//
@div(C1 C2/ @dash(), 2) === {C1 C2/ @dash()}//
设置命名参数前缀: div
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
        // 检查 / 的数量
        let divCnt = 0;
        let pos = parser.cursor;
        while (pos < parser.end && source[pos] === '/') {
            divCnt++;
            pos++;
        }
        if (divCnt === 0) return null;
        // 探查前一个节点是否可用 div只探查前一个
        const prevNode = ctx.toConsume.at(-1);
        if (!prevNode) return null;
        if (prevNode instanceof DivFunction) {
            // 已经是div了 继续加深
            if (exec) prevNode.n += divCnt;
        } else {
            if (prevNode.duration === 0) return null;   // 当作无效文本而不是强行去糖并报错
            if (exec) {
                // 生成一个新的div节点 包含这些内容并替换掉原来的内容
                const argMap: FunctionArgs = new Map();
                argMap.set(0, prevNode);
                argMap.set("n", divCnt);
                const span = ASTBraceNode.getContentSpan(prevNode);
                span.end = pos;    // 扩展到斜杠的末尾
                const newDiv = new DivFunction(
                    span,
                    argMap,
                    ctx,
                );
                ctx.toConsume[ctx.toConsume.length - 1] = newDiv;
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

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.content, this.n] = this.getArgValue(args, ctx) as [ASTNodeBase, number];
        if (this.content.duration === 0) {    // 没有符合要求的节点 必须有
            throw new ErrorDiagnostic(
                "E_DIV_INVALID_CONTENT",
                `函数 @div 至少需要接收1个有时长的元素，但找到了0个`,
                sourceSpan
            );
        }
        this.content.parent = this;
    }

    toString(source: string): string {
        return `@div(${this.content.toString(source)}, ${this.n})`;
    }
}

export const DivNode: ASTFunctionClass = DivFunction;
