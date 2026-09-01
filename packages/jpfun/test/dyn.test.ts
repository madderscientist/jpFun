import { test } from "node:test";

import type { VisualTemporalNode } from "../src/functions/temporal.js";
import { compileScore } from "../src/pipeline.js";
import { compilePlayback } from "../src/playback/compile.js";
import {
    assert,
    attachmentCommands,
    expectCompileError,
    expectLoweringError,
    expectSnapshot,
    layoutOf,
    lower,
    nearly,
    playedNotes,
} from "./helpers.js";

function velocities(source: string) {
    return playedNotes(compilePlayback(lower(source))).map(note => note.velocity);
}

function hairpin(source: string) {
    const layout = layoutOf(source);
    const attachment = layout.attachments.find(item => item.sourceSpan?.start === source.indexOf("@dyn"));
    assert(attachment, "@dyn must produce a layout attachment");
    return { layout, attachment, lines: attachmentCommands(attachment).filter(command => command.kind === "line") };
}

test("dyn 按记谱时间线性叠加力度并在区间后保持", () => {
    assert(velocities(`1@a ^ $p 2 3 4@b 5 @dyn(a,b,24)`).join(" ") === "48 56 64 72 72",
        "crescendo must reach the full delta at the end and retain it afterwards");
    assert(velocities(`1@a ^ $p 2 3@b @dyn(b,a,24)`).join(" ") === "48 60 72",
        "reversed endpoint arguments must still follow score time");
    assert(velocities(`1@a ^ $f 2 3@b 4 @dyn(a,b,-24)`).join(" ") === "96 84 72 72",
        "negative delta must produce a linear diminuendo");
    assert(velocities(`1@a 2@b @dyn(a,b,100)`).join(" ") === "80 127"
        && velocities(`1@a 2@b @dyn(a,b,-100)`).join(" ") === "80 1",
    "output velocity must be clamped to the audible MIDI range");
});

test("dyn 与区间内外的力度记号保持解耦", () => {
    assert(velocities(`1@a ^ $p 2 3 ^ $f 4@b 5 6 ^ $p @dyn(a,b,24)`).join(" ") === "48 56 112 120 120 48",
        "each note must receive the ramp delta on top of its own original velocity");
    assert(velocities(`1@a ^ $p 2 3@b 4 5 ^ $f @dyn(a,b,24)`).join(" ") === "48 60 72 72 96",
        "the first later explicit velocity must take over without the retained delta");
});

test("dyn 覆盖折叠的和弦与倚音成员", () => {
    const chord = playedNotes(compilePlayback(lower(`1@a ^ 3 2 4@b ^ 6 @dyn(a,b,20)`)));
    assert(chord.filter(note => note.start.equals(0)).every(note => note.velocity === 80),
        "all members at the start chord must receive zero delta");
    assert(chord.filter(note => note.start.equals(1)).every(note => note.velocity === 90),
        "the middle note must receive half the delta");
    assert(chord.filter(note => note.start.equals(2)).every(note => note.velocity === 100),
        "all members at the end chord must receive the full delta");

    const grace = playedNotes(compilePlayback(lower(`2>1@a 3 4@b @dyn(a,b,20)`)));
    assert(grace.filter(note => note.start.compare(1) < 0).every(note => note.velocity === 80),
        "grace and host members projected to the start must receive zero delta");
    assert(grace.at(-1)?.velocity === 100, "the end note must still receive the full delta");

    const markedEnd = velocities(`1@a {2 $p}>3@b 4 5 ^ $f @dyn(a,b,20)`);
    assert(markedEnd.join(" ") === "80 100 68 68 96",
        "the marked end note must determine the retained velocity before the next dynamic");
});

test("dyn 在反复中重放同一曲线，多条声明按加法组合", () => {
    assert(velocities(`|: 1@a ^ $p 2 3@b :| @dyn(a,b,24)`).join(" ") === "48 60 72 48 60 72",
        "every repeat pass must replay the same score-time velocity curve");

    const forward = velocities(`1@a 2@b 3@c 4 @dyn(a,b,20) @dyn(b,c,-20)`);
    const reversed = velocities(`1@a 2@b 3@c 4 @dyn(b,c,-20) @dyn(a,b,20)`);
    assert(forward.join(" ") === "80 100 80 80", "opposite ramps must compose back to the base velocity");
    assert(forward.join(" ") === reversed.join(" "), "ordinary integer deltas must compose commutatively");
});

test("dyn 校验增量、音轨和时间跨度", () => {
    expectCompileError(`1@a 2@b @dyn(a,b,0)`, "E_DYN_INVALID_DELTA");
    expectLoweringError(`@stack({1@a 2}, {3@b 4}) @dyn(a,b,20)`, "E_DYN_CROSS_TRACK");
    expectLoweringError(`1@a ^ 3@b @dyn(a,b,20)`, "E_DYN_ZERO_SPAN");

    const clamped = compileScore(`1@a ^ $p 2 3@b @dyn(a,b,200)`);
    assert(clamped.parser.diagnostics.some(item => item.code === "W_DYN_DELTA_CLAMPED"),
        "a finite delta outside the velocity range must be clamped with a warning");
    assert(playedNotes(compilePlayback(clamped.lowering))[1].velocity === 111.5,
        "the clamped delta must be used for interpolation");
});

test("dyn 的闭区间包含端点上的力度记号", () => {
    const clearance = (source: string) => {
        const { layout, attachment } = hairpin(source);
        const middle = layout.objects.find(object => object.ast.sourceSpan.start === source.indexOf("2"));
        assert(middle, "the middle note must be visible");
        return middle.box.y - (attachment.box.y + attachment.box.h);
    };

    const plain = clearance(`1@a 2 3 4@b @dyn(a,b,24)`);
    const marked = clearance(`1@a ^ $p 2 3 4@b ^ $f @dyn(a,b,24)`);
    assert(marked > plain + 1, "p/f on endpoint columns must raise a closed-range hairpin");
});

test("dyn 避让中间高对象和先注册的 attachment", () => {
    const raisedSource = `1@a 2 ^ @tempo(120) 3@b @dyn(a,b,20)`;
    const raised = hairpin(raisedSource);
    const tempo = raised.layout.objects.find(object => object.ast.sourceSpan.start === raisedSource.indexOf("2 ^"));
    assert(tempo, "the middle folded host must exist");
    assert(raised.attachment.box.y + raised.attachment.box.h <= tempo.box.y + 1e-6,
        "the hairpin must stay above a tall object in its closed interval");

    const nested = layoutOf(`@tuplet({1/@a 2/ 3/@b},2) @dyn(a,b,20)`);
    const [tuplet, dyn] = nested.attachments;
    assert(dyn.box.y + dyn.box.h <= tuplet.box.y + 1e-6,
        "a later dyn must clear an earlier overlapping tuplet");

    const stacked = layoutOf(`1@a 2@b @dyn(a,b,20) @dyn(a,b,30)`);
    const [inner, outer] = stacked.attachments;
    assert(outer.box.y + outer.box.h <= inner.box.y + 1e-6,
        "a later hairpin must be placed outside an earlier hairpin");
});

test("dyn 使用最终端点位置并跨行连续绘制", () => {
    const moved = hairpin(`@adjust({1@a}, dx=300px) 2 3@b @dyn(a,b,20)`);
    assert(moved.attachment.regions.length > 0 && moved.attachment.regions.every(region => region.w >= 0),
        "adjusted endpoints must not produce negative regions");
    assert(nearly(moved.lines[0].y1, moved.lines[1].y1)
        && Math.abs(moved.lines[0].y2 - moved.lines[1].y2) > 1,
    "a crescendo tip must remain attached to the start endpoint after its x position crosses the end");

    const source = `1@a 2 @br() 3 4@b @dyn(a,b,20)`;
    const split = hairpin(source);
    assert(split.attachment.regions.length === 2 && split.lines.length === 4,
        "a two-line ramp must produce two regions and two strokes per segment");
    const firstOpen = Math.abs(split.lines[0].y2 - split.lines[1].y2);
    const secondOpen = Math.abs(split.lines[2].y1 - split.lines[3].y1);
    assert(nearly(firstOpen, secondOpen), "the aperture must remain continuous across a line break");
    const page = split.layout.pages[0].bounds;
    assert(split.attachment.regions.every(region => region.x > page.x
        && region.x + region.w < page.x + page.w),
    "broken hairpins must stop at content edges instead of page edges");

    const middle = hairpin(`1@a @br() @adjust({2}, dx=200px) 3 @br() 4@b @dyn(a,b,20)`);
    const middleHosts = middle.layout.objects.filter(host => host.layoutLine === 1);
    const middleLeft = Math.min(...middleHosts.map(host => host.box.x));
    const middleRight = Math.max(...middleHosts.map(host => host.box.x + host.box.w));
    assert(nearly(middle.lines[2].x1, middleLeft) && nearly(middle.lines[2].x2, middleRight),
        "a middle segment must use final visual edges rather than temporal order");

    const blank = hairpin(`1@a @br(2) 2@b @dyn(a,b,20)`);
    assert(blank.attachment.regions.length === 2,
        "a hairpin must not invent a segment on an empty middle line");
});

test("dyn 绘制单行楔形并申报上方占用", () => {
    const source = `1@a 2 3@b @dyn(a,b,20)`;
    const { layout, attachment, lines } = hairpin(source);
    const hosts = layout.objects as VisualTemporalNode[];
    assert(lines.length === 2, "one hairpin segment must contain two strokes");
    assert(nearly(lines[0].y1, lines[1].y1), "a crescendo must begin at a closed tip");
    assert(lines[1].y2 - lines[0].y2 > 0, "a crescendo must open towards its end");
    assert(nearly(lines[0].x1, hosts[0].box.x)
        && nearly(lines[0].x2, hosts.at(-1)!.box.x + hosts.at(-1)!.box.w),
    "a hairpin must span the complete boxes of both endpoint hosts");
    assert(attachment.box.y + attachment.box.h < Math.min(...hosts.map(host => host.box.y)),
        "the hairpin must reserve space above the numbered notes");

    expectSnapshot("dyn-hairpin", [
        `box=${attachment.box.x.toFixed(2)},${attachment.box.y.toFixed(2)},${attachment.box.w.toFixed(2)},${attachment.box.h.toFixed(2)}`,
        `lines=${lines.map(line => `${line.x1.toFixed(2)},${line.y1.toFixed(2)}-${line.x2.toFixed(2)},${line.y2.toFixed(2)}`).join(";")}`,
    ].join("\n"));
});

test("dyn 的闭区间允许只有两个相邻端点", () => {
    const { attachment, lines } = hairpin(`1@a 2@b @dyn(a,b,20)`);
    assert(attachment.regions.length === 1 && lines.length === 2,
        "a two-note dynamic range must still draw one complete hairpin");
});
