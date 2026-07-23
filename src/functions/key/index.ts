import { ColType, TemporalNodeBase } from "../../lowering/types.js";
import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, ParserContext, SourceSpan } from "../ASTtypes.js";

class KeyFunction extends ASTFunctionNode {
    static override def = {
        name: ["key", "1"],
        description: "设置时间线上的 1= 调性基准",
        example: `@1(C4) 或 @key(F#3)
它不会修改 parser 的局部变量，而是在时间固化阶段影响其后的数字音名解释`,
        allowExtraArgs: false,
        args: [
            {
                name: "tonality",
                type: "string" as const,
                default: null,
            },
        ],
    };

    tonality: string;

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.tonality] = this.getArgValue(args, ctx) as [string];
    }

    override loweringEnter() {
        return [new KeyTemporalNode(this)];
    }

    override toString() {
        return `@1(${this.tonality})`;
    }
}

export const KeyNode: ASTFunctionClass = KeyFunction;

class KeyTemporalNode extends TemporalNodeBase {
    declare ast: KeyFunction;

    constructor(ast: KeyFunction) {
        super();
        this.ast = ast;
        this.type = ColType.SINGLE;
    }
    override onTimeState(state: Record<string, any>) {
        state.keySignature = this.ast.tonality;
    }
}