import type { SymbolDefinition } from "../index.js";

const ACCENT_BOOST = 20;
const MAX_VELOCITY = 127;

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
    emitPlayback: emitter => emitter.affectFollowing((context, origin) => {
        for (const event of context.eventsOf(origin)) {
            if (event.kind === "note-on") {
                event.velocity = Math.min(MAX_VELOCITY, event.velocity + ACCENT_BOOST);
            }
        }
    }),
};
