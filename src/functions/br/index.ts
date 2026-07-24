import { ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes.js";
import { ParserContext } from "../../parser/parserContext.js";
import { ColType, TemporalNodeBase } from "../../lowering/types.js";
import { GrammarCallNodeTyped } from "../../parser/grammarType.js";

class BrFunction extends ASTFunctionNode {
    static override def = {
        name: ["br"],
        description: "换行",
        example: `@br(offset=1): 在后续事件前偏移指定行数
@br() === @br(1)
@br(2): 空出一行后继续
语法糖: [仅限顶层]至少连续两个换行
`,
        allowExtraArgs: false,
        args: [
            {
                name: "offset",
                type: "number" as const,
                default: 1,
            },
        ],
    };

    static override deSugarAtom(source: string, start: number, end: number, depth: number) {
        if (depth > 0) return null;  // 语法糖只在顶层生效
        if (source[start] !== '\n' || source[start + 1] !== '\n') return null;
        let p = start + 2;
        while (p < end && source[p] === '\n') p++;
        const node: GrammarCallNodeTyped = {
            kind: "call",
            typed: true,
            name: "br",
            args: new Map(),
            span: { start, end: p },
        };
        return { next: p, node };
    }

    readonly offset: number;

    override loweringEnter() {
        const br = new TemporalNodeBase();
        br.ast = this;
        br.T = 0;
        br.type = ColType.SINGLE;
        br.layoutLine = this.offset;
        return [br];
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        const [offset] = this.getArgValue(args, ctx) as [number];
        this.offset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    }

    override toString() { return `@br(${this.offset})`; }
}

export const BrNode: ASTFunctionClass = BrFunction;