import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";

import { compileScore } from "../src/pipeline.js";
import type { PathCommand } from "../src/render/types.js";
import { compilePlayback } from "../src/playback/compile.js";
import { assert, attachmentCommands, commandsOfKind, compileValid, layoutOf, lower, nearly, playedNotes, recordCommands } from "./helpers.js";

/** 两个控制点同高的三次贝塞尔，实际弧高是抬高的 3/4 */
function tieApexHeight(path: { commands: readonly PathCommand[] }) {
    const [start, outer] = path.commands;
    if (start.op !== "M" || outer.op !== "C") throw new Error("unexpected tie path shape");
    return (start.y - outer.cy1) * 0.75;
}

const opsOf = (path: { commands: readonly PathCommand[] }) =>
    path.commands.map(command => command.op).join(",");

test("增时线参与显式及默认连音端点，但不合并播放音符", () => {
    for (const source of [
        `1 -@a 1@b @tie(a,b)`,
        `1@a -@b 1 @tie(a,b)`,
        `1 1 - @tie()`,
        `1 - 1 @tie()`,
    ]) {
        const layout = layoutOf(source);
        const path = attachmentCommands(layout.attachments[0]).find(command => command.kind === "path");
        assert(path?.kind === "path" && path.commands[0]?.op === "M", "a dash tie must still draw its curve");
        const start = source.startsWith("1@a") ? layout.objects[0] : layout.objects[1];
        assert(nearly(path.commands[0].x, start.box.x + (start.ports["tie.top"]?.x ?? start.box.w / 2)),
            "default endpoints must include the recent dash instead of skipping it");
        const plan = compilePlayback(lower(source));
        const notes = playedNotes(plan);
        assert(notes.length === 2 && notes[0].midi === 60 && notes[1].midi === 60
            && notes[0].duration.clone().add(notes[1].duration).equals(3)
            && notes[1].start.equals(notes[0].duration),
        "a tie involving a dash must leave two separately articulated notes");
    }
});

test("连音线弧高支持自动跨度缩放、显式长度、作用域继承与跨行固定高度", () => {
    const smallTiePath = commandsOfKind(`1@a 2@b @tie(a,b,height=0.5em)`, "path", 20)[0];
    const largeTiePath = commandsOfKind(`1@a 2@b @tie(a,b,height=0.5em)`, "path", 40)[0];
    assert(nearly(tieApexHeight(largeTiePath), tieApexHeight(smallTiePath) * 2), "tie geometry scales with fontSize");
    assert(nearly(tieApexHeight(commandsOfKind(`1@a 2@b @tie(a,b,height=10px)`, "path")[0]), 10), "fixed length height");

    const autoPaths = commandsOfKind("1@a 2@b 3 4 5 6 7 1@c @tie(a,b,c)", "path", 20);
    assert(tieApexHeight(autoPaths[0]) < tieApexHeight(autoPaths[1]) && nearly(tieApexHeight(autoPaths[1]), 10),
        "automatic height grows with span and caps at 0.5em");
    deepStrictEqual(commandsOfKind("1@a 2@b @tie(a,b,height=0)", "path"), commandsOfKind("1@a 2@b @tie(a,b)", "path"));

    const crossAuto = commandsOfKind("1@a @br() 2@b @tie(a,b)", "path", 20);
    const crossFixed = commandsOfKind("1@a @br() 2@b @tie(a,b,height=0.45em)", "path", 20);
    deepStrictEqual(crossAuto, crossFixed, "cross-line automatic height uses 0.45em");

    const inherited = compileValid("@set(tie.height=2em) 1@a 2@b @tie(a,b)");
    strictEqual(inherited.ast.content.at(-1)!.toString("@set(tie.height=2em) 1@a 2@b @tie(a,b)"), "@tie(a, b, height=44px)");
    assert(compileScore("1@a 2@b @tie(a,b,height=bad)").diagnostics.some(d => d.code === "W_INVALID_LENGTH"), "invalid length");
});

test("ties leave a small font-relative gap above upper octave dots", () => {
    const layout = layoutOf("1'@a 2'@b @tie(a,b)", 20);
    const [path] = attachmentCommands(layout.attachments[0]).filter(command => command.kind === "path");
    const start = path.commands[0];
    assert(start.op === "M", "expected tie start");
    const circles = recordCommands(layout).filter(command => command.kind === "circle");
    const dots = circles.filter(dot => nearly(dot.cx, start.x) && dot.cy > start.y);
    assert(dots.length > 0 && nearly(Math.min(...dots.map(dot => dot.cy - dot.r)) - start.y, 1),
        "the tie endpoint must stay 0.05em above the uppermost dot");
});

test("up 成员标签连接该成员，整体标签连接整个 up", () => {
    const tieStartY = (source: string) => {
        const result = layoutOf(source);
        const chord = result.objects[0] as typeof result.objects[number] & {
            members: readonly (typeof result.objects[number])[];
        };
        const path = attachmentCommands(result.attachments[0]).find(command => command.kind === "path");
        assert(path?.kind === "path" && path.commands[0]?.op === "M", "the up tie must start with a path move");
        const member = chord.members[0];
        return {
            actual: path.commands[0].y,
            member: member.box.y + (member.ports["tie.top"]?.y ?? 0),
            chord: chord.box.y + chord.ports["tie.top"].y,
        };
    };

    const memberTie = tieStartY(`{1@x}^{@1(C4)} 2@y @tie(x,y)`);
    assert(nearly(memberTie.actual, memberTie.member) && !nearly(memberTie.actual, memberTie.chord),
        "a tie from an up member label must use that member's own top port");

    const chordTie = tieStartY(`{1^@1(C4)}@x 2@y @tie(x,y)`);
    assert(nearly(chordTie.actual, chordTie.chord) && !nearly(chordTie.actual, chordTie.member),
        "a tie from an up label must use the whole chord's top port");
});

test("grace 内部标签连接成员，外部标签穿透到宿主", () => {
    const tieStart = (source: string) => {
        const result = layoutOf(source);
        const grace = result.objects[0] as typeof result.objects[number] & {
            host: typeof result.objects[number];
            graces: readonly (typeof result.objects[number])[];
        };
        const path = attachmentCommands(result.attachments[0]).find(command => command.kind === "path");
        assert(path?.kind === "path" && path.commands[0]?.op === "M", "the grace tie must start with a path move");
        const graceMember = grace.graces[0];
        return {
            actual: { x: path.commands[0].x, y: path.commands[0].y },
            host: {
                x: grace.host.box.x + (grace.host.ports["tie.top"]?.x ?? grace.host.box.anchor),
                y: grace.host.box.y + (grace.host.ports["tie.top"]?.y ?? 0),
            },
            grace: {
                x: graceMember.box.x + (graceMember.ports["tie.top"]?.x ?? graceMember.box.anchor),
                y: graceMember.box.y + (graceMember.ports["tie.top"]?.y ?? 0),
            },
            composite: {
                x: grace.box.x + (grace.ports["tie.top"]?.x ?? grace.box.anchor),
                y: grace.box.y + (grace.ports["tie.top"]?.y ?? 0),
            },
        };
    };

    const graceTie = tieStart(`@grace({1},{2@x}) 3@y @tie(x,y)`);
    assert(nearly(graceTie.actual.x, graceTie.grace.x) && nearly(graceTie.actual.y, graceTie.grace.y),
        "a label on a grace member must use that member's own port");

    const hostTie = tieStart(`@grace({1},{2})@x 3@y @tie(x,y)`);
    assert(nearly(hostTie.actual.x, hostTie.host.x) && nearly(hostTie.actual.y, hostTie.host.y)
        && !nearly(hostTie.actual.y, hostTie.composite.y),
    "a label after grace must delegate to the host's labelable node");
});

test("跨系统连音线按首、中、尾分段绘制", () => {
    const crossLineTieResult = layoutOf(`1@a @br() 2@b @tie(a,b)`);
    const crossLineTiePaths = attachmentCommands(crossLineTieResult.attachments[0])
        .filter(command => command.kind === "path");
    assert(crossLineTiePaths.length === 2, "a two-system tie must emit first and final segments");
    assert(crossLineTieResult.objects[0].box.y > 0, "the first tie segment must push its note row down");
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

    const emptyMiddleTieResult = layoutOf(`1@a @br(2) 2@b @tie(a,b)`);
    assert(emptyMiddleTieResult.lineCount === 3, "a tie spanning br(2) must preserve its empty middle system");
    const emptyMiddleTiePaths = attachmentCommands(emptyMiddleTieResult.attachments[0])
        .filter(command => command.kind === "path");
    assert(emptyMiddleTiePaths.length === 3, "a tie spanning an empty system must still emit three segments");
    assert(
        emptyMiddleTiePaths[1].commands.every(command => command.op === "Z" || command.y > 0),
        "an attachment-only middle system must receive a final positive visual-axis position",
    );
});

test("短行跨行连音线的首尾段最短时只有起落弧", () => {
    const layout = layoutOf(`3@x

4@tie()`);
    const firstLineRight = Math.max(...layout.objects
        .filter(object => object.layoutLine === 0)
        .map(object => object.box.x + object.box.w));
    const opening = layout.attachments[0].regions.find(region => region.line === 0);
    assert(opening && opening.x + opening.w >= firstLineRight,
        "a short opening tie segment must cover its system's actual content edge");
    const curveWidth = layout.objects[0].ast.size * 0.45 * 1.2;
    assert(nearly(opening.w, curveWidth),
        "a short opening tie segment must be exactly one rising curve wide");
    const closing = layout.attachments[0].regions.find(region => region.line === 1);
    assert(closing && nearly(closing.w, curveWidth),
        "a short closing tie segment must be exactly one falling curve wide");

    const paths = attachmentCommands(layout.attachments[0]).filter(command => command.kind === "path");
    const openingCurve = paths[0].commands[1];
    const openingLine = paths[0].commands[2];
    assert(openingCurve.op === "Q" && openingLine.op === "L" && nearly(openingCurve.x, openingLine.x),
        "the shortest opening segment must have no horizontal line");
    const closingStart = paths[1].commands[0];
    const closingLine = paths[1].commands[1];
    assert(closingStart.op === "M" && closingLine.op === "L" && nearly(closingStart.x, closingLine.x),
        "the shortest closing segment must have no horizontal line");
});

test("进入多声部系统的连音线从大括号右侧开始", () => {
    const source = `1@a @br()
@voices(@voice({2@b 3}, A), @voice({4 5}, B))
@tie(a,b)`;
    const layout = layoutOf(source);
    const brace = layout.attachments.find(attachment => attachment.layer === "background");
    const tie = layout.attachments.find(attachment => attachment.sourceSpan
        && source.slice(attachment.sourceSpan.start, attachment.sourceSpan.end).startsWith("@tie"));
    assert(brace && tie, "the sample must create both a voices brace and a tie");
    const closingPath = attachmentCommands(tie).filter(command => command.kind === "path").at(-1);
    assert(closingPath?.kind === "path" && closingPath.commands[0]?.op === "M",
        "the closing tie segment must begin with a path move");
    assert(closingPath.commands[0].x >= brace.regions[0].x + brace.regions[0].w,
        "the closing tie segment must not pass through the voices brace");
});

test("进入多声部系统中段端点的连音线从该 Track 首音开始", () => {
    const source = `3@x

N: 44@tie(x)
N: 3`;
    const layout = layoutOf(source);
    const firstFour = layout.objects.find(object => object.ast.sourceSpan.start === source.indexOf("44"));
    assert(firstFour, "the sample must contain the first 4 on the target track");
    const tie = layout.attachments.find(attachment => attachment.sourceSpan
        && source.slice(attachment.sourceSpan.start, attachment.sourceSpan.end).startsWith("@tie"));
    assert(tie, "the sample must create a tie");
    const closingPath = attachmentCommands(tie).filter(command => command.kind === "path").at(-1);
    assert(closingPath?.kind === "path" && closingPath.commands[0]?.op === "M",
        "the closing tie segment must begin with a path move");
    assert(nearly(closingPath.commands[0].x, firstFour.box.x),
        "the closing tie segment must start at the target track's leftmost note edge");
});

test("连音线可以跨行与跨轨，首尾弧从端点固定抬高", () => {
    const crossTrackTieResult = layoutOf(`@stack({1@a}, {2@b}) @tie(a,b)`);
    assert(crossTrackTieResult.attachments.length === 1, "tie must allow endpoints on different tracks");
    assert(crossTrackTieResult.attachments[0].regions[0].h > 0, "a cross-track tie must produce visible geometry");

    const tieIntoUp = layoutOf(`@set(tie.height=0.5em) 1@x

@up(3,4) 5@y @tie(x,y)`);
    const closingPath = attachmentCommands(tieIntoUp.attachments[0])
        .filter(command => command.kind === "path").at(-1);
    assert(closingPath?.kind === "path"
        && closingPath.commands[0]?.op === "M"
        && closingPath.commands[2]?.op === "Q",
    "the closing tie segment must contain its plateau and endpoint");
    assert(nearly(closingPath.commands[2].y - closingPath.commands[0].y, 11),
        "a closing tie plateau must be exactly one configured height above its endpoint");

    const tieOutOfUp = layoutOf(`@set(tie.height=0.5em) @up(3,4) 5@x @br() 1@y @tie(x,y)`);
    const openingPath = attachmentCommands(tieOutOfUp.attachments[0])
        .find(command => command.kind === "path");
    assert(openingPath?.kind === "path"
        && openingPath.commands[0]?.op === "M"
        && openingPath.commands[1]?.op === "Q",
    "the opening tie segment must contain its endpoint and plateau");
    assert(nearly(openingPath.commands[0].y - openingPath.commands[1].y, 11),
        "an opening tie plateau must be exactly one configured height above its endpoint");

    const compactCrossTrackTie = layoutOf(`
@page(width=200px,height=150px,top=10px,bottom=10px,left=10px,right=10px)
@stack({1@a 2},{3 4@b}) @tie(a,b,height=60px)
`);
    const compactTieBox = compactCrossTrackTie.attachments[0].regions[0];
    assert(compactCrossTrackTie.pages.length === 1, "a cross-track tie must not duplicate its height across tracks");
    assert(compactTieBox.y >= 10 - 1e-6 && compactTieBox.y + compactTieBox.h <= 140 + 1e-6,
        "a cross-track tie must stay inside the measured page content area");
});

test("跨轨连音线只占用主体上方，不撑开两条轨之间的间距", () => {
    // 弧的下半截属于另一条轨；若整段都记给较高的那条轨，两支之间的空档会被重复计入
    const measure = (source: string) => {
        const [lower, upper] = layoutOf(source).objects;
        return { gap: lower.box.y - upper.box.y, top: upper.box.y };
    };
    const plain = measure(`@stack({1@a},{2@b})`);
    const tied = measure(`@stack({1@a},{2@b}) @tie(a,b,height=60px)`);

    assert(nearly(plain.gap, tied.gap),
        `a cross-track tie must not widen the branch gap: ${plain.gap.toFixed(2)} -> ${tied.gap.toFixed(2)}`);
    assert(tied.top - plain.top > 40,
        "a cross-track tie must still reserve its own height above the upper track");
});

test("跨越空谱面行的连音线只占自己的带宽", () => {
    // 空行没有主体可以让出下半截，此时整段弧带就是它自己的全部占用
    const regions = layoutOf(`@page(gap=0px) 1@a @br(3) 2@b @tie(a,b)`).attachments[0].regions;
    const middle = regions
        .filter(region => region.line === 1 || region.line === 2)
        .sort((left, right) => left.y - right.y);
    assert(middle.length === 2, "a tie crossing empty systems must draw one band per system");
    assert(nearly(middle[1].y - middle[0].y, middle[0].h),
        `an empty system must reserve only the tie band:`
        + ` ${(middle[1].y - middle[0].y).toFixed(2)} vs ${middle[0].h.toFixed(2)}`);
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
    assert(crossPageTieAttachment.regions.every(region => [region.x, region.y, region.w, region.h].every(Number.isFinite)),
        "cross-page tie geometry must stay finite");
});

test("普通连音线与八度点借用行间留白不拉大行距，超高外扩按 minGap 保底推开", () => {
    const plain = layoutOf(`1 2 3 4 @br() 1 2 3 4`);
    const line0Bottom = plain.objects[0].box.y + plain.objects[0].box.h;
    const line1Axis = (layout: typeof plain) => {
        const node = layout.objects.find(item => item.layoutLine === 1 && !item.T.isZero())!;
        return node.box.y + node.box.visualAxis;
    };
    for (const source of [
        `1 2 3 4 @br() 1@a 2@b 3 4 @tie(a,b)`,
        `1 2 3 4 @br() 1'' 2 3 4`,
        `1 2 3 4 @br() 1 ^ $tenuto 2 3 4`,
    ]) {
        assert(nearly(line1Axis(layoutOf(source)), line1Axis(plain)), `${source} must borrow lineGap without pushing line 1`);
    }
    for (const [source, minGap] of [
        [`1 2 3 4 @br() 1 ^ $fermata 2 3 4`, 11],
        [`N: 1 2 3\n\nN: 1 2 3^4`, 11],
        [`@page(gap=1em, minGap=0.8em)\nN: 1 2 3\n\nN: 1 2 3^4`, 22 * 0.8],
    ] as const) {
        const top = Math.min(...layoutOf(source).objects.filter(n => n.layoutLine === 1 && !n.T.isZero()).map(n => n.box.y));
        assert(nearly(top - line0Bottom, minGap), `${source} must keep ${minGap}px minGap`);
    }
    assert(nearly(layoutOf(`1 2 3 4 @br() 1@a 2@b 3 4 @tie(a,b,height=30px)`).attachments[0].regions[0].y - line0Bottom, 11),
        "an oversized tie must keep the default 11px minGap");

    // 歌词位于基线下方，行距从歌词底部算起；下一行的普通 tie 仍借用这段行距
    const lyricPlain = layoutOf(`@voice({1 2}, , "甲 乙") @br() @voice({3 4})`);
    const lyricTied = layoutOf(`@voice({1 2}, , "甲 乙") @br() @voice({3@a 4@b @tie(a,b)})`);
    const lyricBox = lyricPlain.attachments[0].regions[0];
    assert(nearly(line1Axis(lyricPlain) - 11 - (lyricBox.y + lyricBox.h), 22)
        && nearly(line1Axis(lyricTied), line1Axis(lyricPlain)),
        "lyrics must preserve full lineGap below them while allowing next-line ties to borrow it");
});
