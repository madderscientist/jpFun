import type { SymbolDefinition } from "../index.js";

export const staccatoSymbol: SymbolDefinition = {
    name: "staccato",
    description: "断奏",
    weight: 0.8,
    shapes: [
        {
            path: [
                { op: "M", x: 0, y: 0 },
                { op: "L", x: 12, y: 0 },
                { op: "L", x: 6, y: 13 },
                { op: "Z" },
            ],
            style: { fill: "#000" },
        },
    ],
};
