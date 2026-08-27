import type { TemporalNodeBase } from "../lowering/types.js";

/**
 * 播放列游标
 *
 * 控制流只能通过它查询已经发生的事实，因此自身不保存状态，同一份 lowering 结果重复编译结果一致
 */
export interface PlaybackCursor {
    /** 正在决定去留的列 */
    readonly column: number;
    /** 该列到目前为止被到达的次数，含本次；被跳过的到达也算 */
    visits(column: number): number;
    /** 从 from 出发沿 direction 找最近一个带该标记的列，不含 from 自身 */
    seek(mark: string, from: number, direction: -1 | 1): number | undefined;
}

/**
 * 对游标的一次干预
 * - jump: 当前列不演奏，直接跳到目标列
 * - stop: 在当前列之前结束
 */
export type PlaybackFlowAction =
    | { kind: "jump"; column: number }
    | { kind: "stop" };

/** 把事件映射到它在播放时间流中的列；折叠成员会映射到宿主 */
export type PlaybackColumnOf = (node: TemporalNodeBase) => number | undefined;

/** 控制流在编译开始时生成的执行声明；range 是运行的升序闭区间，缺省表示每列都运行 */
export interface PlaybackFlowHook {
    readonly range?: readonly [number, number];
    run(cursor: PlaybackCursor): PlaybackFlowAction | undefined;
}

/** 参与播放顺序决策的能力；Temporal 与 attachment 都可以实现 */
export interface PlaybackFlow {
    /** 给自己所在的列贴标记，供其它控制流 seek；只对进入时间流的对象有意义 */
    playbackMarks?(): readonly string[];
    /** 根据本轮列索引声明生效范围和运行逻辑；返回 undefined 表示只有标记、没有 hook */
    playbackFlow?(columnOf: PlaybackColumnOf): PlaybackFlowHook | undefined;
}
