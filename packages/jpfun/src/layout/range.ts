import { isVisualTemporalNode, TemporalNodeBase } from "../functions/temporal.js";
import type { Track } from "../lowering/track.js";
import type { HorizontalLineView, LayoutHost, LayoutRange } from "./types.js";

export type QueryLine = Omit<HorizontalLineView, "registerHorizontalLayoutHook">;

/** 范围在本域视图中覆盖的闭区间列，start > end 表示空 */
interface ResolvedRange {
    start: number;
    end: number;
    /** 省略范围即整行，附件占用不再按所选主体的横向范围筛选 */
    wholeLine: boolean;
}

const EMPTY: ResolvedRange = { start: 0, end: -1, wholeLine: false };

/**
 * 把轨归入以 root 为根的 Track 树
 *
 * 复合体的私有根轨从它所在的轨分出却不挂进分组，所以沿 Track.parent 上溯总会回到外层的树
 */
export function liftInto(root: Track): (track: Track) => Track {
    const tracks = new Set<Track>();
    const collect = (track: Track) => {
        tracks.add(track);
        for (const group of track.groups) {
            for (const member of group.members) collect(member);
        }
    };
    collect(root);
    return track => {
        for (let lane: Track | null = track; lane; lane = lane.parent) {
            if (tracks.has(lane)) return lane;
        }
        return track;
    };
}

/** 本域里代表 host 的列：折叠成员沿 foldedInto 上溯到本域的主体 */
function columnOf(view: QueryLine, host: LayoutHost): number {
    for (let node: LayoutHost | undefined = host; node;) {
        const column = view.columnOf(node);
        if (column >= 0) return column;
        const folded: TemporalNodeBase | undefined = node instanceof TemporalNodeBase ? node.foldedInto : undefined;
        node = folded && isVisualTemporalNode(folded) ? folded : undefined;
    }
    return -1;
}

/**
 * 在正文行或子域的视图里解析一次范围查询
 *
 * 数字端点是本视图的列下标；对象端点可以逆序或跨行，按本行截取。
 * 指定 track 时两个端点都必须位于该轨，私有轨先经 lift 归入本域
 */
export function resolveRange(
    view: QueryLine,
    range: LayoutRange | undefined,
    track: Track | undefined,
    lift: (track: Track) => Track,
): ResolvedRange {
    if (!range) return { start: 0, end: view.columns.length - 1, wholeLine: true };
    if (typeof range[0] === "number") {
        return { start: Math.max(0, range[0]), end: Math.min(view.columns.length - 1, range[1] as number), wholeLine: false };
    }
    let [from, to] = range as readonly [LayoutHost, LayoutHost];
    if (from.layoutLine > to.layoutLine) [from, to] = [to, from];
    if (view.index < from.layoutLine || view.index > to.layoutLine) return EMPTY;
    const target = track && lift(track);
    if (target && (lift(from.track) !== target || lift(to.track) !== target)) {
        throw new Error("Range endpoints must belong to the selected track");
    }
    const start = from.layoutLine < view.index ? 0 : columnOf(view, from);
    const end = to.layoutLine > view.index ? view.columns.length - 1 : columnOf(view, to);
    if (start < 0 || end < 0) return EMPTY;
    return { start: Math.min(start, end), end: Math.max(start, end), wholeLine: false };
}

/** 范围内的列；指定 track 时只保留该轨主体，空列照样保留 */
export function rangeColumns(
    view: QueryLine | undefined,
    range: LayoutRange | undefined,
    track: Track | undefined,
    lift: (track: Track) => Track,
): readonly (readonly LayoutHost[])[] {
    if (!view) return [];
    const { start, end } = resolveRange(view, range, track, lift);
    const columns = view.columns.slice(start, end + 1);
    if (!track) return columns;
    const target = lift(track);
    const onTarget = (host: LayoutHost) => host.track === target;
    return columns.every(column => column.every(onTarget)) ? columns : columns.map(column => column.filter(onTarget));
}
