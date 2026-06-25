import { ASTNodeBase } from "../functions/ASTtypes.js";

export interface TimeLineEvent {
    t: number; // 事件发生的时间点
    T: number; // 事件的持续时间
    track: any; // 事件所属轨道的任意标识符 给布局用的
}

/**
 * 时间流动模式（由 AST 节点的 timeFlowMode 返回）
 *
 * 这组模式只回答一个问题：当父节点展开子节点时，时间指针如何推进
 *
 * - sequence: 子节点串行，后一个子节点从前一个子节点结束位置开始
 * - parallel: 子节点并行，所有子节点都从同一个 startQN 开始，父节点结束时间取最大值
 */
export type TimeFlowMode = "sequence" | "parallel";

/**
 * 在时间列中怎么表现
 * - anchor: 时间对齐点，比如 bar
 * - single: 需要单独成列 一般是设置类，目的是不影响后面音符和其他轨道的对齐
 * - default: 其他所有希望被分到同一个时间列的
 */
export enum ColType {
    ANCHOR, // anchor 最优先
    SINGLE,
    DEFAULT // 普通事件必须最后
}

export interface TemporalNodeRecord extends TimeLineEvent {
    track: string;  // 算法自动生成的是字符串

    ast: ASTNodeBase; // 对应的 AST 节点
    order: number; // timeAllocation 创建顺序，作为id。可以用于区分同时发生的父子、排序同一时刻发生的事件
    addon: Record<string, any>; // 其他任意字段
    type: ColType; // 事件类型
}
