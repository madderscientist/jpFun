import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, ParserContext, SourceSpan, LengthValue } from "../ASTtypes.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { LoweringContent, LoweringGroup } from "../../lowering/types.js";
import { isVisualTemporalNode, type VisualTemporalNode } from "../temporal.js";
import { ErrorDiagnostic } from "../../diagnostic.js";
import { layoutHorizontalRegion } from "../../layout/model.js";
import type { AttachmentLayoutContext, HorizontalLineView, LayoutAttachment } from "../../layout/types.js";
import type { Painter } from "../../render/types.js";

type BoxContent = LoweringContent & { nodes: VisualTemporalNode[] };

class BoxFunction extends ASTFunctionNode {
    static override def = {
        name: ["box"],
        description: "给目标结构或对象加外框",
        details: `\
~~~jpfun
@box({1 2 3}, padding=0.2em, stroke=0.08em)
~~~`,
        allowExtraArgs: false,
        args: [
            {
                type: "content" as const,
                description: "需要加框的内容或结构",
                default: null,
            },
            {
                name: "padding",
                description: "内容到框线的内边距，负值向内收缩",
                type: "length" as const,
                default: {
                    value: 0,
                    unit: "em",
                } as LengthValue,
            },
            {
                name: "stroke",
                description: "框线宽度",
                type: "length" as const,
                default: {
                    value: 1,
                    unit: "px",
                } as LengthValue,
            },
            {
                name: "width",
                description: "约束内部排版的宽度，非正值表示随内容自动确定",
                type: "length" as const,
                default: {
                    value: -1,
                    unit: "px",
                } as LengthValue,
            },
        ],
    };

    target: ASTNodeBase;
    padding: number;
    stroke: number;
    width: number;
    override get children() { return [this.target]; }
    override timeFlowModel() {
        return {
            children: [this.target],
            mode: "sequence" as const,
        };
    }

    /**
     * box 不创建时间事件
      * 进入目标内容前只开始收集所有成员矩形的引用
     */
    override loweringEnter(ctx: LoweringContext) {
        const group: LoweringGroup & BoxContent = {
            nodes: [],
            attachments: [],
            onTemporal(node) { if (isVisualTemporalNode(node)) group.nodes.push(node); },
            onAttachment(attachment) { group.attachments.push(attachment); },
        };
        ctx.beginLoweringGroup(this, group);
        return [];
    }

    /** 退出时把注册入口接到首成员；嵌套框按退出顺序由内向外组合 */
    override loweringExit(ctx: LoweringContext) {
        const content = ctx.endLoweringGroup(this) as LoweringGroup & BoxContent;
        const attachment = new BoxLayoutAttachment(content, this);
        ctx.addAttachment(attachment);
        const first = content.nodes[0];
        if (first) {
            const prepare = first.prepareHorizontal;
            first.prepareHorizontal = line => {
                prepare?.call(first, line);
                attachment.registerHorizontal(line);
            };
        }
        return [];
    }

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [tgt, pad, stroke, width] = this.getArgValue(args, ctx) as [ASTNodeBase, LengthValue, LengthValue, LengthValue];
        tgt.parent = this;
        this.target = tgt;
        this.padding = ctx.length2px(pad);
        this.stroke = Math.max(0, ctx.length2px(stroke));
        this.width = ctx.length2px(width);
    }

    override toString(source: string) {
        return `@box(${this.target.toString(source)}, padding=${this.padding}px, stroke=${this.stroke}px, width=${this.width}px)`;
    }
}

export const BoxNode: ASTFunctionClass = BoxFunction;

class BoxLayoutAttachment implements LayoutAttachment {
    layer = "background" as const;

    private fixedStart: VisualTemporalNode | null = null;
    private wallOffset = 0;
    get sourceSpan() { return this.owner.sourceSpan; }

    constructor(
        private readonly content: BoxContent,
        private readonly owner: BoxFunction,
    ) {}

    /** 只在完整包含成员的视图注册；留白和定宽共用同一个由内向外执行的 hook */
    registerHorizontal(line: HorizontalLineView) {
        const members = this.content.nodes;
        let first = members[0];
        if (!first) return;
        if (members.some(member => member.layoutLine !== first.layoutLine)) {
            throw new ErrorDiagnostic(
                "E_BOX_CROSS_LINE",
                "@box 的内容不能跨越谱面行",
                this.owner.sourceSpan,
            );
        }
        let last = first;

        for (const member of members) {
            const index = line.columnOf(member);
            if (index < 0) return;
            if (index < line.columnOf(first)) first = member;
            if (index > line.columnOf(last)) last = member;
        }
        const { width, padding, stroke } = this.owner;
        line.registerHorizontalLayoutHook(first, last, ({
            columns, rows, start, end, X, fixed, options,
        }) => {
            const edge = (index: number) => columns[index].filter(element =>
                members.some(member => member.box === element.box));
            const left = edge(start);
            const right = edge(end);
            if (width > 0) {
                const leftInset = Math.max(...left.map(element => element.WL));
                const rightInset = Math.max(...right.map(element => element.WR));
                if (width < leftInset + rightInset - 1e-6) {
                    throw new ErrorDiagnostic(
                        "E_BOX_WIDTH_TOO_SMALL",
                        "@box 的宽度小于首末元素的固有宽度",
                        this.owner.sourceSpan,
                    );
                }
                if (fixed[start - 1] || fixed[end]) {
                    throw new ErrorDiagnostic(
                        "E_BOX_CONSTRAINT_CROSSING",
                        "定宽 @box 可以嵌套，但不能部分交叉",
                        this.owner.sourceSpan,
                    );
                }
                const regionX = X.subarray(start, end + 1);
                if (start === end) {
                    const extra = (width - leftInset - rightInset) / 2;
                    for (const element of left) element.WL += extra;
                    for (const element of right) element.WR += extra;
                    regionX[0] = leftInset + extra;
                } else {
                    layoutHorizontalRegion(
                        columns.slice(start, end + 1),
                        rows,
                        regionX,
                        fixed.subarray(start, end),
                        width,
                        options,
                        0,
                    );
                    const actualWidth = regionX[regionX.length - 1] - regionX[0] + leftInset + rightInset;
                    if (Math.abs(actualWidth - width) > 1e-6) {
                        throw new ErrorDiagnostic(
                            "E_BOX_CONSTRAINT_CONFLICT",
                            "多个 @box 为相同内容指定了不同宽度",
                            this.owner.sourceSpan,
                        );
                    }
                }
                this.fixedStart = first;
                this.wallOffset = -regionX[0];
            }
            const inset = padding + stroke / 2;
            for (const element of left) element.WL += inset;
            for (const element of right) element.WR += inset;
        });
    }

    /**
     * box 必须等所有成员获得最终 x 和 y 后再求边界
     * stroke 以矩形边界为中心绘制，因此外接盒额外包含半个线宽
     */
    createGeometry(context: AttachmentLayoutContext) {
        const { padding, stroke } = this.owner;
        const rect = context.getContentBounds(this.content);
        if (!rect) {
            return { regions: [], paint() {} };
        }

        const inset = padding + stroke / 2;
        // 边框不抢轨道纵向空间，只参与画布边界
        const fixedX = this.fixedStart
            ? this.fixedStart.box.x + this.fixedStart.box.anchor + this.wallOffset
            : rect.x;
        const region = {
            x: fixedX - inset,
            y: rect.y - inset,
            w: (this.fixedStart ? this.owner.width : rect.w) + inset * 2,
            h: rect.h + inset * 2,
        };
        if (region.w < stroke || region.h < stroke) {
            throw new ErrorDiagnostic(
                "E_BOX_PADDING_TOO_SMALL",
                "@box 的负内边距使边框宽度或高度小于零",
                this.owner.sourceSpan,
            );
        }
        return {
            regions: [region],
            paint(painter: Painter) {
                const strokeInset = stroke / 2;
                painter.drawRect(
                    region.x + strokeInset,
                    region.y + strokeInset,
                    Math.max(0, region.w - stroke),
                    Math.max(0, region.h - stroke),
                    {
                        stroke: "#000",
                        strokeWidth: stroke,
                    },
                );
            },
        };
    }
}