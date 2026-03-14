/**
 * 时间流动模式（由 AST 节点的 timeFlowMode 返回，供 semantic/build.ts 的 timeAllocation 使用）
 *
 * 这组模式只回答一个问题：当父节点展开子节点时，时间指针如何推进
 * 不包含任何渲染含义
 *
 * - leaf: 当前节点按叶子处理，不继续展开子节点
 * - sequence: 子节点串行，后一个子节点从前一个子节点结束位置开始
 * - parallel: 子节点并行，所有子节点都从同一个 startQN 开始，父节点结束时间取最大值
 * - transparent: 语义上是“包装层”，时间计算按并行模型处理，但主要用于表达“自身不引入额外时间位移”
 */
export type TimeFlowMode = "leaf" | "sequence" | "parallel" | "transparent";

/**
 * 时间状态容器（time-state sweep 阶段共享上下文）
 *
 * 使用位置：
 * - 写入：函数节点 onTimeState，例如 key/tempo 会写入 keySignature、bpm
 * - 读取：函数节点 onTimeState，例如 note 会读取 keySignature、bpm 并固化渲染字段
 * - 驱动：semantic/build.ts 主循环中，先 onTimeState，再 createSemanticNode
 *
 * 设计意图：
 * - 词法变量与时间状态分离
 * - 由时间顺序驱动状态，而不是靠 AST 词法作用域传播
 */
export type TimeState = Record<string, string | number | boolean>;

/**
 * 纯时间求解记录（由 semantic/build.ts::timeAllocation 生成）
 * 该结构是 semantic 物化前的公共基础记录，后续会并入 SemanticNodeRecord
 */
export interface TemporalNodeRecord {
    id: string; // 索引
    parentId: string | null; // 原始父的 id
    startQN: number; // 绝对起始位置，单位 QN（四分音符）
    endQN: number;
    durationQN: number;
    order: number; // timeAllocation 创建顺序，用于区分同时发生的父子
}