import type { SymbolDefinition } from "../index.js";

// 多声部常在同一时段各写一个延长记号；按区间并集减速一次，避免速度随记号数指数下降
const FERMATA_BPM_SCALE = {};

export const fermataSymbol: SymbolDefinition = {
    name: "fermata",
    description: "延长记号：覆盖区间速度减半，目标音实际时长翻倍",
    weight: 0.6,
    shapes: [
        {
            path: [
                { op: "M", x: 0, y: 7.46666 },
                { op: "C", cx1: 3.65834, cy1: 0, cx2: 8.53611, cy2: 0, x: 12.19445, y: 7.46666 },
                { op: "M", x: 12.19445, y: 7.46666 },
                { op: "C", cx1: 8.53611, cy1: 0.74666, cx2: 3.65833, cy2: 0.74666, x: 0, y: 7.46666 },
            ],
            style: { fill: "#000", stroke: "#000", strokeWidth: 1 },
        },
        {
            circle: { cx: 6.09723, cy: 6.26666, r: 1.2 },
            style: { fill: "#000" },
        },
    ],
    /** 声明同 key 的减速区间，沿逻辑连接延续终点；范围不依赖实际子音的拆分结果 */
    emitPlayback: emitter => emitter.scaleFollowingBpm(FERMATA_BPM_SCALE, 1, 2, { followConnections: true }),
};
