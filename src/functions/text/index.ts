import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, ParserContext, SourceSpan, LengthValue } from "../ASTtypes.js";

class TextFunction extends ASTFunctionNode {
    static override def = {
        name: ["text"],
        description: "文本标记。单独写在谱中是文本对象；也可作为 up 的单个可见成员",
        example: `@text(进入主题)`,
        allowExtraArgs: false,
        args: [
            {
                type: "string" as const,
                default: null,
            },
            {
                name: "size",
                type: "length" as const,
                default: {
                    value: 1,
                    unit: "em",
                } as LengthValue,
            }
        ],
    };

    text: string;
    size: number;
    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [txt, sz] = this.getArgValue(args, ctx) as [string, LengthValue];
        this.text = txt;
        this.size = ctx.length2px(sz);
    }

    override toString(s: string) { return `@text(${this.text})`; }
}

export const TextNode: ASTFunctionClass = TextFunction;
