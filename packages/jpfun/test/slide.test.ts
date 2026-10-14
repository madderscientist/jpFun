import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { SlideNode } from "../src/functions/slide/index.js";
import { layoutDocument } from "../src/layout/engine.js";
import { compilePlayback } from "../src/playback/compile.js";
import { renderLayoutPagesToSvg } from "../src/render/svg.js";
import { assert, attachmentCommands, compileValid, expectCompileError, expectSnapshot, layoutContext, lower, nearly, playedNotes } from "./helpers.js";

test("slide SVG snapshot covers all four directions and note decorations", () => {
    const { layout } = compileValid(`
        @slide(#5'.) 3
        @slide(b3'., direction=down) 3
        @slide(#5'., side=post) 3
        @slide(b3'., side=post, direction=down) 3
    `);
    expectSnapshot("slide-svg", renderLayoutPagesToSvg(layout).join("\n"));
});

test("slide draws the four directions outside its host", () => {
    for (const side of ["pre", "post"]) {
        for (const direction of ["up", "down"]) {
            const { layout } = compileValid(`1 @slide(#5., side=${side}, direction=${direction}) 3`);
            const host = layout.objects[1];
            const path = attachmentCommands(layout.attachments[0]).find(item => item.kind === "path");
            assert(path?.kind === "path", "slide paints a path");
            const [start, end] = path.commands;
            assert(start.op === "M" && end.op === "L", "straight arrow shaft");
            strictEqual(Math.sign(end.y - start.y), direction === "up" ? -1 : 1);
            assert(end.x > start.x, "arrow follows time");
            assert(nearly(Math.abs(end.y - start.y), end.x - start.x), "shaft is exactly 45 degrees");
            assert(nearly(Math.max(start.y, end.y), host.box.y + host.box.visualAxis),
                "lower endpoint lies on the digit centerline");
            assert(nearly(Math.min(start.y, end.y), host.box.y + host.ports["shoulder"].y - host.ast.size * 0.1),
                "upper endpoint sits slightly above the digit top");
            if (side === "pre") {
                assert(end.x < host.box.x && start.x > layout.objects[0].box.x + layout.objects[0].box.w, "left space clears neighbors");
            } else {
                assert(start.x > host.box.x + host.box.w && end.x < layout.objects[2].box.x, "right space clears neighbors");
            }
        }
    }
});

test("slide decorates only the boundary and accepts composite and unpitched content", () => {
    for (const content of ["{1^3}", "-", "0", "@grace(1,2)", "@box({1 2})"]) {
        for (const side of ["pre", "post"]) {
            const result = compileValid(`@slide(${content}, side=${side})`);
            strictEqual(result.layout.attachments.filter(item => item.sourceSpan?.start === 0).length, 1);
        }
    }
    for (const side of ["pre", "post"]) {
        const { layout } = compileValid(`@slide({1 2 3}, side=${side})`);
        strictEqual(layout.attachments.length, 1);
        const path = attachmentCommands(layout.attachments[0]).find(item => item.kind === "path");
        assert(path?.kind === "path", "one boundary arrow");
        const first = path.commands[0];
        assert(first.op === "M", "arrow starts with move");
        assert(side === "pre" ? first.x < layout.objects[0].box.x : first.x > layout.objects[2].box.x, "correct boundary");
    }
});

test("slide preserves playback and is stable on repeated layout", () => {
    const notes = (source: string) => playedNotes(compilePlayback(lower(source)))
        .map(note => [note.midi, note.start.toString(), note.end.toString()]);
    deepStrictEqual(notes("@slide({1 - 5}, side=post)"), notes("1 - 5"));
    const document = lower("@slide(1) 2");
    const first = layoutDocument(document, layoutContext);
    const commands = attachmentCommands(first.attachments[0]);
    const boxes = first.objects.map(node => ({ ...node.box }));
    const second = layoutDocument(document, layoutContext);
    deepStrictEqual(attachmentCommands(second.attachments[0]), commands);
    deepStrictEqual(second.objects.map(node => node.box), boxes);
    strictEqual(SlideNode.loweringFinalize, undefined);
});

test("slide supports local layouts, nesting and multi-line content", () => {
    for (const source of [
        "@grace(1,@slide(2))",
        "@up(1,@slide(3))",
        "@box(@slide(1))",
        "@slide(@slide(1), side=post)",
        "@slide({1 @br() 2}, side=post)",
        "@adjust(@slide(1), dx=2px, dy=3px)",
    ]) {
        const result = compileValid(source);
        assert(result.layout.bounds.w > 0 && result.layout.bounds.h > 0, source);
        assert(!renderLayoutPagesToSvg(result.layout).join("").includes("NaN"), "finite SVG geometry");
    }
    const once = compileValid("1 @slide(2) 3");
    const twice = compileValid("1 @slide(@slide(2)) 3");
    deepStrictEqual(twice.layout.objects.map(node => node.box), once.layout.objects.map(node => node.box));
});

test("slide scales with the host font and validates arguments", () => {
    const width = (size: number) => compileValid(`@set(fontsize=${size}) @slide(1)`).layout.attachments[0].box.w;
    assert(nearly(width(40), width(20) * 2), "arrow scales with font");
    expectCompileError("@slide(1, side=bad)", "E_SLIDE_SIDE");
    expectCompileError("@slide(1, direction=bad)", "E_SLIDE_DIRECTION");
    expectCompileError("@slide({})", "E_SLIDE_CONTENT");
    expectCompileError("@slide()", "E_MISSING_REQUIRED_ARG");
});
