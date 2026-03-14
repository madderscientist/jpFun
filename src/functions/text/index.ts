import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, FunctionDef, ParserContext, SourceSpan, LengthValue } from "../ASTtypes";

class TextFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["text"],
        description: "文本标记。单独写在谱中是文本对象；写在 over 里会由 over 的层叠逻辑放到上层",
        example: `@text(进入主题)`,
        allowExtraArgs: false,
        args: [
            {
                type: "string",
                default: null,
            },
            {
                name: "size",
                type: "length",
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

    toString(): string { return `@text(${this.text})`; }
}

export const TextNode: ASTFunctionClass = TextFunction;
