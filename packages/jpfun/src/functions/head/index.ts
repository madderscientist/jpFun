import { ErrorDiagnostic } from "../../diagnostic.js";
import { layoutHorizontalRegion, type HorizontalLayoutHookContext } from "../../layout/model.js";
import type { HorizontalLineView, LayoutBox } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { Extent, MeasureFn, TrackArrangement, TrackPlacement } from "../../lowering/track.js";
import {
    isVisualTemporalNode,
    TemporalNodeBase,
    type VisualTemporalNode,
} from "../../lowering/types.js";
import type { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import { ParserContext, skipSpaces, skipSpacesBack } from "../../parser/parserContext.js";
import {
    ASTBraceNode,
    ASTFunctionNode,
    ASTNodeBase,
    type ASTFunctionClass,
    type FunctionArgs,
    type SourceSpan,
} from "../ASTtypes.js";
import { KeyNode } from "../key/index.js";
import { MeterNode } from "../meter/index.js";
import { TempoNode } from "../tempo/index.js";
import { TextNode } from "../text/index.js";

// 语法糖的预设对齐
type SlotName = "left" | "center" | "right";
type SideName = Exclude<SlotName, "center">;
const FIELD_SLOT = {
    title: "center", subtitle: "center", author: "right",
    signature: "left", tempo: "left", left: "left", center: "center", right: "right",
} as const satisfies Record<string, SlotName>;
type HeadField = keyof typeof FIELD_SLOT;

const TEXT_PRESET = {
    title: [2, "center"], subtitle: [0.85, "center"], author: [0.8, "right"],
} as const;
const ITEM_GAP_EM = 0.25;
// 也决定居中精度：值越大弹簧越软，求解器按合力收敛后残留的坐标误差越大
const HEAD_STRETCH = 10_000;

function sugarRow(span: SourceSpan, content: ASTNodeBase[]) {
    return content.length === 1 && content[0] instanceof ASTBraceNode
        ? content[0]
        : new ASTBraceNode(span, content);
}

function findLineEnd(source: string, start: number, end = source.length) {
    while (start < end && source[start] !== "\r" && source[start] !== "\n") start++;
    return start;
}

/**
 * 让一个槽的两个边界代表它在弹簧链上应占的横向范围
 *
 * 先在本区间自然求解（宽度不限，因此更窄的 hook 已固化的布局原样保留），再移动边界：
 * 侧槽的两个边界重合成一个点，center 的两个边界贴住内容的几何左右沿。
 * 整段随即固化，最终求解合并成一根刚性列，而刚性列的宽度只取首末边界，
 * 中间列的相对布局原样保留。
 */
function layoutHeadSlot(
    { columns, rows, start, end, X, fixed, options }: HorizontalLayoutHookContext,
    occupiesWidth: boolean,
) {
    layoutHorizontalRegion(
        columns.slice(start, end + 1),
        rows,
        X.subarray(start, end + 1),
        fixed.subarray(start, end),
        Infinity,
        options,
    );

    let left = Infinity;
    let right = -Infinity;
    for (let c = start + 1; c < end; c++) {
        for (let r = 0; r < rows; r++) {
            left = Math.min(left, X[c] - columns[c][r].WL);
            right = Math.max(right, X[c] + columns[c][r].WR);
        }
    }

    if (occupiesWidth && left <= right) {
        X[start] = left;
        X[end] = right;
    } else X[end] = X[start];
}

/** 行从上到下紧贴排列；capture 让 Head 在同一遍测量里取得整组范围 */
function measureRows(
    members: readonly (Extent | null)[],
    capture?: (extent: Extent | null) => void,
): readonly (TrackPlacement | null)[] {
    const placements: (TrackPlacement | null)[] = [];
    let top: number | undefined;
    let cursor: number | undefined;
    for (const extent of members) {
        if (!extent) {
            placements.push(null);
            continue;
        }
        const offset = cursor === void 0 ? 0 : cursor - extent.top;
        placements.push({ offset, extent });
        top ??= offset + extent.top;
        cursor = offset + extent.bottom;
    }
    capture?.(top === void 0 || cursor === void 0 ? null : { top, bottom: cursor });
    return placements;
}

class HeadBoundaryTemporal extends TemporalNodeBase {
    declare ast: HeadSlotNode;
    declare box: LayoutBox;

    constructor(ast: HeadSlotNode) {
        super();
        this.ast = ast;
        this.initLayoutBox();
    }

    override prepareLayout() { this.box.w = this.box.h = this.box.anchor = this.box.visualAxis = 0; }

    override prepareHorizontal(line: HorizontalLineView) {
        // 只由第一个边界协调一次整块 Head，避免六个边界重复改弹簧
        if (this.ast.name === "left" && this === this.ast.start) this.ast.owner.prepareHead(line);
    }

    override onPlaced() {
        if (this.ast.name === "left" && this === this.ast.start) this.ast.owner.alignHead();
    }
}

/** 一个槽既是 AST 容器，也是把每个顶层行分配到独立 Track 的边界 */
class HeadSlotNode extends ASTNodeBase {
    start!: HeadBoundaryTemporal;
    end!: HeadBoundaryTemporal;

    constructor(
        span: SourceSpan,
        readonly owner: HeadFunction,
        readonly name: SlotName,
        readonly rows: ASTNodeBase[],
        private readonly tracks: TrackArrangement,
    ) {
        super(span, owner);
        for (const row of this.rows) row.parent = this;
    }

    // 零宽边界需要字号契约，但字号由 Head 统一冻结，不在三个槽里重复保存
    get size() { return this.owner.size; }

    override get children() { return this.rows; }

    override timeFlowModel() {
        if (this.rows.length === 0) return null;
        return {
            mode: "parallel" as const,
            children: this.rows,
            tracks: this.tracks,
        };
    }

    override loweringEnter() {
        this.start = new HeadBoundaryTemporal(this);
        return [this.start];
    }

    override loweringExit() {
        this.end = new HeadBoundaryTemporal(this);
        return [this.end];
    }

    addRow(row: ASTNodeBase) {
        row.parent = this;
        this.rows.push(row);
    }
}

/**
 * Head 布局建立在全局时序与布局协议上：
 *
 * 1. Head 是 left -> center -> right 的 sequence，保证三槽在全局列中的先后顺序；
 *    每个槽再把第一层节点作为一组 parallel Track，形成多行。三槽使用不同 laneKey
 *    独立测量行距；center 第一行的求解轴与宿主轴相同，left/right 整组在 place 阶段
 *    平移到同一个底边，较高侧的顶部贴住 center 第一行的下侧。
 *
 *    例如 `@head(left={L1 L2 L3}, center={C1 C2}, right={R1})` 会形成：
 *
 *    Head (sequence)
 *    +-- left (independent parallel Tracks)
 *    |   +-- Track L1
 *    |   +-- Track L2
 *    |   `-- Track L3
 *    +-- center (independent parallel Tracks, axis(C1) = host axis)
 *    |   +-- Track C1
 *    |   `-- Track C2
 *    `-- right (independent parallel Tracks)
 *        `-- Track R1
 *
 *    left/right 是两组不同 Track，但最终拥有相同的包围盒底边；任一侧的行高只影响
 *    自己后续各行。槽参数的一层内容表示多行；若要让多个对象留在同一行，需再包
 *    一层 brace，如 `left={{@key(C) @meter(4,4)}}`。center 为空时，较高侧从宿主轴
 *    开始向下排列。
 *
 * 2. 每个槽在真实内容前后各产生一个零尺寸 Temporal。边界和每个真实 Temporal
 *    都进入全局 TimeColumn；同一时刻只有 mergeKey 相同的跨轨事件才会合列，
 *    key、meter 等默认仍各自占列，并非一个 Head 槽只有一列。Track 只表达纵向行，
 *    不取代横向列。Head 因此仍可行内使用或嵌套，box、tie 等 attachment 也沿用
 *    正常生命周期。
 * 3. 横向求解前，left.start 的回调把最外侧设为自由边、让 center 向两侧撑开，
 *    并为三个槽各注册一个 layoutHeadSlot。每个槽的两个边界因此代表本块在弹簧链上
 *    应占的横向范围：left/right 收缩成一个点，center 贴住内容的几何左右沿。
 * 4. 于是链形如 `点 - 强弹簧 - center - 强弹簧 - 点`。两根强弹簧参数相同、压缩量
 *    必然相等，两个点又被自由的墙对称顶在纸面两侧，因此 center 的几何中心精确落在
 *    内容区中线，与两侧内容多宽、多少行无关。center 的求解坐标即最终坐标，不参与
 *    后置重排。两个代价是刻意接受的：侧槽不占横向流，所以内容过宽时会与 center 的
 *    第二行及以后重叠，引擎不再阻止；强弹簧靠“把整行撑到必然过满”成立，所以同一
 *    谱面行上的普通内容会被挤到几乎没有间隙，行内 head 只适合极短的内容。
 * 5. 纵向放置完成后，left.start 以两个点为准，按顶层 AST 单元重新写入两侧成员的
 *    box.x：left 向右、right 向左紧凑排列，单元间留 0.25em。因此 TimeColumn 拓扑
 *    没有消失，但两侧最终 x 不再等于全局列锚点；复合内容整体平移。随后重新调用
 *    成员的 `onPlaced`，使折叠成员同步最终坐标，attachment 再读取这些坐标生成几何。
 *
 * Head 只协调布局，不建立局部列或局部 attachment 系统。内部内容须为零时长，且不能主动换谱面行。
 */
class HeadFunction extends ASTFunctionNode {
    static override def = {
        name: ["head"],
        description: "提供左、中、右三块布局，常用于曲谱头部信息展示；也可用连续的 H.*: 行声明构造",
        example: `@head(left={{@key(C) @meter(4,4)}}, center={@text(标题)}, right={@text(作者)})
语法糖：相邻的 H.*: 声明合并为一个 head，每条声明生成对应槽的一行；空行或普通内容结束组合
H.title: 标题       center 槽，预设大字号居中 Text
H.subtitle: 副标题  center 槽，预设小字号居中 Text
H.author: 作者      right 槽，预设小字号右对齐 Text
H.signature: 1=C 4/4  left 槽，同一行生成 Key 和 Meter
H.tempo: 94           left 槽，生成 Tempo
H.left: / H.center: / H.right: 接受对应槽的任意零时长 DSL 内容
以 @ 或 { 开头时按 DSL 解析，否则按该字段的裸文本规则生成 Text`,
        allowExtraArgs: false,
        args: [
            { name: "left", type: "content" as const, default: "" },
            { name: "center", type: "content" as const, default: "" },
            { name: "right", type: "content" as const, default: "" },
        ],
    };

    readonly slots: [HeadSlotNode, HeadSlotNode, HeadSlotNode];
    readonly size: number;
    private readonly members: TemporalNodeBase[] = [];
    private createdBySugar = false;

    override get children() { return this.slots; }

    override timeFlowModel() {
        return { mode: "sequence" as const, children: this.slots };
    }

    static override deSugarAtom(source: string, start: number, end: number) {
        if (source[start] !== "H" || source[start + 1] !== ".") return null;
        let pos = start + 2;
        while (pos < end && source[pos] >= "a" && source[pos] <= "z") pos++;
        const field = source.slice(start + 2, pos) as HeadField;
        if (!Object.hasOwn(FIELD_SLOT, field) || source[pos] !== ":") return null;
        pos++;
        const lineEnd = findLineEnd(source, pos, end);
        const contentStart = skipSpaces(source, pos, lineEnd);
        const explicitContent = source[contentStart] === "@" || source[contentStart] === "{";
        // 裸文本整行归 Head 所有，直接越过可避免其中的 F 等字符被识别成音符
        // 显式 DSL 仍从冒号后继续扫描，保留内部函数高亮
        return {
            next: explicitContent ? pos : lineEnd,
            node: {
                kind: "sugar",
                data: { class: HeadFunction, field },
                span: { start, end: pos },
            } as GrammarSugarNode,
        };
    }

    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        const sugar = nodes[at++] as GrammarSugarNode;
        if (sugar.data?.class !== HeadFunction) return null;
        const field = sugar.data.field as HeadField;
        let breakAt = at;
        for (; breakAt < nodes.length; breakAt++) {
            const node = nodes[breakAt];
            if (typeof node === "number" && (ctx.source[node] === "\r" || ctx.source[node] === "\n")) break;
            if (typeof node !== "number" && node.kind === "sugar" && node.data?.class === HeadFunction) break;
        }
        const stop = nodes[breakAt];
        // 裸文本在第一轮被整体越过，EOF 时 nodes 中没有末尾标记，需从源码恢复边界
        let boundary: number;
        if (typeof stop === "number") boundary = stop;
        else if (stop) boundary = stop.span.start;
        else if (breakAt > at) {
            const last = nodes[breakAt - 1];
            boundary = typeof last === "number" ? last + 1 : last.span.end;
        } else boundary = findLineEnd(ctx.source, sugar.span.end);
        const start = skipSpaces(ctx.source, sugar.span.end, boundary);
        const last = skipSpacesBack(ctx.source, boundary - 1, start);
        const span = { start, end: Math.max(start, last + 1) };
        if (span.start >= span.end) {
            throw new ErrorDiagnostic("E_HEAD_EMPTY_DECLARATION", `H.${field}: 后必须有内容`, sugar.span);
        }
        const text = ctx.source.slice(span.start, span.end).trim();
        let parsed: ASTNodeBase[] | undefined;
        if (text.startsWith("@") || text.startsWith("{")) {
            const sub = new ParserContext(ctx);
            sub.makeNodes(nodes.slice(at, breakAt));
            parsed = sub.nodes;
        }
        const previous = ctx.nodes.at(-1);
        // 只有相邻的 H.* 声明合并；普通节点或空行都会切断组合
        const head = previous instanceof HeadFunction && previous.createdBySugar
            ? previous
            : new HeadFunction(sugar.span, new Map(), ctx, null);
        head.createdBySugar = true;
        head.addSugarRow(FIELD_SLOT[field], HeadFunction.parseSugarRow(ctx, field, span, text, parsed));
        head.sourceSpan.end = span.end;
        if (head !== previous) ctx.pushNode(head);

        if (typeof stop !== "number") return breakAt;
        let next = breakAt + 1;
        if (ctx.source[stop] === "\r") {
            const lf = nodes[next];
            if (typeof lf === "number" && ctx.source[lf] === "\n") next++;
        }
        return next;
    }

    private static parseSugarRow(
        ctx: ParserContext,
        field: HeadField,
        span: SourceSpan,
        text: string,
        parsed?: ASTNodeBase[],
    ): ASTNodeBase {
        if (parsed !== void 0) return sugarRow(span, parsed);
        if (field === "signature") {
            const match = /^(1\s*=\s*(\S+))\s+((\d+)\s*\/\s*(\d+))$/.exec(text);
            if (!match) throw new ErrorDiagnostic("E_HEAD_INVALID_SIGNATURE", "H.signature 的格式应为 1=C 4/4", span);
            const keySpan = { start: span.start, end: span.start + match[1].length };
            const meterSpan = { start: span.end - match[3].length, end: span.end };
            return sugarRow(span, [
                new KeyNode(keySpan, new Map([["tonality", match[2]]]), ctx, null),
                new MeterNode(meterSpan, new Map([["num", Number(match[4])], ["den", Number(match[5])]]), ctx, null),
            ]);
        }
        if (field === "tempo") {
            const bpm = Number(text);
            if (!Number.isFinite(bpm) || bpm <= 0) throw new ErrorDiagnostic("E_HEAD_INVALID_TEMPO", "H.tempo 后必须是正数", span);
            return sugarRow(span, [new TempoNode(span, new Map([["bpm", bpm]]), ctx, null)]);
        }
        const args: FunctionArgs = new Map([[0, text]]);
        const preset = TEXT_PRESET[field as keyof typeof TEXT_PRESET];
        if (preset) {
            args.set("size", { value: preset[0], unit: "em" });
            args.set("align", preset[1]);
        }
        return sugarRow(span, [new TextNode(span, args, ctx, null)]);
    }

    constructor(
        span: SourceSpan,
        args: FunctionArgs,
        ctx: ParserContext,
        parent: ASTNodeBase | null = null,
    ) {
        super(span, parent);
        this.size = ctx.fontSize;
        // laneKey 必须区分同一宿主轨上的多个 Head；源码起点是稳定且无需额外存储的身份
        const laneKey = `head/rows/${span.start}`;
        let titleBottom = 0;
        let leftExtent: Extent | null = null;
        let rightExtent: Extent | null = null;
        const sideTracks = (name: SideName): TrackArrangement => ({
            laneKey: `${laneKey}/${name}`,
            hostIndex: null,
            measure: members => measureRows(members, extent => {
                if (name === "left") leftExtent = extent;
                else rightExtent = extent;
            }),
            place: () => {
                const extent = name === "left" ? leftExtent : rightExtent;
                if (!extent) return titleBottom;
                const leftHeight = leftExtent ? leftExtent.bottom - leftExtent.top : 0;
                const rightHeight = rightExtent ? rightExtent.bottom - rightExtent.top : 0;
                // 两侧共享底边；以较高侧定总高度，使它的顶部恰好贴标题底边
                const targetBottom = titleBottom + Math.max(leftHeight, rightHeight);
                return targetBottom - extent.bottom;
            },
        });
        const centerMeasure: MeasureFn = members => {
            const placements = measureRows(members);
            const first = placements.find(placement => placement !== null);
            titleBottom = first ? first.offset + first.extent.bottom : 0;
            return placements;
        };
        const rows = (name: SlotName, index: number) => {
            const value = args.get(name) ?? args.get(index);
            if (!(value instanceof ASTNodeBase)) return [];
            return value instanceof ASTBraceNode ? value.content : [value];
        };
        this.slots = [
            new HeadSlotNode(span, this, "left", rows("left", 0), sideTracks("left")),
            new HeadSlotNode(span, this, "center", rows("center", 1), {
                laneKey: `${laneKey}/center`,
                hostIndex: null,
                measure: centerMeasure,
            }),
            new HeadSlotNode(span, this, "right", rows("right", 2), sideTracks("right")),
        ];
    }

    override loweringEnter(ctx: LoweringContext) {
        this.members.length = 0;
        // 收集真实全局事件：退出时校验时值，放置后按 AST 行归属做横向对齐
        ctx.beginLoweringGroup(this, { onTemporal: node => this.members.push(node) });
        return [];
    }

    override loweringExit(ctx: LoweringContext) {
        ctx.endLoweringGroup(this);
        for (const node of this.members) {
            if (!node.T.isZero()) {
                throw new ErrorDiagnostic(
                    "E_HEAD_NONZERO_DURATION",
                    "@head 的内容必须全部为零时长",
                    node.ast.sourceSpan
                );
            }
            if (node.breakBefore > 0) {
                throw new ErrorDiagnostic(
                    "E_HEAD_INTERNAL_BREAK",
                    "@head 的内部不能使用 @br；第一层内容已经表示视觉行",
                    node.ast.sourceSpan
                );
            }
        }
        return [];
    }

    private addSugarRow(name: SlotName, row: ASTNodeBase) {
        this.slots.find(slot => slot.name === name)!.addRow(row);
    }

    prepareHead(line: HorizontalLineView) {
        if (this.members.some(node => isVisualTemporalNode(node) && node.layoutLine !== line.index)) {
            throw new ErrorDiagnostic("E_HEAD_INTERNAL_BREAK", "@head 的内容不能跨谱面行", this.sourceSpan);
        }
        const [left, center, right] = this.slots;
        // 最外侧不受墙的推力，两个点才能落在纸面边缘
        left.start.springConfig.alpha_L = 0;
        right.end.springConfig.alpha_R = 0;
        // 串联弹簧的静长是两端之和、刚度由软端主导，所以只需 center 自己向两侧撑开
        this.stretch(center.start, "L");
        this.stretch(center.end, "R");
        for (const slot of this.slots) {
            line.registerHorizontalLayoutHook(slot.start, slot.end,
                context => layoutHeadSlot(context, slot === center));
        }
    }

    alignHead() {
        // 全局列已经完成求解；这里不改 TimeColumn，只覆盖 left/right 主体的最终 box.x
        // center 不参与后置重排，继续使用全局列坐标
        const cells = new Map<ASTNodeBase, VisualTemporalNode[]>();
        for (const member of this.members) {
            if (!isVisualTemporalNode(member)) continue;
            const cell = this.sideCellOf(member.ast);
            if (!cell) continue;
            const members = cells.get(cell);
            if (members) members.push(member);
            else cells.set(cell, [member]);
        }
        const [left, , right] = this.slots;
        this.packRows(left, left.start.box.x, "left", cells);
        this.packRows(right, right.end.box.x, "right", cells);
    }

    override toString(source: string) {
        const slots = this.slots
            .filter(slot => slot.rows.length > 0)
            .map(slot => {
                const rows = slot.rows
                    .map(row => `    ${row.toString(source).replaceAll("\n", "\n    ")}`)
                    .join("\n");
                return `  ${slot.name}={\n${rows}\n  }`;
            });
        return `@head(\n${slots.join(",\n")}\n)`;
    }

    private stretch(node: VisualTemporalNode, side: "L" | "R") {
        const alpha = side === "L" ? "alpha_L" : "alpha_R";
        const beta = side === "L" ? "beta_L" : "beta_R";
        // alpha 撑开槽间空间；beta 反向缩放，避免弹簧刚度随 alpha 一起失控
        node.springConfig[alpha] = node.springConfig[alpha]! * HEAD_STRETCH;
        node.springConfig[beta] = node.springConfig[beta]! * 3 / HEAD_STRETCH;
    }

    private packRows(
        slot: HeadSlotNode,
        target: number,
        side: SideName,
        cells: ReadonlyMap<ASTNodeBase, VisualTemporalNode[]>,
    ) {
        const gap = this.size * ITEM_GAP_EM;
        const fromLeft = side === "left";
        const direction = fromLeft ? 1 : -1;
        for (const row of slot.rows) {
            const rowCells = row instanceof ASTBraceNode ? row.content : [row];
            let cursor = target;
            for (
                let index = fromLeft ? 0 : rowCells.length - 1;
                index >= 0 && index < rowCells.length;
                index += direction
            ) {
                const members = cells.get(rowCells[index]);
                if (!members) continue;
                let left = Infinity;
                let right = -Infinity;
                for (const member of members) {
                    left = Math.min(left, member.box.x);
                    right = Math.max(right, member.box.x + member.box.w);
                }
                const offset = cursor - (fromLeft ? left : right);
                for (const member of members) member.box.x += offset;
                // 复合单元先整体平移，再让其内部成员读取彼此的最终坐标
                for (const member of members) member.onPlaced?.();
                cursor += direction * (right - left + gap);
            }
        }
    }

    /** 找到成员所属侧栏行的顶层单元；复合节点内部成员会归回同一个直接子节点 */
    private sideCellOf(ast: ASTNodeBase): ASTNodeBase | null {
        let cell = ast;
        while (cell.parent) {
            const parent = cell.parent;
            const slot = parent instanceof HeadSlotNode
                ? parent
                : parent instanceof ASTBraceNode && parent.parent instanceof HeadSlotNode
                    ? parent.parent
                    : null;
            if (slot?.owner === this) return slot.name === "center" ? null : cell;
            cell = parent;
        }
        return null;
    }
}

export const HeadNode: ASTFunctionClass = HeadFunction;
