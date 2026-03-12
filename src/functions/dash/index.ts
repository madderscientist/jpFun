import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../types";
import { GrammarCallNodeTyped } from "../../parser/grammarType";

class DashFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["dash", "-"],
        description: "增时线",
        example: `@dash() 创建一根增时线
语法糖: 一个 '-' 代表一个 @dash()
`,
        allowExtraArgs: false,
        args: []
    };

    static deSugarAtom(source: string, start: number, end: number) {
        if (source[start] !== '-') return null;
        const node: GrammarCallNodeTyped = {
            kind: "call",
            typed: true,
            name: "-",
            args: new Map(),
            span: { start, end: start + 1 },
        };
        return { next: start + 1, node };
    };

    get duration() { return 1; }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
    }

    toString(s: string) { return "-"; }
}

export const DashNode: ASTFunctionClass = DashFunction;