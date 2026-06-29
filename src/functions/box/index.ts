import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, ParserContext, SourceSpan, LengthValue } from "../ASTtypes.js";

class BoxFunction extends ASTFunctionNode {
    static override def = {
        name: ["box"],
        description: "给目标结构或对象加外框",
        example: `@box(content, padding=0.2, stroke=0.08)`,
        allowExtraArgs: false,
        args: [
            {
                type: "content" as const,
                default: null,
            },
            {
                name: "padding",
                type: "length" as const,
                default: {
                    value: 0,
                    unit: "em",
                } as LengthValue,
            },
            {
                name: "stroke",
                type: "length" as const,
                default: {
                    value: 1,
                    unit: "em",
                } as LengthValue,
            },
        ],
    };

    target: ASTNodeBase;
    padding: number;
    stroke: number;
    override get children() { return [this.target]; }
    override timeFlowModel() {
        return {
            children: [this.target],
            mode: "sequence" as const,
        };
    }

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [tgt, pad, stroke] = this.getArgValue(args, ctx) as [ASTNodeBase, LengthValue, LengthValue];
        tgt.parent = this;
        this.target = tgt;
        this.padding = ctx.length2px(pad);
        this.stroke = ctx.length2px(stroke);
    }
}

export const BoxNode: ASTFunctionClass = BoxFunction;