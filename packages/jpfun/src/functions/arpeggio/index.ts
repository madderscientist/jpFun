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
        example: `@arp({1 ^ 3 ^ 5}) 默认从低到高，无箭头
    @arp({1 ^ 3 ^ 5}, direction=up) 从低到高，顶端带箭头
    @arp({1 ^ 3 ^ 5}, direction=down) 从高到低，底端带箭头`,
        allowExtraArgs: false,
        args: [
            {
                name: "content",
                type: "content" as const,
                default: null
            },
            {
                name: "direction",
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
        this.size = ctx.fontSize;
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

    override emitPlayback(emitter: PlaybackEmitter) {
        emitter.play(this.host);
        const total = emitter.end.clone().sub(emitter.start);
        const step = new Fraction(1, 8)
        const maxStep = total.clone().div(2).div(this.playbackMembers.length - 1);
        if (step.compare(maxStep) > 0) step.copyFrom(maxStep);
        const slots = new Map<TemporalNodeBase, number>(
            this.playbackMembers.map((member, index) => [member, index]),
        );
        const owner = this;
        emitter.defer(context => {
            let rootOrigin: PlaybackOrigin | undefined;
            for (let index = context.events.length - 1; index >= 0; index--) {
                const event = context.events[index];
                if (!event.origins.some(origin => origin.node === owner)) continue;
                rootOrigin = event.origins[0];
                break;
            }
            if (!rootOrigin) return;
            for (const event of context.events) {
                if ((event.kind !== "note-on" && event.kind !== "note-off")
                    || event.origins[0] !== rootOrigin) continue;
                const member = event.origins.find(origin => slots.has(origin.node))?.node;
                const slot = member ? slots.get(member) : undefined;
                if (!slot) continue;
                event.at.add(step.clone().mul(slot));
                if (event.kind === "note-off" && event.at.compare(emitter.end) > 0) {
                    event.at.copyFrom(emitter.end);
                }
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