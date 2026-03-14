import { TimeState } from "../../semantic/contracts";
import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, FunctionDef, ParserContext, SourceSpan } from "../ASTtypes";

class KeyFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["key", "1"],
        description: "设置时间线上的 1= 调性基准",
        example: `@1(C4) 或 @key(F#3)
它不会修改 parser 的局部变量，而是在时间固化阶段影响其后的数字音名解释`,
        allowExtraArgs: false,
        args: [
            {
                name: "tonality",
                type: "string",
                default: null,
            },
        ],
    };

    tonality: string;

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.tonality] = this.getArgValue(args, ctx) as [string];
    }

    onTimeState(state: TimeState): boolean {
        state.keySignature = this.tonality;
        return true;
    }

    toString(): string {
        return `@1(${this.tonality})`;
    }
}

export const KeyNode: ASTFunctionClass = KeyFunction;