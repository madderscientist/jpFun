import { ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
import { Fraction } from "../../fraction.js";
import { getLayoutBounds, prepareLayoutHost } from "../../layout/engine.js";
import type { HorizontalLineView, LayoutBox, LayoutPrepareContext } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { Track } from "../../lowering/track.js";
import type { PlaybackEmitter, PlaybackOrigin } from "../../playback/types.js";
import type { Painter, PathCommand } from "../../render/types.js";
import {
    ASTFunctionNode,
    type ASTFunctionClass,
    type ASTNodeBase,
    type FunctionArgs,
    type ParserContext,
    type SourceSpan,
} from "../ASTtypes.js";
import { transferFunctionAddons, TemporalNodeBase, type TimeState, type VisualTemporalNode } from "../temporal.js";
import { prepareArpeggioShape } from "./shape.js";

type FoldShape = VisualTemporalNode & {
    readonly members: readonly VisualTemporalNode[];
    readonly ast: VisualTemporalNode["ast"] & { readonly contents: readonly ASTNodeBase[] };
};

/** Fold 保持模块私有；琶音只在自己的边界读取它已经公开在实例上的结构。 */
function readFold(node: TemporalNodeBase | undefined): FoldShape | null {
    const candidate = node as unknown as Partial<FoldShape> | undefined;
    const ast = candidate?.ast as unknown as { callName?: string; contents?: unknown } | undefined;
    return (ast?.callName === "up" || ast?.callName === "down")
        && Array.isArray(candidate?.members)
        && Array.isArray(ast.contents)
        ? candidate as FoldShape
        : null;
}

/** 折叠成员共享同一对齐锚点，取最宽左半宽才能避免升降号等越过宿主左界压住琶音线 */
function foldAnchor(fold: FoldShape): number {
    let anchor = fold.box.anchor;
    for (const member of fold.members) {
        const nested = readFold(member);
        anchor = Math.max(anchor, nested ? foldAnchor(nested) : member.box.anchor);
    }
    return anchor;
}

class ArpeggioFunction extends ASTFunctionNode {
    static override def = {
        name: ["arp", "arpeggio"],
        description: "琶音",
        details: `\
~~~jpfun
@arp({1 ^ 3 ^ 5}, direction=up)
~~~
给和弦绘制琶音记号，播放时按方向错开成员起点并保持共同终点。复合成员的内部音符按比例压缩到剩余时值，装饰音在确定后的区间内展开。`,
        allowExtraArgs: false,
        args: [
            {
                name: "content",
                description: "由 `up` / `down` 堆叠形成的和弦",
                type: "content" as const,
                default: null
            },
            {
                name: "direction",
                description: "空值从低到高、不画箭头；`up` 从低到高、顶端带箭头；`down` 从高到低、底端带箭头",
                type: "string" as const,
                default: ""
            },
        ],
    };

    readonly content: ASTNodeBase;
    readonly direction: "" | "up" | "down";
    readonly size: number;

    override get children() { return [this.content]; }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        const [content, direction] = this.getArgValue(args, ctx) as [ASTNodeBase, string];
        let normalized: "" | "up" | "down" = "";
        if (direction !== "" && direction !== "up" && direction !== "down") {
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_ARPEGGIO_INVALID_DIRECTION",
                "@arp 的 direction 只能是 up 或 down，已回退到无箭头上行琶音",
                span,
            ));
        } else normalized = direction;
        this.content = content;
        this.direction = normalized;
        this.size = ctx.variables.fontsize;
        content.parent = this;
    }

    override loweringEnter(ctx: LoweringContext, track: Track) {
        const events = ctx.isolateFromLoweringGroups(() =>
            ctx.trackedEvents(this.content, new Fraction(), track).flat());
        const fold = events.length === 1 ? readFold(events[0]) : null;
        if (!fold || fold.members.length < 2) {
            throw new ErrorDiagnostic(
                "E_ARPEGGIO_INVALID_CONTENT",
                "@arp 只接受至少包含两个成员的同轨 @up/@down 折叠体",
                this.content.sourceSpan,
            );
        }
        return [new ArpeggioTemporal(this, fold)];
    }

    override toString(source: string) {
        const direction = this.direction ? `, direction=${this.direction}` : "";
        return `@arp(${this.content.toString(source)}${direction})`;
    }
}

export const ArpeggioNode: ASTFunctionClass = ArpeggioFunction;

class ArpeggioTemporal extends TemporalNodeBase {
    declare ast: ArpeggioFunction;
    declare box: LayoutBox;

    readonly host: FoldShape;
    /** 槽位取自成员顺序；无声成员也占槽，不能按实际发声音符重新编号 */
    private readonly slots: ReadonlyMap<TemporalNodeBase, number>;
    private hostX = 0;
    private markCommands: PathCommand[] = [];

    constructor(ast: ArpeggioFunction, host: FoldShape) {
        super();
        this.ast = ast;
        this.host = host;
        const aboveCount = host.ast.contents.length;
        const bottomToTop = [
            ...host.members.slice(aboveCount).reverse(),
            ...host.members.slice(0, aboveCount),
        ];
        const members = ast.direction === "down" ? bottomToTop.reverse() : bottomToTop;
        this.slots = new Map(members.map((member, index) => [member, index]));
        this.T.copyFrom(host.T);
        this.mergeKey = host.mergeKey;
        this.initLayoutBox();
        if (host.addon) this.addon = { ...host.addon };
        host.addon = void 0;
        host.foldedInto = this;
    }

    override onTimeState(state: TimeState) {
        this.host.t.copyFrom(this.t);
        this.host.T.copyFrom(this.T);
        this.host.track = this.track;
        this.host.layoutLine = this.layoutLine;
        const offset = this.host.onTimeState?.(state);
        this.T.copyFrom(this.host.T);
        return offset;
    }

    override prepareHorizontal(line: HorizontalLineView) {
        this.host.prepareHorizontal?.(line);
    }

    override prepareLayout(context: LayoutPrepareContext) {
        const { host } = this;
        transferFunctionAddons(this, host);
        prepareLayoutHost(host, context);
        this.springConfig = { ...host.springConfig };

        const em = this.ast.size;
        const contentBounds = getLayoutBounds(host, true);
        const bounds = getLayoutBounds(host);
        const { commands, width } = prepareArpeggioShape(contentBounds.h, em, this.ast.direction);
        this.markCommands = commands;
        this.hostX = width + em * 0.16 + foldAnchor(host) - host.box.anchor;
        this.box.w = this.hostX + host.box.w;
        this.box.h = bounds.h;
        this.box.anchor = this.hostX + host.box.anchor;
        this.box.visualAxis = host.box.visualAxis - bounds.y;
        for (const name in host.ports) {
            const port = host.ports[name];
            this.ports[name] = { ...port, x: this.hostX + port.x, y: port.y - bounds.y };
        }
    }

    override onPlaced() {
        this.host.box.x = this.box.x + this.hostX;
        this.host.box.y = this.box.y - (getLayoutBounds(this.host).y - this.host.box.y);
        this.host.onPlaced?.();
    }

    /**
     * 先发布宿主，再将各成员的内部区间缩放到延迟后的剩余窗口
     * 这里只调整结构区间，系统控制事件仍保留原来的声明时刻
     */
    override emitPlayback(emitter: PlaybackEmitter) {
        emitter.play(this.host);
        const total = emitter.end.clone().sub(emitter.start);
        if (total.compare(0) <= 0) return;
        const step = new Fraction(1, 8);
        // 短音段限制总延迟，让最后一个成员仍保留至少一半的宿主窗口。
        const maxStep = total.clone().div(2).div(this.slots.size - 1);
        if (step.compare(maxStep) > 0) step.copyFrom(maxStep);
        const { slots } = this;
        const owner = this;
        emitter.defer(context => {
            let rootOrigin: PlaybackOrigin | undefined;
            // 宿主刚在上面发布，其全部子区间连续排在 spans 末尾；命中后处理完同组即停。
            for (let index = context.spans.length - 1; index >= 0; index--) {
                const note = context.spans[index];
                const origin = note.origins.find(item => item.node === owner);
                if (!origin || (rootOrigin && origin !== rootOrigin)) break;
                rootOrigin = origin;
                const member = note.origins.find(item => slots.has(item.node))?.node;
                const slot = member ? slots.get(member) : undefined;
                if (!slot) continue;
                // 起止一起缩放再平移，保留宿主终点及成员内部节奏，避免只钳制尾部造成负时值。
                const offset = step.clone().mul(slot).add(emitter.start);
                const scale = emitter.end.clone().sub(offset).div(total);
                note.start.sub(emitter.start).mul(scale).add(offset);
                note.end.sub(emitter.start).mul(scale).add(offset);
            }
        });
    }

    override paint(painter: Painter) {
        painter.drawPath(this.markCommands, { fill: "#000" }, {
            x: this.box.x, y: getLayoutBounds(this.host, true).y, scaleX: 1, scaleY: 1,
        });
        this.host.paint(painter);
        for (const decoration of this.host.decorations) decoration.paint?.(painter);
    }
}