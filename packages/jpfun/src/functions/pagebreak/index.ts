import { TemporalNodeBase } from "../temporal.js";
import { BrNode } from "../br/index.js";
import {
    ASTFunctionNode,
    type ASTFunctionClass,
    type ASTNodeBase,
    type FunctionArgs,
    type ParserContext,
    type SourceSpan,
} from "../ASTtypes.js";

class PageBreakFunction extends ASTFunctionNode {
    static override def = {
        name: ["pagebreak", "pb"],
        description: "强制换页",
        details: `\
~~~jpfun
1 2 @br() 3 4 @pagebreak() 5 6
~~~
同时换行并开启新页，不占音乐时值。同一时刻的并行调用只换一次页，\`justify=false\` 优先。`,
        allowExtraArgs: false,
        args: [{
            name: "justify",
            description: "是否分配当前页的剩余空间；无限页高时不拉伸",
            type: "boolean" as const,
            default: true,
        }],
    };

    static override loweringFinalize = BrNode.loweringFinalize;

    readonly justify: boolean;

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        [this.justify] = this.getArgValue(args, ctx) as [boolean];
    }

    override loweringEnter() {
        const node = new TemporalNodeBase();
        node.ast = this;
        node.mergeKey = -1;
        node.addon = { breakBefore: 1, pageBreakBefore: this.justify };
        return [node];
    }

    override toString() { return `@pagebreak(justify=${this.justify})`; }
}

export const PageBreakNode: ASTFunctionClass = PageBreakFunction;
