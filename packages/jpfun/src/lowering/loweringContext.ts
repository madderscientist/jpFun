import { Diagnostic } from "../diagnostic.js";
import { Fraction } from "../fraction.js";
import { ASTFunctionClass, ASTNodeBase } from "../functions/ASTtypes.js";
import type { PageConfig } from "../layout/types.js";
import {
    ANCHOR_KEY,
    TemporalNodeBase,
    type LoweringAugmenter,
    type LoweringFinalizer,
    type LoweringGroup,
    type LoweringAttachment,
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
 * - [API] LoweringContext.addAttachment：注册不推进时间的附属对象；当前外层分组会收到该对象
 * - [config] timeFlowModel：声明子节点按 sequence 或 parallel 推进时间；parallel 还要声明音轨复用键与纵向排列策略
 * - [hook] Temporal.onTimeState：锚点归并后固化调性、速度等状态
 * - [hook] loweringAugment：最终列和 layoutLine 固化后扫描结果并生成要追加的 attachment
 * - [hook] loweringFinalize：所有派生 attachment 追加完成后，按注册顺序处理完整结果
 */
export class LoweringContext {
    private loweringAugmenters: LoweringAugmenter[] = [];
    private loweringFinalizers: LoweringFinalizer[] = [];
    private cnt = 0;  // 生成唯一id的计数器

    /** 不推进时间的附属对象 */
    private attachments: LoweringAttachment[] = [];

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
    readonly diagnostics: Diagnostic[];

    constructor(diagnostics: Diagnostic[] = []) {
        this.diagnostics = diagnostics;
    }

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
        const duration = new Fraction();
        const columns = this.trackedEvents(node, duration, rootTrack);
        this.solidifyColumns(columns);
        return this.postprocessResult({
            diagnostics: this.diagnostics,
            columns,
            attachments: this.attachments,
            astToTemporal: this.astToTemporal,
            duration,
            rootTrack,
            page: this.page,
        });
    }

    /**
     * 固化谱面行号并进行时间状态固化
     */
    private solidifyColumns(columns: TimeColumn[]) {
        // 同时刻跨轨的 br 已经合成一列，所以取最大；同轨连写仍是多个列，因而累加
        let line = 0;
        for (const column of columns) {
            let offset = 0;
            for (const node of column) {
                if (node.breakBefore > offset) offset = node.breakBefore;
            }
            line += offset;
            // 换行列本身归属于换行之后的那一行
            column.layoutLine = line;
        }

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
    endLoweringGroup(owner: ASTNodeBase): LoweringGroup {
        const active = this.activeLoweringGroups.pop();
        if (!active) throw new Error("No active lowering group to end");
        if (active.owner !== owner) throw new Error("Lowering groups must end in reverse order");
        if (active.group.attachment) this.addAttachment(active.group.attachment);
        return active.group;
    }

    /** 先统一生成派生 attachment，再按注册顺序执行最终处理 */
    private postprocessResult(result: LoweringResult): LoweringResult {
        if (this.activeLoweringGroups.length > 0)
            throw new Error("Lowering groups must be closed before post-processing");

        const additions: LoweringAttachment[] = [];
        for (const augment of this.loweringAugmenters) {
            for (const attachment of augment(result)) additions.push(attachment);
        }
        for (const attachment of additions) this.addAttachment(attachment);
        // 进行校验或者其他动作
        for (const finalize of this.loweringFinalizers) finalize(result);
        return result;
    }

    /**
     * 注册不推进时间的排版对象
     * 被 tie、beam、box 等函数使用
     */
    addAttachment(attachment: LoweringAttachment) {
        this.attachments.push(attachment);
        // 由内向外分组，符合嵌套作用域语义
        for (let i = this.activeLoweringGroups.length - 1; i >= 0; i--) {
            this.activeLoweringGroups[i].group.onAttachment?.(attachment);
        }
    }

    /** 查询 AST 自己产生的 temporal；是否沿 foldedInto 投影由调用者决定 */
    getTemporalNodes(ast: ASTNodeBase): readonly TemporalNodeBase[] {
        return this.astToTemporal.get(ast) ?? [];
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
        timeOffset: Fraction,
        track: Track,
    ) {
        event.t.add(timeOffset);
        event.track = track;
        event.ast ??= owner;
        event.order = this.cnt++;
        event.mergeKey ??= event.order; // 默认为独立成列，用 order 保证唯一性
    }

    /**
     * 递归展开一棵子树，得到它的时间列与结束时间
     * @param timeOffset 当前节点的时间偏移量（单位QN） 由父节点传入，会被原地修改
     * @param track 当前所在的纵向音轨
     */
    trackedEvents(
        node: ASTNodeBase,
        timeOffset: Fraction,
        track: Track,
    ): TimeColumn[] {
        const columns: TimeColumn[] = [];
        this.appendEvents(
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
                        for (const column of this.trackedEvents(c, timeOffset, track)) columns.push(column);
                    }
                } break;
                case "parallel": {
                    // 具体函数只声明音轨复用方式和纵向排列策略
                    const spec = model.tracks;
                    const children = model.children;
                    const hostIndex = spec.hostIndex === void 0 ? 0 : spec.hostIndex;
                    const group = track.group(
                        spec,
                        hostIndex === null ? children.length : children.length - 1,
                    );

                    const branches: TimeColumn[][] = [];
                    for (let i = 0; i < children.length; i++) {
                        const c = children[i];
                        // 宿主成员就地留在当前轨，其余成员按书写顺序拿分支音轨
                        const branchTrack = i === hostIndex
                            ? track
                            : group.members[hostIndex === null || i < hostIndex ? i : i - 1];
                        // 每个分支从头开始
                        const branchTime = timeOffset.clone();
                        const branch = this.trackedEvents(c, branchTime, branchTrack);
                        if (branch.length === 0) {
                            this.diagnostics.push(Diagnostic.warning.ZeroTimeTrack(c.sourceSpan, i + 1));
                        }
                        branches.push(branch);
                    }
                    // 归并 局部归并以限制对齐作用域
                    for (const column of LoweringContext.anchorAlign(branches)) columns.push(column);
                    const lastCol = columns[columns.length - 1];
                    if (lastCol) {
                        let maxDuration = lastCol[0].T;
                        for (let i = 1; i < lastCol.length; i++) {
                            if (lastCol[i].T.compare(maxDuration) > 0) maxDuration = lastCol[i].T;
                        }
                        timeOffset.copyFrom(lastCol.t).add(maxDuration);
                    }
                } break;
            }
        }
        this.appendEvents(
            node.loweringExit(this, track, timeOffset),
            node, timeOffset,
            track, columns,
        );
        return columns;
    }

    /**
     * 将 hook 返回的事件规范化、加入索引与分组，再追加到时间列
     * 原地修改 timeOffset
     */
    private appendEvents(
        events: Iterable<TemporalNodeBase>,
        owner: ASTNodeBase,
        timeOffset: Fraction,
        track: Track,
        columns: TimeColumn[],
    ) {
        // 由于大部分时候不会有事件，所以延迟创建
        let eventEnd: Fraction | undefined;
        for (const event of events) {
            this.initEvent(event, owner, timeOffset, track);
            this.indexTemporal(event);
            for (let i = this.activeLoweringGroups.length - 1; i >= 0; i--) {
                this.activeLoweringGroups[i].group.onTemporal?.(event);
            }
            const end = (eventEnd ??= new Fraction()).copyFrom(event.t).add(event.T);
            if (end.compare(timeOffset) > 0) timeOffset.copyFrom(end);
            columns.push(new TimeColumn(event));
        }
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
            const idt = new Fraction(), jdt = new Fraction(); // 应用时间偏移一定要紧在 push 前
            let a = track0[0], b = track1[0];
            const t0 = a.t.clone(), t1 = b.t.clone();

            while (true) {
                if (a.mergeKey === ANCHOR_KEY) {
                    // 等待b也遇到anchor
                    if (b.mergeKey !== ANCHOR_KEY) {
                        result.push(b);
                        b = track1[++j];
                        while (j < l1 && b.mergeKey !== ANCHOR_KEY) {
                            if (!jdt.isZero()) b.shiftTime(jdt);
                            result.push(b);
                            b = track1[++j];
                        }
                        if (b) {
                            b.shiftTime(jdt);
                            t1.copyFrom(b.t);
                        }
                    }
                    if (j < l1) {    // b 也是 anchor
                        const maxT = t0.compare(t1) >= 0 ? t0 : t1;
                        idt.add(maxT).sub(t0);
                        jdt.add(maxT).sub(t1);
                        a.push(...b);
                        a.t = maxT;
                        b = track1[++j];
                    }
                    result.push(a);
                    a = track0[++i];
                    // 准备下一个
                    if (a) {
                        a.shiftTime(idt);
                        t0.copyFrom(a.t);
                    }
                    if (b) {
                        b.shiftTime(jdt);
                        t1.copyFrom(b.t);
                    }
                    if (!a || !b) break;
                }
                if (b.mergeKey === ANCHOR_KEY) {
                    if (a.mergeKey !== ANCHOR_KEY) {
                        result.push(a);
                        a = track0[++i];
                        while (i < l0 && a.mergeKey !== ANCHOR_KEY) {
                            if (!idt.isZero()) a.shiftTime(idt);
                            result.push(a);
                            a = track0[++i];
                        }
                        if (a) {
                            a.shiftTime(idt);
                            t0.copyFrom(a.t);
                        }
                    }
                    if (i < l0) {
                        const maxT = t0.compare(t1) >= 0 ? t0 : t1;
                        idt.add(maxT).sub(t0);
                        jdt.add(maxT).sub(t1);
                        b.push(...a);
                        b.t = maxT;
                        a = track0[++i];
                    }
                    result.push(b);
                    b = track1[++j];
                    if (a) {
                        a.shiftTime(idt);
                        t0.copyFrom(a.t);
                    }
                    if (b) {
                        b.shiftTime(jdt);
                        t1.copyFrom(b.t);
                    }
                    if (!a || !b) break;
                }
                if (t0.equals(t1)) {
                    if (a.mergeKey === b.mergeKey) {
                        a.push(...b);
                        result.push(a);
                        a = track0[++i];
                        b = track1[++j];
                        if (a) {
                            a.shiftTime(idt);
                            t0.copyFrom(a.t);
                        }
                        if (b) {
                            b.shiftTime(jdt);
                            t1.copyFrom(b.t);
                        }
                        if (!a || !b) break;
                    } else if (a.mergeKey < b.mergeKey) {
                        result.push(a);
                        a = track0[++i];
                        if (a) {
                            a.shiftTime(idt);
                            t0.copyFrom(a.t);
                        } else break;
                    } else {
                        result.push(b);
                        b = track1[++j];
                        if (b) {
                            b.shiftTime(jdt);
                            t1.copyFrom(b.t);
                        } else break;
                    } continue;
                }
                if (t0.compare(t1) < 0) {
                    result.push(a);
                    a = track0[++i];
                    if (a) {
                        a.shiftTime(idt);
                        t0.copyFrom(a.t);
                        continue;
                    } else break;
                }
                if (t1.compare(t0) < 0) {
                    result.push(b);
                    b = track1[++j];
                    if (b) {
                        b.shiftTime(jdt);
                        t1.copyFrom(b.t);
                        continue;
                    } else break;
                }

            }
            if (a) result.push(a);
            while (++i < l0) {
                a = track0[i];
                if (!idt.isZero()) a.shiftTime(idt);
                result.push(a);
            }
            if (b) result.push(b);
            while (++j < l1) {
                b = track1[j];
                if (!jdt.isZero()) b.shiftTime(jdt);
                result.push(b);
            }
            return result;
        }

        // 归并多个轨道
        const p = new Uint16Array(l);   // 当前指向第几个
        const dt = Array.from({ length: l }, () => new Fraction()); // 每个轨道的偏移量
        const anchorBuffer: heapItem[] = [];
        const heap = new HeapSort(l); // 保证每个轨在堆里最多一个
        for (let i = 0; i < l; i++) heap.push({ e: tracks[i][0], i });

        const fetchNext = (i: number) => {
            const e = tracks[i][++p[i]];
            if (e) {
                if (!dt[i].isZero()) e.shiftTime(dt[i]);
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
                for (let j = 1; j < anchorBuffer.length; j++) {
                    if (anchorBuffer[j].e.t.compare(maxT) > 0) maxT = anchorBuffer[j].e.t;
                }
                dt[first.i].add(maxT).sub(container.t);
                fetchNext(first.i);

                for (let j = 1; j < anchorBuffer.length; j++) {
                    const item = anchorBuffer[j];
                    container.push(...item.e);
                    dt[item.i].add(maxT).sub(item.e.t);
                    fetchNext(item.i);
                }
                anchorBuffer.length = 0;
                container.t = maxT;
                container.sort((a, b) => a.order - b.order);    // 保证同一列的顺序和原来一致; 插入顺序和原来的时间有关
                result.push(container);
                continue;
            }
            if (front.e.mergeKey === ANCHOR_KEY) {
                // 进入缓冲区 不补充本track的下一个元素
                anchorBuffer.push(front);
                continue;
            }
            // 找同时刻的同组
            const consumed = [front.i];
            while (true) {
                const f = heap.front();
                // 堆序保证同组相邻，遇到别的组即说明本组已取完
                if (!f || !f.e.t.equals(front.e.t) || f.e.mergeKey !== front.e.mergeKey) break;
                heap.pop();
                front.e.push(...f.e);
                consumed.push(f.i);
            }
            result.push(front.e);
            // 最后再加新的，使得只合并每个轨道最前面的，防止把后面同时刻的都合并了
            for (const i of consumed) fetchNext(i);
        } return result;
    }
}

class TimeColumn extends Array<TemporalNodeBase> {
    readonly mergeKey: number;
    constructor(n: TemporalNodeBase) {
        super(1);
        this.mergeKey = n.mergeKey;
        this[0] = n;
    }
    get t() {
        return this[0].t;
    }
    set t(value: Fraction) {
        for (const node of this) node.t.copyFrom(value);
    }

    shiftTime(offset: Fraction) {
        for (const node of this) node.t.add(offset);
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
    const timeOrder = a.e.t.compare(b.e.t);
    if (timeOrder !== 0) return timeOrder;
    // 有无穷所以不能直接减
    if (a.e.mergeKey !== b.e.mergeKey) return a.e.mergeKey < b.e.mergeKey ? -1 : 1;
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