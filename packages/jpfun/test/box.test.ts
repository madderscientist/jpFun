import { test } from "node:test";

import { GraceTemporal } from "../src/functions/grace/index.js";
import { compileScore } from "../src/pipeline.js";
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

test("box 首尾留白参与横排，嵌套每层只计一次", () => {
    const plain = layoutOf("1 2 3 4");
    const boxed = layoutOf("1 @box(@box({2 3},padding=3px,stroke=2px),padding=5px,stroke=2px) 4");
    const shift = boxed.objects.map((node, index) => node.box.x - plain.objects[index].box.x);
    assert(shift.every((value, index) => nearly(value, [0, 10, 10, 20][index])),
        "only the two external gaps gain the sum of the nested insets");
    assert(nearly(boxed.attachments[1].box.x, boxed.attachments[0].box.x - 6),
        "the outer frame must add only its own inset");

    const single = layoutOf("@box(@box(1,padding=3px,stroke=2px),padding=5px,stroke=2px) 2");
    assert(nearly(single.objects[0].box.x - plain.objects[0].box.x, 10)
        && nearly(single.objects[1].box.x - plain.objects[1].box.x, 20),
        "a single-column box reserves both edges exactly once");

    const fixed = layoutOf("@box(@box({1 2},padding=3px,stroke=2px,width=60px),padding=5px,stroke=2px,width=68px)");
    assert(nearly(fixed.attachments[0].box.w, 68) && nearly(fixed.attachments[1].box.w, 80),
        "the outer width includes the inner frame, excluding its own inset");
    expectLayoutError("@box(@box(1,padding=10px),width=20px)", "E_BOX_WIDTH_TOO_SMALL");
});

test("负 padding 收窄边框与占位，过量收缩时报错", () => {
    const baseline = layoutOf("1 @box({2 3},padding=0px,stroke=2px) 4");
    const narrowed = layoutOf("1 @box({2 3},padding=-2px,stroke=2px) 4");
    assert(nearly(narrowed.attachments[0].box.w, baseline.attachments[0].box.w - 4)
        && nearly(narrowed.attachments[0].box.h, baseline.attachments[0].box.h - 4),
        "negative padding must inset both frame edges");
    assert(narrowed.objects.every((node, index) =>
        nearly(node.box.x - baseline.objects[index].box.x, [0, -2, -2, -4][index])
        && nearly(node.box.w, baseline.objects[index].box.w)
        && nearly(node.box.h, baseline.objects[index].box.h)),
        "only external spacing changes; content dimensions and internal spacing stay unchanged");
    expectLayoutError("@box(1,padding=-100px)", "E_BOX_PADDING_TOO_SMALL");
    expectLayoutError("@box({1 2},padding=-12px,width=120px)", "E_BOX_PADDING_TOO_SMALL");
});

test("倚音序列和宿主都预留框占位，前后倚音与嵌套框共用横向约束", () => {
    for (const side of ["pre", "post"]) {
        const layout = layoutOf(`@grace(@box(1,padding=5px,stroke=2px),
            {@box(@box({2 3},padding=3px,stroke=2px),padding=5px,stroke=2px) 4},side=${side})`);
        const node = layout.objects[0];
        assert(node instanceof GraceTemporal, "expected a grace composite");
        const frames = layout.attachments.filter(item => item.layer === "background");
        const hostFrame = frames.find(item => nearly(item.box.w, node.host.box.w + 12))!;
        const graceFrame = frames.find(item => nearly(item.box.w,
            node.graces[0].box.w + node.graces[1].box.w + 20))!;
        assert(hostFrame && graceFrame, "host and nested grace frames must retain their own geometry");
        assert(nearly(node.graces[1].box.x, node.graces[0].box.x + node.graces[0].box.w),
            "frame padding must not enter the enclosed internal gap");
        assert(nearly(node.graces[2].box.x, graceFrame.box.x + graceFrame.box.w),
            "the next local member touches the outer frame, not its content");
        const left = side === "pre" ? graceFrame.box.x : hostFrame.box.x;
        const right = side === "pre" ? hostFrame.box.x + hostFrame.box.w
            : node.graces[2].box.x + node.graces[2].box.w;
        assert(nearly(node.box.x, left) && nearly(node.box.x + node.box.w, right),
            "both external frame edges must be included in the composite width");
        assert(nearly(node.box.x + node.ports.lyric.x, node.host.box.x + node.host.ports.lyric.x),
            "padding must preserve forwarded host ports");
        const before = [node.host, ...node.graces].map(member => ({ ...member.box }));
        node.onPlaced();
        node.onPlaced();
        assert([node.host, ...node.graces].every((member, index) =>
            nearly(member.box.x, before[index].x) && nearly(member.box.y, before[index].y)),
            "placement must always recompute from saved offsets");
    }
});

test("倚音内的定宽框使用局部零间隙并保留内层约束", () => {
    const source = `@grace(1,{@box(@box({2 3},padding=3px,stroke=2px,width=60px),
        padding=5px,stroke=2px,width=68px)})`;
    const layout = layoutOf(source);
    const node = layout.objects[0];
    assert(node instanceof GraceTemporal, "expected a grace composite");
    const frames = layout.attachments.filter(item => item.layer === "background");
    assert(nearly(frames[0].box.w, 68) && nearly(frames[1].box.w, 80),
        "fixed local frame widths must include each layer's own inset exactly once");
    assert(nearly(node.box.w, 80 + node.host.box.w + node.ast.size * 0.7 * 0.2),
        "the enclosing composite must retain the whole fixed region");
    expectLayoutError("@grace(1,@box({2 3},width=1px))", "E_BOX_WIDTH_TOO_SMALL");
});

test("同时间多轨框只修改自己的首末成员，不新增列或累加另一轨留白", () => {
    const source = (padding: number) => `@stack(
        {@box({1 2},padding=${padding}px,stroke=0px) 3},
        {@box({4 5},padding=10px,stroke=0px) 6})`;
    const baseline = compileScore(source(0));
    const boxed = compileScore(source(4));
    assert(boxed.lowering.columns.length === 3 && boxed.layout.objects.length === 6,
        "frames must not create temporal events or boundary columns");
    for (let column = 0; column < boxed.lowering.columns.length; column++) {
        const members = boxed.lowering.columns[column];
        assert(members.length === 2 && members.every((node, index) =>
            node.t.equals(baseline.lowering.columns[column][index].t)
            && node.T.equals(baseline.lowering.columns[column][index].T)),
            "track timing and column membership must remain unchanged");
        const [first, second] = boxed.layout.objects.slice(column * 2, column * 2 + 2);
        assert(nearly(first.box.x + first.box.anchor, second.box.x + second.box.anchor),
            "parallel frames must retain their shared anchors");
    }
    assert(boxed.layout.objects.every((node, index) => nearly(node.box.x, baseline.layout.objects[index].box.x)),
        "the smaller frame must not increase the larger parallel frame's reservation");
});

test("窄页只压缩外层横排，嵌套倚音内的自然占位保持不变", () => {
    const source = "@grace(@grace(1,@box({2 3},padding=8px)),{4 5},side=post) 6 7";
    const wide = layoutOf(source).objects[0];
    const narrow = layoutOf("@page(width=130px,left=10px,right=10px) " + source).objects[0];
    assert(wide instanceof GraceTemporal && narrow instanceof GraceTemporal,
        "expected nested grace composites");
    assert(nearly(wide.box.w, narrow.box.w), "page width must not change local natural width");
    const wideMembers = [wide.host, ...wide.graces];
    const narrowMembers = [narrow.host, ...narrow.graces];
    assert(wideMembers.every((member, index) =>
        nearly(member.box.x - wide.box.x, narrowMembers[index].box.x - narrow.box.x)),
        "all saved local offsets must survive outer compression");
});
