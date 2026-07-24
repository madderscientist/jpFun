import { Diagnostic } from "../diagnostic.js";
import { ASTFunctionClass, ASTNodeBase } from "../functions/ASTtypes.js";
import type {
    LayoutAttachment,
    LayoutBox,
    PageConfig,
} from "../layout/types.js";
import {
    ColType,
    TemporalNodeBase,
    TimeWrapFunc,
    TimeWrapConfig,
    type LoweringFinalizer,
    type LoweringResult,
} from "./types.js";

interface ActiveLayoutGroup {
    owner: ASTNodeBase;                  // 用于验证分组严格按栈顺序结束
    attachment: LayoutAttachment;        // 分组结束后注册的附属布局对象
    boxes?: LayoutBox[];                 // box 等范围对象需要的成员盒 包括 attachment 的盒子
    temporals?: TemporalNodeBase[];      // voice/div 等关系对象需要的成员事件
}

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
 * - [hook] loweringEnter/loweringExit：进入或离开节点时修改 vars、生成 TemporalNode
 * - [API] LoweringContext.beginLayoutGroup/endLayoutGroup：通常在 enter/exit 中被调用，以栈方式收集当前子树产生的 box、TemporalNode 和嵌套 attachment；供 box、voice 使用
 * - [API] LoweringContext.addLayoutAttachment：注册不推进时间的独立排版对象，供 tie、beam 等函数使用；若当前位于分组中，其 box 也会加入外层分组
 * - [config] timeWrapConfig：注册 div、dot 等时长变换；被 LoweringContext 调用
 * - [config] timeFlowModel：声明子节点按 sequence 或 parallel 推进时间
 * - [hook] Temporal.onTimeState：锚点归并后固化调性、速度等状态
 * - [hook] loweringFinalize：最终列和 layoutLine 固化后扫描结果并生成要追加的 attachment
 */
export class LoweringContext {
    private timeWrapFuncs: TimeWrapFunc[] = [];
    private loweringFinalizers: LoweringFinalizer[] = [];
    private cnt = 0;  // 生成唯一id的计数器

    /** 不推进时间的关系对象和分组对象 */
    private attachments: LayoutAttachment[] = [];

    /** 当前完整文档的页面配置；fragment 会暂时隔离 */
    private page?: PageConfig;

    /**
     * 一个 AST 节点可能不产生 temporal，也可能产生多个 temporal
     * 不包含子节点的 TemporalNode
     */
    private astToTemporal = new Map<ASTNodeBase, TemporalNodeBase[]>();

    /**
     * 当前递归路径上正在收集成员的分组，用 beginLayoutGroup 和 endLayoutGroup 管理
     * 被 box 和 voice 等函数使用
     */
    private activeLayoutGroups: ActiveLayoutGroup[] = [];


    /** 供外部调用: 初始化 hook */
    registerFunctions(functionClasses: ASTFunctionClass[]) {
        const configs: TimeWrapConfig[] = [];
        const finalizers: LoweringFinalizer[] = this.loweringFinalizers = [];
        for (const cls of functionClasses) {
            const functionClass = cls as unknown as typeof ASTNodeBase;
            const cfg = functionClass.timeWrapConfig;
            if (cfg) configs.push(cfg);
            if (functionClass.loweringFinalize) finalizers.push(functionClass.loweringFinalize);
        }
        // 按优先级排序
        configs.sort((a, b) => b.priority - a.priority);
        // 提取时间变换函数
        this.timeWrapFuncs = configs.map(config => config.func);
    }

    /** 供 page 函数调用 */
    setPageConfig(page: PageConfig) {
        this.page = page;
    }

    /**
     * 调用注册的时间变换函数
     * @param vars 环境变量
     * @param dt 要变换的时长
     */
    applyTimeWrap(vars: Record<string, any>, dt: number): number {
        for (const func of this.timeWrapFuncs) {
            dt = func(vars, dt);
        } return dt;
    }

    static getTrackId(base: string, newOffset?: number | string): string {
        if (newOffset === void 0 || newOffset === 0) return base;
        if (typeof newOffset === "string") return base + newOffset;
        if (newOffset < 0) throw new Error(`Track offset must be non-negative, got ${newOffset}`);
        return base + String.fromCharCode(newOffset);
    }

    /**
     * 以 @ 开头的属性会被认为要加入子节点中
     * 命名规则：@${函数名}
     * 后续 layout 用同样的规则查询 handler 来消费该属性
     */
    private static attachDecoration(vars: Record<string, any>, addon?: Record<string, any>) {
        let result = addon;
        // 只在发现需要快照的 @ 字段时创建 addon
        for (const key in vars) {
            if (key[0] !== "@" || vars[key] === void 0) continue;
            (result ??= {})[key] = vars[key];
        } return result;
    }

    /**
     * 完整 lowering 入口
     *
     * 每次调用都会重置本轮产生的数据
     * 已注册的时间变换函数会保留，可以复用同一个 LoweringContext
     */
    lowerDocument(node: ASTNodeBase): LoweringResult {
        this.cnt = 0;
        this.attachments = [];
        this.page = undefined;
        this.astToTemporal = new Map();
        this.activeLayoutGroups = [];

        const { columns, timeOffset } = this.trackedEvents(node);
        this.solidifyColumns(columns, {});
        return this.finalizeResult({
            columns,
            attachments: this.attachments,
            astToTemporal: this.astToTemporal,
            duration: timeOffset,
            page: this.page,
        });
    }

    /**
     * 为 over 等复合节点执行隔离的局部 lowering
     *
     * 局部事件继续写入共享的 AST 映射，关系函数仍能找到它们
    * 局部 attachment 和分组不会进入全局列表，避免被全局 layout 重复处理
     * 本方法不执行 onTimeState，复合节点会在自己的时间点传入外层状态快照
     */
    lowerFragment(
        node: ASTNodeBase,
        vars: Record<string, any> = {},
    ): LoweringResult {
        const outerAttachments = this.attachments;
        const outerGroups = this.activeLayoutGroups;
        const outerPage = this.page;
        this.attachments = [];
        this.activeLayoutGroups = [];
        this.page = undefined;

        try {
            const { columns, timeOffset } = this.trackedEvents(node, vars, 0, String.fromCharCode(0));
            // 局部 fragment 不固化时间状态，但需要从 0 开始固化相对行号
            this.solidifyColumns(columns);
            return this.finalizeResult({
                columns,
                attachments: this.attachments,
                astToTemporal: this.astToTemporal,
                duration: timeOffset,
                page: this.page,
            });
        } finally {
            this.attachments = outerAttachments;
            this.activeLayoutGroups = outerGroups;
            this.page = outerPage;
        }
    }

    /**
     * 把 TimeColumn 中的临时偏移转换为实际行号，并进行时间固化
     * state 仅在完整文档 lowering 时传入，局部 fragment 会跳过 onTimeState
     */
    private solidifyColumns(columns: TimeColumn[], state?: Record<string, any>) {
        let line = 0;
        for (const column of columns) {
            const offset = column.maxLineOffset;
            line += offset;
            column.layoutLine = line;
            if (state) {
                for (const node of column) node.onTimeState?.(state);
            }
        }
    }

    /**
     * 开始收集一个分组作用域
     * boxes 和 temporals 均按辅助对象需求可选，避免创建无用成员数组
     */
    beginLayoutGroup(
        owner: ASTNodeBase,
        attachment: LayoutAttachment,
        boxes?: LayoutBox[],
        temporals?: TemporalNodeBase[],
    ) {
        this.activeLayoutGroups.push({ owner, attachment, boxes, temporals });
    }

    /**
     * 结束最近的分组并注册其辅助排版对象
     * 嵌套分组按退出顺序注册，因此天然是由内向外计算边界
     */
    endLayoutGroup(owner: ASTNodeBase) {
        const group = this.activeLayoutGroups.pop();
        if (!group) throw new Error("No active layout group to end");
        if (group.owner !== owner) throw new Error("Layout groups must end in reverse order");
        this.addLayoutAttachment(group.attachment);
    }

    /** 函数自行解释固化后的事件流，LoweringContext 不识别具体关系规则 */
    private finalizeResult(result: LoweringResult): LoweringResult {
        for (const finalize of this.loweringFinalizers) {
            for (const attachment of finalize(result)) this.addLayoutAttachment(attachment);
        } return result;
    }

    /**
     * 注册不推进时间的排版对象
     * 被 tie、beam、box 等函数使用
     */
    addLayoutAttachment(attachment: LayoutAttachment) {
        this.attachments.push(attachment);
        for (const group of this.activeLayoutGroups) {
            group.boxes?.push(attachment.box);
        }
    }

    /**
     * 查询 AST 节点在当前 lowering 中产生的所有 temporal 节点
     */
    getTemporalNodes(ast: ASTNodeBase): readonly TemporalNodeBase[] {
        return this.astToTemporal.get(ast) ?? [];
    }

    /**
     * 获取时间列 用于时间固化和计算布局
     * @param node 需要 timeFlowMode 方法
     * @param tracks_events 每个轨的所有事件
     * @param vars 存储如 div dot 这种时间变换方法
     * @param timeOffset 当前节点的时间偏移量（单位QN） 由父节点传入
     * @param track 父轨道的id
     * @returns 时间偏移,列
     */
    private trackedEvents(
        node: ASTNodeBase,
        vars: Record<string, any> = {},
        timeOffset: number = 0,
        track: string = String.fromCharCode(0),
    ): {
        timeOffset: number,
        columns: TimeColumn[]
    } {
        const columns: TimeColumn[] = [];
        timeOffset = this.appendEvents(
            node.loweringEnter(vars, this),
            node, vars, timeOffset,
            track, columns,
        );

        // 处理子元素
        const model = node.timeFlowModel();
        if (model) {
            switch (model.mode) {
                case "sequence": {
                    for (const c of model.children) {
                        const result = this.trackedEvents(c, vars, timeOffset, track);
                        timeOffset = result.timeOffset;
                        for (const column of result.columns) columns.push(column);
                    }
                } break;
                case "parallel": {
                    const cols = [];
                    for (let i = 0; i < model.children.length; i++) {
                        const c = model.children[i];
                        const trackId = LoweringContext.getTrackId(track, i);
                        // 每个分支从头开始
                        const result = this.trackedEvents(c, vars, timeOffset, trackId);
                        cols.push(result.columns);
                    }
                    // 归并 局部归并以限制对齐作用域
                    for (const column of LoweringContext.anchorAlign(cols)) columns.push(column);
                    const lastCol = columns[columns.length - 1];
                    if (lastCol) timeOffset = lastCol.t + lastCol.reduce((maxT, n) => Math.max(maxT, n.T), 0);
                } break;
            }
        }
        timeOffset = this.appendEvents(
            node.loweringExit(vars, this),
            node, vars, timeOffset,
            track, columns,
        );
        return { timeOffset, columns };
    }

    /**
     * 将 hook 返回的事件规范化并追加到时间列
     * enter 和 exit 必须共享完全相同的初始化顺序
     */
    private appendEvents(
        events: Iterable<TemporalNodeBase>,
        owner: ASTNodeBase,
        vars: Record<string, any>,
        timeOffset: number,
        track: string,
        columns: TimeColumn[],
    ): number {
        for (const event of events) {
            // 原地补全字段，保留 addon 内部对象的引用关系
            event.t = timeOffset + (event.t ?? 0);
            event.T = event.T === void 0 ? 0 : this.applyTimeWrap(vars, event.T);
            event.track = LoweringContext.getTrackId(track, event.track);
            event.ast = event.ast ?? owner;
            event.order = this.cnt++;
            event.addon = LoweringContext.attachDecoration(vars, event.addon);
            event.type ??= event.T === 0 ? ColType.SINGLE : ColType.DEFAULT;

            this.registerTemporal(event);
            timeOffset = Math.max(timeOffset, event.t + event.T);
            columns.push(new TimeColumn(event));
        } return timeOffset;
    }

    /**
     * 记录事件来源并把它加入当前所有分组
     * 同一个对象只会在创建时经过这里一次
     */
    private registerTemporal(node: TemporalNodeBase) {
        // 记录 AST->TemporalNode 的映射
        const existing = this.astToTemporal.get(node.ast);
        if (existing) existing.push(node);
        else this.astToTemporal.set(node.ast, [node]);

        // 加入当前正在收集的分组
        for (const group of this.activeLayoutGroups) {
            if (node.box) group.boxes?.push(node.box);
            group.temporals?.push(node);
        }
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
            switch(front.e.type) {
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

    /** 当前列开始前的最大临时行偏移 */
    get maxLineOffset() {
        let offset = 0;
        for (const node of this) offset = Math.max(offset, node.layoutLine);
        return offset;
    }

    /** 将当前列所有事件的临时偏移覆盖为 lowering 后的实际行号 */
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