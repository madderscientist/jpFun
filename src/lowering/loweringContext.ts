import { Diagnostic } from "../diagnostic.js";
import { ASTFunctionClass, ASTNodeBase } from "../functions/ASTtypes.js";
import type {
    LayoutAttachment,
    PageConfig,
} from "../layout/types.js";
import {
    ColType,
    TemporalNodeBase,
    type LoweringAugmenter,
    type LoweringFinalizer,
    type LoweringGroup,
    type LoweringResult,
} from "./types.js";
import { Track } from "./track.js";

/**
 * 把 AST 展开并固化为时间列、attachment 和页面配置
 *
 * 标准用法：
 * 1. 创建 LoweringContext
 * 2. 调用 registerFunctions，传入与 parser 相同的函数类列表
 * 3. 调用 lowerDocument(root)，得到 LoweringResult
 * 4. 把结果交给 layoutDocument
 *
 * 大多数 AST 函数通过以下入口参与 lowering（按时间顺序）：
 * - [hook] loweringEnter/loweringExit：进入或离开节点时生成 TemporalNode、管理作用域
 * - [API] LoweringContext.beginLoweringGroup/endLoweringGroup：通常在 enter/exit 中被调用，以栈方式观察当前子树产生的 TemporalNode 和 attachment
 * - [API] LoweringContext.addLayoutAttachment：注册不推进时间的独立排版对象，供 tie、beam 等函数使用；若当前位于分组中，其 box 也会加入外层分组
 * - [config] timeFlowModel：声明子节点按 sequence 或 parallel 推进时间；parallel 还要声明音轨复用键与纵向排列策略
 * - [hook] Temporal.onTimeState：锚点归并后固化调性、速度等状态
 * - [hook] loweringAugment：最终列和 layoutLine 固化后扫描结果并生成要追加的 attachment
 * - [hook] loweringFinalize：所有派生 attachment 追加完成后，按注册顺序处理完整结果
 */
export class LoweringContext {
    private loweringAugmenters: LoweringAugmenter[] = [];
    private loweringFinalizers: LoweringFinalizer[] = [];
    private cnt = 0;  // 生成唯一id的计数器

    /** 不推进时间的关系对象和分组对象 */
    private attachments: LayoutAttachment[] = [];

    /** 当前完整文档的页面配置 */
    private page?: PageConfig;

    /**
     * 一个 AST 节点可能不产生 temporal，也可能产生多个 temporal
     * 不包含子节点的 TemporalNode
     */
    private astToTemporal = new Map<ASTNodeBase, TemporalNodeBase[]>();

    /**
     * 当前递归路径上正在收集成员的作用域 的栈
     * 使用 beginLoweringGroup/endLoweringGroup 维护
     */
    private activeLoweringGroups: {
        owner: ASTNodeBase;  // 用于验证分组严格按栈顺序结束
        group: LoweringGroup;
    }[] = [];

    /** 收集本轮 lowering 产生的诊断信息 */
    diagnostics: Diagnostic[] = [];

    /** 供外部调用: 初始化 hook */
    registerFunctions(functionClasses: ASTFunctionClass[]) {
        const augmenters: LoweringAugmenter[] = this.loweringAugmenters = [];
        const finalizers: LoweringFinalizer[] = this.loweringFinalizers = [];
        for (const cls of functionClasses) {
            const functionClass = cls as unknown as typeof ASTNodeBase;
            if (functionClass.loweringAugment) augmenters.push(functionClass.loweringAugment);
            if (functionClass.loweringFinalize) finalizers.push(functionClass.loweringFinalize);
        }
    }

    /** 供 page 函数调用 */
    setPageConfig(page: PageConfig) {
        this.page = page;
    }

    /**
     * 完整 lowering 入口
     *
     * 每次调用都会重置本轮产生的数据
     * 已注册的后处理 hook 会保留，可以复用同一个 LoweringContext
     */
    lowerDocument(node: ASTNodeBase): LoweringResult {
        this.cnt = 0;
        this.attachments = [];
        this.page = void 0;
        this.astToTemporal = new Map();
        this.activeLoweringGroups = [];

        const rootTrack = new Track();
        const { columns, timeOffset } = this.trackedEvents(node, 0, rootTrack);
        this.solidifyColumns(columns);
        return this.postprocessResult({
            columns,
            attachments: this.attachments,
            astToTemporal: this.astToTemporal,
            duration: timeOffset,
            rootTrack,
            page: this.page,
        });
    }

    /**
     * 固化谱面行号并进行时间状态固化
     */
    private solidifyColumns(columns: TimeColumn[]) {
        // 同一轨的请求累加（`br br` 两行），不同轨的请求取最大（两轨同时 br 只换一行）
        let line = 0;
        let t = 0;  // 上一个br的时间点
        let requests = new Map<Track, number>();
        let pending: TimeColumn[] = [];

        const applyBreak = () => {
            if (requests.size === 0) return;
            let offset = 0;
            for (const value of requests.values()) offset = Math.max(offset, value);
            line += offset;
            // 换行列本身归属于换行之后的那一行
            for (const column of pending as TimeColumn[]) column.layoutLine = line;
            requests.clear();
            pending.length = 0;
        };

        for (const column of columns) {
            if (!column.breakRequested) {
                applyBreak();
                column.layoutLine = line;
                continue;
            }
            if (column.t !== t) {
                applyBreak();   // 不在同一时刻，重启换行
                t = column.t;
            } else {
                for (const node of column) {
                    if (node.breakBefore <= 0) continue;
                    if (requests.has(node.track)) {
                        applyBreak();   // 同一轨重复出现，先把之前的换行列固化
                        break;
                    }
                }
            }
            for (const node of column) {
                if (node.breakBefore > 0) requests.set(node.track, node.breakBefore);
            } pending.push(column);
        }
        applyBreak();

        // 行号全部就位后再固化时间状态，up 等节点才能把行号转发给内部成员
        const state: Record<string, any> = {};
        for (const column of columns) {
            for (const node of column) node.onTimeState?.(state);
        }
    }

    /**
     * 开始一个 lowering 分组作用域
     * group 可以收集并提交新增 temporal，也可以观察成员并携带一个 attachment
     */
    beginLoweringGroup(
        owner: ASTNodeBase,
        group: LoweringGroup,
    ) {
        this.activeLoweringGroups.push({ owner, group });
    }

    /**
     * 结束最近的分组并注册其辅助排版对象
     * 嵌套分组按退出顺序注册，因此天然是由内向外计算边界
     */
    endLoweringGroup(owner: ASTNodeBase) {
        const active = this.activeLoweringGroups.pop();
        if (!active) throw new Error("No active lowering group to end");
        if (active.owner !== owner) throw new Error("Lowering groups must end in reverse order");
        if (active.group.attachment) this.addLayoutAttachment(active.group.attachment);
    }

    /** 先统一生成派生 attachment，再按注册顺序执行最终处理 */
    private postprocessResult(result: LoweringResult): LoweringResult {
        if (this.activeLoweringGroups.length > 0)
            throw new Error("Lowering groups must be closed before post-processing");

        const additions: LayoutAttachment[] = [];
        for (const augment of this.loweringAugmenters) {
            for (const attachment of augment(result)) additions.push(attachment);
        }
        for (const attachment of additions) this.addLayoutAttachment(attachment);
        // 进行校验或者其他动作
        for (const finalize of this.loweringFinalizers) finalize(result);
        return result;
    }

    /**
     * 注册不推进时间的排版对象
     * 被 tie、beam、box 等函数使用
     */
    addLayoutAttachment(attachment: LayoutAttachment) {
        this.attachments.push(attachment);
        for (const { group } of this.activeLoweringGroups) {
            group.onAttachment?.(attachment);
        }
    }

    /**
     * 查询 AST 节点在当前 lowering 中产生的所有 temporal 节点
     *
     * 被折叠进别人盒子的成员没有独立的全局位置，统一上溯到宿主，
     * 所以写在成员上的标签等价于写在整个复合节点上。
     */
    getTemporalNodes(ast: ASTNodeBase): readonly TemporalNodeBase[] {
        const nodes = this.astToTemporal.get(ast);
        if (!nodes) return [];
        return nodes.map(node => {
            while (node.foldedInto) node = node.foldedInto;
            return node;
        });
    }

    /**
     * 展开内容，但外层分组看不见它们
     *
     * 复合节点把子树折叠成一个符号时，成员不是外层分组的成员，宿主才是。
     * 否则 voice 的歌词按下标配对时，一个和弦会占掉成员数加一个槽位，
     * 而这些槽位都在同一个 x 上，后面的音符全部对不上歌词。
     */
    isolateFromLoweringGroups<T>(run: () => T): T {
        const outer = this.activeLoweringGroups;
        this.activeLoweringGroups = [];
        try {
            return run();
        } finally {
            this.activeLoweringGroups = outer;
        }
    }

    /**
     * 原地补全 hook: loweringEnter / loweringExit 返回的事件
     */
    private initEvent(
        event: TemporalNodeBase,
        owner: ASTNodeBase,
        timeOffset: number,
        track: Track,
    ) {
        event.t = timeOffset + (event.t ?? 0);
        event.T ??= 0;
        event.track = track;
        event.ast ??= owner;
        event.order = this.cnt++;
        event.type ??= event.T === 0 ? ColType.SINGLE : ColType.DEFAULT;
    }

    /**
     * 递归展开一棵子树，得到它的时间列与结束时间
     * @param timeOffset 当前节点的时间偏移量（单位QN） 由父节点传入
     * @param track 当前所在的纵向音轨
     */
    trackedEvents(
        node: ASTNodeBase,
        timeOffset: number,
        track: Track,
    ): {
        timeOffset: number,
        columns: TimeColumn[]
    } {
        const columns: TimeColumn[] = [];
        timeOffset = this.appendEvents(
            node.loweringEnter(this, track),
            node, timeOffset,
            track, columns,
        );

        // 处理子元素
        const model = node.timeFlowModel();
        if (model) {
            switch (model.mode) {
                case "sequence": {
                    for (const c of model.children) {
                        const result = this.trackedEvents(c, timeOffset, track);
                        timeOffset = result.timeOffset;
                        for (const column of result.columns) columns.push(column);
                    }
                } break;
                case "parallel": {
                    // 具体函数只声明音轨复用方式和纵向排列策略
                    const spec = model.tracks;
                    const children = model.children;
                    const hostIndex = spec.hostIndex === void 0 ? 0 : spec.hostIndex;
                    const group = track.group(
                        spec.laneKey,
                        hostIndex === null ? children.length : children.length - 1,
                        spec.arrange,
                    );

                    const branches: TimeColumn[][] = [];
                    for (let i = 0; i < children.length; i++) {
                        const c = children[i];
                        // 宿主成员就地留在当前轨，其余成员按书写顺序拿分支音轨
                        const branchTrack = i === hostIndex
                            ? track
                            : group.members[hostIndex === null || i < hostIndex ? i : i - 1];
                        // 每个分支从头开始
                        const result = this.trackedEvents(c, timeOffset, branchTrack);
                        if (result.timeOffset <= timeOffset) {
                            this.diagnostics.push(Diagnostic.warning.ZeroTimeTrack(c.sourceSpan, i + 1));
                        }
                        branches.push(result.columns);
                    }
                    // 归并 局部归并以限制对齐作用域
                    for (const column of LoweringContext.anchorAlign(branches)) columns.push(column);
                    const lastCol = columns[columns.length - 1];
                    if (lastCol) timeOffset = lastCol.t + lastCol.reduce((maxT, n) => Math.max(maxT, n.T), 0);
                } break;
            }
        }
        timeOffset = this.appendEvents(
            node.loweringExit(this, track),
            node, timeOffset,
            track, columns,
        );
        return { timeOffset, columns };
    }

    /** 将 hook 返回的事件规范化、加入索引与分组，再追加到时间列 */
    private appendEvents(
        events: Iterable<TemporalNodeBase>,
        owner: ASTNodeBase,
        timeOffset: number,
        track: Track,
        columns: TimeColumn[],
    ): number {
        for (const event of events) {
            this.initEvent(event, owner, timeOffset, track);
            this.indexTemporal(event);
            for (const { group } of this.activeLoweringGroups) {
                group.onTemporal?.(event);
            }
            timeOffset = Math.max(timeOffset, event.t + event.T);
            columns.push(new TimeColumn(event));
        } return timeOffset;
    }

    /** 记录 AST->TemporalNode 的映射 */
    private indexTemporal(node: TemporalNodeBase) {
        const existing = this.astToTemporal.get(node.ast);
        if (existing) existing.push(node);
        else this.astToTemporal.set(node.ast, [node]);
    }

    /**
     * 多轨时间上的 ANCHOR 对齐形成列，被 trackedEvents 在中间使用。会修改时间
     * @param tracks 多个 trackedEvents 的结果
     * @returns 锚点对齐后的 tracks，多轨道相同时间的会被合并为一个列
     */
    static anchorAlign(tracks: TimeColumn[][]): TimeColumn[] {
        // 删去长度为0的轨道
        for (let i = tracks.length - 1; i >= 0; i--) {
            if (tracks[i].length === 0) tracks.splice(i, 1);
        }
        const l = tracks.length;
        if (l === 0) throw new Error("No tracks to align");
        if (l === 1) return tracks[0];

        const result: TimeColumn[] = [];

        if (l === 2) {
            // 归并两个轨道
            const track0 = tracks[0], track1 = tracks[1];
            const l0 = track0.length, l1 = track1.length;
            let i = 0, j = 0;
            let idt = 0, jdt = 0;   // 应用时间偏移一定要紧在 push 前
            let a = track0[0], b = track1[0];
            let t0 = a.t, t1 = b.t;

            while (true) {
                if (a.type === ColType.ANCHOR) {
                    // 等待b也遇到anchor
                    if (b.type !== ColType.ANCHOR) {
                        result.push(b);
                        b = track1[++j];
                        while (j < l1 && b.type !== ColType.ANCHOR) {
                            if (jdt) b.t += jdt;    // setter 比较重，能避免尽量避免
                            result.push(b);
                            b = track1[++j];
                        }
                        if (b) b.t = t1 = b.t + jdt;
                    }
                    if (j < l1) {    // b.type === "anchor"
                        const maxT = Math.max(t0, t1);
                        idt += maxT - t0, jdt += maxT - t1;
                        a.push(...b);
                        a.t = maxT;
                        b = track1[++j];
                    }
                    result.push(a);
                    a = track0[++i];
                    // 准备下一个
                    if (a) a.t = t0 = a.t + idt;
                    if (b) b.t = t1 = b.t + jdt;
                    if (!a || !b) break;
                }
                if (b.type === ColType.ANCHOR) {
                    if (a.type !== ColType.ANCHOR) {
                        result.push(a);
                        a = track0[++i];
                        while (i < l0 && a.type !== ColType.ANCHOR) {
                            if (idt) a.t += idt;
                            result.push(a);
                            a = track0[++i];
                        }
                        if (a) a.t = t0 = a.t + idt;
                    }
                    if (i < l0) {
                        const maxT = Math.max(t0, t1);
                        idt += maxT - t0, jdt += maxT - t1;
                        b.push(...a);
                        b.t = maxT;
                        a = track0[++i];
                    }
                    result.push(b);
                    b = track1[++j];
                    if (a) a.t = t0 = a.t + idt;
                    if (b) b.t = t1 = b.t + jdt;
                    if (!a || !b) break;
                }
                if (Math.abs(t0 - t1) < 1e-6) {
                    if (a.type === ColType.SINGLE) {
                        result.push(a);
                        if (++i < l0) {
                            a = track0[i];
                            a.t = t0 = a.t + idt;
                        } else break;
                    } else if (b.type === ColType.SINGLE) {
                        result.push(b);
                        if (++j < l1) {
                            b = track1[j];
                            b.t = t1 = b.t + jdt;
                        } else break;
                    } else {
                        a.push(...b);
                        result.push(a);
                        a = track0[++i];
                        b = track1[++j];
                        if (a) a.t = t0 = a.t + idt;
                        if (b) b.t = t1 = b.t + jdt;
                        if (!a || !b) break;
                    } continue;
                }
                if (t0 < t1) {
                    result.push(a);
                    if (++i < l0) {
                        a = track0[i];
                        a.t = t0 = a.t + idt;
                        continue;
                    } else break;
                }
                if (t1 < t0) {
                    result.push(b);
                    if (++j < l1) {
                        b = track1[j];
                        b.t = t1 = b.t + jdt;
                        continue;
                    } else break;
                }

            }
            if (a) result.push(a);
            while (++i < l0) {
                a = track0[i];
                if (idt) a.t += idt;
                result.push(a);
            }
            if (b) result.push(b);
            while (++j < l1) {
                b = track1[j];
                if (jdt) b.t += jdt;
                result.push(b);
            }
            return result;
        }

        // 归并多个轨道
        const p = new Uint16Array(l);   // 当前指向第几个
        const dt = new Float64Array(l); // 每个轨道的偏移量
        const anchorBuffer: heapItem[] = [];
        const heap = new HeapSort(l); // 保证每个轨在堆里最多一个
        for (let i = 0; i < l; i++) heap.push({ e: tracks[i][0], i });

        const fetchNext = (i: number) => {
            const e = tracks[i][++p[i]];
            if (e) {
                if (dt[i]) e.t += dt[i];
                heap.push({ e, i });
            }
        }

        while (true) {
            const front = heap.pop() as heapItem | undefined;
            if (front === void 0) {
                if (anchorBuffer.length === 0) break;   // 都完了

                const first = anchorBuffer[0];
                const container = first.e;
                let maxT = container.t;
                for (let j = 1; j < anchorBuffer.length; j++) maxT = Math.max(maxT, anchorBuffer[j].e.t);
                dt[first.i] += maxT - container.t;
                fetchNext(first.i);

                for (let j = 1; j < anchorBuffer.length; j++) {
                    const item = anchorBuffer[j];
                    container.push(...item.e);
                    dt[item.i] += maxT - item.e.t;
                    fetchNext(item.i);
                }
                anchorBuffer.length = 0;
                container.t = maxT;
                container.sort((a, b) => a.order - b.order);    // 保证同一列的顺序和原来一致; 插入顺序和原来的时间有关
                result.push(container);
                continue;
            }
            switch (front.e.type) {
                case ColType.ANCHOR:
                    // 进入缓冲区 不补充本track的下一个元素
                    anchorBuffer.push(front);
                    break;
                case ColType.SINGLE:
                    result.push(front.e);
                    fetchNext(front.i);
                    break;
                default:
                    // 找同时的
                    const minT = front.e.t + 1e-6;  // 避免浮点数误差
                    const consumed = [front.i];
                    while (true) { // heap 的排序保证此时同时刻没有single和anchor
                        const f = heap.front();
                        if (!f || f.e.t > minT) break;  // 所有轨道都处理完了
                        heap.pop();
                        front.e.push(...f.e);
                        consumed.push(f.i);
                    }
                    result.push(front.e);
                    // 最后再加新的，使得只合并每个轨道最前面的，防止把后面同时刻的都合并了
                    // 这也是引入 SINGLE 的原因
                    for (const i of consumed) fetchNext(i);
            }
        } return result;
    }
}

class TimeColumn extends Array<TemporalNodeBase> {
    type: TemporalNodeBase["type"];
    constructor(n: TemporalNodeBase) {
        super(1);
        this.type = n.type;
        this[0] = n;
    }
    get t() {
        return this[0].t;
    }
    set t(value: number) {
        for (const n of this) n.t = value;
    }

    /** 当前列是否携带换行请求 */
    get breakRequested() {
        for (const node of this) {
            if (node.breakBefore > 0) return true;
        } return false;
    }

    /** 将当前列所有事件的行号固化为 lowering 后的实际行号 */
    set layoutLine(value: number) {
        for (const node of this) node.layoutLine = value;
    }
}

interface heapItem {
    e: TimeColumn,
    i: number,  // 轨道索引
}

function heapItemCmp(a: heapItem, b: heapItem) {
    if (a.e.t !== b.e.t) return a.e.t - b.e.t;
    const orderDiff = a.e.type - b.e.type;
    if (orderDiff !== 0) return orderDiff;
    return a.i - b.i;
}
// 最小堆
class HeapSort extends Array<heapItem> {
    validLen: number = 0;
    constructor(n: number) {
        super(n);
    }
    front(): heapItem | undefined {
        if (this.validLen === 0) return void 0;
        return this[0];
    }
    push(item: heapItem) {
        this[this.validLen] = item;
        this.up(this.validLen++);
        return this.validLen;
    }
    pop(): heapItem | undefined {
        if (this.validLen === 0) return void 0;
        const item = this[0];
        this[0] = this[--this.validLen];
        this[this.validLen] = void 0 as any;
        this.down(0);
        return item;
    }
    up(i: number) {
        const item = this[i];
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heapItemCmp(item, this[parent]) >= 0) break;
            this[i] = this[parent];
            i = parent;
        } this[i] = item;
    }
    down(i: number) {
        const item = this[i];
        while (true) {
            let left = (i << 1) + 1;
            let right = left + 1;
            if (left >= this.validLen) break;
            let minChild = left;
            if (right < this.validLen && heapItemCmp(this[right], this[left]) < 0) minChild = right;
            if (heapItemCmp(this[minChild], item) >= 0) break;
            this[i] = this[minChild];
            i = minChild;
        } this[i] = item;
    }
}