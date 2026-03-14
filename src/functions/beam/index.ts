import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, FunctionDef, SourceSpan } from "../ASTtypes";
import { ParserContext } from "../ASTtypes";
import { ErrorDiagnostic } from "../../parser/diagnostic";

class BeamFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["beam"],
        description: "减时线连接",
        example: "@beam(label1, label2, ...): 将多个已标记音符按顺序连接为减时线组",
        allowExtraArgs: true,
        args: [],
    };

    endPoints: ASTNodeBase[] = [];

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        for (const [, value] of args) {
            const parsed = ctx.parseArgWithType((value as SourceSpan).start, (value as SourceSpan).end, "label", sourceSpan.start);
            if (parsed instanceof ASTFunctionNode) this.endPoints.push(parsed);
        }

        // 未显式给全时，回退到最近可标记对象，至少取两个。
        let k = ctx.labelableNodes.length - 1;
        while (this.endPoints.length < 2 && k >= 0) {
            const candidate = ctx.labelableNodes[k--];
            if (this.endPoints.includes(candidate)) continue;
            this.endPoints.unshift(candidate);
        }

        if (this.endPoints.length < 2) {
            throw new ErrorDiagnostic("E_NOT_ENOUGH_ARGS", "@beam 至少需要两个端点", sourceSpan);
        }
    }
}

export const BeamNode: ASTFunctionClass = BeamFunction;
