import { ErrorDiagnostic } from "../../diagnostic.js";
import { pathBounds } from "../../layout/path.js";
import type { LayoutAttachment } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { LoweringGroup } from "../../lowering/types.js";
import type { Painter, PathCommand } from "../../render/types.js";
import {
    ASTFunctionNode, type ASTFunctionClass, type ASTNodeBase, type FunctionArgs,
    type ParserContext, type SourceSpan,
} from "../ASTtypes.js";
import { isVisualTemporalNode, type VisualTemporalNode } from "../temporal.js";

class SlideFunction extends ASTFunctionNode {
    static override def = {
        name: ["slide"],
        description: "滑入或滑出记号",
        details: `\
~~~jpfun
@slide(5, side=pre, direction=up)
~~~
仅绘制，不改变时值和播放。pre 修饰内容首端，post 修饰末端；up/down 表示随时间上行/下行。`,
        allowExtraArgs: false,
        args: [
            { type: "content" as const, default: null, description: "被修饰的内容" },
            { name: "side", type: "string" as const, default: "pre", description: "pre 滑入，post 滑出" },
            { name: "direction", type: "string" as const, default: "up", description: "up 上行，down 下行" },
        ],
    };

    readonly content: ASTNodeBase;
    readonly side: "pre" | "post";
    readonly direction: "up" | "down";
    override get children() { return [this.content]; }
    override timeFlowModel() { return { children: this.children, mode: "sequence" as const }; }
    override labelable() { return ASTFunctionNode.findLabelable(this.content); }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        const [content, side, direction] = this.getArgValue(args, ctx) as [ASTNodeBase, string, string];
        if (side !== "pre" && side !== "post") throw new ErrorDiagnostic(
            "E_SLIDE_SIDE",
            "@slide 的 side 必须是 pre 或 post",
            span
        );
        if (direction !== "up" && direction !== "down") throw new ErrorDiagnostic(
            "E_SLIDE_DIRECTION",
            "@slide 的 direction 必须是 up 或 down",
            span
        );
        this.content = content;
        this.side = side;
        this.direction = direction;
        content.parent = this;
    }

    override loweringEnter(ctx: LoweringContext) {
        const pre = this.side === "pre";
        const group: SlideGroup = {
            // 只保留首端或末端，不收集整段内容
            onTemporal(node) {
                if (isVisualTemporalNode(node) && (!pre || !group.host)) group.host = node;
            },
        };
        ctx.beginLoweringGroup(this, group);
        return [];
    }

    override loweringExit(ctx: LoweringContext) {
        const { host } = ctx.endLoweringGroup(this) as SlideGroup;
        if (!host) throw new ErrorDiagnostic(
            "E_SLIDE_CONTENT",
            "@slide 的内容必须包含可绘制对象",
            this.sourceSpan
        );
        const attachment = new SlideAttachment(host, this);
        ctx.addAttachment(attachment);
        const prepare = host.prepareHorizontal;
        host.prepareHorizontal = line => {
            prepare?.call(host, line);
            if (line.columnOf(host) < 0) return;
            line.registerHorizontalLayoutHook(host, host, ({ columns, start }) => {
                const pre = this.side === "pre";
                const edge = pre ? "WL" : "WR";
                const inset = pre ? host.box.anchor : host.box.w - host.box.anchor;
                const space = inset + attachment.length + host.ast.size * 0.22;
                // 只扩大宿主的求解占位，重复记号不累加，原始盒子保持不变
                for (const element of columns[start]) {
                    if (element.box !== host.box) continue;
                    element[edge] = Math.max(element[edge], space);
                }
            });
        }; return [];
    }

    override toString(source: string) {
        return `@slide(${this.content.toString(source)}, side=${this.side}, direction=${this.direction})`;
    }
}

export const SlideNode: ASTFunctionClass = SlideFunction;

interface SlideGroup extends LoweringGroup {
    host?: VisualTemporalNode;
}

class SlideAttachment implements LayoutAttachment {
    readonly layer = "foreground" as const;
    readonly endPoints: readonly VisualTemporalNode[];
    get sourceSpan() { return this.owner.sourceSpan; }

    constructor(private readonly host: VisualTemporalNode, private readonly owner: SlideFunction) {
        this.endPoints = [host];
    }

    get length() {
        const { host } = this;
        return host.box.visualAxis - (host.ports["shoulder"]?.y ?? 0) + host.ast.size * 0.1;
    }

    createGeometry() {
        const { host, owner } = this;
        const size = host.ast.size;
        const pre = owner.side === "pre";
        const length = this.length;
        const up = owner.direction === "up";
        const bottom = host.box.y + host.box.visualAxis;
        const left = pre ? host.box.x - size * 0.12 - length : host.box.x + host.box.w + size * 0.12;
        // 下端在中心线，上端略高于数字顶端，45°
        const start = { x: left, y: up ? bottom : bottom - length };
        const end = { x: left + length, y: up ? bottom - length : bottom };
        const angle = up ? -Math.PI / 4 : Math.PI / 4;
        const wing = (offset: number) => ({
            x: end.x - size * 0.25 * Math.cos(angle + offset),
            y: end.y - size * 0.25 * Math.sin(angle + offset),
        });
        const commands: PathCommand[] = [
            { op: "M", ...start }, { op: "L", ...end },
            { op: "M", ...wing(-Math.PI / 6) }, { op: "L", ...end },
            { op: "L", ...wing(Math.PI / 6) },
        ];
        const strokeWidth = size * 0.05;
        const bounds = pathBounds(commands);
        const region = {
            x: bounds.x - strokeWidth / 2, y: bounds.y - strokeWidth / 2,
            w: bounds.w + strokeWidth, h: bounds.h + strokeWidth,
            line: host.layoutLine, track: host.track,
        };
        return {
            regions: [region],
            paint(painter: Painter) {
                painter.drawPath(commands, { fill: "none", stroke: "#000", strokeWidth });
            },
        };
    }
}
