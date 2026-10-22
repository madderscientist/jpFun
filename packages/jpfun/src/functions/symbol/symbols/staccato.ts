import type { SymbolDefinition } from "../index.js";

export const staccatoSymbol: SymbolDefinition = {
    name: "staccato",
    description: "断奏：所附着音符的实际发声时长缩短为一半",
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
    /** 将目标音段的实际发声区间压缩至前半段，保留原起点与子音相对比例 */
    emitPlayback: emitter => emitter.affectFollowing((_context, notes) => {
        const origin = notes[0].start.clone();
        for (const note of notes) {
            note.start.sub(origin).div(2).add(origin);
            note.end.sub(origin).div(2).add(origin);
        }
    }),
};
