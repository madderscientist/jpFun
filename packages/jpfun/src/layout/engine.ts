import { Diagnostic } from "../diagnostic.js";
import type { Track, TrackGroup, TrackPlacement } from "../lowering/track.js";
import {
    ANCHOR_KEY,
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
    rowGap?: number;            // 强制覆盖每行的轨道间距；缺省按该行最大字号推导
    horizontalOnly?: boolean;   // 跳过文档级纵向放置、分页与附件测量；子域仍完成尺寸所需的布局
}

export interface DocumentLayoutResult {
    diagnostics: Diagnostic[];       // parser 与 lowering 传入的诊断信息
    objects: VisualTemporalNode[];   // 已准备尺寸并获得最终坐标的可见事件
    attachments: PlacedAttachment[]; // box、tie、beam、歌词等非时间对象的最终几何
    bounds: Rect;                    // 所有对象和辅助对象的最终外接矩形
    lineCount: number;               // 按换行控制切分后的谱面行数量
    pages: DocumentLayoutPage[];     // 全局坐标中的页面边界与谱面行范围
}

/** 一行的纵向占用；正文每行一份，子域只有自己所在的一行 */
interface LineExtents {
    /** 只包含可见主体的轴局部占用，整个纵向布局中不变 */
    hostExtents: Map<Track, Extent>;
    /** 首轮 attachment 测量折算出的占用，只写一次，供重排时求轴 */
    attachmentExtents: Map<Track, Extent>;
}

interface LayoutLine extends LineExtents {
    /** lowering 的结果只保留看得见的列 */
    columns: VisualTemporalNode[][];
}

/** 一个附件测量域，按行号稀疏索引：正文是全部谱面行，子域只占自己所在的那一行 */
interface AttachmentDomain {
    lines: readonly LineExtents[];
    views: readonly QueryLine[];
    /** 子域的私有轨归入外层可见的轨 */
    lift: (track: Track) => Track;
}

type BaseAttachmentContext = Omit<AttachmentLayoutContext, "getAttachmentBox" | "getAttachmentOccupancy" | "getRangeExtents" | "getHorizontalExtents" | "getContentBounds">;

interface AttachmentItem {
    geometry: AttachmentGeometry;
    box?: Rect;
}
type AttachmentLookup = (attachment: LayoutAttachment, layoutOnly?: boolean) => AttachmentItem | undefined;

/** 一个测量域里的后置平移 */
interface Displacement {
    /** 域内声明了平移的主体，外层在前 */
    nodes: readonly VisualTemporalNode[];
    /** 域内（含内层子域）有主体或附件平移：首轮只测布局位置的占用，平移后另测绘制几何 */
    layoutOnly: boolean;
}

/** 块内测得的几何及当时参照成员的位置 */
interface BlockSnapshot {
    geometry: AttachmentGeometry;
    position: LayoutPoint;
}

/** 子域附件随块平移，块的位移由参照成员的当前位置与快照之差给出 */
interface SubdomainItem {
    reference: VisualTemporalNode;
    paint: BlockSnapshot;
    /** 占用测量使用布局位置下的快照；没有后置平移时与 paint 相同 */
    layout: BlockSnapshot;
}

/** 一块 attachment 的轴局部占用 */
interface ExtentRange extends Extent {
    track: Track;
    left: number;
    right: number;
}

/** 轨道间距相对行内最大字号的比例；正文行与子域共用 */
const ROW_GAP_RATIO = 0.75;

// 装饰边界是本轮排列结果，不作为主体上的第二套空间协议
const decorationExtents = new WeakMap<LayoutHost, Extent & { contentTop: number }>();

/** 内容边界不含纯留白，完整占用还包含装饰预留的上下空间 */
export function getLayoutBounds(host: LayoutHost, contentOnly = false): Rect {
    const { box } = host;
    const extent = decorationExtents.get(host);
    if (!extent) return box;
    const top = contentOnly ? extent.contentTop : extent.top;
    const bottom = contentOnly ? 0 : extent.bottom;
    return { x: box.x, y: box.y + top, w: box.w, h: box.h - top + bottom };
}

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
    node.springConfig = {};
    if (node.decorations) decorationExtents.delete(node);
    node.decorations = [];
    node.ports = {};
    node.box.x = node.box.y = 0;
    node.prepareLayout(context); // 计算大小等 layout 需要的参数

    // 把 lowering 固化在 addon 中的语义交给已注册 handler，生成本轮函数装饰
    if (node.addon) {
        for (const [key, value] of Object.entries(node.addon)) {
            const handler = context.decorationHandlers.get(key);
            if (!handler) continue;
            const decoration = handler(node, value, context);
            if (decoration) node.decorations.push(decoration);
        }
    }

    // 处理 decoration
    arrangeDecorations(node);
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
    const displaced = collectDisplaced(result);
    // 块内（含内层块）有平移的复合体：外层可能依赖它的附件，也要分开测量布局与绘制
    const displacedBlocks: TemporalNodeBase[] = [];
    const subdomainItems = new Map<LayoutAttachment, SubdomainItem>();
    const subdomainGeometry = (attachment: LayoutAttachment, layoutOnly = false) => {
        const item = subdomainItems.get(attachment);
        return item && moveSubdomainItem(item, layoutOnly);
    };
    context = {
        ...context,
        solverOptions: options,
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
            const nodes = displaced.filter(within);
            const layoutOnly = nodes.length > 0 || own.some(isDisplaced) || displacedBlocks.some(within);
            if (layoutOnly) displacedBlocks.push(owner);
            const block = layoutSubdomainBlock(columns, line, root, own, context, subdomainGeometry, { nodes, layoutOnly });
            own.forEach((attachment, index) => subdomainItems.set(attachment, block.items[index]));
            return { width: line.width, height: block.height, positions: block.positions };
        },
    };

    // 1. 按 layoutLine 切行，并生成固有尺寸与装饰尺寸
    const { lines, pageBreaks } = splitLayoutLines(result);
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
    const regions = horizontal.map(line => line.layout(contentWidth, page.fillRatio));
    alignHorizontalBars(views, regions, contentWidth, pageBreaks);
    for (const line of horizontal) {
        for (const column of line.view.columns) {
            for (const node of column) node.box.x += originX;
        }
    }
    // midi 导入进行自动断行的快通道
    if (options.horizontalOnly) {
        return {
            diagnostics: result.diagnostics,
            objects,
            attachments: [],
            bounds: { x: 0, y: 0, w: 0, h: 0 },
            lineCount: lines.length,
            pages: [],
        };
    }

    // host 申报纵向占用
    // 主体占用只依赖固有尺寸，整个纵向布局中保持不变
    for (const node of objects) {
        const line = lines[node.layoutLine];
        includeHostExtent(line.hostExtents, node);
    }
    // 根据配置得到行距
    const rowGaps = measureRowGaps(lines.length, objects, options.rowGap);

    const domain: AttachmentDomain = { lines, views, lift };
    let pages: DocumentLayoutPage[] = [];
    /** 按当前主体与 attachment 占用求轴、分页并放置所有主体，返回本轮的附件上下文 */
    const placeVertically = () => {
        const heights: number[] = [];
        const headrooms: number[] = [];
        const axes = lines.map((line, i) => {
            const solved = solveVerticalAxes(line, result.rootTrack, rowGaps[i]);
            heights.push(solved.height);
            let top = Infinity;
            for (const column of line.columns) {
                for (const node of column) {
                    top = Math.min(top, (solved.axes.get(node.track) ?? 0) - node.ast.size / 2);
                }
            }
            headrooms.push(top < Infinity ? top : 0);
            return solved.axes;
        });
        let lineTops: number[];
        try {
            ({ pages, lineTops } = paginateLayoutLines(heights, page, pageBreaks, headrooms));
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

        return attachmentContext(context, domain, { width: contentWidth, originX, pages: pages.map(item => item.bounds) }, visualAxisOf);
    };

    // 3. 放置并测量正文 attachment，扩张有效轨道占用时重排一次，最后施加后置平移
    // 正文的作用域是全文：子域认领的附件有平移时，正文依赖它也只能读布局快照
    const displacement = { nodes: displaced, layoutOnly: displaced.length > 0 || layoutAttachments.some(isDisplaced) };
    const { items } = placeAndMeasure(domain, placeVertically, documentAttachments, subdomainGeometry, displacement);
    let next = 0;
    const attachments = layoutAttachments.map<PlacedAttachment>(attachment => {
        const { geometry } = subdomainGeometry(attachment) ?? items[next++];
        return {
            kind: attachment.kind,
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
        for (const node of objects) yield getLayoutBounds(node);
        for (const attachment of attachments) yield* attachment.regions;
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
 * 上下分别由内向外排列，纯留白只进入占用，不改变主体绘制坐标
 */
function arrangeDecorations(node: VisualTemporalNode) {
    if (node.decorations.length === 0) return;
    let contentTop = 0;
    let contentBottom = -Infinity;
    let top = 0;
    let bottom = -Infinity;
    for (const side of ["above", "below"] as const) {
        const above = side === "above";
        const decorations = node.decorations.length === 1 ? node.decorations : node.decorations.filter(item => item[side]);
        if (decorations.length > 1) decorations.sort((left, right) => left[side]!.order - right[side]!.order);
        // 下方可覆盖起点，避免把字体盒的留白当成可见正文；两侧仍独立排列
        let cursor = above ? 0 : (node.ports["decoration.below"]?.y ?? node.box.h);
        let sideBottom = above ? -Infinity : node.box.h;
        let sideContentBottom = sideBottom;
        for (const decoration of decorations) {
            const item = decoration[side];
            if (!item) continue;
            const height = Math.max(0, item.height ?? 0);
            // 纯留白包围完整内容，不能被正文盒内的装饰起点吞掉
            if (!above && !decoration.paint) cursor = Math.max(cursor, sideContentBottom);
            const y = above ? cursor - (item.gap ?? 0) - height : cursor + (item.gap ?? 0);
            item.place?.(y);
            cursor = above ? y : y + height;
            top = Math.min(top, y);
            sideBottom = above ? Math.max(sideBottom, y + height) : cursor;
            if (decoration.paint) {
                contentTop = Math.min(contentTop, y);
                sideContentBottom = above ? Math.max(sideContentBottom, y + height) : cursor;
            }
        }
        bottom = Math.max(bottom, sideBottom);
        contentBottom = Math.max(contentBottom, sideContentBottom);
    }
    node.box.h = contentBottom;
    const extraBottom = Math.max(0, bottom - contentBottom);
    if (top !== 0 || extraBottom !== 0) {
        decorationExtents.set(node, { top, bottom: extraBottom, contentTop });
    }
}

/**
 * 按 lowering 已固化的 layoutLine 把可见事件拆成谱面行
 *
 * 控制事件不会进入 columns；行号跳跃时保留中间空行，使数组下标始终等于 node.layoutLine
 */
function splitLayoutLines(result: LoweringResult) {
    const createLine = (): LayoutLine => ({
        columns: [],
        hostExtents: new Map(),
        attachmentExtents: new Map(),
    });

    const lines: LayoutLine[] = [];
    const pageBreaks: (boolean | undefined)[] = [];
    let currentLine = createLine();

    for (const column of result.columns) {
        const visibleColumn: VisualTemporalNode[] = []; // 从列中提取可见元素

        // 空行
        while (lines.length < column.layoutLine) {
            lines.push(currentLine);
            currentLine = createLine();
        }

        for (const node of column) {
            const pageBreak = node.addon?.pageBreakBefore;
            if (pageBreak !== undefined) {
                pageBreaks[lines.length] = (pageBreaks[lines.length] ?? true) && pageBreak;
            }
            if (isVisualTemporalNode(node)) visibleColumn.push(node);
        }
        if (visibleColumn.length) currentLine.columns.push(visibleColumn);
    }
    // 至少保留一行；强制换页新开的尾页也不能因没有可见内容而丢弃
    if (currentLine.columns.length > 0 || pageBreaks[lines.length] !== undefined || lines.length === 0) lines.push(currentLine);
    return { lines, pageBreaks };
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
    let trackIndex: Map<LayoutHost, number> | undefined;

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
        trackIndexOf(host) {
            if (!trackIndex) {
                trackIndex = new Map();
                for (const run of trackRuns.values()) {
                    for (let i = 0; i < run.length; i++) trackIndex.set(run[i], i);
                }
            }
            return trackIndex.get(host) ?? -1;
        },
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
            const solved = layoutHorizontal(elements, limit, options, hooks, fillMinRatio);
            return Object.assign(elements, { extra: solved.extra, groupOf: solved.groupOf });
        },
    };
}

/** 利用无挤压撑满行的剩余宽度，向同小节数或成倍数邻行的公共台阶做水位填充，使行间小节线对齐 */
function alignHorizontalBars(
    views: readonly HorizontalLineView[],
    regions: readonly { extra: number; groupOf?: Uint32Array }[],
    contentWidth: number,
    pageBreaks: readonly (boolean | undefined)[],
) {
    // 1. 提取每行的内部小节线，并扣除单行撑满时平摊的 extra，还原各小节的自然宽度底线 minW
    const states = views.map(({ columns }, i) => {
        const { extra, groupOf } = regions[i];
        if (extra < 0 || !columns.length) return;
        const bars: number[] = [];
        let hasMusic = false;
        for (let c = 0; c < columns.length; c++) {
            if (columns[c].some(n => n.mergeKey === ANCHOR_KEY)) {
                if (hasMusic) { bars.push(c); hasMusic = false; }
            } else if (columns[c].some(n => !n.T.isZero())) hasMusic = true;
        }
        // 丢弃右侧没有正时值事件的行尾小节线；行首记号与 |: 因左侧尚无音符已在上面自动跳过
        if (!hasMusic) bars.pop();
        if (!bars.length) return;

        // groupAt 将原始列映射到合并后的自由虚拟列；两列之差即其间的自由间隙数
        const groupAt = (c: number) => groupOf ? groupOf[c] : c;
        const totalGaps = groupAt(columns.length - 1);
        const ends = [...bars.map(groupAt), totalGaps];
        let prevX = 0, prevG = 0;
        const gaps = ends.map(g => (g -= prevG, prevG += g, g));
        const minW = ends.map((_, m) => {
            const x = m < bars.length ? columns[bars[m]][0].box.x + columns[bars[m]][0].box.anchor : contentWidth;
            const w = x - prevX;
            prevX = x;
            return totalGaps > 0 ? w - extra * (gaps[m] / totalGaps) : w;
        });
        return { columns, extra, groupAt, totalGaps, ends, gaps, minW };
    });

    type State = NonNullable<typeof states[number]>;
    const divides = (a: number, b: number) => a % b === 0 || b % a === 0;
    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
    // 在各行小节数最小公倍数 L 的细网格上求公共台阶（整段时 L 即最大小节数，回退子窗口时也保证整除），并通过水位填充（涨水填谷）补足剩余空白
    const buildGrid = (lo: number, hi: number) => {
        const group = states.slice(lo, hi + 1) as State[];
        const L = group.reduce((acc, n) => acc / gcd(acc, n.minW.length) * n.minW.length, 1);
        const grid = new Array<number>(L).fill(0);
        // 先填细网格行，再把粗网格行（如 2 小节行）超出对应细格之和的差额平摊进去
        for (const n of [...group].sort((a, b) => b.minW.length - a.minW.length)) {
            const step = L / n.minW.length;
            for (let m = 0; m < n.minW.length; m++) {
                const w = n.minW[m];
                let sum = 0;
                for (let j = 0; j < step; j++) sum += grid[m * step + j];
                if (w > sum) for (let j = 0; j < step; j++) grid[m * step + j] += (w - sum) / step;
            }
        }
        // 公共台阶总和不超过行宽时，把水位拉到 avg，只填平低于水位的窄格，不拉大已高于水位的宽格
        // open 记录段内所有行在该细格均有自由间隙，供第 3 步复用
        const open = grid.map((_, g) => Number(group.every(n => n.gaps[Math.floor(g * n.minW.length / L)] > 0)));
        const free = open.slice();
        let rem = contentWidth;
        for (let g = 0; g < L; g++) if (!free[g]) rem -= grid[g];
        for (let step = 0; step < L; step++) {
            const freeSum = free.reduce((a, b) => a + b, 0);
            if (!freeSum || rem <= 0) break;
            const avg = rem / freeSum;
            if (!grid.some((w, g) => free[g] && w > avg && (rem -= w, free[g] = 0, true))) {
                for (let g = 0; g < L; g++) if (free[g]) grid[g] = avg;
                break;
            }
        }
        return { L, grid, open };
    };
    // 公共台阶只取决于窗口，按窗口缓存，避免段内每行重建网格导致 O(行数²)；每行只把每 r 个细格合回自己的 1 个小节目标宽度
    const grids = new Map<number, ReturnType<typeof buildGrid>>();
    const targetOf = (s: State, lo: number, hi: number) => {
        const key = lo * states.length + hi;
        let cell = grids.get(key);
        if (!cell) grids.set(key, cell = buildGrid(lo, hi));
        const { L, grid, open } = cell, r = L / s.minW.length;
        // 本行被 @rest 等完全锁死的小节保持原宽
        const target = s.minW.map((w, m) => {
            if (!s.gaps[m]) return w;
            let sum = 0;
            for (let j = 0; j < r; j++) sum += grid[m * r + j];
            return sum;
        });
        return { r, open, target };
    };

    // 同小节数且被上一行段覆盖的行，两侧扩展与相同行窗口的扫描都与上一行一致，从上一行结果续扫以免每行重扫整段
    let prev: { l: number; s: State; start: number; end: number; win?: number[] } | undefined;
    for (let l = 0; l < states.length; l++) {
        const s = states[l];
        if (!s || s.extra <= 0 || !s.totalGaps) continue;
        const M = s.minW.length;
        // 2. 向两侧扩展收集连续行段：新行小节数须与本行及段内最大小节数都成整数倍，从而段内各行都整除最大小节数
        //    （如 2、6 小节行成段后不再并入 4 小节行）；遇到 extra = 0 的挤压行或强制换页即作为刚性边界停下
        const last = prev?.l === l - 1 && prev.s.minW.length === M && prev.end >= l ? prev : undefined;
        let start = last?.start ?? l, end = last?.end ?? l, maxM = M;
        if (!last) {
            const joins = (n?: State) => !!n && divides(n.minW.length, M) && divides(n.minW.length, maxM);
            while (states[start]!.extra > 0 && pageBreaks[start] === undefined && joins(states[start - 1])) maxM = Math.max(maxM, states[--start]!.minW.length);
            while (states[end]!.extra > 0 && pageBreaks[end + 1] === undefined && joins(states[end + 1])) maxM = Math.max(maxM, states[++end]!.minW.length);
        }
        prev = { l, s, start, end };
        if (start === end) continue;

        let { r, open, target } = targetOf(s, start, end);
        // 若整段公共台阶总和超出行宽，退回只与上下紧邻行对齐；与本行台阶相同的相邻行视为一体共用窗口，避免相同行逐行错开
        if (target.reduce((a, b) => a + b, 0) > contentWidth + 1e-6) {
            const same = (n?: State) => n?.minW.length === M
                && n.minW.every((w, m) => Math.abs(w - s.minW[m]) <= 1e-6 && !n.gaps[m] === !s.gaps[m]);
            // 与上一行逐值相同时 same 判定不变，上一行窗口的两端必然停在扫描终点，从那里续扫即可
            let [lo, hi] = last?.win && last.win[1] >= l
                && last.s.minW.every((w, m) => w === s.minW[m] && last.s.gaps[m] === s.gaps[m]) ? last.win : [l, l];
            while (lo > start && same(states[lo - 1])) lo--;
            while (hi < end && same(states[hi + 1])) hi++;
            prev.win = [lo, hi];
            ({ r, open, target } = targetOf(s, Math.max(start, lo - 1), Math.min(end, hi + 1)));
        }

        // 3. 退水触底：若目标总宽仍超出行宽（空白不够追平邻行），同步回缩并在碰到本行底线 minW 时锁死
        //    本行第 m 小节对应细格 m·r，段内各行在该细格的自由标记即 open[m·r]
        const free = s.gaps.map((g, m) => g > 0 ? open[m * r] : 0);
        if (!free.some(Boolean)) for (let m = 0; m < M; m++) free[m] = Number(s.gaps[m] > 0);
        for (let step = 0; step < M; step++) {
            let rem = contentWidth, remTarget = 0, freeSum = 0;
            for (let m = 0; m < M; m++) {
                if (free[m]) { remTarget += target[m]; freeSum++; }
                else rem -= target[m];
            }
            if (!freeSum || Math.abs(rem - remTarget) <= 1e-6) break;
            const shift = (rem - remTarget) / freeSum;
            if (!target.some((w, m) => free[m] && w + shift < s.minW[m] && (target[m] = s.minW[m], free[m] = 0, true))) {
                for (let m = 0; m < M; m++) if (free[m]) target[m] += shift;
                break;
            }
        }

        // 4. 将每小节新分到的空白与原平摊空白之差均摊到小节内各自由间隙，累加写回 box.x
        const shift = new Float64Array(s.totalGaps + 1);
        for (let m = 0, k = 0; m < M; m++) {
            const delta = s.gaps[m] > 0 ? (target[m] - s.minW[m]) / s.gaps[m] - s.extra / s.totalGaps : 0;
            for (; k < s.ends[m]; k++) shift[k + 1] = shift[k] + delta;
        }
        for (let c = 0; c < s.columns.length; c++) {
            const dx = shift[s.groupAt(c)];
            if (dx) for (const node of s.columns[c]) node.box.x += dx;
        }
    }
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
    const line = prepareHorizontalLine(columns, columns[0][0].layoutLine, context.solverOptions, true);
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
 * 与正文行共用 placeAndMeasure：沿 root 的 Track 树求轴放置，按登记顺序测量附件，
 * 附件扩张占用时重排一次，最后施加块内的后置平移。positions 是放置时写入的块内布局位置，不含后置平移
 */
function layoutSubdomainBlock(
    columns: readonly (readonly VisualTemporalNode[])[],
    { width, view }: { width: number; view: HorizontalLineView },
    root: Track,
    attachments: readonly LayoutAttachment[],
    context: LayoutPrepareContext,
    lookup: AttachmentLookup,
    displacement: Displacement,
): { height: number; positions: LayoutPoint[]; items: SubdomainItem[] } {
    const members = columns.flat();
    const extents: LineExtents = { hostExtents: new Map(), attachmentExtents: new Map() };
    let gap = 0;
    for (const member of members) {
        includeHostExtent(extents.hostExtents, member);
        gap = Math.max(gap, member.ast.size * ROW_GAP_RATIO);
    }
    const lines: LineExtents[] = [];
    const views: QueryLine[] = [];
    lines[view.index] = extents;
    views[view.index] = view;
    const domain: AttachmentDomain = { lines, views, lift: liftInto(root) };

    const positions = members.map(member => ({ x: member.box.x, y: 0 }));
    let solved!: VerticalSolution;
    const blockContext = attachmentContext(context, domain, { width, originX: 0, pages: [] },
        (_line, track) => solved.axes.get(track) ?? 0);
    const { items, layoutItems } = placeAndMeasure(domain, () => {
        solved = solveVerticalAxes(extents, root, gap);
        members.forEach((member, index) => {
            member.box.y = positions[index].y = solved.axes.get(member.track)! - member.box.visualAxis;
            member.onPlaced?.();
        });
        return blockContext;
    }, attachments, lookup, displacement, true);

    // 以首个成员为参照：布局快照就是它的块内位置，绘制快照取平移后的位置
    const reference = members[0];
    const painted = { x: reference.box.x, y: reference.box.y };
    return {
        height: solved.height,
        positions,
        items: items.map(({ geometry }, index) => {
            const paint = { geometry, position: painted };
            const layout = layoutItems ? { geometry: layoutItems[index].geometry, position: positions[0] } : paint;
            return { reference, paint, layout };
        }),
    };
}

/** 正文与子域的附件上下文只差页面坐标系与视觉轴来源 */
function attachmentContext(
    context: LayoutPrepareContext,
    { lines, views, lift }: AttachmentDomain,
    frame: Pick<BaseAttachmentContext, "width" | "originX" | "pages">,
    axisOf: (line: number, track: Track) => number,
): BaseAttachmentContext {
    return {
        ...context,
        ...frame,
        lines: views,
        getVisualAxis: (line, track) => axisOf(line, lift(track)),
        getHostExtent: (line, track) => lines[line]?.hostExtents.get(lift(track)),
        getRangeColumns: (line, range, track) => rangeColumns(views[line], range, track, lift),
    };
}

/**
 * 正文与子域共用的纵向流程：放置 → 测占用 → [重排一次] → 后置平移 → 测绘制几何
 *
 * place 写入主体坐标并返回本轮附件上下文。有后置平移时首轮只测布局位置的占用，平移后再生成绘制几何；
 * 既无平移也未重排时首轮几何就是最终结果。keepLayout 时另留一份最终布局位置下的占用几何，供外层读取。
 */
function placeAndMeasure(
    domain: AttachmentDomain,
    place: () => BaseAttachmentContext,
    attachments: readonly LayoutAttachment[],
    lookup: AttachmentLookup,
    { nodes, layoutOnly }: Displacement,
    keepLayout = false,
): { items: AttachmentItem[]; layoutItems?: AttachmentItem[] } {
    const measure = (context: BaseAttachmentContext, layoutOnly: boolean) =>
        measureAttachmentPass(attachments, context, domain.lift, lookup, layoutOnly);
    let context = place();
    let measured = measure(context, layoutOnly);
    const relayout = reserveOccupancy(domain.lines, measured.occupancy);
    if (relayout) context = place();
    const layoutItems = keepLayout && layoutOnly ? (relayout ? measure(context, true) : measured).items : undefined;
    displace(nodes);
    if (relayout || layoutOnly) measured = measure(context, false);
    return { items: measured.items, layoutItems };
}

/**
 * 首轮占用并入各行的附件占用，供重排时求轴；任一块越出主体占用就需要重排
 *
 * 与逐块比较「主体 ∪ 此前各块」等价：第一个越界块之前的块都落在主体占用之内
 */
function reserveOccupancy(lines: readonly LineExtents[], occupancy: readonly (readonly ExtentRange[])[]): boolean {
    let needsRelayout = false;
    occupancy.forEach((ranges, line) => {
        const { hostExtents, attachmentExtents } = lines[line];
        for (const { track, top, bottom } of ranges) {
            const host = hostExtents.get(track);
            if (!host || top < host.top || bottom > host.bottom) needsRelayout = true;
            includeTrackExtent(attachmentExtents, track, top, bottom);
        }
    });
    return needsRelayout;
}

/**
 * 关系附件按首端点所在的各层复合体建立候选索引，由内到外逐层登记
 *
 * 端点都在正文的附件不进索引；子域从这里取候选，再认领端点全部落在自己成员上的关系，不论它写在哪里
 */
function groupRelations(attachments: readonly LayoutAttachment[]) {
    const groups = new Map<TemporalNodeBase, LayoutAttachment[]>();
    for (const attachment of attachments) {
        for (let owner = attachment.endPoints?.[0]?.foldedInto; owner; owner = owner.foldedInto) {
            const group = groups.get(owner);
            if (group) group.push(attachment);
            else groups.set(owner, [attachment]);
        }
    }
    return groups;
}

/** 子域是刚性块：按参照成员的位移平移块内测得的几何 */
function moveSubdomainItem({ reference, paint, layout }: SubdomainItem, layoutOnly = false): AttachmentItem {
    const { geometry, position } = layoutOnly ? layout : paint;
    const dx = reference.box.x - position.x;
    const dy = reference.box.y - position.y;
    return { geometry: dx === 0 && dy === 0 ? geometry : translateGeometry(geometry, dx, dy) };
}

function translateGeometry(geometry: AttachmentGeometry, dx: number, dy: number): AttachmentGeometry {
    const move = <T extends Rect>(rect: T): T => ({ ...rect, x: rect.x + dx, y: rect.y + dy });
    return {
        regions: geometry.regions.map(move),
        occupancy: geometry.occupancy?.map(move),
        // attachment 的绘制大多用闭包保存几何，只能代理 painter
        paint: painter => geometry.paint(new TranslatingPainter(painter, dx, dy)),
    };
}

function isDisplaced(target: { placementOffset?: LayoutPoint }) {
    return !!(target.placementOffset?.x || target.placementOffset?.y);
}

/** 按 foldedInto 深度排序，外层先平移：复合体的 onPlaced 带动成员，成员再叠加自己的平移 */
function collectDisplaced(result: LoweringResult): VisualTemporalNode[] {
    const depths = new Map<VisualTemporalNode, number>();
    for (const nodes of result.astToTemporal.values()) {
        for (const node of nodes) {
            if (!isVisualTemporalNode(node) || !isDisplaced(node)) continue;
            let depth = 0;
            for (let host = node.foldedInto; host; host = host.foldedInto) depth++;
            depths.set(node, depth);
        }
    }
    return [...depths.keys()].sort((left, right) => depths.get(left)! - depths.get(right)!);
}

/** 占用测量完成后施加后置平移；之后不得再放置，否则复合体会把成员同步回布局位置 */
function displace(nodes: readonly VisualTemporalNode[]) {
    for (const node of nodes) {
        node.box.x += node.placementOffset!.x;
        node.box.y += node.placementOffset!.y;
        node.onPlaced?.();
    }
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
 * 按声明顺序测量几何，后注册的附件可以查询此前的区域和占用；只读主体坐标，不改写行占用
 *
 * layoutOnly 用于有后置平移时的占用测量：主体尚未平移，附件自身的平移也不施加，依赖的子域附件取布局快照
 */
function measureAttachmentPass(
    attachments: readonly LayoutAttachment[],
    baseContext: BaseAttachmentContext,
    lift: (track: Track) => Track,
    lookup: AttachmentLookup,
    layoutOnly: boolean,
) {
    const measured = new Map<LayoutAttachment, AttachmentItem>();
    const occupancy: ExtentRange[][] = [];

    // 同一测量轮坐标不变，子域几何只需平移一次
    function resolveAttachment(dependency: LayoutAttachment) {
        let item = measured.get(dependency);
        if (!item) {
            item = lookup(dependency, layoutOnly);
            if (item) measured.set(dependency, item);
        }
        return item;
    }

    function getExtents(line: number, range?: LayoutRange | { left: number; right: number }): ReadonlyMap<Track, Readonly<Extent>>;
    function getExtents(line: number, range: LayoutRange | undefined, track: Track): Readonly<Extent> | undefined;
    function getExtents(line: number, range?: LayoutRange | { left: number; right: number }, track?: Track): ReadonlyMap<Track, Readonly<Extent>> | Readonly<Extent> | undefined {
        const view = baseContext.lines[line];
        const extents = track === undefined ? new Map<Track, Extent>() : undefined;
        let extent: Extent | undefined;
        const horizontal = range && "left" in range ? range : undefined;
        if (!view || (horizontal && horizontal.left >= horizontal.right)) return extents;
        const include = (owner: Track, top: number, bottom: number) => {
            if (extents) includeTrackExtent(extents, owner, top, bottom);
            else if (extent) includeExtent(extent, top, bottom);
            else extent = { top, bottom };
        };
        // 主体和附件共用范围筛选，仅累加结果的容器随查询模式变化。
        const elementRange = range && !("left" in range) ? range : undefined;
        const { start, end } = resolveRange(view, elementRange);
        const target = track && lift(track);

        let left = horizontal?.left ?? (elementRange ? Infinity : baseContext.originX);
        let right = horizontal?.right ?? (elementRange ? -Infinity : baseContext.originX + baseContext.width);
        for (let column = start; column <= end; column++) {
            for (const host of view.columns[column]) {
                if (target && host.track !== target) continue;
                if (horizontal && (host.box.x + host.box.w <= left || host.box.x >= right)) continue;
                if (elementRange) {
                    if (host.box.x < left) left = host.box.x;
                    if (host.box.x + host.box.w > right) right = host.box.x + host.box.w;
                }
                const { top, height } = hostSpan(host);
                const hostTop = host.box.y + top - baseContext.getVisualAxis(line, host.track);
                include(host.track, hostTop, hostTop + height);
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
        getRangeExtents: getExtents,
        getHorizontalExtents: (line, left, right) => getExtents(line, { left, right }),
        getAttachmentOccupancy(dependency) {
            const geometry = resolveAttachment(dependency)?.geometry;
            return geometry && (geometry.occupancy ?? geometry.regions);
        },
        getAttachmentBox(dependency) {
            const resolved = resolveAttachment(dependency);
            if (!resolved) throw new Error("Layout attachment dependency has not been measured");
            if (!resolved.box) {
                resolved.box = { x: 0, y: 0, w: 0, h: 0 };
                unionLayoutBoxes(resolved.box, resolved.geometry.regions);
            }
            return resolved.box;
        },
        getContentBounds(content) {
            const boxes: Rect[] = [];
            for (const node of content.nodes) {
                if (isVisualTemporalNode(node) && (node.box.w > 0 || node.box.h > 0)) boxes.push(getLayoutBounds(node, true));
            }
            for (const attachment of content.attachments) {
                if (!isLayoutAttachment(attachment)) continue;
                // 端点越出本域的关系交给外层测量，此时还没有几何
                const resolved = resolveAttachment(attachment);
                if (!resolved && !attachments.includes(attachment)) continue;
                if (!resolved) throw new Error("Layout attachment dependency has not been measured");
                for (const region of resolved.geometry.regions) {
                    if (region.w > 0 || region.h > 0) boxes.push(region);
                }
            }
            const bounds = { x: 0, y: 0, w: 0, h: 0 };
            return unionLayoutBoxes(bounds, boxes) ? bounds : undefined;
        },
    };

    const items = attachments.map(attachment => {
        let geometry = attachment.createGeometry(context);
        if (!layoutOnly && isDisplaced(attachment)) {
            geometry = translateGeometry(geometry, attachment.placementOffset!.x, attachment.placementOffset!.y);
        }
        const item: AttachmentItem = { geometry };
        measured.set(attachment, item);
        // 当前项立即登记，保证后注册的 attachment 能看到并避让它
        for (const region of geometry.occupancy ?? geometry.regions) {
            if (region.line === void 0) continue;
            const track = lift(region.track);
            const top = region.y - baseContext.getVisualAxis(region.line, track);
            (occupancy[region.line] ??= []).push({
                track,
                left: region.x,
                right: region.x + region.w,
                top,
                bottom: top + region.h,
            });
        }
        return item;
    });

    return { items, occupancy };
}

/** 主体完整占用相对盒顶的上沿与高度；调用方各自换算到轴局部或行坐标，不必创建全局矩形 */
function hostSpan(host: LayoutHost) {
    const decoration = decorationExtents.get(host);
    const top = decoration?.top ?? 0;
    return { top, height: host.box.h - top + (decoration?.bottom ?? 0) };
}

function includeHostExtent(extents: Map<Track, Extent>, host: LayoutHost) {
    const { top, height } = hostSpan(host);
    const axisTop = top - host.box.visualAxis;
    includeTrackExtent(extents, host.track, axisTop, axisTop + height);
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
