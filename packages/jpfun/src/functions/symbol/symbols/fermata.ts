import type { SymbolDefinition } from "../index.js";

export const fermataSymbol: SymbolDefinition = {
    name: "fermata",
    description: "延长记号：目标音延长一倍，整条时间线随之停留",
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
};
