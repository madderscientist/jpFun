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
    /** 将重音登记为声音变换，保留音段的结构边界和系统速度 */
    emitPlayback: emitter => emitter.affectFollowing((_context, notes) => {
        // 前序装饰可能已拆出多个子音，逐个增加原有力度并限制到 MIDI 最大力度。
        for (const note of notes) {
            note.velocity = Math.min(MAX_VELOCITY, note.velocity + ACCENT_BOOST);
        }
    }),
};
