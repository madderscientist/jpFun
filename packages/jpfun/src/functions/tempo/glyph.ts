import type { PathCommand } from "../../render/types.js";

/** 已按字号固化的四分音符字形 */
export interface PreparedQuarterNote {
    w: number;
    h: number;
    /** 符干中线到字形左边界的距离；它是这个字形的竖笔，对齐点取这里 */
    stemCenterX: number;
    commands: readonly PathCommand[];
    /** 传给 PathTransform 的等比缩放，倾斜的符头不能被非等比拉伸 */
    scale: number;
}

// 轮廓直接照抄成品字模，坐标单位是 em；y=0 是符干顶端，y=HEIGHT 是符头底端（对齐文字基线）
const GLYPH_EM = 11;
const WIDTH = 3.864;
const HEIGHT = 10.88;
const STEM_LEFT = 3.304;

const QUARTER_NOTE_COMMANDS: readonly PathCommand[] = [
    { op: "M", x: 3.864, y: 8.5 },
    { op: "Q", cx: 3.864, cy: 9.228, x: 3.5, y: 9.76 },
    { op: "Q", cx: 3.136, cy: 10.292, x: 2.555, y: 10.586 },
    { op: "Q", cx: 1.974, cy: 10.88, x: 1.302, y: 10.88 },
    { op: "Q", cx: 0.826, cy: 10.88, x: 0.413, y: 10.621 },
    { op: "Q", cx: 0, cy: 10.362, x: 0, y: 9.844 },
    { op: "Q", cx: 0, cy: 9.34, x: 0.364, y: 8.899 },
    { op: "Q", cx: 0.728, cy: 8.458, x: 1.288, y: 8.185 },
    { op: "Q", cx: 1.848, cy: 7.912, x: 2.422, y: 7.912 },
    { op: "Q", cx: 2.968, cy: 7.912, x: 3.304, y: 8.094 },
    { op: "L", x: 3.304, y: 0 },
    { op: "L", x: 3.864, y: 0 },
    { op: "Z" },
];

export function prepareQuarterNote(size: number): PreparedQuarterNote {
    const scale = size / GLYPH_EM;
    return {
        w: WIDTH * scale,
        h: HEIGHT * scale,
        stemCenterX: (STEM_LEFT + WIDTH) / 2 * scale,
        commands: QUARTER_NOTE_COMMANDS,
        scale,
    };
}
