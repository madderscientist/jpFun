import { TimeState } from "../../semantic/contracts";
import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, FunctionDef, ParserContext, SourceSpan } from "../ASTtypes";

class TempoFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["tempo"],
        description: "设置时间线上的速度",
        example: `@tempo(96) 将其后的时间状态速度设置为 96 BPM`,
        allowExtraArgs: false,
        args: [
            {
                name: "bpm",
                type: "number",
                default: null,
            },
        ],
    };

    bpm: number;

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.bpm] = this.getArgValue(args, ctx) as [number];
    }

    onTimeState(state: TimeState) {
        state.bpm = this.bpm;
        return true;
    }

    toString(): string {
        return `@tempo(${this.bpm})`;
    }
}

export const TempoNode: ASTFunctionClass = TempoFunction;