import { WarningDiagnostic } from "../diagnostic.js";
import type { LoweringResult, TemporalNodeBase } from "../lowering/types.js";
import type { PlaybackCursor, PlaybackFlow, PlaybackFlowHook } from "./types.js";

/**
 * 按控制流声明展开出实际访问的列顺序
 *
 * 核心只维护游标、到达次数和标记表，跳转规则全部由函数在自己的 `playbackFlow` 里写：
 * 反复线找最近的段起点标记，房子按段起点被访问过几次决定本遍演不演。
 */
function linearizeColumns(lowering: LoweringResult, diagnostics: WarningDiagnostic[]) {
    const columns = lowering.columns;
    const columnOf = new Map<TemporalNodeBase, number>();
    // 先建立时间流内的 TemporalNode 的列索引
    for (let index = 0; index < columns.length; index++) {
        for (const node of columns[index]) columnOf.set(node, index);
    }
    // 再建立折叠元素的列索引，用此函数实现
    const resolveColumn = (node: TemporalNodeBase) => {
        for (let at: TemporalNodeBase | undefined = node; at; at = at.foldedInto) {
            const index = columnOf.get(at);
            if (index !== void 0) return index;
        } return void 0;
    };

    // 收集流的控制信息
    const marked = new Map<string, number[]>(); // 用于查询最近的标签的列
    const hooks: PlaybackFlowHook[] = [];
    const addHook = (owner: Partial<PlaybackFlow>) => {
        const hook = owner.playbackFlow?.(resolveColumn);
        if (hook) hooks.push(hook);
    };
    // 走 astToTemporal 而不是 columns，折叠成员才不会被漏掉
    for (const nodes of lowering.astToTemporal.values() as MapIterator<(TemporalNodeBase & Partial<PlaybackFlow>)[]>) {
        for (const node of nodes) {
            addHook(node);
            const marks = node.playbackMarks?.();
            if (!marks) continue;
            const at = resolveColumn(node);
            if (at === void 0) continue;
            for (const mark of marks) {
                const list = marked.get(mark);
                if (list) list.push(at);
                else marked.set(mark, [at]);
            }
        }
    }
    for (const attach of lowering.attachments as Iterable<Partial<PlaybackFlow>>) addHook(attach);
    // 如果没有任何控制流声明，直接按列顺序播放
    if (hooks.length === 0) return columns.map((_, index) => index);

    for (const list of marked.values()) list.sort((a, b) => a - b);
    // 每个位置有哪些 hook。主要因为跳房子是 attachment 还有覆盖范围
    const hooksByColumn = new Map<number, PlaybackFlowHook[]>();
    for (const hook of hooks) {
        const [from, to] = hook.range ?? [0, columns.length - 1];
        for (let at = from; at <= to; at++) {
            const list = hooksByColumn.get(at);
            if (list) list.push(hook);
            else hooksByColumn.set(at, [hook]);
        }
    }
    const visits = new Array<number>(columns.length).fill(0);
    let index = 0;
    const cursor: PlaybackCursor = {
        get column() { return index; },
        visits: column => visits[column] ?? 0,
        seek(mark, from, direction) {
            const list = marked.get(mark);
            if (!list) return undefined;
            if (direction > 0) return list.find(column => column > from);
            for (let i = list.length - 1; i >= 0; i--) if (list[i] < from) return list[i];
            return undefined;
        },
    };

    const order: number[] = []; // 记录最终的播放顺序
    const MAX_FLOW_STEPS = 1 << 16;
    let steps = 0;  // 防死循环
    let ended = false;  // stop 或步数上限；提前结束时后面的列不算“没演到”
    flow: while (index < columns.length) {
        if (++steps > MAX_FLOW_STEPS) {
            diagnostics.push(new WarningDiagnostic(
                "W_PLAYBACK_FLOW_OVERFLOW",
                "播放控制流互相跳转，展开到达上限后停止",
                columns[index][0].ast.sourceSpan,
            ));
            ended = true;
            break;
        }
        visits[index]++;
        let jumpTo: number | undefined;
        for (const hook of hooksByColumn.get(index) ?? []) {
            const action = hook.run(cursor);
            if (!action) continue;
            if (action.kind === "stop") { ended = true; break flow; }
            // 取最小的跳转目标到最前面
            jumpTo = Math.min(jumpTo ?? Infinity, action.column);
        }
        if (jumpTo !== undefined) index = jumpTo;
        else {  // 没有 hook 走这个分支
            order.push(index);
            index++;
        }
    }
    // 正常走到文末才报告从未演奏的列；连续缺失区间只报第一列
    if (!ended) {
        const played = new Set(order);
        let previousMissing = false;
        for (let index = 0; index < columns.length; index++) {
            const missing = !played.has(index);
            if (missing && !previousMissing) {
                diagnostics.push(new WarningDiagnostic(
                    "W_PLAYBACK_COLUMN_NEVER_PLAYED",
                    "这里在任何一遍里都不会演奏",
                    columns[index][0].ast.sourceSpan,
                ));
            }
            previousMissing = missing;
        }
    }
    return order;
}
