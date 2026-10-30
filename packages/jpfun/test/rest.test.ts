import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { ASTFunctionNode } from "../src/functions/ASTtypes.js";
import { ANCHOR_KEY, DEFAULT_KEY, type TemporalNodeBase } from "../src/functions/temporal.js";
import { compilePlayback } from "../src/playback/compile.js";
import { renderLayoutPagesToSvg } from "../src/render/svg.js";
import {
    assert, compileValid, expectCompileError,
    layoutOf, lower, nearly, playedNotes, recordCommands,
} from "./helpers.js";

function named(node: TemporalNodeBase, name: string) {
    return node.ast instanceof ASTFunctionNode && node.ast.callName === name;
}

test("rest 保留完整休止时长且不产生可播放音符", () => {
    const compiled = compileValid("@meter(4,4) | @rest(3) |");
    const rests = compiled.lowering.columns.flat().filter(node => named(node, "rest"));
    strictEqual(rests.length, 1);
    assert(rests[0].t.equals(0) && rests[0].T.equals(12), "rest must retain one full-duration event");
    assert(compiled.lowering.duration.equals(12), "EOF must include the whole rest");
    const playback = compilePlayback(compiled.lowering);
    strictEqual(playedNotes(playback).length, 0);
    assert(playback.performanceDuration.equals(12), "hidden boundaries must not truncate silent playback");
});

test("default rest shows 1 and needs an explicit onset meter", () => {
    const compiled = compileValid("@meter(4,4) | @rest() |");
    assert(compiled.lowering.duration.equals(4), "default count must be one");
    assert(recordCommands(compiled.layout).some(command => command.kind === "text" && command.text === "1"),
        "single-measure rest must display 1");
    expectCompileError("@rest(2)", "E_REST_METER");
});

test("rest-only columns insert a shared pause before other voices' notes", () => {
    for (const [content, hostName] of [["@rest(2)", "rest"], ["@up(@rest(2), @text(X))", "up"]]) {
        const result = lower(`@meter(4,4)\nN: | ${content} |\nN: | 1 2 3 4 |`);
        const restColumn = result.columns.find(column => column.some(node => named(node, hostName)))!;
        strictEqual(restColumn.length, 1, "rest hosts must never merge with other voices' notes");
        const notes = result.columns.flat().filter(node => named(node, "note"));
        deepStrictEqual(notes.map(node => node.t.toString()), ["8", "9", "10", "11"]);
        assert(result.duration.equals(12), "shared pause must push subsequent music and the final endpoint");
        deepStrictEqual(playedNotes(compilePlayback(result)).map(note => note.start.toString()), ["8", "9", "10", "11"]);
        assert(result.diagnostics.some(diagnostic => diagnostic.code === "W_METER_MISMATCH"),
            "the last virtual measure includes following notes without a separating bar");
    }
    const chord = lower('@meter(4,4)\nN: | @up(@rest(2),1) |\nN: | 1234 |');
    deepStrictEqual(chord.columns.flat().filter(node => named(node, "note")).map(node => node.t.toString()), ["8", "9", "10", "11"]);
});

test("simultaneous rests add their maximum duration once and emit boundaries once", () => {
    for (const [content, hostName] of [["@rest(2)", "rest"], ["@up(@rest(2), @text(X))", "up"]]) {
        const compiled = compileValid(`@set(strict=true) @meter(4,4)\nN: | ${content} |\nN: | @rest(3) |`);
        const column = compiled.lowering.columns.find(column => column.some(node => named(node, hostName)))!;
        strictEqual(column.length, 2);
        assert(column.every(node => node.t.equals(0)), "members of one rest column must start together");
        deepStrictEqual(column.map(node => node.T.toString()), ["8", "12"]);
        assert(compiled.lowering.duration.equals(12), "durations must not be summed across voices");
        deepStrictEqual(compiled.lowering.columns.flat().filter(node => node.mergeKey === ANCHOR_KEY && !node.box)
            .map(node => node.t.toString()), ["4", "8"]);
    }
});

test("same-time meter precedes a rest column regardless of voice order", () => {
    for (const voices of [
        "N: | @rest(2) |\nN: | @meter(3,4) @rest(1) |",
        "N: | @meter(3,4) @rest(1) |\nN: | @rest(2) |",
    ]) {
        const compiled = compileValid(`@meter(4,4)\n${voices}`);
        assert(compiled.lowering.duration.equals(6), "all rests must use the actual onset meter");
        deepStrictEqual(compiled.lowering.columns.flat().filter(node => named(node, "rest"))
            .map(node => node.T.toString()).sort(), ["3", "6"]);
    }
});

test("serial rests freeze onset meters and preserve exact fractional durations", () => {
    const result = compileValid("@meter(4,4) | @rest(2) | @meter(3,4) @rest(2) |").lowering;
    deepStrictEqual(result.columns.flat().filter(node => named(node, "rest")).map(node => [node.t.toString(), node.T.toString()]),
        [["0", "8"], ["8", "6"]]);
    assert(result.duration.equals(14), "serial offsets must accumulate");
    const fractional = compileValid("@meter(5,6) | @rest(3) |").lowering;
    assert(fractional.duration.equals(10), "fractional measures must remain exact");
    deepStrictEqual(fractional.columns.flat().filter(node => node.mergeKey === ANCHOR_KEY && !node.box)
        .map(node => node.t.toString()), ["10/3", "20/3"]);
});

test("invisible boundaries preserve strict first and last measure validation", () => {
    for (const source of [
        "@set(strict=true) @meter(4,4) | 1 @rest(2) |",
        "@set(strict=true) @meter(4,4) | @rest(2) 1234 |",
        "@set(strict=true) @meter(4,4) | @rest(1) 1 |",
    ]) {
        const diagnostic = expectCompileError(source, "E_METER_MISMATCH");
        assert(diagnostic.span.start <= diagnostic.span.end, "virtual boundary diagnostics must have a valid source range");
    }
    compileValid("@set(strict=true) @meter(4,4) @rest(3)");
    compileValid("@set(strict=true) @meter(4,4) 1 | @rest(2) |");
});

for (const content of ["@rest(2)", "@up(@rest(2), @text(X))"]) {
    test(`${content}: silence respects tempo and repeats without duplicate spans`, () => {
        const compiled = compileValid(`@tempo(60) @meter(4,4) |: ${content} :|`);
        const playback = compilePlayback(compiled.lowering);
        strictEqual(playedNotes(playback).length, 0);
        assert(playback.performanceDuration.equals(16), "the whole rest must repeat");
        assert(nearly(playback.durationSeconds, 16), "tempo must apply to the whole silent interval");
    });
}

test("rest has fixed minimum graphical width, size-based anchor, thick bar and right clearance", () => {
    for (const size of [16, 32]) {
        const layout = layoutOf(`@meter(4,4) | @rest(3,width=80px,size=${size}px) |`);
        const rest = layout.objects.find(node => named(node, "rest"))!;
        strictEqual(rest.box.anchor, size * 0.4);
        const commands = recordCommands(layout);
        const lines = commands.filter(command => command.kind === "line");
        strictEqual(lines.length, 3);
        const [bar, left, right] = lines;
        assert(nearly(bar.style?.strokeWidth ?? 0, size * 0.24)
            && nearly(left.style?.strokeWidth ?? 0, size * 0.12), "horizontal stroke must be twice the caps");
        const number = commands.filter(command => command.kind === "text").find(command => command.text === "3")!;
        const numberGap = bar.y1 - (bar.style?.strokeWidth ?? 0) / 2 - number.y;
        assert(nearly(numberGap, size * 0.255), "the number must sit close to the horizontal stroke at every size");
        assert(nearly(left.x1 - size * 0.06, rest.box.x), "painted left edge must match the box left edge");
        const paintedRight = right.x1 + size * 0.06;
        assert(paintedRight - rest.box.x >= 80 - 1e-6, "width must reserve at least the requested graphical width");
        assert(nearly(rest.box.x + rest.box.w - paintedRight, size * 0.25), "right gap must be reserved in the ordinary box");
        const [svg] = renderLayoutPagesToSvg(layout);
        assert(!svg.includes("NaN") && !svg.includes("Infinity") && svg.includes(">3</text>"), "SVG must draw one finite rest");
    }
});

test("rest keeps compact symmetric bar gaps and rejects invalid arguments or sustain", () => {
    for (const fillRatio of [0, 2]) {
        const layout = layoutOf(`@page(fillRatio=${fillRatio}) @meter(2,4) | @rest(20,width=80px,size=16px) |`);
        const rest = layout.objects.find(node => named(node, "rest"))!;
        const bars = layout.objects.filter(node => named(node, "bar"));
        const paintedWidth = rest.box.w - 16 * 0.25;
        const leftGap = rest.box.x - (bars[0].box.x + bars[0].box.w);
        const rightGap = bars[1].box.x - (rest.box.x + paintedWidth);
        assert(nearly(leftGap, 4) && nearly(rightGap, 4), `fillRatio=${fillRatio}`);
    }

    for (const count of ["0", "-1", "1.5", "9007199254740992"]) {
        expectCompileError(`@meter(4,4) @rest(${count})`, "E_REST_COUNT");
    }
    expectCompileError("@meter(4,4) @rest(2,size=0px)", "E_REST_SIZE");
    expectCompileError("@meter(4,4) | @rest(2) | -", "E_REST_SUSTAIN");
    expectCompileError("@meter(4,4) | @rest(2) | @up(-,1)", "E_REST_SUSTAIN");
    compileValid("@meter(2,4) | @rest(2) | @up(1,-) 2 |");
});

test("labeled rests preserve volta layout and composite wrappers propagate timing", () => {
    const compiled = compileValid(`@meter(4,4) |: 1234 | @rest(4)@a :| 5671 | @volta(a,a,1)`);
    const playback = compilePlayback(compiled.lowering);
    assert(playback.performanceDuration.equals(28), "rest must play only on the first pass");
    assert(recordCommands(compiled.layout).some(command => command.kind === "text" && command.text === "1."),
        "volta must retain its visible rest endpoint");

    for (const content of [
        '@up(@rest(2), @text(X))',
        '@grace(@rest(2), {1 2}, side=pre)',
        '@arp(@up(@rest(2), @text(X)))',
    ]) {
        const res = compileValid(`@set(strict=true) @meter(4,4) | ${content} | 1234 |`);
        assert(res.lowering.duration.equals(12), content);
        expectCompileError(`@set(strict=true) @meter(4,4) | 1 ${content} |`, "E_METER_MISMATCH");
        expectCompileError(`@meter(4,4) | ${content} | @up(-,1)`, "E_REST_SUSTAIN");
    }

    const chord = lower("@meter(4,4) @up(@rest(2), 1) 2");
    deepStrictEqual(playedNotes(compilePlayback(chord)).map(note => [note.start.toString(), note.end.toString()]), [["0", "8"], ["8", "9"]]);
    const secondary = lower("@meter(4,4) @up(1, @rest(2)) -");
    assert(secondary.columns.flat().find(node => named(node, "up"))!.T.equals(1) && secondary.duration.equals(2),
        "a non-host rest must not take over the fold's rhythm");
});
