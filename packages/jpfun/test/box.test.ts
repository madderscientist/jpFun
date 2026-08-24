import { test } from "node:test";

import type { DocumentLayoutResult } from "../src/layout/engine.js";
import type { Rect } from "../src/layout/types.js";
import { assert, expectLayoutError, expectSnapshot, layoutOf, nearly } from "./helpers.js";

test("关系对象向上让位，box 包含它们的完整范围", () => {
    const relationResult = layoutOf(`
@box({1@a 2@b @tie(a,b)}, 2px, 1px)
@box({3/@c 4/@d @beam(c,d)}, 2px, 1px)
`);
    const backgroundObjects = relationResult.attachments.filter(item => item.layer === "background");
    const foregroundObjects = relationResult.attachments.filter(item => item.layer === "foreground");

    assert(backgroundObjects.length === 2, "each box must create one background attachment");
    assert(foregroundObjects.length === 2, "tie and beam must create two foreground attachments");

    const tie = foregroundObjects[0];
    const beam = foregroundObjects[1];
    const firstNote = relationResult.objects[0];
    const firstBeamNote = relationResult.objects[2];

    assert(tie.box.y < firstNote.box.y, "tie must reserve space above its endpoint notes");
    assert(firstNote.box.y > 0, "the track visual axis must move down to include the tie");
    assert(beam.box.y >= firstBeamNote.box.y + firstBeamNote.box.visualAxis, "beam must stay below note visual axes");

    const tieBox = backgroundObjects[0].box;
    assert(tieBox.x < tie.box.x, "box padding must extend left of the enclosed tie");
    assert(tieBox.y < tie.box.y, "box padding must extend above the enclosed tie");
    assert(tieBox.x + tieBox.w > tie.box.x + tie.box.w, "box must include the full tie width");
    assert(tieBox.y + tieBox.h > firstNote.box.y + firstNote.box.h, "box must include its notes and padding");

    expectSnapshot("box-relations",
        `attachments=${relationResult.attachments.length} tieTop=${tie.box.y.toFixed(2)}`
        + ` visualAxis=${(firstNote.box.y + firstNote.box.visualAxis).toFixed(2)}`);
});

test("box 的边框覆盖成员自身的图形，只有写在框内的关系才撑框", () => {
    // 减时线是成员自己的装饰，@beam 只是改由谁绘制，写在框内框外都必须落在框里
    for (const source of [
        `@box({1/ 2/},padding=0px,stroke=1px)`,
        `@box({1/@a 2/@b},padding=0px,stroke=1px) @beam(a,b)`,
    ]) {
        const layout = layoutOf(source);
        const frame = layout.attachments.find(item => item.layer === "background");
        const beam = layout.attachments.find(item => item.layer === "foreground");
        assert(frame && beam, `${source} must create a box and a beam`);
        assert(contains(frame.box, beam.box), `a box must contain the div lines of its members: ${source}`);
    }

    // 连音线拱在主体上方：写在框外时不该把框撑高，写在框内时必须被框住
    const outsideSource = `@box({1/@a 2/@b},padding=0px,stroke=1px) @tie(a,b)`;
    const outside = layoutOf(outsideSource);
    const outsideFrame = outside.attachments.find(item => item.layer === "background")!;
    assert(!contains(outsideFrame.box, tieOf(outside, outsideSource).box),
        "a tie declared outside the box must not be captured merely because its endpoints are inside");

    const insideSource = `@box({1/@a 2/@b @tie(a,b)},padding=0px,stroke=1px)`;
    const inside = layoutOf(insideSource);
    const insideFrame = inside.attachments.find(item => item.layer === "background")!;
    assert(contains(insideFrame.box, tieOf(inside, insideSource).box),
        "a tie declared inside the box must be captured");
});

function contains(outer: Rect, inner: Rect) {
    return outer.x <= inner.x
        && outer.y <= inner.y
        && outer.x + outer.w >= inner.x + inner.w
        && outer.y + outer.h >= inner.y + inner.h;
}

function tieOf(layout: DocumentLayoutResult, source: string) {
    const tie = layout.attachments.find(item => item.sourceSpan?.start === source.indexOf("@tie"));
    assert(tie, `${source} must create a tie`);
    return tie;
}

test("固定宽度的 box 约束成员跨度并均匀分配余宽", () => {
    const adaptiveBox = layoutOf(`@box({1 2 3},padding=0px,stroke=0px)`).attachments[0];
    const fixedBoxResult = layoutOf(`@box({1 2 3},padding=0px,stroke=0px,width=120px) 4`);
    const fixedBox = fixedBoxResult.attachments[0];
    assert(adaptiveBox.box.w < 120, "negative default box width must preserve natural global layout");
    assert(nearly(fixedBox.box.w, 120), "positive box width must constrain its complete member span");
    const fixedBoxMembers = fixedBoxResult.objects.slice(0, 3);
    assert(nearly(fixedBoxMembers[0].box.x, fixedBox.box.x), "fixed box content must touch its left wall");
    assert(nearly(fixedBoxMembers[2].box.x + fixedBoxMembers[2].box.w, fixedBox.box.x + fixedBox.box.w),
        "fixed box content must touch its right wall");
    const fixedGap1 = fixedBoxMembers[1].box.x + fixedBoxMembers[1].box.anchor
        - fixedBoxMembers[0].box.x - fixedBoxMembers[0].box.anchor;
    const fixedGap2 = fixedBoxMembers[2].box.x + fixedBoxMembers[2].box.anchor
        - fixedBoxMembers[1].box.x - fixedBoxMembers[1].box.anchor;
    assert(nearly(fixedGap1, fixedGap2), "fixed box must distribute spare width evenly");
    assert(fixedBoxResult.objects[3].box.x > fixedBox.box.x + fixedBox.box.w, "objects after a fixed box must remain in the global flow");

    const alignedFixedBox = layoutOf(`@stack({@box({1 2 3},padding=0px,stroke=0px,width=120px)}, {4 5 6})`);
    for (let i = 0; i < 3; i++) {
        const upper = alignedFixedBox.objects[i * 2];
        const lower = alignedFixedBox.objects[i * 2 + 1];
        assert(
            nearly(upper.box.x + upper.box.anchor, lower.box.x + lower.box.anchor),
            "a fixed box must move every track that shares its global time columns",
        );
    }

    const nestedFixedBoxes = layoutOf(
        `@box({1 @box({2 3},padding=0px,stroke=0px,width=60px) 4},padding=0px,stroke=0px,width=140px)`,
    ).attachments;
    assert(nearly(nestedFixedBoxes[0].box.w, 60), "the inner fixed box must keep its exact width");
    assert(nearly(nestedFixedBoxes[1].box.w, 140), "the outer fixed box must preserve the nested constraint");
});

test("矛盾、交叉与过窄的 box 各自报告到它的声明处", () => {
    const conflictingBoxSource = `@box(@box({1 2},padding=0px,stroke=0px,width=60px),padding=0px,stroke=0px,width=80px)`;
    const conflictingBoxDiagnostic = expectLayoutError(conflictingBoxSource, "E_BOX_CONSTRAINT_CONFLICT");    assert(conflictingBoxSource.slice(conflictingBoxDiagnostic.span.start, conflictingBoxDiagnostic.span.end) === conflictingBoxSource,
        "a conflicting box diagnostic must point to the box that owns the rejected width");

    const crossingBoxSource = `@stack({@box({1 2 3},width=80px)}, {4 @box({5 6 7},width=80px)})`;
    const crossingBoxDiagnostic = expectLayoutError(crossingBoxSource, "E_BOX_CONSTRAINT_CROSSING");
    assert(crossingBoxSource.slice(crossingBoxDiagnostic.span.start, crossingBoxDiagnostic.span.end).startsWith("@box"),
        "a crossing box diagnostic must point to the box that introduces the crossing constraint");

    const narrowBoxSource = `@box({1 2},width=1px)`;
    const narrowBoxDiagnostic = expectLayoutError(narrowBoxSource, "E_BOX_WIDTH_TOO_SMALL");
    assert(narrowBoxSource.slice(narrowBoxDiagnostic.span.start, narrowBoxDiagnostic.span.end) === narrowBoxSource,
        "a narrow box diagnostic must point to its declaration");
});

test("box 不得跨行，分居两行的 box 各自取本行边界", () => {
    const crossLineBoxSource = `@box({1 @br() 2}, 2px, 1px)`;
    const crossLineBoxDiagnostic = expectLayoutError(crossLineBoxSource, "E_BOX_CROSS_LINE");
    assert(crossLineBoxSource.slice(crossLineBoxDiagnostic.span.start, crossLineBoxDiagnostic.span.end) === crossLineBoxSource,
        "a cross-line box diagnostic must point to its declaration");

    const separateLineBoxes = layoutOf(`@box({1}) @br() @box({2})`).attachments;
    assert(
        separateLineBoxes[1].box.y >= separateLineBoxes[0].box.y + separateLineBoxes[0].box.h,
        "a later system box must not include empty attachment bounds from the document origin",
    );
});

test("空 box 不伪造对象，边界保持有限", () => {
    const emptyBoxResult = layoutOf(`@box({})`);
    assert(emptyBoxResult.objects.length === 0, "empty box must not create a fake temporal object");
    assert(Object.values(emptyBoxResult.bounds).every(Number.isFinite), "empty box bounds must stay finite");
    expectSnapshot("box-empty", `bounds.w=${emptyBoxResult.bounds.w}`);
});
