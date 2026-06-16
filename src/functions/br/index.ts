import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes.js";
import { ParserContext } from "../../parser/parserContext.js";

class BrFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["br"],
        description: "换一行。各个自成分会在时间上进行对齐",
        example: `@br()`,
        allowExtraArgs: true,
        args: [],
    };

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
    }

    toString(source: string): string {
        return `@br()`;
    }
}

export const BrNode: ASTFunctionClass = BrFunction;