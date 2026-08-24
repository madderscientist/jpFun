import type { LoweringContext } from "../../lowering/loweringContext.js";
import {
    DEFAULT_PAGE_CONFIG,
    normalizePageConfig,
} from "../../layout/page.js";
import type {
    AttachmentGeometry,
    AttachmentLayoutContext,
    LayoutAttachment,
    PageConfig,
} from "../../layout/types.js";
import type { TextStyle } from "../../render/types.js";
import { Diagnostic, WarningDiagnostic } from "../../diagnostic.js";
import {
    ASTFunctionNode,
    type ASTFunctionClass,
    type ASTNodeBase,
    type FunctionArgs,
    type LengthValue,
    type ParserContext,
    type SourceSpan,
} from "../ASTtypes.js";

const px = (value: number): LengthValue => ({ value, unit: "px" });

/** 页码字号，同时也是放得下页码所需的最小下边距 */
export const PAGE_NUMBER_FONT_SIZE = 16;
const PAGE_NUMBER_STYLE: TextStyle = { fontSize: PAGE_NUMBER_FONT_SIZE, textAlign: "center", fill: "#606060" };

/** 模式串里的 1 是计数符号，最后一个取总页数，其余取当前页 */
function formatPageNumber(pattern: string, current: number, total: number): string {
    const last = pattern.lastIndexOf("1");
    return pattern.replace(/1/g, (_, index: number) => String(index === last ? total : current));
}

/** 浮在每页下边距带里的页码，不属于任何谱面行，因此不申报 Track 占用 */
class PageNumberAttachment implements LayoutAttachment {
    readonly layer = "foreground" as const;

    constructor(
        readonly sourceSpan: SourceSpan,
        private readonly pattern: string,
        private readonly marginBottom: number,
    ) {}

    createGeometry(context: AttachmentLayoutContext): AttachmentGeometry {
        const marks = context.pages.map((page, index) => {
            const text = formatPageNumber(this.pattern, index + 1, context.pages.length);
            const { w, h, baseline } = context.textMeasurer.measureText(text, PAGE_NUMBER_STYLE);
            const center = page.y + page.h - this.marginBottom / 2;
            return { text, x: page.x + page.w / 2, y: center - h / 2 + baseline, w, h, baseline };
        });
        return {
            regions: marks.map(({ x, y, w, h, baseline }) => ({ x: x - w / 2, y: y - baseline, w, h })),
            paint(painter) {
                for (const mark of marks) painter.drawText(mark.text, mark.x, mark.y, PAGE_NUMBER_STYLE);
            },
        };
    }
}

export class PageFunction extends ASTFunctionNode {
    static override def = {
        name: ["page"],
        description: "设置文档页面尺寸、边距、最小谱面行间距和页码",
        example: "@page(width=794px, height=1123px, top=48px, bottom=48px, left=40px, right=40px, gap=1em, numbering=\"1/1\")",
        allowExtraArgs: false,
        args: [
            { name: "width", type: "length" as const, default: px(DEFAULT_PAGE_CONFIG.width) },
            { name: "height", type: "length" as const, default: px(0) },
            { name: "top", type: "length" as const, default: px(DEFAULT_PAGE_CONFIG.marginTop) },
            { name: "bottom", type: "length" as const, default: px(DEFAULT_PAGE_CONFIG.marginBottom) },
            { name: "left", type: "length" as const, default: px(DEFAULT_PAGE_CONFIG.marginLeft) },
            { name: "right", type: "length" as const, default: px(DEFAULT_PAGE_CONFIG.marginRight) },
            { name: "gap", type: "length" as const, default: { value: 1, unit: "em" as const } },
            // 模式串里的 1 是计数符号，最后一个取总页数
            { name: "numbering", type: "string" as const, default: "" },
        ],
    };

    readonly config: PageConfig | null;
    private readonly numbering: string = "";

    constructor(
        sourceSpan: SourceSpan,
        args: FunctionArgs,
        ctx: ParserContext,
        parent: ASTNodeBase | null = null,
    ) {
        super(sourceSpan, parent);

        if (ctx.scopeDepth !== 0) {
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_PAGE_NOT_TOP_LEVEL",
                "@page 只能在文档顶层声明；当前声明已忽略",
                sourceSpan,
            ));
            this.config = null;
            return;
        }

        if (ctx.documentDeclarations["page"]) {
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_DUPLICATE_PAGE",
                "文档只能声明一个 @page；后续声明已忽略",
                sourceSpan,
            ));
            this.config = null;
            return;
        }
        ctx.documentDeclarations["page"] = true;

        const values = this.getArgValue(args, ctx);
        const numbering = values.pop() as string;
        const [width, height, top, bottom, left, right, gap] =
            (values as LengthValue[]).map(value => ctx.length2px(value));
        if (!Number.isFinite(width) || width <= 0)
            throw Diagnostic.error.InvalidPageConfig("@page 的 width 必须是正有限长度", sourceSpan);
        if (!Number.isFinite(height) || height < 0)
            throw Diagnostic.error.InvalidPageConfig("@page 的 height 必须是非负有限长度；0 表示不分页", sourceSpan);
        if ([top, bottom, left, right, gap].some(value => !Number.isFinite(value) || value < 0))
            throw Diagnostic.error.InvalidPageConfig("@page 的边距和 gap 必须是非负有限长度", sourceSpan);
        if (left + right >= width)
            throw Diagnostic.error.InvalidPageConfig("@page 的左右边距没有留下可用内容宽度", sourceSpan);
        if (height > 0 && top + bottom >= height)
            throw Diagnostic.error.InvalidPageConfig("@page 的上下边距没有留下可用内容高度", sourceSpan);
        if (numbering && bottom < PAGE_NUMBER_FONT_SIZE)
            throw Diagnostic.error.InvalidPageConfig(
                `@page 的 bottom 至少需要 ${PAGE_NUMBER_FONT_SIZE}px 才能放下页码`,
                sourceSpan,
            );

        this.config = normalizePageConfig({
            width,
            height,
            marginTop: top,
            marginBottom: bottom,
            marginLeft: left,
            marginRight: right,
            lineGap: gap,
        });
        this.numbering = numbering;
    }

    override loweringEnter(ctx: LoweringContext) {
        if (!ctx || !this.config) return [];
        ctx.setPageConfig(this.config);
        if (this.numbering) {
            ctx.addLayoutAttachment(
                new PageNumberAttachment(this.sourceSpan, this.numbering, this.config.marginBottom),
            );
        }
        return [];
    }
}

export const PageNode: ASTFunctionClass = PageFunction;