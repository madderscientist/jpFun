import type { SymbolDefinition } from "../index.js";

export const wheelSymbol: SymbolDefinition = {
    name: "wheel",
    description: "轮指",
    shapes: [
        {
            path: [
                { op: "M", x: 8.8, y: 0 },
                { op: "L", x: 11.2, y: 0 },
                { op: "L", x: 11.2, y: 6 },
                { op: "L", x: 8.8, y: 6 },
                { op: "Z" },
                { op: "M", x: 13.43341, y: 7.62266 },
                { op: "L", x: 19.13974, y: 5.76856 },
                { op: "L", x: 19.88139, y: 8.0511 },
                { op: "L", x: 14.17505, y: 9.9052 },
                { op: "Z" },
                { op: "M", x: 11.38032, y: 13.94141 },
                { op: "L", x: 14.90703, y: 18.79551 },
                { op: "L", x: 16.84867, y: 17.38483 },
                { op: "L", x: 13.32196, y: 12.53073 },
                { op: "Z" },
                { op: "M", x: 8.61968, y: 13.94141 },
                { op: "L", x: 5.09297, y: 18.79551 },
                { op: "L", x: 3.15133, y: 17.38483 },
                { op: "L", x: 6.67804, y: 12.53073 },
                { op: "Z" },
                { op: "M", x: 6.56659, y: 7.62266 },
                { op: "L", x: 0.86026, y: 5.76856 },
                { op: "L", x: 0.11861, y: 8.0511 },
                { op: "L", x: 5.82495, y: 9.9052 },
                { op: "Z" },
            ],
            style: { fill: "#000" },
        },
    ],
};
