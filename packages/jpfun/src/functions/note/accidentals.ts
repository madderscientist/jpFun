import type { PathCommand } from "../../render/types.js";

interface AccidentalDefinition {
    w: number;
    h: number;
    baseline: number;
    strokeWidth: number;
    commands: readonly PathCommand[];
}

export interface PreparedAccidental {
    w: number;
    h: number;
    baseline: number;
    strokeWidth: number;
    commands: readonly PathCommand[];
}

const ACCIDENTALS: Partial<Record<string, AccidentalDefinition>> = {
    "#": {
        w: 0.46,
        h: 0.78,
        baseline: 0.63,
        strokeWidth: 0.1,
        commands: [
            { op: "M", x: 0.34, y: 0.05 },
            { op: "L", x: 0.27, y: 0.95 },
            { op: "M", x: 0.72, y: 0.05 },
            { op: "L", x: 0.65, y: 0.95 },
            { op: "M", x: 0.08, y: 0.38 },
            { op: "L", x: 0.9, y: 0.28 },
            { op: "M", x: 0.05, y: 0.72 },
            { op: "L", x: 0.87, y: 0.62 },
        ],
    },
    b: {
        w: 0.38,
        h: 0.82,
        baseline: 0.67,
        strokeWidth: 0.11,
        commands: [
            { op: "M", x: 0.3, y: 0.04 },
            { op: "L", x: 0.3, y: 0.94 },
            { op: "M", x: 0.3, y: 0.5 },
            { op: "Q", cx: 0.92, cy: 0.36, x: 0.76, y: 0.68 },
            { op: "Q", cx: 0.63, cy: 0.87, x: 0.3, y: 0.86 },
        ],
    },
    n: {
        w: 0.42,
        h: 0.82,
        baseline: 0.67,
        strokeWidth: 0.1,
        commands: [
            { op: "M", x: 0.28, y: 0.05 },
            { op: "L", x: 0.28, y: 0.82 },
            { op: "L", x: 0.72, y: 0.68 },
            { op: "L", x: 0.72, y: 0.95 },
            { op: "M", x: 0.72, y: 0.95 },
            { op: "L", x: 0.72, y: 0.18 },
            { op: "L", x: 0.28, y: 0.32 },
        ],
    },
};

export function prepareAccidental(symbol: string, size: number): PreparedAccidental | null {
    const definition = ACCIDENTALS[symbol];
    if (!definition) return null;

    const w = definition.w * size;
    const h = definition.h * size;
    return {
        w,
        h,
        baseline: definition.baseline * size,
        strokeWidth: definition.strokeWidth * Math.min(w, h),
        commands: definition.commands,
    };
}