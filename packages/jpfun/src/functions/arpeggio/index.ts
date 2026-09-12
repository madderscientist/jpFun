import { ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
import { Fraction } from "../../fraction.js";
import { prepareLayoutHost } from "../../layout/engine.js";
import type { LayoutBox, LayoutPrepareContext } from "../../layout/types.js";
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
import { TemporalNodeBase, type TimeState, type VisualTemporalNode } from "../temporal.js";
import { prepareArpeggioShape } from "./shape.js";

type FoldShape = VisualTemporalNode & {
    readonly members: readonly VisualTemporalNode[];
    readonly ast: VisualTemporalNode["ast"] & { readonly contents: readonly ASTNodeBase[] };
};

/** Fold 保持模块私有；琶音只在自己的边界读取它已经公开在实例上的结构。 */
function readFold(node: VisualTemporalNode): FoldShape | null {
    const candidate = node as unknown as Partial<FoldShape>;
    const ast = node.ast as unknown as { callName?: string; contents?: unknown };
    return (ast.callName === "up" || ast.callName === "down")
        && Array.isArray(candidate.members)
        && Array.isArray(ast.contents)
        ? candidate as FoldShape
        : null;
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
        let host: VisualTemporalNode | null = null;
        ctx.isolateFromLoweringGroups(() => {
            const events = ctx.trackedEvents(this.content, new Fraction(), track).flat();
            if (events.length !== 1 || !events[0].box) {
                throw new ErrorDiagnostic(
                    "E_ARPEGGIO_INVALID_CONTENT",
                    "@arp 的内容必须恰好产生一个同轨和弦",
                    this.content.sourceSpan,
                );
            }
            host = events[0] as VisualTemporalNode;
        });

        const fold = readFold(host!);
        if (!fold || fold.members.length < 2 || fold.members.some(member => member.track !== track)) {
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

    private readonly host: FoldShape;
    private readonly playbackMembers: readonly VisualTemporalNode[];
    private hostX = 0;
    private markX = 0;
    private markCommands: PathCommand[] = [];

    constructor(ast: ArpeggioFunction, host: FoldShape) {
        super();
        this.ast = ast;
        this.host = host;
        const aboveCount = host.ast.contents.length;
        const bottomToTop = [
            ...host.members.slice(aboveCount).reverse(),
            host.members[0],
            ...host.members.slice(1, aboveCount),
        ];
        this.playbackMembers = ast.direction === "down" ? bottomToTop.reverse() : bottomToTop;
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
        this.host.onTimeState?.(state);
    }

    override prepareLayout(context: LayoutPrepareContext) {
        if (this.addon) {
            this.host.addon = this.addon;
            this.addon = void 0;
        }
        prepareLayoutHost(this.host, context);

        const em = this.ast.size;
        const gap = em * 0.16;
        const { commands, bounds: markBounds } = prepareArpeggioShape(this.host.box.h, em, this.ast.direction);
        this.markCommands = commands;
        this.markX = -markBounds.x;
        this.hostX = markBounds.w + gap;
        this.box.w = this.hostX + this.host.box.w;
        this.box.h = this.host.box.h;
        this.box.anchor = this.hostX + this.host.box.anchor;
        this.box.visualAxis = this.host.box.visualAxis;
        for (const name in this.host.ports) {
            const port = this.host.ports[name];
            this.ports[name] = { x: this.hostX + port.x, y: port.y };
        }
    }

    override onPlaced() {
        this.host.box.x = this.box.x + this.hostX;
        this.host.box.y = this.box.y;
        this.host.onPlaced?.();
    }

    /**
     * 先发布宿主，再将各成员的内部区间缩放到延迟后的剩余窗口
     * 这里只调整结构区间，系统控制事件仍保留原来的声明时刻
     */
    override emitPlayback(emitter: PlaybackEmitter) {
        emitter.play(this.host);
        const total = emitter.end.clone().sub(emitter.start);
        const step = new Fraction(1, 8)
        // 短音段限制总延迟，让最后一个成员仍保留至少一半的宿主窗口。
        const maxStep = total.clone().div(2).div(this.playbackMembers.length - 1);
        if (step.compare(maxStep) > 0) step.copyFrom(maxStep);
        // 槽位取自成员顺序；无声成员也占槽，不能按实际发声音符重新编号。
        const slots = new Map<TemporalNodeBase, number>(
            this.playbackMembers.map((member, index) => [member, index]),
        );
        const owner = this;
        emitter.defer(context => {
            let rootOrigin: PlaybackOrigin | undefined;
            // 反向锁定最近一次宿主访问的来源身份，避免修改前一遍反复留下的区间。
            for (let index = context.spans.length - 1; index >= 0; index--) {
                const note = context.spans[index];
                if (!note.origins.some(origin => origin.node === owner)) continue;
                rootOrigin = note.origins[0];
                break;
            }
            if (!rootOrigin) return;
            // 先限制到同一次顶层访问，再由成员来源筛出本宿主的全部有声、无声子区间。
            for (const note of context.spans) {
                if (note.origins[0] !== rootOrigin) continue;
                const member = note.origins.find(origin => slots.has(origin.node))?.node;
                const slot = member ? slots.get(member) : undefined;
                if (!slot) continue;
                // 起止一起缩放再平移，保留宿主终点及成员内部节奏，避免只钳制尾部造成负时值。
                const delay = step.clone().mul(slot);
                const scale = total.clone().sub(delay).div(total);
                note.start.sub(emitter.start).mul(scale).add(emitter.start).add(delay);
                note.end.sub(emitter.start).mul(scale).add(emitter.start).add(delay);
            }
        });
    }

    override paint(painter: Painter) {
        const originX = this.box.x;
        const originY = this.box.y;
        painter.drawPath(this.markCommands, { fill: "#000" }, {
            x: originX + this.markX, y: originY, scaleX: 1, scaleY: 1,
        });
        this.host.paint(painter);
        for (const decoration of this.host.decorations) decoration.paint(painter);
    }
}