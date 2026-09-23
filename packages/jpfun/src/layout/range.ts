import { isVisualTemporalNode, TemporalNodeBase } from "../functions/temporal.js";
import type { Track } from "../lowering/track.js";
import type { HorizontalLineView, LayoutHost, LayoutRange } from "./types.js";

interface Position {
    start: number;
    end: number;
}

interface SequenceIndex {
    columns: readonly (readonly LayoutHost[])[];
    positions: Map<LayoutHost, Position>;
}

/** 一次查询的结构解析结果；主体选择和附件隔离使用同一份范围语义 */
interface ResolvedRange {
    columns: readonly (readonly LayoutHost[])[];
    start: number;
    end: number;
    scope: LayoutScope;
    wholeLine: boolean;
}

type QueryLine = Omit<HorizontalLineView, "registerHorizontalLayoutHook">;

/** 正文行是查询根范围，已注册的局部序列以其宿主作为范围身份 */
export type LayoutScope = QueryLine | LayoutHost;

/** 本轮布局的查询拓扑；只保存对象引用，不保存会随纵向重排变化的坐标 */
export class LayoutRangeIndex {
    private readonly local = new Map<LayoutHost, readonly LayoutHost[]>();
    private readonly parents = new Map<LayoutHost, LayoutHost>();
    private readonly tracks = new Map<QueryLine, Map<Track, SequenceIndex>>();
    private readonly sequences = new Map<LayoutHost, SequenceIndex>();
    private sealed = false;

    private parent(host: LayoutHost): LayoutHost | undefined {
        const registered = this.parents.get(host);
        if (registered) return registered;
        const folded = host instanceof TemporalNodeBase ? host.foldedInto : undefined;
        return folded && isVisualTemporalNode(folded) ? folded : undefined;
    }

    register(owner: LayoutHost, columns: readonly (readonly LayoutHost[])[]) {
        if (this.sealed) throw new Error("Local layout columns are sealed after preparation");
        if (this.local.has(owner)) throw new Error("Local layout columns already registered");
        if (columns.length === 0) throw new Error("Local layout columns must not be empty");
        const members = new Set<LayoutHost>();
        for (const column of columns) {
            if (column.length !== 1) throw new Error("Local layout columns require exactly one member on the owner's track");
            const [member] = column;
            if (member === owner || members.has(member) || member.track !== owner.track
                || member.layoutLine !== owner.layoutLine) throw new Error("Invalid local layout column member");
            members.add(member);
            const parent = this.parent(member);
            if (parent && parent !== owner) throw new Error("Local layout member belongs to another owner");
        }
        for (let ancestor: LayoutHost | undefined = owner; ancestor; ancestor = this.parent(ancestor)) {
            if (members.has(ancestor)) throw new Error("Cyclic local layout columns");
        }
        for (const member of members) this.parents.set(member, owner);
        this.local.set(owner, [...members]);
    }

    /** 准备结束后只允许读取拓扑，成员坐标仍由后续放置更新 */
    seal() {
        this.sealed = true;
    }

    private documentColumn(host: LayoutHost, view: QueryLine): number {
        let column = view.columnOf(host);
        while (column < 0) {
            const parent = this.parent(host);
            if (!parent) return -1;
            host = parent;
            column = view.columnOf(host);
        }
        return column;
    }

    /** 正文先筛选目标轨，局部成员已在注册时校验同轨；递归保持原序，未注册的复合体作为一列 */
    private expand(columns: readonly (readonly LayoutHost[])[], track: Track): SequenceIndex {
        const result: (readonly LayoutHost[])[] = [];
        const positions = new Map<LayoutHost, Position>();
        const append = (host: LayoutHost) => {
            const start = result.length;
            const sequence = this.local.get(host);
            if (sequence) {
                for (const member of sequence) append(member);
            } else result.push([host]);
            positions.set(host, { start, end: result.length - 1 });
        };
        for (const column of columns) {
            const host = column.find(member => member.track === track);
            if (host) append(host);
        }
        return { columns: result, positions };
    }

    private position(host: LayoutHost, index: SequenceIndex): Position | undefined {
        for (;;) {
            const position = index.positions.get(host);
            if (position) return position;
            const parent = this.parent(host);
            if (!parent) return undefined;
            host = parent;
        }
    }

    /** 同一不透明叠放体中的局部序列仍可独立查询，不把叠放成员拆成正文多列 */
    private commonSequence(from: LayoutHost, to: LayoutHost): LayoutHost | undefined {
        if (this.local.size === 0) return undefined;
        for (let owner: LayoutHost | undefined = from; owner; owner = this.enclosingSequence(owner)) {
            if (this.local.has(owner) && this.contains(owner, to)) return owner;
        }
        return undefined;
    }

    private contains(owner: LayoutHost, member: LayoutHost): boolean {
        for (let node: LayoutHost | undefined = member; node; node = this.parent(node)) {
            if (node === owner) return true;
        }
        return false;
    }

    contentScope(nodes: readonly TemporalNodeBase[]): LayoutHost | undefined {
        if (this.local.size === 0) return undefined;
        const first = nodes.find(isVisualTemporalNode);
        if (!first) return undefined;
        for (let owner = this.enclosingSequence(first); owner; owner = this.enclosingSequence(owner)) {
            if (nodes.every(node => !isVisualTemporalNode(node) || this.contains(owner, node))) return owner;
        }
        return undefined;
    }

    enclosingSequence(member: LayoutHost): LayoutHost | undefined {
        for (let owner = this.parent(member); owner; owner = this.parent(owner)) {
            if (this.local.has(owner)) return owner;
        }
        return undefined;
    }

    /** 占用从所属范围逐级向外可见，最终归入该几何区域所在的正文行 */
    parentScope(scope: LayoutScope, line: QueryLine): LayoutScope | undefined {
        return scope === line ? undefined : this.enclosingSequence(scope as LayoutHost) ?? line;
    }

    resolve(view: QueryLine, range?: LayoutRange, track?: Track): ResolvedRange {
        this.seal();
        const result: ResolvedRange = { columns: view.columns, start: 0, end: -1, scope: view, wholeLine: range === undefined };
        if (!range || typeof range[0] === "number") {
            const start = range ? Math.max(0, range[0] as number) : 0;
            const end = range ? Math.min(view.columns.length - 1, range[1] as number) : view.columns.length - 1;
            if (start > end) return result;
            result.start = start;
            result.end = end;
            return result;
        }
        let [from, to] = range as readonly [LayoutHost, LayoutHost];
        if (from.layoutLine > to.layoutLine) [from, to] = [to, from];
        if (view.index < from.layoutLine || view.index > to.layoutLine) return result;
        if (track && (from.track !== track || to.track !== track)) throw new Error("Range endpoints must belong to the selected track");
        if (!track || this.local.size === 0) {
            const start = from.layoutLine < view.index ? 0 : this.documentColumn(from, view);
            const end = to.layoutLine > view.index ? view.columns.length - 1 : this.documentColumn(to, view);
            if (start < 0 || end < 0) return result;
            result.start = Math.min(start, end);
            result.end = Math.max(start, end);
            return result;
        }
        const owner = this.commonSequence(from, to);
        result.scope = owner ?? view;
        let index: SequenceIndex;
        if (owner) {
            index = this.sequences.get(owner) ?? this.expand([[owner]], track);
            this.sequences.set(owner, index);
        } else {
            let tracks = this.tracks.get(view);
            if (!tracks) this.tracks.set(view, tracks = new Map());
            index = tracks.get(track) ?? this.expand(view.columns, track);
            tracks.set(track, index);
        }
        const first = this.position(from, index);
        const last = this.position(to, index);
        const start = first?.start ?? (from.layoutLine < view.index ? 0 : -1);
        const end = last?.end ?? (to.layoutLine > view.index ? index.columns.length - 1 : -1);
        if (start < 0 || end < 0) return result;
        result.columns = index.columns;
        result.start = first && last ? Math.min(first.start, last.start) : start;
        result.end = first && last ? Math.max(first.end, last.end) : end;
        return result;
    }
}