import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, ParserContext, SourceSpan, LengthValue } from "../ASTtypes.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import { isVisualTemporalNode, type VisualTemporalNode } from "../../lowering/types.js";
import { ErrorDiagnostic } from "../../diagnostic.js";
import { unionLayoutBoxes } from "../../layout/engine.js";
import { layoutHorizontalRegion } from "../../layout/model.js";
import type { HorizontalLineView, LayoutAttachment, Rect } from "../../layout/types.js";
import type { Painter } from "../../render/types.js";

class BoxFunction extends ASTFunctionNode {
    static override def = {
        name: ["box"],
        description: "给目标结构或对象加外框",
        example: `@box(content, padding=0.2em, stroke=0.08em, width=-1px)`,
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
                    unit: "px",
                } as LengthValue,
            },
            {
                name: "width",
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
          const members: Rect[] = [];
        const temporalMembers: VisualTemporalNode[] = [];
        ctx.beginLoweringGroup(this, {
            attachment: new BoxLayoutAttachment(members, temporalMembers, this),
            onTemporal(node) {
                if (!isVisualTemporalNode(node)) return;
                members.push(node.box);
                temporalMembers.push(node);
            },
            onAttachment(attachment) {
                members.push(attachment.box);
            },
        });
        return [];
    }

    /** 目标内容完成 lowering 后结束当前 box 作用域 */
    override loweringExit(ctx: LoweringContext) {
        ctx.endLoweringGroup(this);
        return [];
    }

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [tgt, pad, stroke, width] = this.getArgValue(args, ctx) as [ASTNodeBase, LengthValue, LengthValue, LengthValue];
        tgt.parent = this;
        this.target = tgt;
        this.padding = Math.max(0, ctx.length2px(pad));
        this.stroke = Math.max(0, ctx.length2px(stroke));
        this.width = ctx.length2px(width);
    }
}

export const BoxNode: ASTFunctionClass = BoxFunction;

class BoxLayoutAttachment implements LayoutAttachment {
    box: Rect = {
        x: 0,
        y: 0,
        w: 0,
        h: 0,
    };
    layer = "background" as const;

    /** 同一个数组会在 lowering 递归过程中持续加入成员盒引用 */
    private readonly members: Rect[];
    private readonly temporalMembers: VisualTemporalNode[];
    private readonly owner: BoxFunction;
    private fixedStart: VisualTemporalNode | null = null;
    private wallOffset = 0;
    get sourceSpan() { return this.owner.sourceSpan; }

    constructor(
        members: Rect[],
        temporalMembers: VisualTemporalNode[],
        owner: BoxFunction,
    ) {
        this.members = members;
        this.temporalMembers = temporalMembers;
        this.owner = owner;
    }

    /** 定宽 box 在成员覆盖的全局列上运行局部墙布局 */
    prepareHorizontal(context: HorizontalLineView[]) {
        const layoutLine = this.temporalMembers[0]?.layoutLine;
        if (layoutLine === void 0) return;
        if (this.temporalMembers.some(member => member.layoutLine !== layoutLine)) {
            throw new ErrorDiagnostic(
                "E_BOX_CROSS_LINE",
                "@box 的内容不能跨越谱面行",
                this.owner.sourceSpan,
            );
        }
        if (this.owner.width <= 0) return;

        const line = context[layoutLine];
        if (!line) return;
        let first: VisualTemporalNode | null = null;
        let last: VisualTemporalNode | null = null;
        let firstIndex = Infinity;
        let lastIndex = -Infinity;
        let leftInset = 0;
        let rightInset = 0;

        // 首末列可能同时站着多个声部，取其中最宽的固有半宽
        for (const member of this.temporalMembers) {
            const index = line.columnOf(member);
            if (index < 0) continue;
            const left = member.box.anchor;
            const right = member.box.w - left;
            if (index < firstIndex) { firstIndex = index; first = member; leftInset = left; }
            else if (index === firstIndex) leftInset = Math.max(leftInset, left);
            if (index > lastIndex) { lastIndex = index; last = member; rightInset = right; }
            else if (index === lastIndex) rightInset = Math.max(rightInset, right);
        }
        if (!first || !last) return;

        if (this.owner.width < leftInset + rightInset - 1e-6) {
            throw new ErrorDiagnostic(
                "E_BOX_WIDTH_TOO_SMALL",
                "@box 的宽度小于首末元素的固有宽度",
                this.owner.sourceSpan,
            );
        }
        line.registerHorizontalLayoutHook(first, last, ({
            columns, rows, start, end, X, fixed, options,
        }) => {
            if (fixed[start - 1] || fixed[end]) {
                throw new ErrorDiagnostic(
                    "E_BOX_CONSTRAINT_CROSSING",
                    "定宽 @box 可以嵌套，但不能部分交叉",
                    this.owner.sourceSpan,
                );
            }
            const regionX = X.subarray(start, end + 1);
            layoutHorizontalRegion(
                columns.slice(start, end + 1),
                rows,
                regionX,
                fixed.subarray(start, end),
                this.owner.width,
                options,
                true,
            );
            const actualWidth = regionX[regionX.length - 1] - regionX[0] + leftInset + rightInset;
            if (Math.abs(actualWidth - this.owner.width) > 1e-6) {
                throw new ErrorDiagnostic(
                    "E_BOX_CONSTRAINT_CONFLICT",
                    "多个 @box 为相同内容指定了不同宽度",
                    this.owner.sourceSpan,
                );
            }
            this.fixedStart = first;
            this.wallOffset = -regionX[0];
        });
    }

    /**
     * box 必须等所有成员获得最终 x 和 y 后再求边界
     * stroke 以矩形边界为中心绘制，因此外接盒额外包含半个线宽
     */
    layout() {
        const { padding, stroke } = this.owner;
        const rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
        // 未命名歌词等 attachment 会保留全零盒，不能让它把边框拉到文档原点
        if (!unionLayoutBoxes(rect, this.members.filter(member => member.w > 0 || member.h > 0))) return [];

        const inset = padding + stroke / 2;
        // 边框不抢轨道纵向空间，只参与画布边界；this.box 由引擎写回
        const fixedX = this.fixedStart
            ? this.fixedStart.box.x + this.fixedStart.box.anchor + this.wallOffset
            : rect.x;
        return [{
            x: fixedX - inset,
            y: rect.y - inset,
            w: (this.fixedStart ? this.owner.width : rect.w) + inset * 2,
            h: rect.h + inset * 2,
        }];
    }

    paint(painter: Painter) {
        if (this.box.w === 0 && this.box.h === 0) return;

        const stroke = this.owner.stroke;
        const inset = stroke / 2;
        painter.drawRect(
            this.box.x + inset,
            this.box.y + inset,
            Math.max(0, this.box.w - stroke),
            Math.max(0, this.box.h - stroke),
            {
                stroke: "#000",
                strokeWidth: stroke,
            },
        );
    }
}