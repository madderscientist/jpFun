import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, LengthValue, ParserContext, SourceSpan } from "../ASTtypes.js";
import { WarningDiagnostic } from "../../diagnostic.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import { isVisualTemporalNode, type LoweringGroup, type VisualTemporalNode } from "../../lowering/types.js";
import type {
    AttachmentLayoutContext,
    LayoutAttachment,
    LayoutPrepareContext,
    LayoutRegion,
} from "../../layout/types.js";
import type { PaintStyle, Painter, PathCommand, PathTransform, TextStyle } from "../../render/types.js";

class AdjustFunction extends ASTFunctionNode {
    static override def = {
        name: ["adjust", "adj"],
        description: "微调目标的位置与占位",
        example: `@adjust(content, dx=0px, dy=0px, dw=0px, dh=0px)
    dw/dh 在排版前增减占位，最终尺寸不小于 0；dw 按原左右占位比例分配，dh 调整下方；
    dx/dy 在排版完成后平移目标，邻居不会让开，因此可以故意重叠。
    括住的若是关系对象（连音线等）且其中没有对象，平移的就是这条关系对象`,
        allowExtraArgs: false,
        args: [
            {
                type: "content" as const,
                default: null,
            },
            {
                name: "dx",
                type: "length" as const,
                default: { value: 0, unit: "px" } as LengthValue,
            },
            {
                name: "dy",
                type: "length" as const,
                default: { value: 0, unit: "px" } as LengthValue,
            },
            {
                name: "dw",
                type: "length" as const,
                default: { value: 0, unit: "px" } as LengthValue,
            },
            {
                name: "dh",
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
    override timeFlowModel() {
        return {
            children: [this.target],
            mode: "sequence" as const,
        };
    }

    /** 微调不创建时间事件，只收集作用域内的对象与关系对象 */
    override loweringEnter(ctx: LoweringContext) {
        const targets = { temporal: 0, attachment: 0 };
        const group: AdjustGroup = {
            targets,
            onTemporal: node => {
                if (!isVisualTemporalNode(node)) return;
                targets.temporal++;
                offsetTemporal(node, this);
            },
            onAttachment: attachment => {
                targets.attachment++;
                offsetAttachment(attachment, targets, this.dx, this.dy);
            },
        };
        ctx.beginLoweringGroup(this, group);
        return [];
    }

    override loweringExit(ctx: LoweringContext) {
        const group = ctx.endLoweringGroup(this) as AdjustGroup;
        if (group.targets.temporal === 0 && group.targets.attachment === 0) {
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_ADJUST_NO_TARGET",
                "@adjust 没有找到可调整的对象",
                this.sourceSpan,
            ));
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
}

export const AdjustNode: ASTFunctionClass = AdjustFunction;

/** loweringExit 据此判断这次微调是否落空 */
interface AdjustGroup extends LoweringGroup {
    readonly targets: AdjustTargets;
}

interface AdjustTargets {
    temporal: number;
    attachment: number;
}

/** 在原对象上组合布局生命周期，保持布局索引依赖的对象身份 */
function offsetTemporal(node: VisualTemporalNode, owner: AdjustFunction) {
    const { dx, dy, dw, dh } = owner;
    if (dx === 0 && dy === 0 && dw === 0 && dh === 0) return;

    let placedX: number | undefined;
    let placedY: number | undefined;
    const finalize = node.finalizeLayout;
    const onPlaced = node.onPlaced;
    node.finalizeLayout = (context: LayoutPrepareContext) => {
        finalize?.call(node, context);
        const width = Math.max(0, node.box.w + dw);
        node.box.anchor = node.box.w > 0 ? node.box.anchor * width / node.box.w : 0;
        node.box.w = width;
        node.box.h = Math.max(0, node.box.h + dh);
    };
    node.onPlaced = () => {
        if (node.box.x !== placedX) node.box.x += dx;
        if (node.box.y !== placedY) node.box.y += dy;
        onPlaced?.call(node);
        placedX = node.box.x;
        placedY = node.box.y;
    };
}

/**
 * 平移一条关系对象
 *
 * 在原 Attachment 上组合 createGeometry，保留依赖查找与 instanceof 所需的对象身份
 * 作用域里只要有对象被平移过，关系对象就已经跟着端点走了，这里不能再平移第二次
 */
function offsetAttachment(
    attachment: LayoutAttachment,
    targets: Readonly<AdjustTargets>,
    dx: number,
    dy: number,
) {
    if (dx === 0 && dy === 0) return;
    const createGeometry = attachment.createGeometry;
    attachment.createGeometry = (context: AttachmentLayoutContext) => {
        const geometry = createGeometry.call(attachment, context);
        if (targets.temporal > 0) return geometry;

        const shift = (region: LayoutRegion): LayoutRegion => region.line === void 0
            ? { x: region.x + dx, y: region.y + dy, w: region.w, h: region.h }
            : { x: region.x + dx, y: region.y + dy, w: region.w, h: region.h, line: region.line, track: region.track };

        return {
            regions: geometry.regions.map(shift),
            occupancy: geometry.occupancy?.map(shift),
            paint(painter: Painter) {
                // attachment 的绘制大多用闭包存储了，所以只能代理 painter
                geometry.paint(new TranslatingPainter(painter, dx, dy));
            },
        };
    };
}

/** Painter 没有变换栈，被微调的关系对象只能逐条命令平移 */
class TranslatingPainter implements Painter {
    private readonly target: Painter;
    private readonly dx: number;
    private readonly dy: number;

    constructor(target: Painter, dx: number, dy: number) {
        this.target = target;
        this.dx = dx;
        this.dy = dy;
    }

    drawText(text: string, x: number, y: number, style: TextStyle) {
        this.target.drawText(text, x + this.dx, y + this.dy, style);
    }

    drawLine(x1: number, y1: number, x2: number, y2: number, style?: PaintStyle) {
        this.target.drawLine(x1 + this.dx, y1 + this.dy, x2 + this.dx, y2 + this.dy, style);
    }

    drawRect(x: number, y: number, w: number, h: number, style?: PaintStyle) {
        this.target.drawRect(x + this.dx, y + this.dy, w, h, style);
    }

    drawCircle(cx: number, cy: number, r: number, style?: PaintStyle) {
        this.target.drawCircle(cx + this.dx, cy + this.dy, r, style);
    }

    drawPath(commands: readonly PathCommand[], style?: PaintStyle, transform?: PathTransform) {
        if (transform) {
            const moved: PathTransform = { ...transform, x: transform.x + this.dx, y: transform.y + this.dy };
            this.target.drawPath(commands, style, moved);
            return;
        }
        this.target.drawPath(commands.map(command => this.translateCommand(command)), style);
    }

    private translateCommand(command: PathCommand): PathCommand {
        switch (command.op) {
            case "Z": return command;
            case "Q": return {
                op: "Q",
                cx: command.cx + this.dx, cy: command.cy + this.dy,
                x: command.x + this.dx, y: command.y + this.dy,
            };
            case "C": return {
                op: "C",
                cx1: command.cx1 + this.dx, cy1: command.cy1 + this.dy,
                cx2: command.cx2 + this.dx, cy2: command.cy2 + this.dy,
                x: command.x + this.dx, y: command.y + this.dy,
            };
            default: return { op: command.op, x: command.x + this.dx, y: command.y + this.dy };
        }
    }
}
