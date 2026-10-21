import type { SymbolDefinition } from "../index.js";
import { accentSymbol } from "./accent.js";

export const marcatoSymbol: SymbolDefinition = {
    name: "marcato",
    description: "强调音：尖顶记号；播放同重音，所附着音符力度增加 20，最高 127",
    weight: 0.65,
    shapes: [
        {
            path: [
                { op: "M", x: 0, y: 10 },
                { op: "L", x: 4.5, y: 0 },
                { op: "L", x: 5.5, y: 0 },
                { op: "L", x: 10, y: 10 },
                { op: "L", x: 8, y: 10 },
                { op: "L", x: 5, y: 3 },
                { op: "L", x: 2, y: 10 },
                { op: "Z" },
            ],
            style: { fill: "#000" },
        },
    ],
    emitPlayback: accentSymbol.emitPlayback,
};
