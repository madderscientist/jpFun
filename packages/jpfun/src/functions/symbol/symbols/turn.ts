import type { SymbolDefinition } from "../index.js";
import type { PathCommand } from "../../../render/types.js";
import { ornament } from "../ornament.js";

/*!
 * Bravura 1.482 ornamentTurn (U+E567), Y axis flipped; https://github.com/steinbergmedia/bravura
 * Copyright (c) 2026, Steinberg Media Technologies GmbH. Reserved Font Name "Bravura".
 * SPDX-License-Identifier: OFL-1.1
 * Full license: Bravura-LICENSE.txt in the package root and dist.
 */
const turnPath: readonly PathCommand[] = [
    { op: "M", x: 371, y: -218 },
    { op: "C", cx1: 340, cy1: -218, cx2: 315, cy2: -204, x: 315, y: -174 },
    { op: "C", cx1: 315, cy1: -152, cx2: 330, cy2: -138, x: 351, y: -138 },
    { op: "C", cx1: 380, cy1: -138, cx2: 381, cy2: -161, x: 402, y: -161 },
    { op: "C", cx1: 419, cy1: -161, cx2: 435, cy2: -140, x: 435, y: -114 },
    { op: "C", cx1: 435, cy1: -71, cx2: 405, cy2: -50, x: 370, y: -50 },
    { op: "C", cx1: 338, cy1: -50, cx2: 305, cy2: -77, x: 262, y: -125 },
    { op: "C", cx1: 213, cy1: -179, cx2: 169, cy2: -217, x: 104, y: -217 },
    { op: "C", cx1: 38, cy1: -217, cx2: 0, cy2: -167, x: 0, y: -103 },
    { op: "C", cx1: 0, cy1: -31, cx2: 46, cy2: 0, x: 89, y: 0 },
    { op: "C", cx1: 120, cy1: 0, cx2: 145, cy2: -14, x: 145, y: -44 },
    { op: "C", cx1: 145, cy1: -66, cx2: 130, cy2: -80, x: 109, y: -80 },
    { op: "C", cx1: 80, cy1: -80, cx2: 79, cy2: -57, x: 58, y: -57 },
    { op: "C", cx1: 41, cy1: -57, cx2: 25, cy2: -78, x: 25, y: -104 },
    { op: "C", cx1: 25, cy1: -147, cx2: 55, cy2: -168, x: 90, y: -168 },
    { op: "C", cx1: 122, cy1: -168, cx2: 155, cy2: -141, x: 198, y: -93 },
    { op: "C", cx1: 247, cy1: -39, cx2: 291, cy2: -1, x: 356, y: -1 },
    { op: "C", cx1: 422, cy1: -1, cx2: 460, cy2: -51, x: 460, y: -115 },
    { op: "C", cx1: 460, cy1: -187, cx2: 414, cy2: -218, x: 371, y: -218 },
    { op: "Z" },
];

const turnShape = { path: turnPath, style: { fill: "#000" } };

export const turnSymbol: SymbolDefinition = {
    name: "turn",
    description: "回音",
    weight: 0.55,
    shapes: [turnShape],
    emitPlayback: emitter => emitter.affectFollowing(ornament({ body: [1, 0, -1, 0] })),
};

export const iturnSymbol: SymbolDefinition = {
    name: "iturn",
    description: "逆回音",
    weight: 0.55 * 396 / 218,
    shapes: [
        turnShape,
        {
            line: { x1: 230, y1: -290, x2: 230, y2: 74 },
            style: { stroke: "#000", strokeWidth: 32 },
        },
    ],
    emitPlayback: emitter => emitter.affectFollowing(ornament({ body: [-1, 0, 1, 0] })),
};
