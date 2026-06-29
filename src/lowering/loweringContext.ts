import { ASTFunctionClass, ASTNodeBase } from "../functions/ASTtypes.js";
import { ColType, TemporalNodeRecord } from "./types.js";

export type TimeWrapFunc = (vars: Record<string, any>, dt: number) => number;
export type TimeWrapConfig = {
    priority: number;  // 优先级 越大越后执行
    func: TimeWrapFunc;
}

/**
 * AST 节点返回的类型，算法需要补全其他属性
 * 这里 track 表示相对偏移，只能是正整数
 */
export type tmpTemporalNodeRecord = Partial<TemporalNodeRecord> & { track?: number };

export class LoweringContext {
    private timeWrapFuncs: TimeWrapFunc[] = [];
    private cnt = 0;  // 生成唯一id的计数器

    registerTimeWrapFunc(functionClasses: ASTFunctionClass[]) {
        const configs: TimeWrapConfig[] = [];
        for (const cls of functionClasses) {
            const cfg = (cls as unknown as typeof ASTNodeBase).timeWrapConfig;
            if (cfg) configs.push(cfg);
        }
        // 按优先级排序
        configs.sort((a, b) => b.priority - a.priority);
        // 提取时间变换函数
        this.timeWrapFuncs = configs.map(config => config.func);
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

    static getTrackId(base: string, newOffset?: number): string {
        if (newOffset === void 0 || newOffset === 0) return base;
        if (newOffset < 0) throw new Error(`Track offset must be non-negative, got ${newOffset}`);
        return base + String.fromCharCode(newOffset);
    }

    lowering(node: ASTNodeBase) {
        // 获取时间列
        const { columns } = this.trackedEvents(node);
        // 时间固化
        const vars: Record<string, any> = {};
        for (const col of columns) {
            for (const n of col) {
                node.onTimeState?.(vars, n);
            }
        }
        return columns;
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
    trackedEvents(
        node: ASTNodeBase,
        vars: Record<string, any> = {},
        timeOffset: number = 0,
        track: string = String.fromCharCode(0),
    ): {
        timeOffset: number,
        columns: TimeColumn[]
    } {
        const columns: TimeColumn[] = [];
        // 如果是叶节点，可以在这里处理
        const beforeEvents = node.loweringEnter(this, vars);
        for (const b of beforeEvents) {
            // 直接修改，防止引用关系改变
            // 比如允许 addon 中存储对象供后续使用
            b.t = timeOffset + (b.t ?? 0);
            b.T = b.T === void 0 ? 0 : this.applyTimeWrap(vars, b.T);
            (b as TemporalNodeRecord).track = LoweringContext.getTrackId(track, b.track);
            b.ast = b.ast ?? node;
            b.order = this.cnt++;
            b.addon = b.addon ?? {};
            Object.assign(b.addon, vars);   // 存储如 div dot 个数这种
            b.type ??= b.T === 0 ? ColType.SINGLE : ColType.DEFAULT;    // T=0 一般也不会绘制，放在前面
            timeOffset = Math.max(timeOffset, b.t + b.T);
            columns.push(new TimeColumn(b as TemporalNodeRecord));
        }
        // 处理子元素
        const model = node.timeFlowModel();
        if (model) {
            switch (model.mode) {
                case "sequence": {
                    for (const c of model.children) {
                        const result = this.trackedEvents(c, vars, timeOffset, track);
                        timeOffset = result.timeOffset;
                        columns.push(...result.columns);
                    }
                } break;
                case "parallel": {
                    let endTime = timeOffset;
                    const cols = [];
                    for (let i = 0; i < model.children.length; i++) {
                        const c = model.children[i];
                        const trackId = LoweringContext.getTrackId(track, i);
                        // 每个分支从头开始
                        const result = this.trackedEvents(c, vars, timeOffset, trackId);
                        endTime = Math.max(endTime, result.timeOffset);
                        cols.push(result.columns);
                    }
                    // 归并 局部归并以限制对齐作用域
                    columns.push(...LoweringContext.anchorAlign(cols));
                    timeOffset = endTime;
                } break;
            }
        }
        // 如果是叶节点，可以在这里处理
        const afterEvents = node.loweringExit(this, vars);
        for (const b of afterEvents) {
            b.t = timeOffset + (b.t ?? 0);
            b.T = b.T === void 0 ? 0 : this.applyTimeWrap(vars, b.T);
            (b as TemporalNodeRecord).track = LoweringContext.getTrackId(track, b.track);
            b.ast = b.ast ?? node;
            b.order = this.cnt++;
            b.addon = b.addon ?? {};
            Object.assign(b.addon, vars);
            b.type ??= b.T === 0 ? ColType.SINGLE : ColType.DEFAULT;
            timeOffset = Math.max(timeOffset, b.t + b.T);
            columns.push(new TimeColumn(b as TemporalNodeRecord));
        }
        return { timeOffset, columns };
    }

    /**
     * 多轨时间上的 ANCHOR 对齐形成列，被 trackedEvents 在中间使用。会修改时间
     * @param tracks 多个 trackedEvents 的结果
     * @returns 锚点对齐后的 tracks，多轨道相同时间的会被合并为一个列
     */
    static anchorAlign(tracks: TimeColumn[][]): TimeColumn[] {
        const l = tracks.length;
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
                    break;
            }
        } return result;
    }
}

class TimeColumn extends Array<TemporalNodeRecord> {
    type: TemporalNodeRecord["type"];
    constructor(n: TemporalNodeRecord) {
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
        }
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
        }
    }
}