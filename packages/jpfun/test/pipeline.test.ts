import { test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";

import { preprocessSource } from "../src/parser/preprocess.js";
import { compileScore } from "../src/pipeline.js";
import { compilePlayback } from "../src/playback/compile.js";
import { assert, recordCommands } from "./helpers.js";

test("compileScore forwards root variables without mutating the input", () => {
    const variables = { fontsize: 30, font: "Ordinary", numberfont: "Digits", strict: false, custom: "kept" };
    const result = compileScore('@text("hello") 1 @set(font="Changed", custom="updated")', { variables });
    const texts = recordCommands(result.layout).filter(command => command.kind === "text");
    assert(texts.some(command => command.style.fontFamily === "Ordinary"), "ordinary font must be forwarded");
    assert(texts.some(command => command.style.fontFamily === "Digits" && command.style.fontSize === 30), "numeric font and px size must be forwarded");
    deepStrictEqual(variables, { fontsize: 30, font: "Ordinary", numberfont: "Digits", strict: false, custom: "kept" });
});

test("desugaring preserves wrappers, typed defaults and tie endpoints", () => {
    for (const source of [
        "N: @box({1 2}, padding=2px, stroke=2px, width=80px)",
        "N: @adjust({1 2}, dx=2px, dy=-1px, dw=3px, dh=4px)",
        "N: @set(fontsize=30, text.size=0.5em) 1 2",
        "N: 1@a 1@b @tie(a,b,height=12px)",
        "N: 1 1 @tie(height=12px)",
        "@set(note.acc=#) 1",
    ]) {
        const before = compileScore(source);
        const replacement = before.ast.toString(source);
        const after = compileScore(replacement);
        deepStrictEqual(after.diagnostics, [], replacement);
        assert(after.lowering.duration.equals(before.lowering.duration), "desugaring must preserve duration");
        deepStrictEqual(recordCommands(after.layout), recordCommands(before.layout));
        const notes = (result: typeof before) => compilePlayback(result.lowering).events
            .filter(event => event.kind === "note-on").map(event => [event.midi, event.at.toString()]);
        deepStrictEqual(notes(after), notes(before));
    }
});

test("compileScore 一次性返回可直接渲染的完整结果", () => {
    const source = "1 % comment\n2 | 3";
    const compiled = compileScore(source);
    assert(compiled.layout.objects.length === 4, "compileScore must return a directly renderable layout");
    assert(compiled.lowering.columns.length === 4, "compileScore must preserve the complete lowering result");
    assert(compiled.diagnostics.length === 0, "valid default pipeline input must not create diagnostics");
    assert(compiled.maskedSource === preprocessSource(source).maskedSource,
        "compileScore must expose the offset-preserving preprocessing result");
});

test("多声部跨行乐谱的轨道、歌词与连音线", () => {
    const compiled = compileScore(`@voices(
    @voice({1@a}, A),
    @voice({2}, B),
    @voice({3}, C, "春")
)
@br()
@voices(
    @voice({4@b}, A),
    @voice({5}, B),
    @voice({@stack({6},{7})}, C)
)
@tie(a,b)`);
    assert(compiled.layout.lineCount === 2, "the integration score must contain two systems");
    assert(
        new Set(compiled.layout.objects.map(object => object.track)).size === 4,
        "the integration score must contain three voice lanes plus one temporary stack lane",
    );
    assert(
        !compiled.layout.objects.some(object => object.track === compiled.lowering.rootTrack),
        "no voice may reuse the empty host track of a voices block",
    );
    const commands = recordCommands(compiled.layout);
    assert(
        commands.some(command => command.kind === "text" && command.text === "春"),
        "the integration score must render lyrics",
    );
    assert(
        commands.filter(command => command.kind === "path").length >= 2,
        "the integration score must render a cross-system tie",
    );
});
