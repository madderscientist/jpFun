import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeScoreSyntax, compileScore } from "jpfun";
import { completionsAt, labelJumpAt, labelSymbolAt, parameterCompletionEdit, parameterDocAt } from "@jpfun/editor-tools/language";

test("parameter help handles incomplete, named and nested calls", () => {
    for (const [source, position, parameter] of [
        ["@br(", 4, "offset"],
        ["@page(width=120px, height=200px)", 15, "width"],
        ["@page(width=120px, height=200px)", 28, "height"],
        ["@up(1, @br(2))", 12, "offset"],
        ["@set(fontsize=20px)", 10, "18px"],
        ["@set(n.octave=5)", 14, "@note"],
    ]) {
        const { syntax } = analyzeScoreSyntax(source);
        const help = parameterDocAt(source, syntax, position);
        assert.ok(help?.doc.includes(parameter), source);
    }
    for (const source of ["1 2 3", "@unknown(1)", "@set()", "@set(note.)"]) {
        assert.equal(parameterDocAt(source, analyzeScoreSyntax(source).syntax, source.length - 1), null);
    }
});

test("label references bind to their own declaration, including repeated names", () => {
    const source = "% \uD834\uDD1E\n1@a 2@b @tie(a,b) 3@a 4@b @tie(a,b)";
    const { syntax } = analyzeScoreSyntax(source);
    for (const [declaration, reference] of [
        [source.indexOf("@a") + 1, source.indexOf("a,b")],
        [source.lastIndexOf("@a") + 1, source.lastIndexOf("a,b")],
    ]) {
        const expected = { name: "a", declaration: { start: declaration, end: declaration + 1 },
            references: [{ start: reference, end: reference + 1 }] };
        assert.deepEqual(labelSymbolAt(source, syntax, declaration - 1), expected);
        assert.deepEqual(labelSymbolAt(source, syntax, reference), expected);
    }
});

test("label jumps use AST targets or fall back to declarations without an AST", () => {
    const source = "1@a 2@b @tie(a,b)";
    const { syntax } = analyzeScoreSyntax(source);
    const position = source.indexOf("a,b");
    const fallback = labelJumpAt(source, syntax, position);
    assert.equal(source.slice(fallback.target.start, fallback.target.end), "@a");
    const jump = labelJumpAt(source, syntax, position, compileScore(source).ast);
    assert.equal(source.slice(jump.target.start, jump.target.end), "1");
    assert.deepEqual(jump.reference, fallback.reference);
    assert.equal(labelJumpAt(source, syntax, source.indexOf("@a")), null);
    const unresolved = "@tie(missing, other)";
    const analysis = analyzeScoreSyntax(unresolved).syntax;
    assert.equal(labelJumpAt(unresolved, analysis, 6), null);
    assert.equal(labelSymbolAt(unresolved, analysis, 6), null);
});

test("shared completion candidates preserve function, symbol, parameter and label rules", () => {
    const query = (source, pos = source.length) => completionsAt(source, analyzeScoreSyntax(source).syntax, pos);
    assert.ok(query("@br").candidates.some(item => item.kind === "function" && item.label === "@br"));
    assert.ok(query("$tr").candidates.some(item => item.kind === "symbol" && item.label === "$tr"));
    const parameters = query("@page(width=100px, he").candidates;
    assert.ok(parameters.some(item => item.kind === "parameter" && item.label === "height"));
    assert.ok(!parameters.some(item => item.label === "width"));
    const labels = query("1@a 2@b @tie(").candidates.filter(item => item.kind === "label");
    assert.deepEqual(labels.map(item => item.label), ["a", "b"]);
    const setStage1 = query("@set(tie.height=1em, ").candidates.map(item => item.label);
    assert.ok(setStage1.includes("fontsize") && setStage1.includes("note") && !setStage1.includes("tie") && !setStage1.includes("n"));
    assert.deepEqual(query("@set(n.color=#f00, note.").candidates.map(item => item.label), ["name", "acc", "octave"]);
    assert.deepEqual(query("@set(tie.").candidates.map(item => item.label), ["height"]);
    for (const source of ["@up(1", "@page(width=100", "@unknown(", "@set(fontsize=20", "@set(unknown."]) {
        assert.equal(query(source), null, source);
    }
});

test("parameter completion replaces the complete name but preserves its value", () => {
    for (const [source, pos, name, expected] of [
        ["@page(heig=100px)", 8, "height", "@page(height=100px)"],
        ["@page(he", 8, "height", "@page(height="],
        ["@set(fo=20px)", 7, "fontsize", "@set(fontsize=20px)"],
        ["@set(no", 7, "note", "@set(note."],
        ["@set(note.oc", 12, "octave", "@set(note.octave="],
        ["@set(note.oct=5)", 12, "octave", "@set(note.octave=5)"],
    ]) {
        const syntax = analyzeScoreSyntax(source).syntax;
        const edit = parameterCompletionEdit(syntax, completionsAt(source, syntax, pos).range, name);
        assert.equal(source.slice(0, edit.span.start) + edit.text + source.slice(edit.span.end), expected);
    }
});