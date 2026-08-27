import type { SymbolDefinition } from "../index.js";

export const accentSymbol: SymbolDefinition = {
    name: "accent",
    description: "重音",
    weight: 0.5,
    shapes: [
        {
            path: [
                { op: "M", x: 0.21413, y: 0.4818 },
                { op: "L", x: 8.21413, y: 3.72071 },
                { op: "L", x: 0.29494, y: 6.92724 },
            ],
            style: { stroke: "#000", strokeWidth: 1 },
        },
    ],
};
