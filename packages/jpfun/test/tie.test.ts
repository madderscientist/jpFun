import { test } from "node:test";

import type { LayoutAttachment } from "../src/layout/types.js";
import type { PathCommand } from "../src/render/types.js";
import { assert, attachmentCommands, commandsOfKind, layoutOf, nearly } from "./helpers.js";

/** 两个控制点同高的三次贝塞尔，实际弧高是抬高的 3/4 */
function tieApexHeight(path: { commands: readonly PathCommand[] }) {
    const [start, outer] = path.commands;
    if (start.op !== "M" || outer.op !== "C") throw new Error("unexpected tie path shape");
    return (start.y - outer.cy1) * 0.75;
}

/** 跨行段是一条水平带，取它的下沿才能和轨上最高的宿主比较 */
function horizontalBandBottom(attachment: LayoutAttachment, segment: number) {
    const path = attachmentCommands(attachment).filter(command => command.kind === "path")[segment];
    assert(path?.kind === "path", `Expected tie segment ${segment}`);
    return Math.max(...path.commands.flatMap(command => command.op === "L" ? [command.y] : []));
}

const opsOf = (path: { commands: readonly PathCommand[] }) =>
    path.commands.map(command => command.op).join(",");

test("同行连音线是一条闭合填充的丝带", () => {
    const nearTiePaths = commandsOfKind(`1@a 2@b @tie(a,b)`, "path");
    assert(nearTiePaths.length === 1, "a near tie must emit one path");
    assert(
        opsOf(nearTiePaths[0]) === "M,C,C,Z",
        "a same-line tie must be a closed ribbon made of an outer and an inner cubic",
    );
    assert(nearTiePaths[0].style?.fill === "#000", "the tie ribbon must be filled instead of stroked");
    assert(nearly(tieApexHeight(nearTiePaths[0]), 11), "the default tie height must be half an em at the declaration site");

    const farTiePaths = commandsOfKind(`1@a 2 3 4 5 6 7 1@b @tie(a,b)`, "path");
    assert(farTiePaths.length === 1, "a far same-line tie must emit one path");
    assert(
        opsOf(farTiePaths[0]) === "M,C,C,Z",
        "distance must not change the same-line tie drawing type",
    );
});

test("连音线弧高随字号缩放，也接受显式长度", () => {
    const smallTiePath = commandsOfKind(`1@a 2@b @tie(a,b)`, "path", 20)[0];
    const largeTiePath = commandsOfKind(`1@a 2@b @tie(a,b)`, "path", 40)[0];
    assert(
        nearly(tieApexHeight(largeTiePath), tieApexHeight(smallTiePath) * 2),
        "tie geometry must scale with the declaration font size",
    );

    const explicitHeightPath = commandsOfKind(`1@a 2@b @tie(a,b,height=10px)`, "path")[0];
    assert(nearly(tieApexHeight(explicitHeightPath), 10), "tie height must honor its fixed length argument");
});

test("跨系统连音线按首、中、尾分段绘制", () => {
    const crossLineTiePaths = commandsOfKind(`1@a @br() 2@b @tie(a,b)`, "path");
    assert(crossLineTiePaths.length === 2, "a two-system tie must emit first and final segments");
    assert(
        opsOf(crossLineTiePaths[0]) === "M,Q,L,L,L,Q,Z",
        "the first system tie segment must rise, extend to the right edge and close back",
    );
    assert(
        opsOf(crossLineTiePaths[1]) === "M,L,Q,Q,L,Z",
        "the final system tie segment must enter from the left edge, fall and close back",
    );

    const threeLineTiePaths = commandsOfKind(`1@a @br() 2 @br() 3@b @tie(a,b)`, "path");
    assert(threeLineTiePaths.length === 3, "a three-system tie must emit first, middle and final segments");
    assert(
        opsOf(threeLineTiePaths[1]) === "M,L,L,L,Z",
        "every intermediate system must use one full horizontal tie band",
    );

    const emptyMiddleTiePaths = commandsOfKind(`1@a @br(2) 2@b @tie(a,b)`, "path");
    assert(emptyMiddleTiePaths.length === 3, "a tie spanning an empty system must still emit three segments");
    assert(
        emptyMiddleTiePaths[1].commands.every(command => command.op === "Z" || command.y > 0),
        "an attachment-only middle system must receive a final positive visual-axis position",
    );
});

test("三行与含空行的连音线都保持每系统一段", () => {
    const threeLineTieResult = layoutOf(`1@a @br() 2 @br() 3@b @tie(a,b)`);
    assert(attachmentCommands(threeLineTieResult.attachments[0]).filter(command => command.kind === "path").length === 3,
        "a three-system tie must create first, middle and final segments");

    const emptyMiddleTieResult = layoutOf(`1@a @br(2) 2@b @tie(a,b)`);
    assert(emptyMiddleTieResult.lineCount === 3, "a tie spanning br(2) must preserve its empty middle system");
    assert(attachmentCommands(emptyMiddleTieResult.attachments[0]).filter(command => command.kind === "path").length === 3,
        "an attachment must render a segment on an otherwise empty system");
});

test("连音线可以跨行与跨轨，并避开轨上最高的宿主", () => {
    const crossLineTieResult = layoutOf(`1@a @br() 2@b @tie(a,b)`);
    assert(attachmentCommands(crossLineTieResult.attachments[0]).filter(command => command.kind === "path").length === 2,
        "a two-system tie must render one segment in each system");
    assert(crossLineTieResult.objects[0].box.y > 0, "the first tie segment must push its note row down");

    const crossTrackTieResult = layoutOf(`@stack({1@a}, {2@b}) @tie(a,b)`);
    assert(crossTrackTieResult.attachments.length === 1, "tie must allow endpoints on different tracks");
    assert(crossTrackTieResult.attachments[0].box.h > 0, "a cross-track tie must produce visible geometry");

    const tieIntoUp = layoutOf(`1@x

@up(3,4) 5@y @tie(x,y)`);
    assert(horizontalBandBottom(tieIntoUp.attachments[0], 1) < tieIntoUp.objects[1].box.y,
        "a closing tie segment must stay above the highest host on its target track");

    const tieOutOfUp = layoutOf(`@up(3,4) 5@x @br() 1@y @tie(x,y)`);
    assert(horizontalBandBottom(tieOutOfUp.attachments[0], 0) < tieOutOfUp.objects[0].box.y,
        "an opening tie segment must stay above the highest host on its source track");

    const compactCrossTrackTie = layoutOf(`
@page(width=200px,height=150px,top=10px,bottom=10px,left=10px,right=10px)
@stack({1@a 2},{3 4@b}) @tie(a,b,height=60px)
`);
    const compactTieBox = compactCrossTrackTie.attachments[0].box;
    assert(compactCrossTrackTie.pages.length === 1, "a cross-track tie must not duplicate its height across tracks");
    assert(compactTieBox.y >= 10 - 1e-6 && compactTieBox.y + compactTieBox.h <= 140 + 1e-6,
        "a cross-track tie must stay inside the measured page content area");
});

test("跨页连音线每个逻辑系统一段，几何保持有限", () => {
    const crossPageTie = layoutOf(`
@page(width=200px, height=80px, top=10px, bottom=10px, left=20px, right=20px, gap=5px)
1@a @br() 2 @br() 3 @br() 4@b @tie(a,b)
`);
    const crossPageTieAttachment = crossPageTie.attachments[0];
    assert(crossPageTie.pages.length > 1, "the cross-page tie sample must span multiple pages");
    assert(crossPageTie.pages.every(page => page.lineEnd > page.lineStart), "cross-page tie layout must not create empty pages");
    assert(attachmentCommands(crossPageTieAttachment).filter(command => command.kind === "path").length === 4,
        "a cross-page tie must retain one segment per logical system");
    assert(Object.values(crossPageTieAttachment.box).every(Number.isFinite), "cross-page tie geometry must stay finite");
});
