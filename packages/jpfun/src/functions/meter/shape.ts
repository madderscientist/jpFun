import { symbolBounds, type SymbolShape } from "../symbol/shape.js";

export const sanbanShapes: readonly SymbolShape[] = [
    {
        path: [
            { op: "M", x: 1, y: 34 },
            { op: "C", cx1: 23, cy1: 36, cx2: 57, cy2: 28, x: 82, y: 23 },
            { op: "C", cx1: 91, cy1: 21, cx2: 98, cy2: 24, x: 102, y: 29 },
            { op: "Q", cx: 106, cy: 34, x: 98, y: 34 },
            { op: "C", cx1: 68, cy1: 30, cx2: 37, cy2: 39, x: 13, y: 43 },
            { op: "Q", cx: 7, cy: 44, x: 1, y: 39 },
            { op: "Q", cx: -3, cy: 35, x: 1, y: 34 },
            { op: "Z" },
        ],
        style: { fill: "#000" },
    },
    {
        path: [
            { op: "M", x: 29, y: 5 },
            { op: "Q", cx: 27, cy: 3, x: 31, y: 4 },
            { op: "Q", cx: 44, cy: 7, x: 42, y: 12 },
            { op: "C", cx1: 39, cy1: 26, cx2: 43, cy2: 43, x: 42, y: 60 },
            { op: "Q", cx: 41, cy: 69, x: 38, y: 62 },
            { op: "C", cx1: 34, cy1: 47, cx2: 35, cy2: 20, x: 29, y: 5 },
            { op: "Z" },
        ],
        style: { fill: "#000" },
    },
    {
        path: [
            { op: "M", x: 59, y: 1 },
            { op: "Q", cx: 56, cy: -2, x: 61, y: 0 },
            { op: "Q", cx: 76, cy: 4, x: 74, y: 9 },
            { op: "C", cx1: 71, cy1: 17, cx2: 74, cy2: 32, x: 69, y: 48 },
            { op: "C", cx1: 64, cy1: 66, cx2: 55, cy2: 77, x: 40, y: 84 },
            { op: "Q", cx: 37, cy: 85, x: 40, y: 82 },
            { op: "C", cx1: 57, cy1: 66, cx2: 63, cy2: 47, x: 64, y: 29 },
            { op: "C", cx1: 65, cy1: 17, cx2: 63, cy2: 7, x: 59, y: 1 },
            { op: "Z" },
        ],
        style: { fill: "#000" },
    },
];

export const sanbanBounds = symbolBounds(sanbanShapes);
