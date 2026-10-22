import type { SymbolDefinition } from "../index.js";
import type { PathCommand } from "../../../render/types.js";

/** $tocoda 的跳转目标 */
export const CODA_MARK = "repeat.coda";

/*!
 * Bravura coda (U+E048), Y axis flipped; https://github.com/steinbergmedia/bravura
 * Copyright (c) 2026, Steinberg Media Technologies GmbH. Reserved Font Name "Bravura".
 * SPDX-License-Identifier: OFL-1.1
 * Full license: Bravura-LICENSE.txt in the package root and dist.
 */
const codaPath: readonly PathCommand[] = [
    { op: "M", x: -4, y: -376 },
    { op: "C", cx1: -4, cy1: -363, cx2: 0, cy2: -352, x: 14, y: -352 },
    { op: "L", x: 146, y: -352 },
    { op: "C", cx1: 157, cy1: -165, cx2: 296, cy2: -13, x: 458, y: 0 },
    { op: "L", x: 458, y: 140 },
    { op: "C", cx1: 458, cy1: 154, cx2: 469, cy2: 158, x: 482, y: 158 },
    { op: "C", cx1: 495, cy1: 158, cx2: 506, cy2: 154, x: 506, y: 140 },
    { op: "L", x: 506, y: 0 },
    { op: "C", cx1: 668, cy1: -13, cx2: 808, cy2: -165, x: 818, y: -352 },
    { op: "L", x: 937, y: -352 },
    { op: "C", cx1: 951, cy1: -352, cx2: 955, cy2: -363, x: 955, y: -376 },
    { op: "C", cx1: 955, cy1: -389, cx2: 951, cy2: -400, x: 937, y: -400 },
    { op: "L", x: 818, y: -400 },
    { op: "C", cx1: 808, cy1: -588, cx2: 668, cy2: -739, x: 506, y: -752 },
    { op: "L", x: 506, y: -881 },
    { op: "C", cx1: 506, cy1: -894, cx2: 495, cy2: -898, x: 482, y: -898 },
    { op: "C", cx1: 469, cy1: -898, cx2: 458, cy2: -894, x: 458, y: -881 },
    { op: "L", x: 458, y: -752 },
    { op: "C", cx1: 296, cy1: -739, cx2: 157, cy2: -589, x: 146, y: -400 },
    { op: "L", x: 14, y: -400 },
    { op: "C", cx1: 0, cy1: -400, cx2: -4, cy2: -389, x: -4, y: -376 },
    { op: "Z" },
    { op: "M", x: 653, y: -400 },
    { op: "L", x: 506, y: -400 },
    { op: "L", x: 506, y: -696 },
    { op: "C", cx1: 646, cy1: -684, cx2: 653, cy2: -562, x: 653, y: -400 },
    { op: "Z" },
    { op: "M", x: 506, y: -352 },
    { op: "L", x: 653, y: -352 },
    { op: "C", cx1: 650, cy1: -199, cx2: 631, cy2: -63, x: 506, y: -48 },
    { op: "Z" },
    { op: "M", x: 316, y: -400 },
    { op: "C", cx1: 316, cy1: -562, cx2: 316, cy2: -684, x: 458, y: -696 },
    { op: "L", x: 458, y: -400 },
    { op: "Z" },
    { op: "M", x: 458, y: -352 },
    { op: "L", x: 458, y: -48 },
    { op: "C", cx1: 329, cy1: -63, cx2: 317, cy2: -198, x: 316, y: -352 },
    { op: "Z" },
];

export const codaSymbol: SymbolDefinition = {
    name: "coda",
    description: "尾声记号：$tocoda 的跳转目标",
    weight: 1.15,
    playbackMarks: () => [CODA_MARK],
    shapes: [{ path: codaPath, style: { fill: "#000" } }],
};
