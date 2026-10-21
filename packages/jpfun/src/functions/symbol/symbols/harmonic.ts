import type { SymbolDefinition } from "../index.js";

export const harmonicSymbol: SymbolDefinition = {
    name: "harmonic",
    description: "泛音",
    weight: 0.5,
    shapes: [
        {
            circle: { cx: 5, cy: 5, r: 4.5 },
            style: { fill: "none", stroke: "#000", strokeWidth: 1 },
        },
    ],
};
