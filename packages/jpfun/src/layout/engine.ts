import { Diagnostic } from "../diagnostic.js";
import type { Track, TrackGroup, TrackPlacement } from "../lowering/track.js";
import {
    isVisualTemporalNode,
    type TemporalNodeBase,
    type VisualTemporalNode,
} from "../functions/temporal.js";
import type { LoweringResult } from "../lowering/types.js";
import {
    completeSpringConfig,
    layoutElement,
    layoutHorizontal,
    type HorizontalLayoutHookEntry,
    type SolverOptions,
} from "./model.js";
import {
    normalizePageConfig,
    paginateLayoutLines,
    PageLayoutError,
    type DocumentLayoutPage,
} from "./page.js";
import { isLayoutAttachment } from "./types.js";
import { liftInto, rangeColumns, resolveRange, type QueryLine } from "./range.js";
import { TranslatingPainter } from "../render/translate.js";
import type {
    AttachmentGeometry,
    AttachmentLayoutContext,
    Extent,
    HorizontalLineView,
    LayoutAttachment,
    LayoutHost,
    LayoutPoint,
    LayoutPrepareContext,
    LayoutRange,
    PlacedAttachment,
    Rect,
} from "./types.js";

export interface DocumentLayoutOptions extends SolverOptions {
    rowGap?: number;    // 强制覆盖每行的轨道间距；缺省按该行最大字号推导
}

// 兼容旧导入路径；布局入口会把正常页面溢出转换为 ErrorDiagnostic
export { PageLayoutError } from "./page.js";
export type { DocumentLayoutPage } from "./page.js";

export interface DocumentLayoutResult {
    diagnostics: Diagnostic[];       // parser 与 lowering 传入的诊断信息
    objects: VisualTemporalNode[];   // 已准备尺寸并获得最终坐标的可见事件
    attachments: PlacedAttachment[]; // box、tie、beam、歌词等非时间对象的最终几何
    bounds: Rect;                    // 所有对象和辅助对象的最终外接矩形
    lineCount: number;               // 按 br 切分后的谱面行数量
    pages: DocumentLayoutPage[];     // 全局坐标中的页面边界与谱面行范围
}

/** 一行的纵向占用；正文每行一份，子域只有自己所在的一行 */
interface LineExtents {
    /** 只包含可见主体的轴局部占用，整个纵向布局中不变 */
    hostExtents: Map<Track, Extent>;
    /**
     * attachment 测量区域折算出的占用，必要时触发最终重排
     *
     * 故意跨轮累积（查询范围的占用列表则逐轮重建）：第二轮放置发生在第二轮测量之前，
     * 求轴时读到的必须是第一轮的结果。如果将来加第三轮，要先重新定义这里的语义。
     */
    attachmentExtents: Map<Track, Extent>;
}

interface LayoutLine extends LineExtents {
    /** lowering 的结果只保留看得见的列 */
    columns: VisualTemporalNode[][];
}

type BaseAttachmentContext = Omit<AttachmentLayoutContext, "getAttachmentBox" | "getRangeExtents" | "getContentBounds">;

/** 子域附件在块内测得的几何；块此后的位移由参照成员当前与测量时的位置差给出 */
interface SubdomainItem {
    geometry: AttachmentGeometry;
    box: Rect;
    reference: VisualTemporalNode;
    x: number;
    y: number;
}

/** 一块 attachment 的轴局部占用 */
interface ExtentRange extends Extent {
    track: Track;
    left: number;
    right: number;
}

/** 轨道间距相对行内最大字号的比例；正文行与子域共用 */
const ROW_GAP_RATIO = 0.75;

/**
 * 把多个已经定位的盒子合并到 target
 */
export function unionLayoutBoxes(target: Rect, boxes: Iterable<Rect>): boolean {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;

    for (const box of boxes) {
        left = Math.min(left, box.x);
        top = Math.min(top, box.y);
        right = Math.max(right, box.x + box.w);
        bottom = Math.max(bottom, box.y + box.h);
    }

    if (!Number.isFinite(left)) {
        target.x = target.y = target.w = target.h = 0;
        return false;
    }

    target.x = left;
    target.y = top;
    target.w = right - left;
    target.h = bottom - top;
    return true;
}

/**
 * 把一个 lowering 后的可见事件准备成横向布局可以直接消费的主体
 *
 * 调用前，node 只有已经固化的时间语义、addon 和 LayoutBox 引用；
 * box 的尺寸、命名端口及装饰几何都尚未生成。
 *
 * 执行后，box 的 x/y 仍只是局部初值；固有宽高、弹簧参数、端口和装饰均已对应本轮 context 冻结，可以进入横向求解。
 *
 * ports 和 decorations 每轮从空容器重建，因此端口上的一次性标记（如 div 的 claimed）不会跨 pass 残留。
 *
 * 具有内部几何的复合节点（例如 up 的和弦成员）可以对自己的子对象调用同一个函数，
 * 从而保证子对象与顶层对象经过完全一致的准备流程。
 */
export function prepareLayoutHost(node: VisualTemporalNode, context: LayoutPrepareContext) {
    node.springConfig ??= {};
    node.decorations = [];
    node.ports = {};
    node.box.x = node.box.y = 0;
    node.prepareLayout(context); // 计算大小等 layout 需要的参数

    // 把 lowering 固化在 addon 中的语义交给已注册 handler，生成本轮函数装饰
    for (const [key, value] of Object.entries(node.addon ?? {})) {
        const handler = context.decorationHandlers.get(key);
        if (!handler) continue;
        const decoration = handler(node, value, context);
        if (decoration) node.decorations.push(decoration);
    }

    // 处理 decoration
    arrangeBelowDecorations(node);
    // 让节点在最终盒尺寸确定后发布依赖 box 的端口
    node.finalizeLayout?.(context);
}

/**
 * 完成 lowering 结果的全部几何计算
 */
export function layoutDocument(
    result: LoweringResult,
    context: LayoutPrepareContext,
    options: DocumentLayoutOptions = {},
): DocumentLayoutResult {
    const layoutAttachments = result.attachments.filter(isLayoutAttachment);
    const page = normalizePageConfig(result.page);
    const contentWidth = page.width - page.marginLeft - page.marginRight;
    const originX = page.marginLeft;
    const lift = liftInto(result.rootTrack);

    // 子域在主体准备时就排版完毕；它认领的附件保留块内几何，随块平移
    const order = new Map(layoutAttachments.map((attachment, index) => [attachment, index]));
    const relations = groupRelations(layoutAttachments);
    const subdomainItems = new Map<LayoutAttachment, SubdomainItem>();
    const subdomainBox = (attachment: LayoutAttachment) => {
        const item = subdomainItems.get(attachment);
        return item && moveSubdomainItem(item).box;
    };
    context = {
        ...context,
        layoutSubdomain(owner, columns, root, attachments) {
            // 横排时内层子域先排版并认领关系，这里只取剩下的
            const line = layoutLocalLine(columns, context);
            const members = new Set<TemporalNodeBase>(columns.flat());
            const within = (node: TemporalNodeBase) => {
                for (let host: TemporalNodeBase | undefined = node; host && host !== owner; host = host.foldedInto) {
                    if (members.has(host)) return true;
                }
                return false;
            };
            // 内容附件跟随声明位置，关系附件跟随端点
            const own = attachments.filter(isLayoutAttachment).filter(attachment => !attachment.endPoints?.length);
            for (const relation of relations.get(owner) ?? []) {
                if (!subdomainItems.has(relation) && relation.endPoints!.every(within)) own.push(relation);
            }
            own.sort((left, right) => order.get(left)! - order.get(right)!);
            const block = layoutSubdomainBlock(columns, line, root, own, context, subdomainBox);
            own.forEach((attachment, index) => subdomainItems.set(attachment, block.items[index]));
            return { width: line.width, height: block.height, positions: block.positions };
        },
    };

    // 1. 按 layoutLine 切行，并生成固有尺寸与装饰尺寸
    const lines = splitLayoutLines(result);
    const objects: VisualTemporalNode[] = [];
    for (const line of lines) {
        for (const column of line.columns) {
            for (const node of column) {
                objects.push(node);
                prepareLayoutHost(node, context);
            }
        }
    }
    const documentAttachments = layoutAttachments.filter(attachment => !subdomainItems.has(attachment));

    // 2. 横向弹簧布局，得到 box.x
    const horizontal = lines.map((line, index) => prepareHorizontalLine(line.columns, index, options));
    const views = horizontal.map(line => line.view);
    for (const attachment of documentAttachments) attachment.prepareHorizontal?.(views, context);
    for (const line of horizontal) {
        line.layout(contentWidth, page.fillRatio);
        for (const column of line.view.columns) {
            for (const node of column) node.box.x += originX;
        }
    }

    // host 申报纵向占用
    // 主体占用只依赖固有尺寸，整个纵向布局中保持不变
    for (const node of objects) {
        const line = lines[node.layoutLine];
        const top = -node.box.visualAxis;
        includeTrackExtent(line.hostExtents, node.track, top, top + node.box.h);
    }
    // 根据配置得到行距
    const rowGaps = measureRowGaps(lines.length, objects, options.rowGap);

    /** 按当前主体与 attachment 占用求轴、分页并放置所有主体 */
    const placeVertically = () => {
        const heights: number[] = [];
        const axes = lines.map((line, i) => {
            const solved = solveVerticalAxes(line, result.rootTrack, rowGaps[i]);
            heights.push(solved.height);
            return solved.axes;
        });
        let pages: DocumentLayoutPage[];
        let lineTops: number[];
        try {
            ({ pages, lineTops } = paginateLayoutLines(heights, page));
        } catch (error) {
            if (!(error instanceof PageLayoutError)) throw error;
            // 用溢出的元素的 span 构成 Error
            const line = lines[error.line];
            let start = Infinity;
            let end = -Infinity;
            for (const column of line?.columns ?? []) {
                for (const node of column) {
                    start = Math.min(start, node.ast.sourceSpan.start);
                    end = Math.max(end, node.ast.sourceSpan.end);
                }
            }
            if (Number.isFinite(start)) {
                throw Diagnostic.error.PageOverflow(
                    error.requiredHeight,
                    error.availableHeight,
                    { start, end },
                );
            }
            throw error;
        }
        const visualAxisOf = (line: number, track: Track) => (lineTops[line] ?? 0) + (axes[line]?.get(track) ?? 0);

        for (const node of objects) {
            node.box.y = visualAxisOf(node.layoutLine, node.track) - node.box.visualAxis;
            node.onPlaced?.();
        }

        const attachmentContext: BaseAttachmentContext = {
            ...context,
            width: contentWidth,
            originX,
            pages: pages.map(item => item.bounds),
            lines: views,
            // 子域的私有轨在正文里归入复合体所在的轨
            getVisualAxis: (line, track) => visualAxisOf(line, lift(track)),
            getHostExtent: (line, track) => lines[line]?.hostExtents.get(lift(track)),
            getRangeColumns: (line, range, track) => rangeColumns(views[line], range, track, lift),
        };

        return { pages, attachmentContext };
    };

    // 3. 首次纵向放置后测量 attachment；只有有效轨道占用扩张时才重新求解
    let placement = placeVertically();
    let measured = measureAttachments(documentAttachments, placement.attachmentContext, lines, lift, subdomainBox);

    if (measured.needsRelayout) {
        placement = placeVertically();
        measured = measureAttachments(documentAttachments, placement.attachmentContext, lines, lift, subdomainBox);
    }
    const pages = placement.pages;
    let next = 0;
    const attachments = layoutAttachments.map<PlacedAttachment>(attachment => {
        const item = subdomainItems.get(attachment);
        const { geometry, box } = item ? moveSubdomainItem(item) : measured.items[next++];
        return {
            box,
            regions: geometry.regions,
            layer: attachment.layer,
            sourceSpan: attachment.sourceSpan,
            paint(painter) { geometry.paint(painter); },
        };
    });

    const bounds: Rect = {
        x: 0, y: 0,
        w: 0, h: 0,
    };

    // 最终画布只使用排版盒，不追踪盒外悬挂图形
    function* layoutBoxes(): Iterable<Rect> {
        for (const pageResult of pages) yield pageResult.bounds;
        for (const node of objects) yield node.box;
        for (const attachment of attachments) yield attachment.box;
    }
    unionLayoutBoxes(bounds, layoutBoxes());

    return {
        diagnostics: result.diagnostics,
        objects,
        attachments,
        bounds,
        lineCount: lines.length,
        pages,
    };
}

/**
 * 按 below.order 排列主体下方装饰，调用 place 并把其占高计入 box.h
 */
function arrangeBelowDecorations(node: VisualTemporalNode) {
    // 现代 ECMAScript 的稳定排序会保留相同 order 的注册顺序
    const below = node.decorations
        .map(decoration => decoration.below)
        .filter(item => item !== void 0)
        .sort((left, right) => left.order - right.order);
    if (below.length === 0) return;

    // 依次分配每个装饰的局部上边界，并累加最终盒高
    let y = node.box.h;
    for (const item of below) {
        y += item.gap ?? 0;
        item.place?.(y);
        y += Math.max(0, item.height ?? 0);
    } node.box.h = y;
}

/**
 * 按 lowering 已固化的 layoutLine 把可见事件拆成谱面行
 *
 * 控制事件不会进入 columns；行号跳跃时保留中间空行，使数组下标始终等于 node.layoutLine
 */
function splitLayoutLines(result: LoweringResult): LayoutLine[] {
    const createLine = (): LayoutLine => ({
        columns: [],
        hostExtents: new Map(),
        attachmentExtents: new Map(),
    });

    const lines: LayoutLine[] = [];
    let currentLine = createLine();

    for (const column of result.columns) {
        const visibleColumn: VisualTemporalNode[] = []; // 从列中提取可见元素

        // 空行
        while (lines.length < column[0].layoutLine) {
            lines.push(currentLine);
            currentLine = createLine();
        }

        for (const node of column) {
            if (isVisualTemporalNode(node)) visibleColumn.push(node);
        }
        if (visibleColumn.length) currentLine.columns.push(visibleColumn);
    }
    // 至少要有一行，哪怕它没有任何可见对象
    if (currentLine.columns.length > 0 || lines.length === 0) lines.push(currentLine);
    return lines;
}

/** 把新的上下界原地并入已有纵向占用范围 */
function includeExtent(extent: Extent, top: number, bottom: number) {
    extent.top = Math.min(extent.top, top);
    extent.bottom = Math.max(extent.bottom, bottom);
}

function includeTrackExtent(
    extents: Map<Track, Extent>,
    track: Track,
    top: number,
    bottom: number,
) {
    const extent = extents.get(track);
    if (extent) includeExtent(extent, top, bottom);
    else extents.set(track, { top, bottom });
}

/**
 * 为已完成尺寸准备的成员建立横向视图并注册约束；调用 layout 时才创建输入和执行 hook
 * compact 只清零本轮自然间隙，保留时值和弹簧配置；局部列顺序由调用方提供
 */
export function prepareHorizontalLine(
    columns: readonly (readonly VisualTemporalNode[])[],
    index: number,
    options: SolverOptions = {},
    compact = false,
) {
    const hooks: HorizontalLayoutHookEntry[] = [];
    const columnIndex = new Map<LayoutHost, number>();
    const trackRuns = new Map<Track, VisualTemporalNode[]>();

    for (let column = 0; column < columns.length; column++) {
        for (const node of columns[column]) {
            columnIndex.set(node, column);
            completeSpringConfig(node.springConfig, options.globalC);
            const run = trackRuns.get(node.track);
            if (run) run.push(node);
            else trackRuns.set(node.track, [node]);
        }
    }

    const view: HorizontalLineView = {
        index,
        columns,
        trackRuns,
        columnOf: host => columnIndex.get(host) ?? -1,
        registerHorizontalLayoutHook(from, to, hook) {
            const start = columnIndex.get(from);
            const end = columnIndex.get(to);
            if (start === void 0 || end === void 0) return;
            hooks.push({ start: Math.min(start, end), end: Math.max(start, end), hook });
        },
    };
    for (const column of columns) {
        for (const node of column) node.prepareHorizontal?.(view);
    }
    return {
        view,
        layout(limit: number, fillMinRatio?: number) {
            const elements = columns.map(column => column.map(node => {
                const element = layoutElement(node.springConfig, node.box, node, options.globalC);
                if (compact) element.margin_L = element.margin_R = 0;
                return element;
            }));
            layoutHorizontal(elements, limit, options, hooks, fillMinRatio);
            return elements;
        },
    };
}

/** 局部序列按给定顺序完成尺寸、约束与零间隙自然横排，归零占位左沿并返回完整宽度 */
export function layoutLocalSequence(nodes: readonly VisualTemporalNode[], context: LayoutPrepareContext): number {
    return nodes.length === 0 ? 0 : layoutLocalLine(nodes.map(node => [node]), context).width;
}

/** 同 layoutLocalSequence，但同列成员按各自 Track 分行；columns 不能为空 */
function layoutLocalLine(
    columns: readonly (readonly VisualTemporalNode[])[],
    context: LayoutPrepareContext,
): { width: number; view: HorizontalLineView } {
    for (const column of columns) {
        for (const node of column) prepareLayoutHost(node, context);
    }
    const line = prepareHorizontalLine(columns, columns[0][0].layoutLine, {}, true);
    let left = Infinity;
    let right = -Infinity;
    for (const column of line.layout(Infinity)) {
        for (const element of column) {
            const anchor = element.box.x + element.box.anchor;
            left = Math.min(left, anchor - element.WL);
            right = Math.max(right, anchor + element.WR);
        }
    }
    for (const column of columns) {
        for (const node of column) node.box.x -= left;
    }
    return { width: right - left, view: line.view };
}

/**
 * 把已横排的子域按正文规则纵向排版，坐标以块的左上角为原点
 *
 * 与正文行的流程相同：沿 root 的 Track 树求轴放置，按登记顺序测量附件，
 * 附件扩张占用时重排一次。positions 是放置时写入的块内位置，不含成员 onPlaced 追加的平移
 */
function layoutSubdomainBlock(
    columns: readonly (readonly VisualTemporalNode[])[],
    { width, view }: { width: number; view: HorizontalLineView },
    root: Track,
    attachments: readonly LayoutAttachment[],
    context: LayoutPrepareContext,
    measuredElsewhere: (attachment: LayoutAttachment) => Readonly<Rect> | undefined,
): { height: number; positions: LayoutPoint[]; items: SubdomainItem[] } {
    const members = columns.flat();
    const extents: LineExtents = { hostExtents: new Map(), attachmentExtents: new Map() };
    let gap = 0;
    for (const member of members) {
        const top = -member.box.visualAxis;
        includeTrackExtent(extents.hostExtents, member.track, top, top + member.box.h);
        gap = Math.max(gap, member.ast.size * ROW_GAP_RATIO);
    }
    const positions = members.map(member => ({ x: member.box.x, y: 0 }));
    const place = () => {
        const solved = solveVerticalAxes(extents, root, gap);
        members.forEach((member, index) => {
            member.box.y = positions[index].y = solved.axes.get(member.track)! - member.box.visualAxis;
            member.onPlaced?.();
        });
        return solved;
    };
    let solved = place();
    if (attachments.length === 0) return { height: solved.height, positions, items: [] };

    const lift = liftInto(root);
    // 附件按行号查询，子域只占自己所在的那一行
    const lines: LineExtents[] = [];
    const views: QueryLine[] = [];
    lines[view.index] = extents;
    views[view.index] = view;
    const measure = () => measureAttachments(attachments, {
        ...context,
        width,
        originX: 0,
        pages: [],
        lines: views,
        getVisualAxis: (_line, track) => solved.axes.get(lift(track)) ?? 0,
        getHostExtent: (line, track) => lines[line]?.hostExtents.get(lift(track)),
        getRangeColumns: (line, range, track) => rangeColumns(views[line], range, track, lift),
    }, lines, lift, measuredElsewhere);
    let measured = measure();
    if (measured.needsRelayout) {
        solved = place();
        measured = measure();
    }
    const reference = members[0];
    const items = measured.items.map(item => ({ ...item, reference, x: reference.box.x, y: reference.box.y }));
    return { height: solved.height, positions, items };
}

/**
 * 关系附件按同时包含全部端点的复合体分组，由内到外逐层登记
 *
 * 端点都在正文的附件不进分组；子域从这里认领端点全部落在自己成员上的关系，不论它写在哪里
 */
function groupRelations(attachments: readonly LayoutAttachment[]) {
    const groups = new Map<TemporalNodeBase, LayoutAttachment[]>();
    for (const attachment of attachments) {
        const [first, ...rest] = attachment.endPoints ?? [];
        for (let owner = first?.foldedInto; owner; owner = owner.foldedInto) {
            const candidate = owner;
            if (!rest.every(point => encloses(candidate, point))) continue;
            const group = groups.get(owner);
            if (group) group.push(attachment);
            else groups.set(owner, [attachment]);
        }
    }
    return groups;
}

function encloses(owner: TemporalNodeBase, node: TemporalNodeBase) {
    for (let host = node.foldedInto; host; host = host.foldedInto) {
        if (host === owner) return true;
    }
    return false;
}

/** 子域是刚性块：按参照成员的位移平移块内测得的几何 */
function moveSubdomainItem(item: SubdomainItem): { geometry: AttachmentGeometry; box: Rect } {
    const dx = item.reference.box.x - item.x;
    const dy = item.reference.box.y - item.y;
    if (dx === 0 && dy === 0) return item;
    const move = <T extends Rect>(rect: T): T => ({ ...rect, x: rect.x + dx, y: rect.y + dy });
    const { geometry } = item;
    return {
        box: move(item.box),
        geometry: {
            regions: geometry.regions.map(move),
            paint: painter => geometry.paint(new TranslatingPainter(painter, dx, dy)),
        },
    };
}

/** 行距取该行最大字号的 ROW_GAP_RATIO 倍；没有可见对象的行回退到全文档最大字号 */
function measureRowGaps(
    lineCount: number,
    objects: readonly VisualTemporalNode[],
    override?: number,
): number[] {
    if (override !== void 0) return new Array<number>(lineCount).fill(override);

    const gaps = new Array<number>(lineCount).fill(0);
    let documentGap = 0;

    for (const node of objects) {
        const gap = node.ast.size * ROW_GAP_RATIO;
        if (gap > gaps[node.layoutLine]) gaps[node.layoutLine] = gap;
        if (gap > documentGap) documentGap = gap;
    }
    for (let i = 0; i < lineCount; i++) gaps[i] ||= documentGap;
    return gaps;
}

/**
 * 按 lowering 注册顺序原子生成本轮几何，并同步登记轨道占用
 *
 * 正文与子域共用：lines 与 baseContext.lines 都按行号索引，lift 把域外的私有轨归入本域。
 * 分组的 attachment 总在组内对象之后注册，所以读取依赖不需要额外排序；
 * 占用逐条累加，后注册者因此能通过 getRangeExtents 避让先注册者。
 * 其他域测得的附件由 measuredElsewhere 给出当前位置。
 * 返回的 needsRelayout 表示本轮占用超出了主体与先前区域的合并范围。
 */
function measureAttachments(
    attachments: readonly LayoutAttachment[],
    baseContext: BaseAttachmentContext,
    lines: readonly LineExtents[],
    lift: (track: Track) => Track,
    measuredElsewhere: (attachment: LayoutAttachment) => Readonly<Rect> | undefined,
) {
    const measured = new Map<LayoutAttachment, Rect>();
    const own = new Set(attachments);
    const occupancy: ExtentRange[][] = [];
    let needsRelayout = false;

    function getRangeExtents(line: number, columns?: LayoutRange): ReadonlyMap<Track, Readonly<Extent>>;
    function getRangeExtents(line: number, columns: LayoutRange | undefined, track: Track): Readonly<Extent> | undefined;
    function getRangeExtents(line: number, columns?: LayoutRange, track?: Track): ReadonlyMap<Track, Readonly<Extent>> | Readonly<Extent> | undefined {
        const view = baseContext.lines[line];
        const extents = track === undefined ? new Map<Track, Extent>() : undefined;
        let extent: Extent | undefined;
        if (!view) return extents;
        const include = (owner: Track, top: number, bottom: number) => {
            if (extents) includeTrackExtent(extents, owner, top, bottom);
            else if (extent) includeExtent(extent, top, bottom);
            else extent = { top, bottom };
        };
        // 主体和附件共用范围筛选，仅累加结果的容器随查询模式变化。
        const { start, end, wholeLine } = resolveRange(view, columns, track, lift);
        const target = track && lift(track);

        let left = wholeLine ? baseContext.originX : Infinity;
        let right = wholeLine ? baseContext.originX + baseContext.width : -Infinity;
        for (let column = start; column <= end; column++) {
            for (const host of view.columns[column]) {
                if (target && host.track !== target) continue;
                if (!wholeLine) {
                    if (host.box.x < left) left = host.box.x;
                    if (host.box.x + host.box.w > right) right = host.box.x + host.box.w;
                }
                const hostTop = host.box.y - baseContext.getVisualAxis(line, host.track);
                include(host.track, hostTop, hostTop + host.box.h);
            }
        }

        for (const range of occupancy[line] ?? []) {
            if (target && range.track !== target) continue;
            if (range.right <= left || range.left >= right) continue;
            include(range.track, range.top, range.bottom);
        }
        return extents ?? extent;
    }

    const context: AttachmentLayoutContext = {
        ...baseContext,
        getRangeExtents,
        getAttachmentBox(dependency) {
            const resolved = measured.get(dependency) ?? measuredElsewhere(dependency);
            if (!resolved) throw new Error("Layout attachment dependency has not been measured");
            return resolved;
        },
        getContentBounds(content) {
            const boxes: Rect[] = [];
            for (const node of content.nodes) {
                if (isVisualTemporalNode(node) && (node.box.w > 0 || node.box.h > 0)) boxes.push(node.box);
            }
            for (const attachment of content.attachments) {
                if (!isLayoutAttachment(attachment)) continue;
                // 端点越出本域的关系交给外层测量，此时还没有几何
                if (!own.has(attachment) && !measuredElsewhere(attachment)) continue;
                const box = context.getAttachmentBox(attachment);
                if (box.w > 0 || box.h > 0) boxes.push(box);
            }
            const bounds = { x: 0, y: 0, w: 0, h: 0 };
            return unionLayoutBoxes(bounds, boxes) ? bounds : undefined;
        },
    };

    const items = attachments.map(attachment => {
        const geometry = attachment.createGeometry(context);
        const box: Rect = { x: 0, y: 0, w: 0, h: 0 };
        unionLayoutBoxes(box, geometry.regions);
        const item = { geometry, box };
        measured.set(attachment, box);
        // 当前项立即登记，保证后注册的 attachment 能看到并避让它
        for (const region of geometry.occupancy ?? geometry.regions) {
            if (region.line === void 0) continue;
            const line = lines[region.line];
            const track = lift(region.track);
            const top = region.y - baseContext.getVisualAxis(region.line, track);
            const bottom = top + region.h;
            const hostExtent = line.hostExtents.get(track);
            const attachmentExtent = line.attachmentExtents.get(track);
            if (top < Math.min(hostExtent?.top ?? Infinity, attachmentExtent?.top ?? Infinity)
                || bottom > Math.max(hostExtent?.bottom ?? -Infinity, attachmentExtent?.bottom ?? -Infinity)) {
                needsRelayout = true;
            }
            includeTrackExtent(line.attachmentExtents, track, top, bottom);
            (occupancy[region.line] ??= []).push({
                track,
                left: region.x,
                right: region.x + region.w,
                top,
                bottom,
            });
        }
        return item;
    });

    return { items, needsRelayout };
}

/** 一条谱面行的纵向解 */
interface VerticalSolution {
    /** 每条音轨的视觉轴，相对于谱面行顶部 */
    axes: Map<Track, number>;
    height: number;
}

/**
 * 沿 Track 树自内向外求出一条谱面行里所有音轨的纵向轴
 *
 * 引擎只做三件通用的事：递归求出每个成员的子树高度、调用该分组自己声明的 measure、
 * 再用完整宿主占用调可选的 place 定位整组。上方叠放还是局部居中完全由函数决定，
 * 因此这里不需要认识 stack、voices 或任何将来新增的排版函数。
 */
function solveVerticalAxes(
    line: LineExtents,
    rootTrack: Track,
    gap: number,
): VerticalSolution {
    // 成员基线相对宿主基线的偏移；只属于当前这一行
    const offsets = new Map<Track, number>();

    /** 返回该音轨连同其全部分支的占用；null 表示本行完全没有内容 */
    const solveTrack = (track: Track): Extent | null => {
        const hostExtent = line.hostExtents.get(track);
        const attachmentExtent = line.attachmentExtents.get(track);
        // 下面会原地并入分支占用，所以必须复制：hostExtents 在整个纵向布局中不变
        let extent: Extent | null = hostExtent ? { top: hostExtent.top, bottom: hostExtent.bottom } : null;
        if (attachmentExtent) {
            if (extent) includeExtent(extent, attachmentExtent.top, attachmentExtent.bottom);
            else extent = { top: attachmentExtent.top, bottom: attachmentExtent.bottom };
        }

        const measurements: {
            group: TrackGroup;
            placements: readonly (TrackPlacement | null)[];
            extent: Extent;
        }[] = [];

        for (const group of track.groups) {
            const memberExtents = group.members.map(solveTrack);
            // 整组在本行没有任何内容时不占位，避免共用音轨的分组在空行上浪费高度
            if (memberExtents.every(member => member === null)) continue;

            const placements = group.measure(memberExtents, gap);
            let groupExtent: Extent | null = null;
            for (const placement of placements) {
                if (!placement) continue;
                const top = placement.offset + placement.extent.top;
                const bottom = placement.offset + placement.extent.bottom;
                if (groupExtent) includeExtent(groupExtent, top, bottom);
                else groupExtent = { top, bottom };
            }
            if (groupExtent) measurements.push({ group, placements, extent: groupExtent });
        }

        const applyPlacement = (
            measurement: typeof measurements[number],
            groupOffset: number,
        ) => {
            extent ??= { top: 0, bottom: 0 };
            for (let i = 0; i < measurement.group.members.length; i++) {
                const placement = measurement.placements[i];
                if (!placement) continue;
                offsets.set(measurement.group.members[i], groupOffset + placement.offset);
            }
            includeExtent(
                extent,
                groupOffset + measurement.extent.top,
                groupOffset + measurement.extent.bottom,
            );
        };

        // 先完成不依赖宿主的局部布局，依赖宿主的分组再贴到完整占用之外
        for (const measurement of measurements) {
            if (!measurement.group.place) applyPlacement(measurement, 0);
        }
        for (const measurement of measurements) {
            const place = measurement.group.place;
            if (!place) continue;
            const host = extent ?? { top: 0, bottom: 0 };
            applyPlacement(measurement, place(host, measurement.extent, gap));
        }
        return extent;
    };

    const totalExtent = solveTrack(rootTrack);
    const axes = new Map<Track, number>();
    if (!totalExtent) return { axes, height: 0 };

    // 行顶归一化到 0，再把偏移沿树传播成本行的相对视觉轴
    const placeTrack = (track: Track, axis: number) => {
        axes.set(track, axis);
        for (const group of track.groups) {
            for (const member of group.members) {
                const offset = offsets.get(member);
                if (offset !== void 0) placeTrack(member, axis + offset);
            }
        }
    };
    placeTrack(rootTrack, -totalExtent.top);

    return { axes, height: totalExtent.bottom - totalExtent.top };
}
