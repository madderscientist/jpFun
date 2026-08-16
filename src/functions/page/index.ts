import type { LoweringContext } from "../../lowering/loweringContext.js";
import {
    DEFAULT_PAGE_CONFIG,
    normalizePageConfig,
} from "../../layout/page.js";
import type { PageConfig } from "../../layout/types.js";
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

export class PageFunction extends ASTFunctionNode {
    static override def = {
        name: ["page"],
        description: "设置文档页面尺寸、边距和最小谱面行间距",
        example: "@page(width=794px, height=1123px, top=48px, bottom=48px, left=40px, right=40px, gap=1em)",
        allowExtraArgs: false,
        args: [
            { name: "width", type: "length" as const, default: px(DEFAULT_PAGE_CONFIG.width) },
            { name: "height", type: "length" as const, default: px(0) },
            { name: "top", type: "length" as const, default: px(DEFAULT_PAGE_CONFIG.marginTop) },
            { name: "bottom", type: "length" as const, default: px(DEFAULT_PAGE_CONFIG.marginBottom) },
            { name: "left", type: "length" as const, default: px(DEFAULT_PAGE_CONFIG.marginLeft) },
            { name: "right", type: "length" as const, default: px(DEFAULT_PAGE_CONFIG.marginRight) },
            { name: "gap", type: "length" as const, default: { value: 1, unit: "em" as const } },
        ],
    };

    readonly config: PageConfig | null;

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

        const values = this.getArgValue(args, ctx) as LengthValue[];
        const [width, height, top, bottom, left, right, gap] = values.map(value => ctx.length2px(value));
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

        this.config = normalizePageConfig({
            width,
            height,
            marginTop: top,
            marginBottom: bottom,
            marginLeft: left,
            marginRight: right,
            lineGap: gap,
        });
    }

    override loweringEnter(ctx: LoweringContext) {
        if (ctx && this.config) ctx.setPageConfig(this.config);
        return [];
    }
}

export const PageNode: ASTFunctionClass = PageFunction;