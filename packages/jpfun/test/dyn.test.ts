import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { VisualTemporalNode } from "../src/functions/temporal.js";
import { compileScore } from "../src/pipeline.js";
import { compilePlayback } from "../src/playback/compile.js";
import {
    assert,
    attachmentCommands,
    expectCompileError,
    expectLoweringError,
    layoutOf,
    lower,
    nearly,
    playedNotes,
} from "./helpers.js";

function velocities(source: string) {
    return playedNotes(compilePlayback(lower(source))).map(note => note.velocity);
}

function expectVelocities(cases: readonly (readonly [string, string])[]) {
    for (const [source, expected] of cases) strictEqual(velocities(source).join(" "), expected, source);
}

function hairpin(source: string) {
    const layout = layoutOf(source);
    const attachment = layout.attachments.find(item => item.sourceSpan?.start === source.indexOf("@dyn"));
    assert(attachment, "@dyn must produce a layout attachment");
    return { layout, attachment, lines: attachmentCommands(attachment).filter(command => command.kind === "line") };
}

test("dyn 按记谱时间线性叠加力度并在区间后保持，与区间内外的力度记号解耦", () => expectVelocities([
    ["1@a ^ $p 2 3 4@b 5 @dyn(a,b,24)", "49 57 65 73 73"],
    ["1@a ^ $p 2 3@b @dyn(b,a,24)", "49 61 73"],
    ["1@a ^ $f 2 3@b 4 @dyn(a,b,-24)", "96 84 72 72"],
    ["1@a 2@b @dyn(a,b,100)", "80 127"],
    ["1@a 2@b @dyn(a,b,-100)", "80 1"],
    // 每个音在自身原力度上叠加增量；区间后第一个显式力度接管，不再保留增量
    ["1@a ^ $p 2 3 ^ $f 4@b 5 6 ^ $p @dyn(a,b,24)", "49 57 112 120 120 49"],
    ["1@a ^ $p 2 3@b 4 5 ^ $f @dyn(a,b,24)", "49 61 73 73 96"],
]));

test("dyn 的保持在下一个力度记号处结束", () => expectVelocities([
    // 同值重写也结束保持
    ["1@a ^ $p 2 3 4@b @dyn(a,b,32) | 5 ^ $p 6", "49 60 70 81 49 49"],
    // 记号做宿主时，同刻挂在其上的音不再保持
    ["1@a ^ $p 2 3 4@b @dyn(a,b,32) | $p ^ 5 6", "49 60 70 81 49 49"],
    ["1@a 2@b @dyn(a,b,0.4999999)", "80 80"],
]));

test("dyn 按固化后的最终时间判断端点", () => {
    strictEqual(velocities(`@meter(4,4) @rest(1)@a 1@b @dyn(a,b,20) 2`).join(" "), "100 100");
});

test("dyn 的增时线端点使用同轨此前最后一个音符的力度基准", () => {
    for (const endpoints of ["a,b", "b,a"]) {
        const source = `1@a ^ $p 2 -@b 3 4 ^ $f @dyn(${endpoints},24)`;
        const notes = playedNotes(compilePlayback(lower(source)));
        assert(notes.map(note => note.velocity).join(" ") === "49 61 73 96",
            "a dash endpoint must retain the ramp until the next original velocity change");
        assert(notes[1].duration.equals(2), "the sustained note must keep its own onset velocity and duration");
        const { layout, lines } = hairpin(source);
        const end = layout.objects.find(object => object.ast.sourceSpan.start === source.indexOf("-@b"))!;
        assert(nearly(lines[0].x2, end.box.x + end.box.w),
            "the visual endpoint must remain on the labeled dash");
    }
    expectVelocities([
        // 回退基准取最后一个原始力度而不是起点力度
        [`1@a ^ $p 2 ^ $f -@b 3 4 ^ $p @dyn(a,b,24)`, "49 108 120 49"],
        [`1 ^ $p -@a 2 -@b 3 @dyn(a,b,24)`, "49 61 73"],
    ]);
});

test("dyn 的增时线端点不借用其他声部的力度", () => {
    const source = `@stack({1@a ^ $p 2 -@b 3 4 ^ $f}, {5 ^ $f 6 7 1 2}) @dyn(a,b,24)`;
    const lowering = lower(source);
    const track = lowering.columns.flat().find(node => node.ast.sourceSpan.start === source.indexOf("-@b"))!.track;
    const plan = compilePlayback(lowering);
    const trackIndex = plan.tracks.indexOf(track);
    const notes = playedNotes(plan);
    assert(notes.filter(note => note.track === trackIndex).map(note => note.velocity).join(" ") === "49 61 73 96",
        "the endpoint baseline must come from its own track");
    assert(notes.filter(note => note.track !== trackIndex).every(note => note.velocity === 96),
        "other tracks must remain unchanged");
});

test("dyn 找不到此前同轨力度时给出诊断并保留图形", () => {
    for (const content of ["-@a -@b", "@stack({-@a -@b 1}, {5 6 7})"]) {
        const source = `${content} @dyn(a,b,24)`;
        const result = compileScore(source);
        const warnings = result.diagnostics.filter(item => item.code === "W_DYN_NO_VELOCITY");
        assert(warnings.length === 1 && source.slice(warnings[0].span.start, warnings[0].span.end) === "@dyn(a,b,24)",
            "a missing baseline must produce one source-located warning");
        const attachment = result.layout.attachments.find(item => item.sourceSpan?.start === source.indexOf("@dyn"))!;
        assert(attachmentCommands(attachment).filter(command => command.kind === "line").length === 2,
            "the dynamic marking must still be drawn");
        assert(playedNotes(compilePlayback(result.lowering)).every(note => note.velocity === 80),
            "future notes and other tracks must not supply a baseline or receive an increment");
    }
});

test("dyn 覆盖折叠的和弦与倚音成员", () => {
    const chord = playedNotes(compilePlayback(lower(`1@a ^ 3 2 4@b ^ 6 @dyn(a,b,20)`)));
    for (const [start, velocity] of [[0, 80], [1, 90], [2, 100]]) {
        assert(chord.filter(note => note.start.equals(start)).every(note => note.velocity === velocity),
            `all chord members at ${start} must receive the same delta`);
    }

    const grace = playedNotes(compilePlayback(lower(`2>1@a 3 4@b @dyn(a,b,20)`)));
    assert(grace.filter(note => note.start.compare(1) < 0).every(note => note.velocity === 80)
        && grace.at(-1)?.velocity === 100, "grace and host members projected to the start must receive zero delta");
    // 带力度记号的终点倚音决定区间后的保持力度
    expectVelocities([[`1@a {2 $p}>3@b 4 5 ^ $f @dyn(a,b,20)`, "80 100 69 69 96"]]);
});

test("dyn 在反复中重放同一曲线，多条声明按加法组合", () => expectVelocities([
    [`|: 1@a ^ $p 2 3@b :| @dyn(a,b,24)`, "49 61 73 49 61 73"],
    // 相反的两段渐变组合回原力度，且与声明顺序无关
    [`1@a 2@b 3@c 4 @dyn(a,b,20) @dyn(b,c,-20)`, "80 100 80 80"],
    [`1@a 2@b 3@c 4 @dyn(b,c,-20) @dyn(a,b,20)`, "80 100 80 80"],
]));

test("dyn 校验增量、音轨和时间跨度", () => {
    expectCompileError(`1@a 2@b @dyn(a,b,0)`, "E_DYN_INVALID_DELTA");
    expectLoweringError(`@stack({1@a 2}, {3@b 4}) @dyn(a,b,20)`, "E_DYN_CROSS_TRACK");
    expectLoweringError(`1@a ^ 3@b @dyn(a,b,20)`, "E_DYN_ZERO_SPAN");

    const clamped = compileScore(`1@a ^ $p 2 3@b @dyn(a,b,200)`);
    assert(clamped.diagnostics.some(item => item.code === "W_DYN_DELTA_CLAMPED"),
        "a finite delta outside the velocity range must be clamped with a warning");
    assert(playedNotes(compilePlayback(clamped.lowering))[1].velocity === 113,
        "the clamped delta must be used for interpolation");
});

test("dyn 的闭区间包含端点上的力度记号", () => {
    const clearance = (source: string) => {
        const { layout, attachment } = hairpin(source);
        const middle = layout.objects.find(object => object.ast.sourceSpan.start === source.indexOf("2"));
        assert(middle, "the middle note must be visible");
        const region = attachment.regions[0];
        return middle.box.y - (region.y + region.h);
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
    assert(raised.attachment.regions[0].y + raised.attachment.regions[0].h <= tempo.box.y + 1e-6,
        "the hairpin must stay above a tall object in its closed interval");

    const nested = layoutOf(`@tuplet({1/@a 2/ 3/@b},2) @dyn(a,b,20)`);
    const [tuplet, dyn] = nested.attachments.map(item => item.regions[0]);
    assert(dyn.y + dyn.h <= tuplet.y + 1e-6,
        "a later dyn must clear an earlier overlapping tuplet");

    const stacked = layoutOf(`1@a 2@b @dyn(a,b,20) @dyn(a,b,30)`);
    const [inner, outer] = stacked.attachments;
    assert(inner.regions.length === 1 && attachmentCommands(inner).filter(command => command.kind === "line").length === 2,
        "a two-note dynamic range must draw one complete hairpin");
    assert(outer.regions[0].y + outer.regions[0].h <= inner.regions[0].y + 1e-6,
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
    const middleEntry = middleHosts.find(host => !host.T.isZero());
    const middleRight = Math.max(...middleHosts.map(host => host.box.x + host.box.w));
    assert(middleEntry && nearly(middle.lines[2].x1, middleEntry.box.x - middleEntry.ast.size / 4)
        && nearly(middle.lines[2].x2, middleRight),
    "a middle segment may extend a quarter size left of its first timed host");

    const blank = hairpin(`1@a @br(2) 2@b @dyn(a,b,20)`);
    assert(blank.attachment.regions.length === 2,
        "a hairpin must not invent a segment on an empty middle line");

    const voicesSource = `@stack({1@a @br() @text(Prefix) 2@b}, {3 4 @br() 5}) @dyn(a,b,20)`;
    const voices = hairpin(voicesSource);
    const endHost = voices.layout.objects.find(host =>
        host.ast.sourceSpan.start === voicesSource.indexOf("2@b"));
    assert(endHost, "the end host must exist on the continued track");
    const firstTimedHost = voices.layout.objects.find(host =>
        host.layoutLine === 1 && host.track === endHost.track && !host.T.isZero());
    const firstLineRight = Math.max(...voices.layout.objects
        .filter(host => host.layoutLine === 0)
        .map(host => host.box.x + host.box.w));
    assert(firstTimedHost && nearly(voices.lines[0].x2, firstLineRight)
        && nearly(voices.lines[2].x1, firstTimedHost.box.x - firstTimedHost.ast.size / 4),
    "a broken hairpin must end at the system's visual right edge and resume a quarter size before the track's first timed host");
});

test("dyn 绘制单行楔形并申报上方占用", () => {
    const source = `1@a 2 3@b @dyn(a,b,20)`;
    const { layout, attachment, lines } = hairpin(source);
    const hosts = layout.objects as VisualTemporalNode[];
    assert(lines.length === 2 && nearly(lines[0].y1, lines[1].y1) && lines[1].y2 - lines[0].y2 > 0,
        "a crescendo must open from a closed tip with two strokes");
    assert(nearly(lines[0].x1, hosts[0].box.x)
        && nearly(lines[0].x2, hosts.at(-1)!.box.x + hosts.at(-1)!.box.w),
    "a hairpin must span the complete boxes of both endpoint hosts");
    assert(attachment.regions[0].y + attachment.regions[0].h < Math.min(...hosts.map(host => host.box.y)),
        "the hairpin must reserve space above the numbered notes");
});
