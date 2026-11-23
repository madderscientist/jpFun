import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, LengthValue, ParserContext, SourceSpan } from "../ASTtypes.js";
import { WarningDiagnostic } from "../../diagnostic.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import { isVisualTemporalNode, type VisualTemporalNode } from "../temporal.js";
import type { LoweringGroup } from "../../lowering/types.js";
import {
    isLayoutAttachment,
    LayoutAttachment,
    LayoutPoint,
    LayoutPrepareContext,
} from "../../layout/types.js";

class AdjustFunction extends ASTFunctionNode {
    static override def = {
        name: ["adjust", "adj"],
        description: "微调目标的绘制位置与排版占位",
        details: `\
~~~jpfun
@adjust(1, dx=2px, dy=-1px, dw=0.2em, dh=0px)
~~~

位置偏移在排版后应用，相邻对象保持原位；占位调整在排版前应用。只包裹关系对象时，平移作用于该关系对象本身。`,
        allowExtraArgs: false,
        args: [
            {
                type: "content" as const,
                description: "要微调的内容或关系对象",
                default: null,
            },
            {
                name: "dx",
                description: "排版后的水平偏移，正值向右，不改变占位",
                type: "length" as const,
                default: { value: 0, unit: "px" } as LengthValue,
            },
            {
                name: "dy",
                description: "排版后的垂直偏移，正值向下，不改变占位",
                type: "length" as const,
                default: { value: 0, unit: "px" } as LengthValue,
            },
            {
                name: "dw",
                description: "增减水平占位，按原左右比例分配，最终宽度不小于 0",
                type: "length" as const,
                default: { value: 0, unit: "px" } as LengthValue,
            },
            {
                name: "dh",
                description: "增减下方占位，最终高度不小于 0",
                type: "length" as const,
                default: { value: 0, unit: "px" } as LengthValue,
            },
        ],
    };

    target: ASTNodeBase;
    readonly dx: number;
    readonly dy: number;
    readonly dw: number;
    readonly dh: number;
    override get children() { return [this.target]; }

    /** 微调不创建时间事件，只收集作用域内的对象与关系对象 */
    override loweringEnter(ctx: LoweringContext) {
        const group: AdjustGroup = {
            temporals: 0,
            attachments: [],
            onTemporal: node => {
                if (!isVisualTemporalNode(node)) return;
                group.temporals++;
                addOffset(node, this.dx, this.dy);
                resizeTemporal(node, this.dw, this.dh);
            },
            onAttachment: attachment => {
                if (isLayoutAttachment(attachment)) group.attachments.push(attachment);
            },
        };
        ctx.beginLoweringGroup(this, group);
        return [];
    }

    override loweringExit(ctx: LoweringContext) {
        const { temporals, attachments } = ctx.endLoweringGroup<AdjustGroup>(this);
        if (temporals === 0 && attachments.length === 0) {
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_ADJUST_NO_TARGET",
                "@adjust 没有找到可调整的对象",
                this.sourceSpan,
            ));
        } else if (temporals === 0) {
            // 作用域里有时间对象时，关系对象已跟随端点移动，不能再平移本身
            for (const attachment of attachments) addOffset(attachment, this.dx, this.dy);
        }
        return [];
    }

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [tgt, dx, dy, dw, dh] = this.getArgValue(args, ctx) as [ASTNodeBase, ...LengthValue[]];
        tgt.parent = this;
        this.target = tgt;
        this.dx = ctx.length2px(dx);
        this.dy = ctx.length2px(dy);
        this.dw = ctx.length2px(dw);
        this.dh = ctx.length2px(dh);
    }

    override toString(source: string) {
        return `@adjust(${this.target.toString(source)}, dx=${this.dx}px, dy=${this.dy}px, dw=${this.dw}px, dh=${this.dh}px)`;
    }
}

export const AdjustNode: ASTFunctionClass = AdjustFunction;

/** loweringExit 据此判断这次微调是否落空，以及是否平移关系对象本身 */
interface AdjustGroup extends LoweringGroup {
    temporals: number;
    readonly attachments: LayoutAttachment[];
}

/** 后置平移由引擎在排版后施加，嵌套微调逐层累加 */
function addOffset(target: { placementOffset?: LayoutPoint }, dx: number, dy: number) {
    if (dx === 0 && dy === 0) return;
    const offset = target.placementOffset;
    target.placementOffset = { x: (offset?.x ?? 0) + dx, y: (offset?.y ?? 0) + dy };
}

/** 尺寸增量在原对象上组合 finalizeLayout，保持布局索引依赖的对象身份 */
function resizeTemporal(node: VisualTemporalNode, dw: number, dh: number) {
    if (dw === 0 && dh === 0) return;
    const finalize = node.finalizeLayout;
    node.finalizeLayout = (context: LayoutPrepareContext) => {
        finalize?.call(node, context);
        const width = Math.max(0, node.box.w + dw);
        node.box.anchor = node.box.w > 0 ? node.box.anchor * width / node.box.w : 0;
        node.box.w = width;
        node.box.h = Math.max(0, node.box.h + dh);
    };
}
