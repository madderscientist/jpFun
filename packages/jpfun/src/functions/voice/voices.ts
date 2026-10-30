import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, ASTTextNode, FunctionArgs, SourceSpan, type LengthValue } from "../ASTtypes.js";
import { ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
import type { Extent, LayoutAttachment, LayoutPrepareContext, LayoutRegion } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { MeasureFn, Track } from "../../lowering/track.js";
import type { GrammarNode } from "../../parser/grammarType.js";
import { findClosingQuote, quote } from "../../parser/parse-utils/string-utils.js";
import { ParserContext } from "../../parser/parserContext.js";
import { paintRichLine, prepareRichLine, type PreparedRichLine } from "../../render/text.js";
import type { Painter, PathCommand, PathTransform } from "../../render/types.js";
import {
    BRACKET_HOOK_COMMANDS, BRACKET_HOOK_DROP, BRACKET_HOOK_REACH,
    CURVED_BRACE_BOUNDS, CURVED_BRACE_COMMANDS,
    parseConnections, resolveConnections, serializeConnections,
    type ConnectionSpec, type VoiceConnection,
} from "./connections.js";
import { VoiceFunction, type VoiceNameTemporal, voiceNameStyle } from "./voice.js";

const MIN_CONNECTOR_STEM = 2.5;
const CONNECTOR_LABEL_GAP_RATIO = 0.3;

/** 分组总名称与组内声部名之间的横向空隙，相对声部块字号 */
const GROUP_NAME_GAP_RATIO = 0.5;

/**
 * voices 块在宿主基线上局部居中：首末两条 voice 基线的中点对齐宿主轴
 *
 * 居中只看**基线**，不看成员的整体视觉边界，也不取所有基线的算术平均值。
 * 因此嵌套的 stack、歌词、装饰只会撑开相邻基线的间距和行高，
 * 不会把整个块相对于主旋律的语义中心挪走。
 *
 * 本行没有实质高度的成员（空声部，或内容都在上一行）仍然占一个默认高度的槽位，
 * 声部数量因而保持稳定，居中结果也不会因为某一声部没写东西而跳变。
 */
type VoicesMeasure = MeasureFn & { size: number; gap: number; minGap: number };

function makeVoicesMeasure(size: number, gap: number, minGap: number): VoicesMeasure {
    const measure: VoicesMeasure = Object.assign(
        (members: readonly (Extent | null)[]) => {
            const half = measure.size / 2;
            const floor = Math.min(measure.gap, measure.minGap);
            const extents: Extent[] = members.map(member =>
                member ? { top: Math.min(member.top, -half), bottom: Math.max(member.bottom, half) } : { top: -half, bottom: half });
            const offsets: number[] = [];
            let y = 0;
            for (let i = 0; i < extents.length; i++) {
                if (i > 0) y += extents[i - 1].bottom + Math.max(measure.gap + half, floor - extents[i].top);
                offsets.push(y);
            }
            const center = (offsets[0] + offsets[offsets.length - 1]) / 2;
            return offsets.map((offset, i) => ({ offset: offset - center, extent: extents[i] }));
        },
        { size, gap, minGap },
    );
    return measure;
}

function findClosingGroupName(source: string, start: number, end: number, open: "{" | "[", close: "}" | "]"): number {
    let depth = 1;
    for (let i = start; i < end; i++) {
        const ch = source[i];
        if (ch === '"') {
            i = findClosingQuote(source, i, end);
            if (i < 0) return -1;
        } else if (ch === "\r" || ch === "\n") return -1;
        else if (ch === open) depth++;
        else if (ch === close && --depth === 0) return i;
    }
    return -1;
}

export class VoicesFunction extends ASTFunctionNode {
    static override def = {
        name: ["voices", "vs"],
        description: "多个声部",
        details: `\
~~~jpfun
@voices(
    @voice({1 2 3}, 右手, 男=ha ha ha),
    @voice({3 4 5}, 左手, "la la la"),
    connect="{-:钢琴}"
)
~~~

接收多个 \`@voice\`，按书写顺序自上而下同时演奏；可用 \`@set(voices.connect="...", voices.gap=1em)\` 预设默认参数。

**简写**：连续的 \`N:\`（及 \`L:\`）自动合为多声部，空行分段。可用 \`V{组名}:\`（花连谱号）、\`V[组名]:\`（直连谱号）、\`V|:\`（连谱线）指定连谱号，组名可省且支持 \`*斜体*\`、\`**粗体**\` 等文字样式：

~~~jpfun
V{钢琴}:
N(右手): 1 2 3
N(左手): 5 6 7
V[合唱]:
N(女高): 6 6 5
L: 啊 啊 啊
N(女低): 1 2 3
~~~`,
        allowExtraArgs: true,
        extraArgType: "content" as const,
        args: [
            {
                name: "connect",
                namedOnly: true,
                type: "string" as const,
                default: "[-]",
                description: "连谱号：`[起点-终点]` 为括线，`{起点-终点}` 为大括号，`[3]`/`{3}` 表示单声部；端点可省，后可接 `:名称` 指定分组总名称，空串仅保留公共细线。",
            },
            {
                name: "gap",
                namedOnly: true,
                type: "length" as const,
                default: { value: 0.75, unit: "em" as const },
                description: "相邻声部主旋律之间的标准间距",
            },
            {
                name: "minGap",
                namedOnly: true,
                type: "length" as const,
                default: { value: 0.35, unit: "em" as const },
                description: "上方记号借用间距后保留的最小间距",
            },
        ],
    };

    static override deSugarAtom(source: string, start: number, end: number) {
        if (source[start] !== "V") return null;
        if (source.startsWith("V|:", start) && start + 3 <= end) {
            return {
                next: start + 3,
                node: {
                    kind: "sugar" as const,
                    data: { class: VoicesFunction, kind: "line" as const },
                    span: { start, end: start + 3 },
                },
            };
        }
        const open = source[start + 1];
        if (open !== "{" && open !== "[") return null;
        const at = findClosingGroupName(source, start + 2, end, open, open === "{" ? "}" : "]");
        if (at < 0 || at + 1 >= end || source[at + 1] !== ":") return null;
        return {
            next: at + 2,
            node: {
                kind: "sugar" as const,
                data: {
                    class: VoicesFunction,
                    kind: open === "{" ? "brace" as const : "bracket" as const,
                    name: { start: start + 2, end: at },
                },
                span: { start, end: at + 2 },
            },
        };
    }

    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        const first = nodes[at];
        if (typeof first === "number" || first.kind !== "sugar" || first.data?.class !== VoicesFunction) return null;

        let previousIndex = ctx.nodes.length - 1;
        while (previousIndex >= 0 && ctx.nodes[previousIndex] instanceof ASTTextNode) {
            const { sourceSpan } = ctx.nodes[previousIndex];
            const text = ctx.source.slice(sourceSpan.start, sourceSpan.end);
            if (text.includes("\n") || text.trim()) break;
            previousIndex--;
        }
        const previous = ctx.nodes[previousIndex];
        const members = previous instanceof VoiceFunction ? [previous]
            : previous instanceof VoicesFunction && previous.createdBySugar ? [...previous.voices] : [];
        const mergePrevious = members.length > 0;
        const connections: ConnectionSpec[] = [];
        let cursor = at;
        while (cursor < nodes.length) {
            const marker = nodes[cursor];
            if (typeof marker === "number" || marker.kind !== "sugar" || marker.data?.class !== VoicesFunction) break;
            cursor++;
            const carriageReturn = nodes[cursor];
            if (typeof carriageReturn === "number" && ctx.source[carriageReturn] === "\r") cursor++;
            const newline = nodes[cursor];
            if (typeof newline === "number" && ctx.source[newline] === "\n") cursor++;

            // 每段单独解析 N/L，防止歌词越过 V 声明附着到上一段
            const section = new ParserContext(ctx);
            const from = members.length + 1;
            while (cursor < nodes.length) {
                const node = nodes[cursor];
                if (typeof node === "number" || node.kind !== "sugar" || node.data?.class !== VoiceFunction) break;
                cursor = VoiceFunction.deSugarRelation(section, nodes, cursor, members)!;
            }
            if (members.length < from) {
                throw new ErrorDiagnostic("E_VOICES_GROUP_EMPTY", "V 声部分组必须至少包含一条 N: 声部声明", marker.span);
            }
            if (marker.data.kind === "brace" || marker.data.kind === "bracket") {
                const name = marker.data.name
                    ? (ctx.parseArgWithType(marker.data.name, "string") as string | null) ?? ""
                    : "";
                connections.push({
                    kind: marker.data.kind,
                    from,
                    to: members.length,
                    ...(name ? { name } : {}),
                });
            }
        }
        const args: FunctionArgs = new Map();
        members.forEach((member, index) => args.set(index, member));
        args.set("connect", serializeConnections(connections));
        const voices = new VoicesFunction({
            start: mergePrevious ? previous.sourceSpan.start : first.span.start,
            end: members.at(-1)!.sourceSpan.end,
        }, args, ctx);
        voices.createdBySugar = true;
        if (mergePrevious) ctx.nodes.length = previousIndex;
        ctx.pushNode(voices);
        return cursor;
    }

    voices: VoiceFunction[];
    createdBySugar: boolean = false;    // 不同创建方式的不能合并
    size: number;                       // parse 期冻结的字号，px
    readonly font: string;              // parse 期冻结的字体
    gap: number;                        // 相邻声部主旋律之间的标准间距，px
    minGap: number;                     // 顶部外扩借用间距后保留的最小间距，px
    private readonly connect: string;
    /** 声部名右侧为大括号预留的横向空间 */
    get braceSpace() {
        return Math.max(this.size,
            (MIN_CONNECTOR_STEM * (BRACKET_HOOK_REACH + 0.5) + 0.5) / (1 - CONNECTOR_LABEL_GAP_RATIO));
    }
    // 收集阶段只冻结配置，避免提前校验随后会被 V 声明覆盖的默认值。
    private get connectionSpecs(): ConnectionSpec[] {
        return parseConnections(this.connect, this.sourceSpan);
    }
    override get children() { return this.voices; }
    override timeFlowModel() {
        return {
            children: this.children,
            mode: "parallel" as const,
            tracks: {
                laneKey: `voices/${this.voices.length}`,
                hostIndex: null,    // 宿主不是成员：第一个 voice 也必须拥有独立轨道
                measure: makeVoicesMeasure(this.size, this.gap, this.minGap),
            },
        };
    }

    /** 退出时按本块各声部的名称事件注册左侧连谱号，并合并同一组音轨的间距配置 */
    override loweringExit(ctx: LoweringContext, track: Track) {
        const connections = resolveConnections(this.connectionSpecs, this.voices.length, this.sourceSpan);
        if (this.voices.length >= 2) {
            const names = this.voices.map(voice => ctx.getTemporalNodes(voice)[0] as VoiceNameTemporal);
            ctx.addAttachment(new VoicesBraceAttachment(names, this, connections));
        }
        const laneKey = `voices/${this.voices.length}`;
        const measure = track.groups.find(group => group.laneKey === laneKey)?.measure as VoicesMeasure | undefined;
        if (measure) {
            if (this.voices.length >= 2 && (Math.abs(measure.gap - this.gap) > 1e-6 || Math.abs(measure.minGap - this.minGap) > 1e-6)) {
                ctx.diagnostics.push(new WarningDiagnostic(
                    "W_VOICES_GAP_CONFLICT",
                    "相同声部数的 @voices 共用音轨但设置了不同的间距，将取较大值",
                    this.sourceSpan,
                ));
            }
            measure.size = Math.max(measure.size, this.size);
            measure.gap = Math.max(measure.gap, this.gap);
            measure.minGap = Math.max(measure.minGap, this.minGap);
        }
        return [];
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        this.voices = [];
        this.size = ctx.variables.fontsize;
        this.font = ctx.variables.font;
        const [connect, gap, minGap] = this.getArgValue(args, ctx) as [string, LengthValue, LengthValue];
        this.connect = connect;
        this.gap = ctx.length2px(gap);
        this.minGap = ctx.length2px(minGap);
        if (!Number.isFinite(this.gap) || this.gap < 0 || !Number.isFinite(this.minGap) || this.minGap < 0) {
            throw new ErrorDiagnostic(
                "E_INVALID_VOICES_GAP",
                "@voices 的 gap 和 minGap 必须是非负有限长度",
                span,
            );
        }
        for (const [key, value] of args) {
            if (typeof key === "string") continue;
            if (!(value instanceof VoiceFunction)) {
                throw new ErrorDiagnostic(
                    "E_VOICES_INVALID_CHILD",
                    "@voices 的参数必须是 @voice 函数，但发现了其他类型 {actual}",
                    (value as ASTNodeBase).sourceSpan,
                    { actual: String(value?.constructor.name) },
                );
            }
            this.addVoice(value);
        }
        if (this.voices.length === 0) {
            throw new ErrorDiagnostic(
                "E_VOICES_EMPTY",
                `@voices 必须至少包含一个 @voice 函数`,
                span,
            );
        }
    }

    addVoice(v: VoiceFunction) {
        this.voices.push(v);
        v.parent = this;
        this.sourceSpan.start = Math.min(v.sourceSpan.start, this.sourceSpan.start);
        this.sourceSpan.end = Math.max(v.sourceSpan.end, this.sourceSpan.end);
    }

    toString(source: string) {
        const parameters = this.voices.map(voice => `\t${voice.toString(source)}`);
        parameters.push(
            `\tconnect=${quote(serializeConnections(this.connectionSpecs))}`,
            `\tgap=${this.gap}px`,
            `\tminGap=${this.minGap}px`,
        );
        return `@voices(\n${parameters.join(",\n")}\n)`;
    }
}

/**
 * 画在声部名与音符之间的多声部括线
 *
 * 共享一条细竖线，按连接范围添加粗括线或弯曲大括号
 * 纵向跨度直接取首末声部名事件的视觉轴（无名声部的占位盒高度为 0，其 y 就是轨道视觉轴），
 * 因此不需要反查任何轨道信息
 */
class VoicesBraceAttachment implements LayoutAttachment {
    layer = "background" as const;
    private leftWidth = 0;
    private measuredLabels: ({ richLine: PreparedRichLine; leftWidth: number } | undefined)[] = [];

    get sourceSpan() { return this.ast.sourceSpan; }

    constructor(
        private readonly names: readonly VoiceNameTemporal[],
        private readonly ast: VoicesFunction,
        private readonly connections: readonly VoiceConnection[],
    ) {
        const first = names[0];
        const last = names.at(-1)!;
        const prepareLayout = last.prepareLayout;
        last.prepareLayout = context => {
            prepareLayout.call(last, context);
            this.prepareLabels(context);
        };
        const prepareHorizontal = first.prepareHorizontal;
        first.prepareHorizontal = line => {
            prepareHorizontal?.call(first, line);
            if (this.leftWidth <= 0) return;
            // 只扩大该列在求解器中的左占用；各声部名自身的 box 与 anchor 保持原位
            line.registerHorizontalLayoutHook(first, first, ({ columns, start }) => {
                for (const element of columns[start]) {
                    element.WL = Math.max(element.WL, this.leftWidth);
                }
            });
        };
    }

    private prepareLabels(context: LayoutPrepareContext) {
        const style = voiceNameStyle(this.ast.size, this.ast.font);
        const gap = this.ast.size * GROUP_NAME_GAP_RATIO;
        let maxLeftWidth = 0;
        this.measuredLabels = this.connections.map(connection => {
            if (!connection.name) return undefined;
            const richLine = prepareRichLine(connection.name, style, context.textMeasurer);
            let innerWidth = 0;
            for (let i = connection.from - 1; i < connection.to; i++) {
                innerWidth = Math.max(innerWidth, this.names[i].box.anchor);
            }
            const leftWidth = (innerWidth > 0 ? innerWidth + gap : 0) + richLine.w;
            maxLeftWidth = Math.max(maxLeftWidth, leftWidth);
            return { richLine, leftWidth };
        });
        this.leftWidth = maxLeftWidth;
    }

    createGeometry() {
        const first = this.names[0].box;
        const em = this.ast.size;
        const axisY = (index: number) => {
            const { y, visualAxis } = this.names[index].box;
            return y + visualAxis;
        };
        const top = axisY(0) - em * 0.5;
        const bottom = axisY(this.names.length - 1) + em * 0.5;
        if (bottom - top < 1e-6) return { regions: [], paint() {} };

        // 各部分尺寸都以粗竖线宽度为单位，比例取自常见简谱软件的括线
        const stem = Math.max(MIN_CONNECTOR_STEM, em * 0.19);
        const reach = stem * BRACKET_HOOK_REACH;
        const drop = stem * BRACKET_HOOK_DROP;
        const anchorX = first.x + first.anchor;
        const x = anchorX + this.ast.braceSpace * CONNECTOR_LABEL_GAP_RATIO + stem / 2;

        const inset = Math.min(stem * 0.67, em * 0.25);
        const line = {
            x: x + stem * 1.33 - stem * 0.165,
            y: top + inset,
            w: stem * 0.33,
            h: bottom - top - inset * 2,
        };
        const bars: LayoutRegion[] = [];
        const paths: { commands: readonly PathCommand[]; transform: PathTransform }[] = [];
        const labels: (LayoutRegion & PreparedRichLine)[] = [];
        const regions: LayoutRegion[] = [line];
        for (let i = 0; i < this.connections.length; i++) {
            const connection = this.connections[i];
            const groupTop = axisY(connection.from - 1) - em * 0.5;
            const groupBottom = axisY(connection.to - 1) + em * 0.5;
            if (connection.kind === "bracket") {
                bars.push({ x: x - stem / 2, y: groupTop, w: stem, h: groupBottom - groupTop });
                paths.push(
                    { commands: BRACKET_HOOK_COMMANDS, transform: { x, y: groupTop, scaleX: stem, scaleY: -stem } },
                    { commands: BRACKET_HOOK_COMMANDS, transform: { x, y: groupBottom, scaleX: stem, scaleY: stem } },
                );
                regions.push({
                    x: x - stem / 2, y: groupTop - drop,
                    w: reach + stem / 2, h: groupBottom - groupTop + drop * 2,
                });
            } else {
                const width = em * 0.35;
                const left = line.x - em * 0.12 - width;
                const scaleX = width / CURVED_BRACE_BOUNDS.w;
                const scaleY = (groupBottom - groupTop) / CURVED_BRACE_BOUNDS.h;
                paths.push({
                    commands: CURVED_BRACE_COMMANDS,
                    transform: {
                        x: left - CURVED_BRACE_BOUNDS.x * scaleX,
                        y: groupTop - CURVED_BRACE_BOUNDS.y * scaleY,
                        scaleX, scaleY,
                    },
                });
                regions.push({ x: left, y: groupTop, w: width, h: groupBottom - groupTop });
            }
            const label = this.measuredLabels[i];
            if (label) {
                labels.push({
                    ...label.richLine,
                    x: anchorX - label.leftWidth,
                    y: (groupTop + groupBottom - label.richLine.h) / 2,
                });
            }
        }
        bars.push(line);
        // 在首声部名称宿主上发布连谱号细竖线顶端坐标，供行首小节号直接居中对齐
        this.names[0].ports["bar.number"] = {
            x: x + stem * 1.33 - first.x,
            y: Math.min(top, ...regions.map(region => region.y)) - first.y,
        };
        regions.push(...labels);
        return {
            regions,
            paint(painter: Painter) {
                for (const bar of bars) {
                    painter.drawRect(bar.x, bar.y, bar.w, bar.h, { fill: "#000" });
                }
                for (const path of paths) {
                    painter.drawPath(path.commands, { fill: "#000" }, path.transform);
                }
                for (const label of labels) {
                    paintRichLine(painter, label, label.x + label.w, label.y + label.baseline);
                }
            },
        };
    }
}

export const VoicesNode: ASTFunctionClass = VoicesFunction;