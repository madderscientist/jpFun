import { test } from "node:test";

import { pathBounds } from "../src/layout/path.js";
import { compileScore } from "../src/pipeline.js";
import { compilePlayback } from "../src/playback/compile.js";
import { assert, expectCompileError, layoutOf, lower, playedNotes, recordCommands } from "./helpers.js";

test("琶音省略方向时无箭头，显式方向时绘制对应箭头", () => {
    const plain = recordCommands(layoutOf(`@arp({1 ^ 3 ^ 5})`));
    const upward = recordCommands(layoutOf(`@arp({1 ^ 3 ^ 5}, direction=up)`));
    const downward = recordCommands(layoutOf(`@arpeggio({1 ^ 3 ^ 5}, direction=down)`));
    assert(plain.filter(command => command.kind === "path").length === 1,
        "plain arpeggio must paint one arrowless wave path");
    assert(upward.filter(command => command.kind === "path").length === 1,
        "up arpeggio must paint one combined wave and arrow path");
    assert(downward.filter(command => command.kind === "path").length === 1,
        "down arpeggio must paint one combined wave and arrow path");
    const plainPath = plain.find(command => command.kind === "path")!;
    const upPath = upward.find(command => command.kind === "path")!;
    const downPath = downward.find(command => command.kind === "path")!;
    assert(plainPath.style?.fill === "#000" && plainPath.style.stroke === undefined
        && plainPath.commands.length > 50 && upPath.commands.length > 50 && downPath.commands.length > 50,
    "arpeggio must use repeated filled MuseScore outlines rather than a stroked approximation");
    const plainBounds = pathBounds(plainPath.commands);
    const upBounds = pathBounds(upPath.commands);
    const downBounds = pathBounds(downPath.commands);
    assert(upBounds.w > plainBounds.w && downBounds.w > plainBounds.w,
        "explicit directions must add a terminal wider than the plain wave");
    const subpaths = downPath.commands.flatMap((command, index) => command.op === "M" ? [index] : []);
    const tileBounds = pathBounds(downPath.commands.slice(subpaths[0], subpaths[1]));
    const arrowBounds = pathBounds(downPath.commands.slice(subpaths.at(-1)));
    const tileCenter = tileBounds.x + tileBounds.w / 2;
    const arrowCenter = arrowBounds.x + arrowBounds.w / 2;
    assert(Math.abs(tileCenter - arrowCenter) < tileBounds.w * 0.1,
        "the down arrow terminal must stay centered on the repeated wave");
});

test("琶音只接受至少两个成员的同轨 Fold", () => {
    expectCompileError(`@arpeggio(1)`, "E_ARPEGGIO_INVALID_CONTENT");
    expectCompileError(`@arpeggio({1 & 3})`, "E_ARPEGGIO_INVALID_CONTENT");
});

test("非法方向警告后回退到无箭头上行", () => {
    const source = `@arp({1 ^ 3}, direction=sideways)`;
    const compiled = compileScore(source);
    assert(compiled.diagnostics.some(item => item.code === "W_ARPEGGIO_INVALID_DIRECTION"),
        "an invalid direction must report a warning");
    const notes = playedNotes(compilePlayback(compiled.lowering));
    assert(notes.map(note => note.midi).join(",") === "60,64", "fallback playback must remain upward");
    assert(recordCommands(layoutOf(source)).filter(command => command.kind === "path").length === 1,
        "fallback rendering must use the arrowless path");
});

test("琶音按方向错开起音并保持共同终点", () => {
    const notes = (source: string) => playedNotes(compilePlayback(lower(source)));
    const upward = notes(`@arpeggio({1 ^ 3 ^ 5})`);
    const downward = notes(`@arpeggio({1 ^ 3 ^ 5}, direction=down)`);
    assert(upward.map(note => note.midi).join(",") === "60,64,67", "up arpeggio must sound low to high");
    assert(downward.map(note => note.midi).join(",") === "67,64,60", "down arpeggio must sound high to low");
    assert(upward[0].start.compare(upward[1].start) < 0 && upward[1].start.compare(upward[2].start) < 0,
        "up arpeggio starts must increase");
    assert(upward.every(note => note.end.equals(upward[0].end)), "arpeggio notes must share one end");
});

test("反复中的每次琶音访问独立错开一次", () => {
    const notes = playedNotes(compilePlayback(lower(`|: @arpeggio({1 ^ 3 ^ 5}) :|`)));
    assert(notes.length === 6, "the repeated chord must produce two visits");
    const starts = notes.map(note => note.start.toString()).join(",");
    assert(starts === "0,1/8,1/4,1,9/8,5/4", `unexpected repeated starts: ${starts}`);
});

test("不发声成员同样占用一个延迟槽", () => {
    const notes = playedNotes(compilePlayback(lower(`@arpeggio({1 ^ @text(A) ^ 5})`)));
    assert(notes.length === 2, "text must not emit a note");
    assert(notes[0].start.equals(0) && notes[1].start.equals(1, 4),
        "the silent middle member must still consume one arpeggio slot");
});

    test("无声成员占槽但系统状态仍在和弦时刻生效", () => {
        const plan = compilePlayback(lower(`@arp({1 ^ @tempo(80) ^ 5})`));
        const tempo = plan.events.find(event => event.kind === "tempo" && event.bpm === 80);
        const notes = playedNotes(plan);
        assert(tempo?.at.equals(0), "a merged system-state event must not inherit an arbitrary member slot");
        assert(notes.map(note => note.start.toString()).join(",") === "0,1/4",
        "the silent tempo member must still leave one empty arpeggio slot");
    });

test("向上和向下按视觉顺序延迟 Fold 成员", () => {
    const midi = (source: string) => playedNotes(compilePlayback(lower(source)))
        .map(note => note.midi).join(",");
    assert(midi(`@arpeggio({5 _ 3 _ 1})`) === "60,64,67",
        "up must traverse a downward Fold from its visual bottom to top");
    assert(midi(`@arpeggio({5 _ 3 _ 1}, direction=down)`) === "67,64,60",
        "down must traverse a downward Fold from its visual top to bottom");
});

test("短时值压缩延迟且保持共同终点", () => {
    const notes = playedNotes(compilePlayback(lower(`@arpeggio({1// ^ 3// ^ 5//})`)));
    assert(notes.map(note => note.start.toString()).join(",") === "0,1/16,1/8",
        "the last onset must not exceed half of the chord duration");
    assert(notes.every(note => note.end.equals(1, 4)), "all members must keep the common chord end");
});

test("波浪线和箭头完整落在复合盒内", () => {
    for (const source of [
        `@arpeggio({1 ^ 3 ^ 5})`,
        `@arpeggio({1 ^ 3 ^ 5}, direction=down)`,
    ]) {
        const layout = layoutOf(source);
        const host = layout.objects[0];
        const commands = recordCommands(layout);
        const paths = commands.filter(command => command.kind === "path");
        assert(paths.length > 0, "arpeggio must paint a path");
        for (const path of paths) {
            const bounds = pathBounds(path.commands);
            assert(bounds.x >= host.box.x && bounds.x + bounds.w <= host.box.x + host.box.w,
                "arpeggio path must stay inside the composite box horizontally");
            assert(bounds.y >= host.box.y && bounds.y + bounds.h <= host.box.y + host.box.h,
                "arpeggio path must stay inside the composite box vertically");
        }
        const firstNumber = commands.find(command => command.kind === "text");
        assert(firstNumber?.kind === "text" && firstNumber.x > host.box.x,
            "the chord must be shifted right to reserve the arpeggio mark");
    }
});

test("标注整个琶音和弦的 tie 保留 Fold 播放来源", () => {
    const notes = playedNotes(compilePlayback(lower(
        `@arpeggio({1 ^ 3})@a 1@b @tie(a,b)`,
    )));
    const low = notes.find(note => note.midi === 60);
    const high = notes.find(note => note.midi === 64);
    assert(low?.duration.equals(2), "the Fold-level tie must merge the lead note across the chord boundary");
    assert(high?.duration.equals(7, 8), "the untied upper member must retain its arpeggiated duration");
});

test("复合成员的内部事件整体后移且不越过共同终点", () => {
    const notes = playedNotes(compilePlayback(lower(`@arpeggio({1 ^ {2>3} ^ 5})`)));
    assert(notes.length === 4, "the grace member must emit its grace and host notes");
    assert(notes.every(note => note.duration.compare(0) > 0), "every nested note must retain positive duration");
    assert(notes.every(note => note.end.compare(1) <= 0), "nested member events must not pass the chord end");
});

test("arp 是主名且附点和弦具有可辨识的播放间隔", () => {
    const notes = playedNotes(compilePlayback(lower(`@arp({G3. ^ A3 ^ C4})`)));
    assert(notes.map(note => note.start.toString()).join(",") === "0,1/8,1/4",
        "a dotted arp chord must use the audible default spread");
});