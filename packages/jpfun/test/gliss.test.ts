import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { WarningDiagnostic } from "../src/diagnostic.js";
import { ASTFunctionNode } from "../src/functions/ASTtypes.js";
import { GlissNode } from "../src/functions/gliss/index.js";
import { layoutDocument } from "../src/layout/engine.js";
import { compilePlayback } from "../src/playback/compile.js";
import { compileScore } from "../src/pipeline.js";
import { renderLayoutPagesToSvg } from "../src/render/svg.js";
import {
    assert, attachmentCommands, compileValid, expectCompileError, layoutContext,
    lower, nearly, playedNotes,
} from "./helpers.js";

function gliss(source: string, noPitch = false) {
    const compiled = compileScore(source);
    deepStrictEqual(compiled.diagnostics.map(item => item.code), noPitch ? ["W_GLISS_NO_PITCH"] : [], source);
    if (noPitch) {
        const warning = compiled.diagnostics[0];
        assert(warning instanceof WarningDiagnostic && warning.message.includes("没有"), "missing pitch must produce a warning");
        assert(source.slice(warning.span.start, warning.span.end).startsWith("@gliss("), "warning must point at gliss");
    }
    const attachment = compiled.layout.attachments.at(-1)!;
    const path = attachmentCommands(attachment).find(command => command.kind === "path");
    assert(path?.kind === "path", "gliss must paint a path");
    const [start, end] = path.commands;
    assert(start.op === "M" && end.op === "L", "gliss must start with a straight shaft");
    return { ...compiled, attachment, path, start, end };
}

test("gliss draws upward, downward and unison arrows between explicit labels", () => {
    for (const [notes, direction] of [["1@a 5@b", -1], ["5@a 1@b", 1], ["1@a 1@b", 0]] as const) {
        const { layout, start, end, path } = gliss(`${notes} @gliss(a,b)`);
        const [from, to] = layout.objects;
        assert(start.x > from.box.x + from.box.w, "shaft must clear the source");
        assert(end.x < to.box.x, "arrowhead must clear the target");
        strictEqual(Math.sign(end.y - start.y), direction);
        strictEqual(path.commands.map(command => command.op).join(","), "M,L,M,L,L");
        assert(end.x - start.x >= from.ast.size * 0.6, "reserve a readable horizontal shaft");
    }
});

test("gliss uses the selected dash, searches its preceding pitch and clears dots and accidentals", () => {
    const { layout, start, end } = gliss("5 -@a - #1@b @gliss(a,b)");
    const [, from, laterDash, to] = layout.objects;
    assert(start.x > from.box.x + from.box.w && start.x < laterDash.box.x,
        "the selected dash, not the last dash, determines the visual start");
    assert(end.x < to.box.x && end.y > start.y, "preceding pitch determines slope while clearing accidentals");
    const dotted = gliss("1.@a 5@b @gliss(a,b)");
    assert(dotted.start.x > dotted.layout.objects[0].box.x + dotted.layout.objects[0].box.w,
        "source dots must remain before the shaft");
});

test("gliss orders positional endpoints by time regardless of argument order", () => {
    for (const source of [
        "1@a 5@b",
        "5@a 1@b",
        "1@a 1@b",
        "5 -@a - #1@b",
        "@up(1@a,3) 5@b",
        "5 @grace(-@a,1) 2@b",
        "@stack({1@a 0}, {0 5@b})",
        "@stack({0 5@b}, {1@a 0})",
        "5 @br() -@a 2@b",
    ]) {
        const forward = gliss(`${source} @gliss(a,b)`);
        const reverse = gliss(`${source} @gliss(b,a)`);
        deepStrictEqual(attachmentCommands(reverse.attachment), attachmentCommands(forward.attachment));
        deepStrictEqual(reverse.layout.objects.map(node => node.box), forward.layout.objects.map(node => node.box));
    }
});

test("gliss crosses tracks in either vertical direction on the same score line", () => {
    for (const source of [
        "@stack({1@a 0}, {0 5@b}) @gliss(a,b)",
        "@stack({0 5@b}, {1@a 0}) @gliss(a,b)",
    ]) {
        const { layout, start, end, attachment } = gliss(source);
        const [from, to] = layout.objects.filter(node => node.ast instanceof ASTFunctionNode
            && (node.ast.label === "a" || node.ast.label === "b"))
            .sort((a, b) => a.t.compare(b.t));
        assert(from.track !== to.track, "fixture must cross tracks");
        assert(nearly(start.y, from.box.y + from.box.visualAxis), "cross-track source uses its actual axis");
        assert(nearly(end.y, to.box.y + to.box.visualAxis), "cross-track target uses its actual axis");
        assert(attachment.box.w > 0 && attachment.box.h > 0, "cross-track bounds must be finite");
        assert(layout.bounds.h < 500, "cross-track occupancy must not repeatedly push tracks apart");
    }
});

test("gliss geometry scales with fontsize and does not accumulate spacing on relayout", () => {
    strictEqual(GlissNode.loweringFinalize, undefined);
    strictEqual(lower("1 2 3").attachments.length, 0);
    const small = gliss("@set(fontsize=20) 1@a 5@b @gliss(a,b)");
    const large = compileValid("1@a 5@b @gliss(a,b)", { variables: { fontsize: 40 } });
    const largePath = attachmentCommands(large.layout.attachments[0]).find(command => command.kind === "path")!;
    assert(largePath.kind === "path", "expected arrow path");
    assert(nearly(largePath.style!.strokeWidth!, small.path.style!.strokeWidth! * 2), "stroke scales with font size");
    for (const source of ["1@a 5@b @gliss(a,b)", "5 -@a 2@b @gliss(b,a)"]) {
        const lowered = lower(source);
        const first = layoutDocument(lowered, layoutContext);
        const expected = attachmentCommands(first.attachments[0]);
        const second = layoutDocument(lowered, layoutContext);
        deepStrictEqual(attachmentCommands(second.attachments[0]), expected);
    }
});

test("gliss retains the original playback and emits a portable SVG path", () => {
    const source = "1 -@a 5@b";
    const notes = (text: string) => playedNotes(compilePlayback(lower(text)))
        .map(note => [note.midi, note.start.toString(), note.end.toString()]);
    deepStrictEqual(notes(`${source} @gliss(a,b)`), notes(source));
    deepStrictEqual(notes(`${source} @gliss(b,a)`), notes(source));
    const { layout } = compileValid(`${source} @gliss(b,a)`);
    assert(renderLayoutPagesToSvg(layout)[0].includes("<path"), "SVG backend must draw the arrow");
});

test("gliss requires two positional labels and does not accept named or extra options", () => {
    for (const args of ["", "a", "from=a,to=b", "a=b,b=a", "a,to=b"]) {
        expectCompileError(`1@a 5@b @gliss(${args})`, "E_MISSING_REQUIRED_ARG");
    }
    for (const extra of ["play=true", "style=straight", "a"]) {
        const result = compileScore(`1@a 5@b @gliss(a,b,${extra})`);
        deepStrictEqual(result.diagnostics.map(item => item.code), ["W_TOO_MANY_POS_ARGS"]);
    }
});

test("gliss searches only the endpoint's track without interpreting composite types", () => {
    const composite = gliss("@grace(5,1) -@a 2@b @gliss(a,b)", true);
    assert(nearly(composite.end.y, composite.start.y), "a preceding composite without resolvedMidi is not unpacked");
    const dashHost = gliss("5 @grace(-@a,1) 2@b @gliss(a,b)");
    assert(dashHost.end.y > dashHost.start.y, "search can find pitch before an endpoint's layout host");
    gliss("@stack({5 -@a 0}, {1 0 2@b}) @gliss(a,b)");
    gliss("@stack({0 -@a 0}, {1 0 2@b}) @gliss(a,b)", true);
    gliss("@stack({-@a 0}, {1 0 2@b}) @gliss(a,b)", true);
});

test("gliss searches preceding columns across lines, zero-time markers and time gaps", () => {
    for (const source of [
        "5 @br() -@a 2@b @gliss(a,b)",
        "5 - @br() - -@a 2@b @gliss(a,b)",
        "5 | - -@a 2@b @gliss(a,b)",
        "@stack({5},{1 0}) -@a 2@b @gliss(a,b)",
    ]) {
        const result = gliss(source);
        assert(result.end.y > result.start.y, "preceding pitch is used even without continuous sustain");
    }
    const changedKey = gliss("5 @key(C5) -@a 2@b @gliss(a,b)");
    assert(changedKey.end.y < changedKey.start.y, "the preceding resolved pitch is not reinterpreted in the new key");
    for (const source of ["-@a 5@b", "0 -@a 5@b", "5 0 -@a 2@b", "-@a -@b"]) {
        const result = gliss(`${source} @gliss(a,b)`, true);
        assert(nearly(result.end.y, result.start.y), "missing or null pitch warns and falls back horizontally");
    }
});

test("gliss accepts arbitrary graphical endpoints and falls back horizontally without comparable pitches", () => {
    for (const [endpoints, noPitch] of [
        ["0@a 5@b", true],
        ["9@a 5@b", true],
        ["8@a 5@b", true],
        ["1@a -@b", false],
        ["{1^3}@a 5@b", true],
        ["1@a {5^3}@b", false],
        ["@meter(4,4) @rest(1)@a | 5@b 0 0 0", true],
        ["@adjust({0@a},dy=5px) 5@b", true],
    ] as const) {
        const result = gliss(`${endpoints} @gliss(a,b)`, noPitch);
        assert(nearly(result.end.y, result.start.y), "incomparable pitches must give a horizontal shaft");
        const reverse = gliss(`${endpoints} @gliss(b,a)`, noPitch);
        deepStrictEqual(attachmentCommands(reverse.attachment), attachmentCommands(result.attachment));
    }
    const result = gliss("@stack({0@a 0}, {0 5@b}) @gliss(a,b)", true);
    const [from, to] = result.layout.objects.filter(node => node.ast instanceof ASTFunctionNode
        && (node.ast.label === "a" || node.ast.label === "b")).sort((a, b) => a.t.compare(b.t));
    assert(nearly(result.start.y, from.box.y + from.box.visualAxis), "cross-track start retains its actual axis");
    assert(nearly(result.end.y, to.box.y + to.box.visualAxis), "cross-track end retains its actual axis");
    assert(!nearly(result.end.y, result.start.y), "cross-track endpoints remain connected rather than forced horizontal");
});

test("gliss warns once per attachment, including repeated geometry measurement and layout", () => {
    const source = "-@a 5@b @gliss(a,b)";
    const result = gliss(source, true);
    layoutDocument(result.lowering, layoutContext);
    layoutDocument(result.lowering, layoutContext);
    strictEqual(result.diagnostics.length, 1);
    const doubled = compileScore(`${source} @gliss(b,a)`);
    deepStrictEqual(doubled.diagnostics.map(item => item.code), ["W_GLISS_NO_PITCH", "W_GLISS_NO_PITCH"]);
});

test("gliss supports folded note labels, beams, boxes and explicit adjustments", () => {
    gliss("@set(div.autobeam=false) 1/@a 5/@b @beam(a,b) @gliss(a,b)");
    const plain = gliss("1@a 5@b @gliss(a,b)");
    const shifted = gliss("@adjust({1@a},dx=3px,dy=5px) 5@b @gliss(a,b)");
    assert(nearly(shifted.start.x - plain.start.x, 3), "arrow follows source dx");
    assert(nearly(shifted.start.y - plain.start.y, 5), "arrow follows source dy");
    const relationShift = gliss("1@a 5@b @adjust({@gliss(a,b)},dx=3px,dy=5px)");
    assert(nearly(relationShift.start.x - plain.start.x, 3), "arrow accepts attachment dx");
    assert(nearly(relationShift.end.y - plain.end.y, 5), "arrow accepts attachment dy");
    const boxed = compileValid("@box({1@a 5@b @gliss(a,b)})");
    assert(boxed.layout.attachments.length === 2, "box retains its contained arrow");
});

test("gliss leaves readable space on compact pages without stacking duplicate reservations", () => {
    for (const width of [60, 80, 130]) {
        const source = `@page(width=${width}px,left=5px,right=5px,fillRatio=2) 1@a 5@b @gliss(a,b)`;
        const single = gliss(source);
        const repeated = gliss(`${source} @gliss(a,b)`);
        assert(single.end.x - single.start.x >= single.layout.objects[0].ast.size * 0.6,
            "the shaft remains readable on a narrow page");
        deepStrictEqual(repeated.start, single.start);
        deepStrictEqual(repeated.end, single.end);
    }
});

test("gliss rejects simultaneous time, cross-line connections and overlapping endpoints", () => {
    expectCompileError("1@a 5@b @gliss(a,a)", "E_GLISS_ORDER");
    expectCompileError("@stack(1@a,5@b) @gliss(a,b)", "E_GLISS_ORDER");
    expectCompileError("@grace(5,{1@a 3@b @gliss(a,b)})", "E_GLISS_ORDER");
    expectCompileError("1@a @br() 5@b @gliss(a,b)", "E_GLISS_CROSS_LINE");
    expectCompileError("1@a @br() 5@b @gliss(b,a)", "E_GLISS_CROSS_LINE");
    expectCompileError("@adjust({1@a},dx=1000px) 5@b @gliss(a,b)", "E_GLISS_SPACE");
});
