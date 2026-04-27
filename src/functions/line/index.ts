import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes.js";
import { ParserContext } from "../../parser/parserContext.js";

class LineFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["line"],
        description: "一行。各个自成分会在时间上进行对齐",
        example: `@line(content1, content2, ...) 暂时无语法糖`,
        allowExtraArgs: true,
        args: [],
    };

    contents: ASTNodeBase[] = [];
    get children(): ASTNodeBase[] { return this.contents; }
    timeFlowMode() { return "parallel" as const; }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        for (const [key, value] of args) {
            if (value instanceof ASTNodeBase) {
                this.addContent(value);
                continue;
            }
            const c = ctx.parseArgWithType((value as SourceSpan).start, (value as SourceSpan).end, "content", span.start);
            if (c !== null) this.addContent(c as ASTNodeBase);
        }
    }

    addContent(node: ASTNodeBase) {
        if (node instanceof LineFunction) this.combine(node);
        else {
            this.contents.push(node);
            node.parent = this;
            const s = node.sourceSpan;
            this.sourceSpan.start = Math.min(this.sourceSpan.start, s.start);
            this.sourceSpan.end = Math.max(this.sourceSpan.end, s.end);
        }
    }

    toString(source: string): string {
        const contentStrs = this.contents.map(c => c.toString(source)).join(',\n');
        return `@line(\n  ${contentStrs.split('\n').join('\n  ')}\n)`;
    }

    combine(ano: LineFunction): LineFunction {
        this.sourceSpan.start = Math.min(this.sourceSpan.start, ano.sourceSpan.start);
        this.sourceSpan.end = Math.max(this.sourceSpan.end, ano.sourceSpan.end);
        for (const c of ano.contents) c.parent = this;
        this.contents.push(...ano.contents);
        ano.contents.length = 0;
        return this;
    }
}

export const LineNode: ASTFunctionClass = LineFunction;