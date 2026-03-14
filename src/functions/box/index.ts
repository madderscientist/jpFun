import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, FunctionDef, ParserContext, SourceSpan, LengthValue } from "../ASTtypes";

class BoxFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["box"],
        description: "给目标结构或对象加外框",
        example: `@box(content, padding=0.2, stroke=0.08)`,
        allowExtraArgs: false,
        args: [
            {
                type: "content",
                default: null,
            },
            {
                name: "padding",
                type: "length",
                default: {
                    value: 0,
                    unit: "em",
                } as LengthValue,
            },
            {
                name: "stroke",
                type: "length",
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
    get children(): ASTNodeBase[] { return [this.target]; }
    timeFlowMode() { return "transparent" as const; }

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