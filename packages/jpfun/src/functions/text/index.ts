import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, ParserContext, SourceSpan, LengthValue } from "../ASTtypes.js";
import { ErrorDiagnostic } from "../../diagnostic.js";
import { DEFAULT_KEY, TemporalNodeBase } from "../../lowering/types.js";
import type { LayoutBox, LayoutPrepareContext } from "../../layout/types.js";
import type { Painter, TextStyle } from "../../render/types.js";

type TextAlign = "left" | "center" | "right";

class TextFunction extends ASTFunctionNode {
    static override def = {
        name: ["text"],
        description: "文本标记。括号内可直接换行，支持 left、center、right 对齐",
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
            },
            {
                name: "lineheight",
                type: "number" as const,
                default: 1.25,   // 相对自身字号的倍数
            },
            {
                name: "align",
                type: "string" as const,
                default: "left",
            }
        ],
    };

    lines: string[];
    size: number;
    lineAdvance: number;
    align: TextAlign;
    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [text, size, lineHeight, align] = this.getArgValue(args, ctx) as [string, LengthValue, number, TextAlign];
        if (align !== "left" && align !== "center" && align !== "right") {
            throw new ErrorDiagnostic(
                "E_TEXT_INVALID_ALIGN",
                "@text 的 align 参数必须是 'left'、'center' 或 'right'",
                sourceSpan,
            );
        }
        this.lines = text.split(/\r?\n/);
        this.size = ctx.length2px(size);
        this.lineAdvance = lineHeight * this.size;
        this.align = align;
    }

    override loweringEnter() { return [new TextTemporalNode(this)]; }

    override toString() {
        const lineHeight = this.size === 0 ? 1.25 : this.lineAdvance / this.size;
        return `@text(${JSON.stringify(this.lines.join("\n"))}, size=${this.size}px, lineheight=${lineHeight}, align=${this.align})`;
    }
}

export const TextNode: ASTFunctionClass = TextFunction;

class TextTemporalNode extends TemporalNodeBase {
    declare ast: TextFunction;
    declare box: LayoutBox;

    private style: TextStyle;
    private textBaselineY = 0;

    constructor(ast: TextFunction) {
        super();
        this.ast = ast;
        this.mergeKey = DEFAULT_KEY;
        this.style = { fontSize: ast.size, fill: "#000", textAlign: ast.align };
        this.initLayoutBox();
    }

    override prepareLayout(context: LayoutPrepareContext) {
        const { lines, align, lineAdvance } = this.ast;
        const measure = (text: string) => context.textMeasurer.measureText(text, this.style);
        const first = measure(lines[0]);
        let width = first.w;
        for (let i = 1; i < lines.length; i++) width = Math.max(width, measure(lines[i]).w);

        this.box.w = width;
        this.box.h = (lines.length - 1) * lineAdvance + first.h;
        this.box.visualAxis = this.box.h / 2;
        this.textBaselineY = first.baseline;
        if (align === "center") this.box.anchor = width / 2;
        else if (align === "right") {
            const lastChar = [...lines[0]].at(-1);
            this.box.anchor = width - (lastChar ? measure(lastChar).w / 2 : 0);
        } else {
            // 左对齐时锚点落在首字符中心，单字标记才能像音符一样对准宿主
            const firstChar = [...lines[0]][0];
            this.box.anchor = firstChar ? measure(firstChar).w / 2 : 0;
        }
    }

    override paint(painter: Painter) {
        const { lines, align, lineAdvance } = this.ast;
        const x = this.box.x + (align === "center" ? this.box.w / 2 : align === "right" ? this.box.w : 0);
        let y = this.box.y + this.textBaselineY;
        for (const line of lines) {
            painter.drawText(line, x, y, this.style);
            y += lineAdvance;
        }
    }
}
