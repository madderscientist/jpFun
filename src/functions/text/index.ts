import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, ParserContext, SourceSpan, LengthValue } from "../ASTtypes.js";
import { ColType, TemporalNodeBase } from "../../lowering/types.js";
import type { LayoutBox, LayoutPrepareContext } from "../../layout/types.js";
import type { Painter } from "../../render/types.js";

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

    override loweringEnter() { return [new TextTemporalNode(this)]; }

    override toString() { return `@text(${this.text})`; }
}

export const TextNode: ASTFunctionClass = TextFunction;

class TextTemporalNode extends TemporalNodeBase {
    declare ast: TextFunction;
    declare box: LayoutBox;

    private textBaselineY = 0;

    constructor(ast: TextFunction) {
        super();
        this.ast = ast;
        this.T = 0;
        this.type = ColType.DEFAULT;
        this.initLayoutBox();
    }

    override prepareLayout(context: LayoutPrepareContext) {
        const metrics = context.textMeasurer.measureText(this.ast.text, {
            fontSize: this.ast.size,
            fill: "#000",
        });
        this.box.w = metrics.w;
        this.box.h = metrics.h;
        this.box.anchor = 0;
        this.box.visualAxis = metrics.h / 2;
        this.textBaselineY = metrics.baseline;
    }

    override paint(painter: Painter) {
        painter.drawText(
            this.ast.text,
            this.box.x,
            this.box.y + this.textBaselineY,
            {
                fontSize: this.ast.size,
                fill: "#000",
            }
        );
    }
}
