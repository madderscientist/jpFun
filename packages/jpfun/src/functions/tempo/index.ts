import { TemporalNodeBase } from "../../lowering/types.js";
import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, ParserContext, SourceSpan } from "../ASTtypes.js";

class TempoFunction extends ASTFunctionNode {
    static override def = {
        name: ["tempo"],
        description: "设置时间线上的速度",
        example: `@tempo(96) 将其后的时间状态速度设置为 96 BPM`,
        allowExtraArgs: false,
        args: [
            {
                name: "bpm",
                type: "number" as const,
                default: null,
            },
        ],
    };

    bpm: number;

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.bpm] = this.getArgValue(args, ctx) as [number];
    }

    override loweringEnter() {
        return [new TempoTemporalNode(this)];
    }

    override toString() { return `@tempo(${this.bpm})`; }
}

export const TempoNode: ASTFunctionClass = TempoFunction;

class TempoTemporalNode extends TemporalNodeBase {
    declare ast: TempoFunction;

    constructor(ast: TempoFunction) {
        super();
        this.ast = ast;
    }
    override onTimeState(state: Record<string, any>) {
        state.bpm = this.ast.bpm;
    }
}