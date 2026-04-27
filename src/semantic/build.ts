import { ASTFunctionNode, ASTNodeBase } from "../functions/ASTtypes.js";
import {
    TimeState,
    TemporalNodeRecord,
} from "./contracts.js";

// 默认时间状态
// semantic 层不内置函数特化键，默认从空状态开始。
const DEFAULT_TIME_STATE: TimeState = {};

// buildSemanticScore 内部使用的中间记录
// 在 TemporalNodeRecord 的基础上额外挂回原始 AST 节点，便于后续调用节点自己的 hook
interface TimedAstRecord extends TemporalNodeRecord {
    node: ASTNodeBase;
}

// 记录 dot 和 div 对时间的拉伸
// 要特殊记录是因为div和dot的作用顺序和嵌套顺序不一致
// 根源在于dot的作用不能简单叠加，因为dot的时长是等比数列求和，里面有加法，
// 比如 dot(dot(A,1),1) 的时长 = 1 * (1+0.5+0.25) 而不是 1 * (1+0.5) * (1+0.5)
interface TimeWrapState {
    divCnt: number;
    dotCnt: number;
}
function applyNode(s: TimeWrapState, node: ASTNodeBase) {
    if (node instanceof ASTFunctionNode) {
        const name = node.callName ?? '';
        if (name === "div") s.divCnt++;
        else if (name === "dot") s.dotCnt++;
    }
}
function calcTime(base: number, s: TimeWrapState): number {
    return base * (2 - Math.pow(2, -s.dotCnt)) / (1 << s.divCnt);
}

// 负责第一步：根据 AST 结构与 duration，给每个节点分配时间区间
function timeAllocation(nodes: ASTNodeBase[]): TimedAstRecord[] {
    let nextOrder = 0;  // 递增的序号，保持唯一性
    const timedNodes: TimedAstRecord[] = [];
    /**
     * 递归为单个节点及其子节点布置时间位置，并记录
     * 返回该节点的结束时刻用于递归调用
     */
    function placeNode(node: ASTNodeBase, startQN: number, timewrapstate: TimeWrapState, parentId: string | null = null): number {
        const id = `n${nextOrder}`;
        const order = nextOrder++;   // 父元素的order应该靠前 这样才会被ctx先影响
        let ch_startQN = startQN + calcTime(node.timeOffsetQN, timewrapstate); // 子元素的起始时间加上固有时间
        let endQN = ch_startQN;
        applyNode(timewrapstate, node);
        // 处理子元素
        const children = node.timeChildren();
        switch (node.timeFlowMode()) {
            case "parallel":
                for (const c of children) {
                    // 每个分支从头开始
                    const childEnd = placeNode(c, startQN, { ...timewrapstate }, id);
                    endQN = Math.max(endQN, childEnd);  // parallel模式下ASTNode本就应该取子元素的max，这里是保险
                } break;
            case "transparent": {
                for (const c of children) {
                    const childEnd = placeNode(c, startQN, { ...timewrapstate }, id);
                    endQN = Math.max(endQN, childEnd);
                } break;
            }
            case "sequence":
                // 每个子元素依次推进时间
                let p = startQN;
                for (const c of children) p = placeNode(c, p, { ...timewrapstate }, id);
                endQN = Math.max(p, endQN);
                break;
        }
        // 登记自己 因为要知道子元素的用时才能登记自己
        timedNodes.push({
            id, order, parentId,
            node,
            startQN, endQN,
            durationQN: Math.max(0, endQN - startQN),
        }); return endQN;
    }

    let p = 0;
    for (const node of nodes) p = placeNode(node, p, { divCnt: 0, dotCnt: 0 });   // 使用 sequence 规则
    // 排序规则: 开始时间 > 原始记录顺序，保证父元素在子元素之前
    // 因为修改时间变量是按照开始时间来的
    return timedNodes.sort((a, b) => {
        if (a.startQN !== b.startQN) return a.startQN - b.startQN;
        return a.order - b.order;
    });
}


// 语义阶段主入口
// 它刻意拆成两层：
// 1. TimingBuilder 只回答“节点在什么时候”
// 2. time-state sweep 回答“节点所处时刻的状态是什么”
export function buildSemanticScore(nodes: ASTNodeBase[]) {
    // 第一步: 建立时间索引，得到每个节点的时间位置
    const timedNodes = timeAllocation(nodes);  // 已经有序
    // 第二步: 沿时间线推进，固化时间状态
    // 主循环按时间顺序推进时间状态，并把每个 AST 节点物化为稳定语义节点
    const timeState: TimeState = { ...DEFAULT_TIME_STATE };   // 随时间推进的状态上下文
    for (const record of timedNodes) {
        // 让AST节点修改上下文并固化状态
        record.node.onTimeState(timeState);
    }
}

