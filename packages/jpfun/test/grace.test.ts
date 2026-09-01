import { test } from "node:test";

import { divLinePortName } from "../src/functions/div/index.js";
import type { LayoutBox } from "../src/layout/types.js";
import type { VisualTemporalNode } from "../src/functions/temporal.js";
import { compilePlayback } from "../src/playback/compile.js";
import {
    assert,
    attachmentCommands,
    expectLoweringError,
    expectSnapshot,
    layoutOf,
    lower,
    nearly,
    playedNotes,
    recordCommands,
} from "./helpers.js";

function layoutGrace(source: string) {
    const result = layoutOf(source);
    return { result, commands: recordCommands(result) };
}

/** 倪音向宿主借走的演奏时值：前倪音先发声，所以就是首个 gesture 的时长 */
function stealOf(source: string) {
    return playedNotes(compilePlayback(lower(source)))[0].duration.toNumber();
}

const plainNote = layoutGrace(`1`).result.objects[0];
const preGrace = layoutGrace(`2>1`);
const preGraceNode = preGrace.result.objects[0] as VisualTemporalNode & {
    host: { box: LayoutBox };
    graces: readonly VisualTemporalNode[];
};

test("倚音折叠成一个可见对象，但保留宿主的时值与端口", () => {
    assert(preGrace.result.objects.length === 1, "a grace note must fold into a single visible object");
    assert(preGraceNode.T.equals(plainNote.T), "the composite must keep the host duration");
    assert(preGraceNode.box.w > plainNote.box.w, "a grace note must reserve intrinsic horizontal space");
    assert(preGraceNode.box.anchor > plainNote.box.anchor, "a pre-grace must push the host anchor to the right");
    assert(nearly(preGraceNode.ports["lyric"].x, preGraceNode.box.anchor),
        "the composite must forward the host lyric anchor instead of the grace one");

    expectSnapshot("grace-metrics",
        `w=${preGraceNode.box.w.toFixed(2)} anchor=${preGraceNode.box.anchor.toFixed(2)}`
        + ` steal=${stealOf(`2>1`)}`);
});

test("倚音比宿主小一级字号，坐在宿主基线之上的左侧", () => {
    const graceTexts = preGrace.commands.filter(command => command.kind === "text");
    assert(graceTexts.length === 2, "a grace composite must draw both the grace and the host");
    const [hostText, graceText] = graceTexts[0].style.fontSize > graceTexts[1].style.fontSize
        ? [graceTexts[0], graceTexts[1]]
        : [graceTexts[1], graceTexts[0]];
    assert(nearly(graceText.style.fontSize / hostText.style.fontSize, 0.7),
        "a grace note must be exactly one scale step smaller than its host");
    assert(graceText.y < hostText.y, "a grace note must sit above the host baseline");
    assert(graceText.x < hostText.x, "a pre-grace must sit left of the host");
});

// 倚音默认就是八分音符，因此裸写也会有一条减时线；再写一个 '/' 变成十六分
test("倚音的时值决定减时线数量与偷取的宿主时长", () => {
    assert(preGrace.commands.filter(command => command.kind === "line").length === 1,
        "a bare grace note must render its default eighth-note beam line");
    assert(layoutGrace(`2/>1`).commands.filter(command => command.kind === "line").length === 2,
        "an explicit div inside the grace must add a second line");
    assert(preGraceNode.graces[0].T.equals(1, 2), "the grace member must keep its written duration for playback");
    assert(nearly(stealOf(`2>1`), 0.5), "a bare grace steals half of the host duration");
    assert(nearly(stealOf(`2/>1`), 0.25),
        "a sixteenth grace steals a quarter of the host duration");
});

test("宿主的修饰在 loweringFinalize 还给宿主自己", () => {
    const hostDiv = layoutGrace(`2>1/`);
    const hostDivNode = hostDiv.result.objects[0];
    const hostAnchorX = hostDivNode.box.x + hostDivNode.box.anchor;
    const hostDivLine = hostDiv.commands
        .filter(command => command.kind === "line")
        .sort((a, b) => (b.x2 - b.x1) - (a.x2 - a.x1))[0];
    assert(hostDivNode.ports[divLinePortName(0, "left")] !== undefined,
        "the composite must expose the host div ports so beam and tie keep working");
    assert(hostDivLine.x1 < hostAnchorX && hostDivLine.x2 > hostAnchorX,
        "the host div line must be centred on the host anchor, not on the whole composite");
    assert(hostDivLine.x1 > hostDivNode.box.x,
        "the host div line must stay under the host digit instead of spanning the composite");
});

test("连续倚音合并成一条整线", () => {
    const twoGraces = layoutGrace(`{3 2}>1`);
    const twoGraceLines = twoGraces.commands.filter(command => command.kind === "line");
    const singleGraceLine = preGrace.commands.filter(command => command.kind === "line")[0];
    assert(twoGraceLines.length === 1, "consecutive grace notes must share one merged beam line");
    assert(twoGraceLines[0].x2 - twoGraceLines[0].x1 > singleGraceLine.x2 - singleGraceLine.x1,
        "the merged line must span both grace notes");

    const unevenGraces = layoutGrace(`{3,, 4}>4`);
    const unevenTexts = unevenGraces.commands
        .filter(command => command.kind === "text")
        .filter(command => command.style.fontSize < 22);
    assert(unevenTexts.length === 2 && nearly(unevenTexts[0].y, unevenTexts[1].y),
        "grace notes must align on their visual axis even when one carries octave dots");
    assert(unevenGraces.commands.filter(command => command.kind === "line").length === 1,
        "octave dots must not break the merged grace beam line");

    // 复合体可能又被当作宿主或和弦成员折叠进去，内层的合并仍要生效
    assert(layoutGrace(`6>4<{3 5}`).commands.filter(command => command.kind === "line").length === 2,
        "a grace run must still merge when its composite is folded as another grace's host");
    assert(layoutGrace(`{{2 3}>1}^5`).commands.filter(command => command.kind === "line").length === 1,
        "a grace run must still merge when its composite is folded into a chord");
});

test("倚音槽里的零时长标记只随块排版，不承担节奏", () => {
    const marked = layoutGrace(`{@key(F) 1}>2`);
    assert(marked.result.attachments.length === 0,
        "a zero-duration mark must not be beamed to the grace note beside it");
    assert(layoutGrace(`{3 2}>1`).result.attachments.length === 1,
        "two real grace notes must still merge into one beam");

    const markedLine = marked.commands.filter(command => command.kind === "line")[0];
    const soloLine = preGrace.commands.filter(command => command.kind === "line")[0];
    assert(markedLine !== undefined && nearly(markedLine.x2 - markedLine.x1, soloLine.x2 - soloLine.x1),
        "the grace note keeps exactly its own div line, not one stretched across the mark");

    const keyText = marked.commands
        .filter(command => command.kind === "text")
        .find(command => command.text === "1=");
    assert(keyText !== undefined && markedLine.x1 > keyText.x,
        "the div line must stay under the grace digit, clear of the mark");

    // 标记在视觉上是隔断：它两侧的倚音不是邻居，不能连成一条跨过标记的梁
    const split = layoutGrace(`{2 @key(F) 1}>2`);
    const splitKey = split.commands
        .filter(command => command.kind === "text")
        .find(command => command.text === "1=");
    const splitLines = split.commands.filter(command => command.kind === "line");
    assert(split.result.attachments.length === 0,
        "a mark standing between two grace notes must break the beam run");
    assert(splitKey !== undefined && splitLines.length === 2
        && splitLines.every(line => line.x2 < splitKey.x || line.x1 > splitKey.x),
        "each side of the mark keeps its own div line instead of one crossing the mark");

    // 隔断只在标记处切一次，标记之后仍然相邻的倚音照常合并
    assert(layoutGrace(`{2 @key(F) 1 3}>2`).result.attachments.length === 1,
        "grace notes following the mark must still merge into one beam");
});

test("后置倚音不动宿主对齐点，两侧倚音共用一条肩线", () => {
    const postGrace = layoutGrace(`1<2`);
    const postGraceNode = postGrace.result.objects[0];
    assert(nearly(postGraceNode.box.anchor, plainNote.box.anchor),
        "a post-grace must leave the host anchor untouched");
    const postTexts = postGrace.commands.filter(command => command.kind === "text");
    assert(postTexts[1].x > postTexts[0].x, "a post-grace must sit right of the host");

    const bothSides = layoutGrace(`6>4<3`);
    assert(nearly(bothSides.result.objects[0].box.h, postGraceNode.box.h),
        "a host carrying graces on both sides must not grow taller than a single-sided one");
    const bothGraceTexts = bothSides.commands
        .filter(command => command.kind === "text")
        .filter(command => command.style.fontSize < 22);
    assert(bothGraceTexts.length === 2 && nearly(bothGraceTexts[0].y, bothGraceTexts[1].y),
        "the pre-grace and the post-grace of one note must share the same shoulder line");
});

test("倚音嵌套时字号逐层缩小，修饰递归还给最里层宿主", () => {
    const nestedGrace = layoutGrace(`1>2>3`);
    const nestedSizes = nestedGrace.commands
        .filter(command => command.kind === "text")
        .map(command => command.style.fontSize)
        .sort((a, b) => b - a);
    assert(nestedSizes.length === 3, "nested grace notes must all be rendered");
    assert(nearly(nestedSizes[1] / nestedSizes[0], 0.7) && nearly(nestedSizes[2] / nestedSizes[1], 0.7),
        "nesting must scale the font size once per level");
    expectSnapshot("grace-nested", `sizes=${nestedSizes.map(size => size.toFixed(1)).join("/")}`);

    const nestedDivDots = layoutGrace(`1> 2,,,/>3`);
    const nestedDots = nestedDivDots.commands.filter(command => command.kind === "circle");
    const nestedDotTop = Math.min(...nestedDots.map(command => command.cy));
    const nestedDivLines = nestedDivDots.commands
        .filter(command => command.kind === "line")
        .filter(command => command.x1 < nestedDots[0].cx && command.x2 > nestedDots[0].cx);
    assert(nestedDots.length === 3 && nestedDivLines.length === 2,
        "the innermost grace host must carry its own octave dots and div lines");
    assert(nestedDivLines.every(command => command.y1 < nestedDotTop),
        "div lines must stay between the digit and its octave dots");
});

test("和弦折叠进倚音时修饰递归交还给代表成员", () => {
    const chordGrace = layoutGrace(`{1,,, ^ 3}/>2`);
    const chordGraceDots = chordGrace.commands.filter(command => command.kind === "circle");
    const chordGraceLines = chordGrace.commands.filter(command => command.kind === "line");
    assert(chordGraceDots.length === 3 && chordGraceLines.length === 2,
        "a chord folded into a grace must keep its lead member's dots and div lines");
    assert(chordGraceLines.every(command =>
        command.y1 < Math.min(...chordGraceDots.map(dot => dot.cy))),
        "a folded chord's div lines must stay between the digit and its octave dots");
});

test("写在倚音内部的标签仍是合法的关系端点", () => {
    const graceTie = layoutGrace(`2>1@a 3@b @tie(a,b)`);
    assert(graceTie.result.attachments.length === 1
        && attachmentCommands(graceTie.result.attachments[0]).some(command => command.kind === "path"),
        "a label written inside a grace composite must still work as a tie endpoint");

    expectLoweringError(`3>{1 2}`, "E_GRACE_INVALID_HOST");
    // & 的堆叠靠并行 Track，而折叠成员不进引擎，放行只会退化成横排
    expectLoweringError(`{1 & 3}/>2`, "E_GRACE_PARALLEL_CONTENT");
});

test("grace 外部标签穿透宿主后仍保留完整关系左操作数", () => {
    for (const source of [
        `@grace({1},{2})@x ^ 3`,
        `@grace({1},{2})@x & 3`,
        `@grace({1},{2})@x > 3`,
    ]) {
        assert(layoutOf(source).objects.length > 0,
            `a labeled grace must remain the complete left relation operand: ${source}`);
    }
});
