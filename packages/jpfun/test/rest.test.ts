import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { Fraction } from "../src/fraction.js";
import { ASTFunctionNode } from "../src/functions/ASTtypes.js";
import { ANCHOR_KEY, DEFAULT_KEY, type TemporalNodeBase } from "../src/functions/temporal.js";
import { layoutElement } from "../src/layout/model.js";
import { compileScore } from "../src/pipeline.js";
import { compilePlayback } from "../src/playback/compile.js";
import { renderLayoutPagesToSvg } from "../src/render/svg.js";
import {
    assert, compileValid, createLowering, expectCompileError,
    layoutOf, lower, nearly, parse, playedNotes, recordCommands,
} from "./helpers.js";

function named(node: TemporalNodeBase, name: string) {
    return node.ast instanceof ASTFunctionNode && node.ast.callName === name;
}

test("rest is one silent event with standard invisible internal boundaries", () => {
    const compiled = compileValid("@meter(4,4) | @rest(3) |");
    const rests = compiled.lowering.columns.flat().filter(node => named(node, "rest"));
    strictEqual(rests.length, 1);
    assert(rests[0].t.equals(0) && rests[0].T.equals(12), "rest must retain one full-duration event");
    const hidden = compiled.lowering.columns.flat().filter(node => node.mergeKey === ANCHOR_KEY && !node.box);
    deepStrictEqual(hidden.map(node => node.t.toString()), ["4", "8"]);
    assert(hidden.every(node => node.T.isZero() && node.track === rests[0].track && node.layoutLine === rests[0].layoutLine),
        "virtual boundaries must be zero-duration, same-track controls");
    const orders = [...compiled.lowering.astToTemporal.values()].flat().map(node => node.order);
    strictEqual(new Set(orders).size, orders.length);
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
    const result = lower("@meter(4,4)\nN: | @rest(2) |\nN: | 1 2 3 4 |");
    const restColumn = result.columns.find(column => column.some(node => named(node, "rest")))!;
    assert(restColumn.every(node => named(node, "rest")), "rest must never merge with notes");
    const notes = result.columns.flat().filter(node => named(node, "note"));
    deepStrictEqual(notes.map(node => node.t.toString()), ["8", "9", "10", "11"]);
    assert(result.duration.equals(12), "shared pause must push subsequent music and the final endpoint");
    deepStrictEqual(playedNotes(compilePlayback(result)).map(note => note.start.toString()), ["8", "9", "10", "11"]);
    assert(result.diagnostics.some(diagnostic => diagnostic.code === "W_METER_MISMATCH"),
        "the last virtual measure includes following notes without a separating bar");
});

test("simultaneous rests add their maximum duration once and emit boundaries once", () => {
    const compiled = compileValid("@meter(4,4)\nN: | @rest(2) |\nN: | @rest(3) |");
    const column = compiled.lowering.columns.find(column => column.some(node => named(node, "rest")))!;
    strictEqual(column.length, 2);
    assert(column.every(node => node.t.equals(0)), "members of one rest column must start together");
    deepStrictEqual(column.map(node => node.T.toString()), ["8", "12"]);
    assert(compiled.lowering.duration.equals(12), "durations must not be summed across voices");
    deepStrictEqual(compiled.lowering.columns.flat().filter(node => node.mergeKey === ANCHOR_KEY && !node.box)
        .map(node => node.t.toString()), ["4", "8"]);
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

test("rest silence respects tempo and repeats without duplicate spans", () => {
    const compiled = compileValid("@tempo(60) @meter(4,4) |: @rest(2) :|");
    const playback = compilePlayback(compiled.lowering);
    strictEqual(playedNotes(playback).length, 0);
    assert(playback.performanceDuration.equals(16), "the whole rest must repeat");
    assert(nearly(playback.durationSeconds, 16), "tempo must apply to the whole silent interval");
    deepStrictEqual(compilePlayback(compiled.lowering).events, playback.events);
});

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

test("rest springs have fixed natural lengths and stiffness regardless of silent duration", () => {
    for (const bars of ["| @rest(n) |", "@rest(n)", "| @rest(n)", "@rest(n) |"]) {
        for (const width of [200, 794]) {
            let expectedPositions: number[] | undefined;
            for (const meter of ["4,4", "5,6"]) {
                for (const count of [1, 4, 16]) {
                    const layout = layoutOf(`@page(width=${width}px,left=0px,right=0px,fillRatio=2) @meter(${meter}) ${bars.replace("n", String(count))}`);
                    const rest = layout.objects.find(node => named(node, "rest"))!;
                    const element = layoutElement(rest.springConfig, rest.box, rest);
                    assert(nearly(element.margin_L, 6) && nearly(element.margin_R, 6),
                        "both rest springs must keep a 6px natural length");
                    assert(nearly(element.config.beta_L / element.duration_L, 1 / 6)
                        && nearly(element.config.beta_R / element.duration_R, 1 / 6),
                        "default completion must preserve the same stiffness for different durations");
                    const positions = layout.objects.map(node => node.box.x);
                    const expected = expectedPositions;
                    if (expected) {
                        assert(positions.every((x, index) => nearly(x, expected[index])),
                            "changing the rest count or meter must not enlarge its neighboring gaps");
                    } else expectedPositions = positions;
                }
            }
        }
    }
});

test("rest keeps compact symmetric bar gaps even when the line fills", () => {
    for (const size of [16, 32]) {
        for (const width of [32, 400]) {
            for (const fillRatio of [0, 0.5, 2]) {
                const layout = layoutOf(`@page(fillRatio=${fillRatio}) @meter(2,4) | @rest(20,width=${width}px,size=${size}px) |`);
                const rest = layout.objects.find(node => named(node, "rest"))!;
                const bars = layout.objects.filter(node => named(node, "bar"));
                const paintedWidth = rest.box.w - size * 0.25;
                const leftGap = rest.box.x - (bars[0].box.x + bars[0].box.w);
                const rightGap = bars[1].box.x - (rest.box.x + paintedWidth);
                assert(nearly(leftGap, size * 0.25) && nearly(rightGap, leftGap),
                    `painted gaps must be symmetric and 0.25em under fillRatio=${fillRatio}`);
            }
        }
    }
    for (const source of [
        "@meter(4,4) | @rest(2) | @rest(3) |",
        "@meter(4,4) @rest(2) | @rest(3) |",
        "@meter(4,4) | @rest(2) | @rest(3)",
        "@meter(4,4)\nN: | @rest(2) | 1 2 3 4 |\nN: | @rest(2) | 5 6 7 1 |",
    ]) {
        const layout = layoutOf(`@page(fillRatio=0) ${source}`);
        for (const rest of layout.objects.filter(node => named(node, "rest"))) {
            const bars = layout.objects.filter(node => named(node, "bar") && node.track === rest.track);
            const before = bars.filter(bar => bar.box.x < rest.box.x).at(-1);
            const after = bars.find(bar => bar.box.x > rest.box.x);
            const gap = rest.ast.size * 0.25;
            const width = rest.box.w - gap;
            assert((!before || nearly(rest.box.x - before.box.x - before.box.w, gap))
                && (!after || nearly(after.box.x - rest.box.x - width, gap)),
                "shared bars and parallel voices must preserve both locked gaps");
        }
    }
});

test("rest supports ordinary wrappers and fresh repeated lowering", () => {
    const reference = recordCommands(layoutOf("@meter(4,4) | @rest(2) |")).find(command => command.kind === "line")!;
    for (const wrapper of [
        "@box(@rest(2))", "@box(@rest(2),width=160px)",
        "@adjust(@rest(2),dx=3px,dy=4px)", "@adjust(@rest(2),dw=40px,dh=12px)",
    ]) {
        const compiled = compileValid(`@meter(4,4) | ${wrapper} |`);
        assert(compiled.lowering.duration.equals(8), "visual wrappers must not change inserted time");
        const line = recordCommands(compiled.layout).find(command => command.kind === "line")!;
        assert(nearly(line.x2 - line.x1, reference.x2 - reference.x1),
            "wrapper occupancy must not resize the painted rest");
    }
    const context = createLowering();
    const ast = parse("@meter(4,4) | @rest(3) |");
    const first = context.lowerDocument(ast);
    const second = context.lowerDocument(ast);
    strictEqual(first.columns.length, second.columns.length);
    assert(first.columns[0][0] !== second.columns[0][0] && second.duration.equals(12), "no events may leak across compilations");
    const plain = context.lowerDocument(parse("1 2"));
    assert(plain.duration.equals(2) && plain.columns[1][0].t.equals(1), "meter and offsets must reset");
});

test("rest rejects invalid arguments, labels and sustain", () => {
    for (const count of ["0", "-1", "1.5", "9007199254740992"]) {
        expectCompileError(`@meter(4,4) @rest(${count})`, "E_REST_COUNT");
    }
    expectCompileError("@meter(4,4) @rest(2,size=0px)", "E_REST_SIZE");
    assert(compileScore("@meter(4,4) @rest(2)@a").diagnostics.some(diagnostic => diagnostic.code === "W_LABEL_WITHOUT_TARGET"),
        "labels must stop at rest and report the standard unbound-label warning");
    expectCompileError("@meter(4,4) | @rest(2) | -", "E_REST_SUSTAIN");
    expectCompileError("@meter(4,4) | @rest(2) | @up(-,1)", "E_REST_SUSTAIN");
    compileValid("@meter(2,4) | @rest(2) | @up(1,-) 2 |");
});

test("rest sustain checks use the host onset, not private grace members", () => {
    for (const side of ["pre", "post"]) {
        for (const content of [
            `@grace(1, -, side=${side})`,
            `@up({@grace(1, -, side=${side})}, @text(X))`,
            `@arp(@up({@grace(1, -, side=${side})}, @text(X)))`,
        ]) {
            compileValid(`@set(strict=true) @meter(4,4) | @rest(2) | ${content} 234 |`);
        }
        for (const content of [
            `@grace(-, 1, side=${side})`,
            `@up({@grace(-, 1, side=${side})}, @text(X))`,
            `@arp(@up({@grace(-, 1, side=${side})}, @text(X)))`,
        ]) {
            expectCompileError(`@meter(4,4) | @rest(2) | ${content}`, "E_REST_SUSTAIN");
        }
    }
});

test("rest hosts propagate timing through all composite wrappers", () => {
    for (const content of [
        '@up(@rest(2), @text(X))',
        '@down(@rest(2), @text(X))',
        '@up({@down(@rest(2), @text(X))}, @text(Y))',
        '@grace(@rest(2), {1 2}, side=pre)',
        '@grace(@rest(2), {1 2}, side=post)',
        '@grace(@rest(2), @rest(3), side=pre)',
        '@grace(@rest(2), @rest(3), side=post)',
        '@arp(@up(@rest(2), @text(X)))',
        '@up({@grace(@rest(2), {1 2})}, @text(X))',
        '@grace(@arp(@up(@rest(2), @text(X))), 1)',
    ]) {
        const compiled = compileValid(`@set(strict=true) @meter(4,4) | ${content} | 1234 |`);
        const nodes = compiled.lowering.columns.flat();
        const rest = [...compiled.lowering.astToTemporal.values()].flat().find(node =>
            named(node, "rest") && node.ast.toString("") === "@rest(2)")!;
        let host = rest;
        while (host.foldedInto) host = host.foldedInto;
        assert(host.T.equals(8) && rest.T.equals(8), `${content}: inner and outer duration must agree`);
        deepStrictEqual(nodes.filter(node => named(node, "note")).map(node => node.t.toString()), ["8", "9", "10", "11"]);
        deepStrictEqual(nodes.filter(node => node.mergeKey === ANCHOR_KEY && !node.box).map(node => node.t.toString()), ["4"]);
        assert(nodes.filter(node => node.mergeKey === ANCHOR_KEY && !node.box).every(node => node.ast.parent === rest.ast),
            "internal boundaries must belong to the actual rest host, not its private grace content");
        assert(compiled.lowering.duration.equals(12), `${content}: the outer endpoint must include the whole rest`);
        const playback = compilePlayback(compiled.lowering);
        assert(playback.performanceDuration.equals(12), `${content}: playback must preserve the full duration`);
        deepStrictEqual(playedNotes(playback).filter(note => note.start.compare(8) >= 0)
            .map(note => note.start.toString()), ["8", "9", "10", "11"]);
    }
});

test("folded and plain rests merge once and still precede other voices' notes", () => {
    const compiled = compileValid('@set(strict=true) @meter(4,4)\nN: | @up(@rest(2), @text(X)) |\nN: | @rest(3) |');
    const column = compiled.lowering.columns.find(nodes => nodes.some(node => named(node, "up")))!;
    strictEqual(column.length, 2);
    assert(column.every(node => node.t.isZero()), "all rest hosts must stay at the common onset");
    deepStrictEqual(column.map(node => node.T.toString()), ["8", "12"]);
    assert(compiled.lowering.duration.equals(12), "folding must not sum simultaneous pauses");
    deepStrictEqual(compiled.lowering.columns.flat().filter(node => node.mergeKey === ANCHOR_KEY && !node.box)
        .map(node => node.t.toString()), ["4", "8"]);

    const result = lower('@meter(4,4)\nN: | @up(@rest(2), @text(X)) |\nN: | 1234 |');
    deepStrictEqual(result.columns.flat().filter(node => named(node, "note")).map(node => node.t.toString()), ["8", "9", "10", "11"]);
    deepStrictEqual(playedNotes(compilePlayback(result)).map(note => note.start.toString()), ["8", "9", "10", "11"]);
    const chord = lower('@meter(4,4)\nN: | @up(@rest(2),1) |\nN: | 1234 |');
    deepStrictEqual(chord.columns.flat().filter(node => named(node, "note")).map(node => node.t.toString()), ["8", "9", "10", "11"]);
});

test("folded rest repeats and repeated lowering retain independent timing", () => {
    const source = '@tempo(60) @meter(4,4) |: @up(@rest(2), @text(X)) :|';
    const compiled = compileValid(source);
    const playback = compilePlayback(compiled.lowering);
    strictEqual(playedNotes(playback).length, 0);
    assert(playback.performanceDuration.equals(16) && nearly(playback.durationSeconds, 16),
        "the folded silent host must repeat in full at its onset tempo");
    deepStrictEqual(compilePlayback(compiled.lowering).events, playback.events);
    const context = createLowering();
    const ast = parse(source);
    const first = context.lowerDocument(ast);
    const second = context.lowerDocument(ast);
    assert(first.duration.equals(8) && second.duration.equals(8) && first.columns.length === second.columns.length,
        "folded host mappings and offsets must not leak between compilations");
    assert(first.columns.flat().find(node => named(node, "up")) !== second.columns.flat().find(node => named(node, "up")),
        "each lowering must create a fresh composite host");
});

test("rest combinations retain modifiers and the existing host-driven fold semantics", () => {
    for (const content of ["@div(@rest(2),1)", "@dot(@rest(2),1)", "@rest(2)/.",
        '@dot(@div(@up(@rest(2), @text(X))))']) {
        const result = lower(`@meter(4,4) | ${content} |`);
        const host = result.columns.flat().find(node => node.T.compare(0) > 0)!;
        assert(host.T.equals(8) && result.duration.equals(8), "modifiers must not shorten a whole-measure rest");
        assert(host.addon?.["@div"] || host.addon?.["@dot"], "visual modifiers must remain attached");
        const [svg] = renderLayoutPagesToSvg(layoutOf(`@meter(4,4) | ${content} |`));
        assert(!svg.includes("NaN") && !svg.includes("Infinity"), "decorated rests must have finite geometry");
    }
    const chord = lower("@meter(4,4) @up(@rest(2), 1) 2");
    const host = chord.columns.flat().find(node => named(node, "up"))! as TemporalNodeBase & { members: TemporalNodeBase[] };
    assert(host.T.equals(8) && host.members.every(node => node.T.equals(8)), "timed members must share the final host duration");
    deepStrictEqual(playedNotes(compilePlayback(chord)).map(note => [note.start.toString(), note.end.toString()]), [["0", "8"], ["8", "9"]]);

    const secondary = lower("@meter(4,4) @up(1, @rest(2)) -");
    const secondaryHost = secondary.columns.flat().find(node => named(node, "up"))!;
    assert(secondaryHost.T.equals(1) && secondaryHost.mergeKey === DEFAULT_KEY && secondary.duration.equals(2),
        "a non-host rest must not take over the fold's rhythm or merge group");
    strictEqual(secondary.columns.flat().filter(node => node.mergeKey === ANCHOR_KEY && !node.box).length, 0);
    compileValid("@meter(4,4) @grace(1, @rest(2))");
    const tuplet = lower("@meter(4,4) @tuplet({@rest(2) 1 2},3)");
    deepStrictEqual(tuplet.columns.flat().filter(node => named(node, "note")).map(node => [node.t.toString(), node.T.toString()]),
        [["8", "3/2"], ["19/2", "3/2"]]);
    assert(tuplet.duration.equals(11), "tuplet must keep its existing transformation of the ordinary notes");
    expectCompileError("@meter(4,4) @tuplet(@rest(2),2)", "E_TUPLET_EMPTY");
    expectCompileError("@meter(4,4) @arp(@rest(2))", "E_ARPEGGIO_INVALID_CONTENT");
    expectCompileError("@meter(4,4) @head(left=@rest(2))", "E_HEAD_NONZERO_DURATION");
});

test("folded rests preserve strict meter and sustain checks", () => {
    for (const content of [
        '@up(@rest(2), @text(X))',
        '@grace(@rest(2), 1)',
        '@arp(@up(@rest(2), @text(X)))',
    ]) {
        expectCompileError(`@set(strict=true) @meter(4,4) | 1 ${content} |`, "E_METER_MISMATCH");
        expectCompileError(`@meter(4,4) | ${content} | @up(-,1)`, "E_REST_SUSTAIN");
    }
});

test("folded rest bar gaps stay compact with filled lines and multiple voices", () => {
    const wrappers = [
        (rest: string) => `@up(${rest}, @text(X))`,
        (rest: string) => `@down(${rest}, @text(X))`,
        (rest: string) => `@up({@down(${rest}, @text(X))}, @text(Y))`,
    ];
    for (const size of [16, 32]) {
        for (const wrap of wrappers) {
            const source = `@page(fillRatio=0) @meter(4,4) | ${wrap(`@rest(2,width=80px,size=${size}px)`)} |`;
            const compiled = compileValid(source);
            const rest = [...compiled.lowering.astToTemporal.values()].flat().find(node => named(node, "rest"))!;
            const bars = compiled.layout.objects.filter(node => named(node, "bar"));
            const caps = recordCommands(compiled.layout).filter(command => command.kind === "line")
                .filter(command => nearly(command.style?.strokeWidth ?? 0, size * 0.12));
            assert(nearly(rest.box!.x - bars[0].box.x - bars[0].box.w, size * 0.25),
                "folding must not unlock the left bar gap");
            assert(nearly(bars[1].box.x - caps[1].x1 - size * 0.06, size * 0.25),
                "folding must not unlock the right bar gap");
        }
    }
    for (const voices of [
        'N: | @up(@rest(2,size=16px), @text(X)) | @rest(3,size=16px) |\nN: | @rest(2,size=32px) | @down(@rest(3,size=32px), @text(Y)) |',
        'N: | @rest(2,size=32px) | @down(@rest(3,size=32px), @text(Y)) |\nN: | @up(@rest(2,size=16px), @text(X)) | @rest(3,size=16px) |',
    ]) {
        const actual = compileValid(`@page(fillRatio=0) @meter(4,4)\n${voices}`).layout;
        const expected = compileValid(`@page(fillRatio=0) @meter(4,4)\n${voices.replace(/@up\((@rest\([^)]*\)), @text\(X\)\)/g, "$1")
            .replace(/@down\((@rest\([^)]*\)), @text\(Y\)\)/g, "$1")}`).layout;
        assert(actual.objects.every((node, index) => nearly(node.box.x + node.box.anchor, expected.objects[index].box.x + expected.objects[index].box.anchor)),
            "folded/plain voice order must not change the fixed horizontal columns");
    }
});

test("rest shifts nested parallel successors without replacing the existing merge", () => {
    const result = lower("@meter(4,4) @stack({@stack({@rest(2)},{@rest(1)}) 1},{2 3}) 4");
    const notes = result.columns.flat().filter(node => named(node, "note"));
    deepStrictEqual(notes.map(node => node.t.toString()), ["8", "8", "9", "10"]);
    assert(result.duration.equals(11), "nested successors must use the shared insertion once");
});

test("duration is recomputed from long actual endpoints, not the old duration plus offset", () => {
    const result = lower("@meter(1,4) @stack(@dot(1,3), {0 @rest()})");
    const held = result.columns.flat().find(node => named(node, "note"))!;
    assert(held.T.equals(15, 8) && held.t.isZero(), "an event already started must keep its duration");
    assert(result.duration.equals(2), "the inserted rest ends at 2, not the old 15/8 duration plus 1");
    assert(lower("@meter(1,4) @stack(@dot(1,3), {0/ @rest()})").duration.equals(15, 8),
        "a track ending before the rest must still contribute its longer endpoint");
});

test("relations, folded meters, lyrics and endpoint line breaks keep existing behavior", () => {
    const dynamic = compileValid("@meter(4,4) 1@a 234 | @rest(2) | 2@b 345 | @dyn(a,b,20)");
    const notes = dynamic.lowering.columns.flat().filter(node => named(node, "note"));
    assert(notes[4].t.equals(12) && dynamic.lowering.duration.equals(16), "dynamic endpoints must use final times");
    compileValid("@up(1,@meter(3,4)) 23 | @rest(2) |");
    const lines = compileValid("@meter(4,4) | @rest(2) | @br() @rest(2) |");
    strictEqual(lines.layout.lineCount, 2);
    deepStrictEqual(lines.lowering.columns.flat().filter(node => node.mergeKey === ANCHOR_KEY && !node.box)
        .map(node => [node.t.toString(), node.layoutLine]), [["4", 0], ["12", 1]]);
    const lyrics = compileValid("@meter(4,4)\nN: | @rest(2) | 1234 |\nL: a b c d");
    strictEqual(recordCommands(lyrics.layout).filter(command => command.kind === "text" && ["a", "b", "c", "d"].includes(command.text)).length, 4);
});

test("rest expansion handles large counts in one silent event", () => {
    const result = compileValid("@meter(4,4) | @rest(1000) |").lowering;
    strictEqual(result.columns.flat().filter(node => named(node, "rest")).length, 1);
    strictEqual(result.columns.flat().filter(node => node.mergeKey === ANCHOR_KEY && !node.box).length, 999);
    assert(result.duration.equals(new Fraction(4000)), "all virtual bars must leave total duration unchanged");
});
