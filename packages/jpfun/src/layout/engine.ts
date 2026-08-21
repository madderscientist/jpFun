import { Diagnostic } from "../diagnostic.js";
import type { Extent, Track, TrackGroup, TrackPlacement } from "../lowering/track.js";
import {
    isVisualTemporalNode,
    type LoweringResult,
    type VisualTemporalNode,
} from "../lowering/types.js";
import type { Painter } from "../render/types.js";
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
import type {
    AttachmentLayoutContext,
    HorizontalLineView,
    LayoutAttachment,
    LayoutHost,
    LayoutPrepareContext,
    LayoutRegion,
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
    attachments: LayoutAttachment[]; // box、tie、beam、歌词等非时间对象
    bounds: Rect;                    // 所有对象和辅助对象的最终外接矩形
    lineCount: number;               // 按 br 切分后的谱面行数量
    pages: DocumentLayoutPage[];     // 全局坐标中的页面边界与谱面行范围
}

interface LayoutLine {
    /** lowering 的结果只保留看得见的列 */
    columns: VisualTemporalNode[][];
    /** 横向布局 hooks */
    horizontalLayoutHooks: HorizontalLayoutHookEntry[];
    /** 只包含可见主体的轴局部占用，整个纵向布局中不变 */
    hostExtents: Map<Track, Extent>;
    /** attachment 首次测量区域折算出的占用，必要时触发最终重排 */
    attachmentExtents: Map<Track, Extent>;
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
 * ports 和 decorations 在本次 pass 中从空容器开始建立。
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
    const page = normalizePageConfig(result.page);
    const contentWidth = page.width - page.marginLeft - page.marginRight;
    const originX = page.marginLeft;

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

    // 2. 横向弹簧布局，得到 box.x
    const views = buildLineViews(lines, options.globalC);
    for (const object of objects) object.prepareHorizontal?.(views[object.layoutLine]);
    for (const attachment of result.attachments) attachment.prepareHorizontal?.(views);
    for (const line of lines) {
        const elements = line.columns.map(column =>
            column.map(node => layoutElement(node.springConfig, node.box, node, options.globalC))
        );
        layoutHorizontal(elements, contentWidth, options, line.horizontalLayoutHooks);
        for (const column of line.columns) {
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

        const attachmentContext: AttachmentLayoutContext = {
            ...context,
            width: contentWidth,
            originX,
            getVisualAxis: visualAxisOf,
            getHostExtent: (line, track) => lines[line]?.hostExtents.get(track),
        };

        return { pages, attachmentContext };
    };

    // 3. 首次纵向放置后测量 attachment；只有有效轨道占用扩张时才重新求解
    let placement = placeVertically();
    let needsRelayout = false;
    for (const attachment of result.attachments) {
        if (registerAttachmentRegions(
            attachment,
            attachment.layout?.(placement.attachmentContext),
            lines,
            placement.attachmentContext.getVisualAxis,
        )) needsRelayout = true;
    }

    if (needsRelayout) {
        placement = placeVertically();
        // 最终区域只更新绘制外接盒，不再累计没有后续消费者的轨道占用
        for (const attachment of result.attachments) {
            unionLayoutBoxes(
                attachment.box,
                attachment.layout?.(placement.attachmentContext) ?? [],
            );
        }
    }
    const pages = placement.pages;

    const bounds: Rect = {
        x: 0, y: 0,
        w: 0, h: 0,
    };

    // 最终画布只使用排版盒，不追踪盒外悬挂图形
    function* layoutBoxes(): Iterable<Rect> {
        for (const pageResult of pages) yield pageResult.bounds;
        for (const node of objects) yield node.box;
        for (const attachment of result.attachments) yield attachment.box;
    }
    unionLayoutBoxes(bounds, layoutBoxes());

    return {
        diagnostics: result.diagnostics,
        objects,
        attachments: result.attachments,
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
        horizontalLayoutHooks: [],
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
 * 固化每行的横向拓扑：补齐弹簧配置，并生成交给具体函数的只读视图
 */
function buildLineViews(lines: readonly LayoutLine[], force?: number): HorizontalLineView[] {
    return lines.map((line, index) => {
        const columnIndex = new Map<LayoutHost, number>();
        const trackRuns = new Map<Track, VisualTemporalNode[]>();

        for (let i = 0; i < line.columns.length; i++) {
            for (const node of line.columns[i]) {
                columnIndex.set(node, i);
                completeSpringConfig(node.springConfig, force);
                const run = trackRuns.get(node.track);
                if (run) run.push(node);
                else trackRuns.set(node.track, [node]);
            }
        }

        return {
            index,
            trackRuns,
            columnOf: host => columnIndex.get(host) ?? -1,
            registerHorizontalLayoutHook(from, to, hook) {
                const start = columnIndex.get(from);
                const end = columnIndex.get(to);
                if (start === void 0 || end === void 0) return;
                line.horizontalLayoutHooks.push({
                    start: Math.min(start, end),
                    end: Math.max(start, end),
                    hook,
                });
            },
        };
    });
}

/** 行距取该行最大字号的 0.75 倍；没有可见对象的行回退到全文档最大字号 */
function measureRowGaps(
    lineCount: number,
    objects: readonly VisualTemporalNode[],
    override?: number,
): number[] {
    if (override !== void 0) return new Array<number>(lineCount).fill(override);

    const gaps = new Array<number>(lineCount).fill(0);
    let documentGap = 0;

    for (const node of objects) {
        const gap = node.ast.size * 0.75;
        if (gap > gaps[node.layoutLine]) gaps[node.layoutLine] = gap;
        if (gap > documentGap) documentGap = gap;
    }
    for (let i = 0; i < lineCount; i++) gaps[i] ||= documentGap;
    return gaps;
}

/**
 * 把一个 attachment 首次报出的区域折算成外接盒与轨道占用
 *
 * 只声明了矩形的区域仅影响画布边界；同时声明 line 与 track 才会撑开谱面行。
 * 返回值表示区域是否扩张了主体与先前区域的合并占用，因而需要最终重排。
 */
function registerAttachmentRegions(
    attachment: LayoutAttachment,
    regions: readonly LayoutRegion[] | void,
    lines: readonly LayoutLine[],
    visualAxisOf: (line: number, track: Track) => number,
) {
    unionLayoutBoxes(attachment.box, regions ?? []);
    let expandedTrackOccupancy = false;

    for (const region of regions ?? []) {
        if (region.line === void 0 || !region.track) continue;
        const line = lines[region.line];
        if (!line) throw new Error(`Layout attachment referenced invalid line ${region.line}`);
        const axis = visualAxisOf(region.line, region.track);
        const top = region.y - axis;
        const bottom = region.y + region.h - axis;
        const hostExtent = line.hostExtents.get(region.track);
        const attachmentExtent = line.attachmentExtents.get(region.track);
        const previousTop = Math.min(hostExtent?.top ?? Infinity, attachmentExtent?.top ?? Infinity);
        const previousBottom = Math.max(hostExtent?.bottom ?? -Infinity, attachmentExtent?.bottom ?? -Infinity);
        if (top < previousTop || bottom > previousBottom) expandedTrackOccupancy = true;
        includeTrackExtent(line.attachmentExtents, region.track, top, bottom);
    }
    return expandedTrackOccupancy;
}

/**
 * 按固定层级绘制已经完成布局的结果
 *
 * background 先于 temporal 对象绘制
 * foreground 用于 tie、beam 等覆盖在线符号之上的对象
 */
export function paintLayout(result: DocumentLayoutResult, painter: Painter) {
    for (const attachment of result.attachments) {
        if (attachment.layer === "background") attachment.paint(painter);
    }

    for (const node of result.objects) {
        node.paint(painter);
        for (const decoration of node.decorations) decoration.paint(painter);
    }

    for (const attachment of result.attachments) {
        if (attachment.layer === "foreground") attachment.paint(painter);
    }
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
    line: LayoutLine,
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
