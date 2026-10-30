import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, ParserContext, SourceSpan, LengthValue } from "../ASTtypes.js";
import { ErrorDiagnostic } from "../../diagnostic.js";
import { findClosingQuote, quote } from "../../parser/parse-utils/string-utils.js";
import type { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import { DEFAULT_KEY, TemporalNodeBase } from "../temporal.js";
import type { LayoutBox, LayoutPrepareContext } from "../../layout/types.js";
import { paintRichLine, parseRichText, prepareRichLine, type PreparedRichLine } from "../../render/text.js";
import type { Painter, TextStyle } from "../../render/types.js";

type TextAlign = "left" | "center" | "right";

class TextFunction extends ASTFunctionNode {
    static override def = {
        name: ["text"],
        description: "文本标记",
        details: `\
~~~jpfun
@text(进入主题, size=0.8em, align=center)
~~~
**简写**：直接写双引号文本，如 \`"进入主题"\`；可跨行，双引号须配对。

支持 \`*斜体*\`、\`**粗体**\`、\`_下划线_\`、\`^上标^\`（再次出现即关闭，不关闭则一直生效；写 \`\\*\`、\`\\_\`、\`\\^\` 显示原字符）。支持 \`\\uE050\` 形式的 Unicode 转义；反斜杠写 \`\\\\\`。`,
        allowExtraArgs: false,
        args: [
            {
                type: "string" as const,
                description: "文本内容，可直接换行；含逗号等歧义字符时需加引号",
                default: null,
            },
            {
                name: "size",
                description: "文本字号",
                type: "length" as const,
                default: {
                    value: 0.8, // 常用于标记，默认小一些
                    unit: "em",
                } as LengthValue,
            },
            {
                name: "lineheight",
                description: "相对自身字号的行高倍数",
                type: "number" as const,
                default: 1.25,   // 相对自身字号的倍数
            },
            {
                name: "align",
                description: "文本对齐方式：`left`、`center` 或 `right`",
                type: "string" as const,
                default: "left",
            },
            {
                name: "font",
                description: "文本字体，空值沿用当前字体设置",
                type: "string" as const,
                default: ""
            },
        ],
    };

    static override deSugarAtom(source: string, start: number, end: number) {
        if (source[start] !== '"') return null;
        const close = findClosingQuote(source, start, end);
        if (close < 0) return null; // 未闭合就不去糖，与预处理“配对才算字符串”一致
        const node: GrammarSugarNode = {
            kind: "sugar",
            data: TextFunction,
            span: { start, end: close + 1 },
            syntaxKind: "string",
        };
        return { next: close + 1, node };
    }

    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        const node = nodes[at] as GrammarSugarNode;
        if (node.data !== TextFunction) return null;
        // 之所以不在 deSugarAtom 里直接解码返回 typed call，是因为字符串转义可能产生诊断（如非法 \u 转义）：
        // 第一轮 deSugarAtom 没有 ctx（抛异常则会中断词法扫描），放到第二轮才能复用 parseArgWithType 记录警告并回退原文
        ctx.pushNode(new TextFunction(node.span, new Map([[0, ctx.parseArgWithType(node.span, "string")!]]), ctx, null));
        return at + 1;
    }

    readonly text: string;
    size: number;
    readonly lineHeight: number;
    align: TextAlign;
    readonly font: string;
    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [text, size, lineHeight, align, font] = this.getArgValue(args, ctx) as [string, LengthValue, number, TextAlign, string | null];
        this.font = font || ctx.variables.font;
        if (align !== "left" && align !== "center" && align !== "right") {
            throw new ErrorDiagnostic(
                "E_TEXT_INVALID_ALIGN",
                "@text 的 align 参数必须是 'left'、'center' 或 'right'",
                sourceSpan,
            );
        }
        this.text = text.replace(/\r?\n/g, "\n");
        this.size = ctx.length2px(size);
        this.lineHeight = lineHeight;
        this.align = align;
    }

    override loweringEnter() { return [new TextTemporalNode(this)]; }

    override toString() {
        return `@text(${quote(this.text)}, size=${this.size}px, lineheight=${this.lineHeight}, align=${this.align}, font=${quote(this.font)})`;
    }
}

export const TextNode: ASTFunctionClass = TextFunction;

class TextTemporalNode extends TemporalNodeBase {
    declare ast: TextFunction;
    declare box: LayoutBox;

    private preparedLines: PreparedRichLine[] = [];

    constructor(ast: TextFunction) {
        super();
        this.ast = ast;
        this.mergeKey = DEFAULT_KEY;
        this.initLayoutBox();
    }

    override prepareLayout(context: LayoutPrepareContext) {
        const { text, align, size, font, lineHeight } = this.ast;
        const style: TextStyle = { fontSize: size, fontFamily: font, fill: "#000", textAlign: align };
        this.preparedLines = parseRichText(text).map(runs => prepareRichLine(runs, style, context.textMeasurer));
        const first = this.preparedLines[0];
        const width = Math.max(...this.preparedLines.map(l => l.w));

        this.box.w = width;
        this.box.h = (this.preparedLines.length - 1) * lineHeight * size + first.h;
        this.box.visualAxis = this.box.h / 2;
        if (align === "center") this.box.anchor = width / 2;
        else {
            // 左/右对齐时锚点落在首行首/末字符中心，单字标记才能像音符一样对准宿主
            const edgeIdx = align === "right" ? -1 : 0;
            const edgeRun = first.runs.at(edgeIdx);
            const half = edgeRun ? context.textMeasurer.measureText([...edgeRun.text].at(edgeIdx)!, edgeRun.style).w / 2 : 0;
            this.box.anchor = align === "right" ? width - half : half;
        }
    }

    override paint(painter: Painter) {
        const { align, lineHeight, size } = this.ast;
        const x = this.box.x + (align === "center" ? this.box.w / 2 : align === "right" ? this.box.w : 0);
        let y = this.box.y + this.preparedLines[0].baseline;
        for (const line of this.preparedLines) {
            paintRichLine(painter, line, x, y);
            y += lineHeight * size;
        }
    }
}
