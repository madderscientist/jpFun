import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes";
import { ErrorDiagnostic } from "../../parser/diagnostic";

class TieFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["tie"],
        description: "连音线",
        example: `@tie(label1, label2, ...)
将对应元素之间用连音线相连；对于不在同一行的将使用水平跨行连接；若不传参则找最近的`,
        allowExtraArgs: true,
        args: []
    };

    endPoints: ASTNodeBase[] = [];

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        for (const [key, value] of args) {
            const v = ctx.parseArgWithType((value as SourceSpan).start, (value as SourceSpan).end, "label", sourceSpan.start);
            if (v !== null) this.endPoints.push(v as ASTFunctionNode);
        }
        // 数目不足，则找最近的
        let k = ctx.labelableNodes.length - 1;
        for (let i = this.endPoints.length; i < 2; i++) {
            while (k >= 0 && this.endPoints.includes(ctx.labelableNodes[k])) k--;
            if (k < 0) break;
            this.endPoints[1 - i] = ctx.labelableNodes[k--];    // 保持顺序
        }
        if (this.endPoints.length < 2) throw new ErrorDiagnostic("E_NOT_ENOUGH_ARGS", "@tie 连音线需要至少两个端点", sourceSpan);
    }

    toString(source: string): string {
        return `@tie(${this.endPoints.map(p => `${(p as ASTFunctionNode).label ?? 'anon'}:[${p.toString(source)}]`).join(", ")})`;
    }
}

export const TieNode: ASTFunctionClass = TieFunction;