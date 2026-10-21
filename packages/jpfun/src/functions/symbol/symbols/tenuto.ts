import type { SymbolDefinition } from "../index.js";

export const tenutoSymbol: SymbolDefinition = {
    name: "tenuto",
    description: "保持音",
    weight: 0.18,
    shapes: [
        {
            line: { x1: 0, y1: 0, x2: 7.2, y2: 0 },
            style: { stroke: "#000", strokeWidth: 1.8 },
        },
    ],
};
