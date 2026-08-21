import type { Painter, PathCommand } from "../../render/types.js";

interface AccidentalDefinition {
    w: number;
    h: number;
    baseline: number;
    commands: readonly PathCommand[];
}

export interface PreparedAccidental {
    w: number;
    h: number;
    baseline: number;
    strokeWidth: number;
    commands: readonly PathCommand[];
}

/** 已经定位到宿主盒局部坐标的升降号 */
export interface PlacedAccidental {
    shape: PreparedAccidental;
    x: number;
    y: number;
}

/** 字形相对数字字号的缩放，线宽则取与数字笔画相当的固定比例 */
const GLYPH_SCALE = 0.72;
const STROKE_RATIO = 0.06;
/** 升降号写在宿主基线之上多少，贴住数字左上角 */
const RAISE_RATIO = 0.42;

const ACCIDENTALS: Partial<Record<string, AccidentalDefinition>> = {
    "#": {
        w: 0.46,
        h: 0.78,
        baseline: 0.63,
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

/** size 是数字字号，升降号自己决定缩小多少 */
function prepareAccidental(symbol: string, size: number): PreparedAccidental | null {
    const definition = ACCIDENTALS[symbol];
    if (!definition) return null;

    const glyphSize = size * GLYPH_SCALE;
    return {
        w: definition.w * glyphSize,
        h: definition.h * glyphSize,
        baseline: definition.baseline * glyphSize,
        strokeWidth: size * STROKE_RATIO,
        commands: definition.commands,
    };
}

/**
 * 把升降号串按同一基线依次排在 x 右侧
 * @param size 宿主数字的字号
 * @param baselineY 宿主文字基线在宿主盒局部坐标中的 y
 * @param gap 相邻升降号之间的间隔；末尾也留一份，宿主据此得到 right
 * @returns right 是下一个字形的起点，top 是最高处（可能为负，宿主自行决定是否下移）
 */
export function placeAccidentals(symbols: string, size: number, x: number, baselineY: number, gap: number) {
    const placed: PlacedAccidental[] = [];
    const raise = size * RAISE_RATIO;
    let right = x;
    let top = 0;
    for (const symbol of symbols) {
        const shape = prepareAccidental(symbol, size);
        if (!shape) continue;
        const y = baselineY - shape.baseline - raise;
        placed.push({ shape, x: right, y });
        if (y < top) top = y;
        right += shape.w + gap;
    }
    return { placed, right, top };
}

/** commands 是 0..1 归一化坐标，必须配回字形自己的 w/h 才不会画歪 */
export function paintAccidental(
    painter: Painter,
    { shape, x, y }: PlacedAccidental,
    origin: { x: number; y: number },
    color: string,
) {
    painter.drawPath(
        shape.commands,
        { stroke: color, strokeWidth: shape.strokeWidth },
        { x: origin.x + x, y: origin.y + y, scaleX: shape.w, scaleY: shape.h },
    );
}
