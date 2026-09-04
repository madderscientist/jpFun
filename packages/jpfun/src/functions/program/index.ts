import { ErrorDiagnostic } from "../../diagnostic.js";
import { TemporalNodeBase, type TimeState } from "../temporal.js";
import {
    ASTFunctionNode,
    type ASTFunctionClass,
    type ASTNodeBase,
    type FunctionArgs,
    type ParserContext,
    type SourceSpan,
} from "../ASTtypes.js";

class ProgramFunction extends ASTFunctionNode {
    static override def = {
        name: ["program", "instrument"],
        description: "设置当前音轨的 MIDI 音色",
        example: `@program(40) 将后续音符切换到 MIDI program 40`,
        allowExtraArgs: false,
        args: [{ name: "program", type: "number" as const, default: null }],
    };

    readonly program: number;

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        const [program] = this.getArgValue(args, ctx) as [number];
        if (!Number.isSafeInteger(program) || program < 0 || program > 127) {
            throw new ErrorDiagnostic("E_PROGRAM_INVALID", "@program 必须是 0..127 的整数", span);
        }
        this.program = program;
    }

    override loweringEnter() {
        const node = new TemporalNodeBase();
        node.ast = this;
        node.playbackState = { program: this.program };
        node.onTimeState = (state: TimeState) => { state.program = this.program; };
        return [node];
    }

    override toString() { return `@program(${this.program})`; }
}

export const ProgramNode: ASTFunctionClass = ProgramFunction;