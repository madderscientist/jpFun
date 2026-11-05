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
    ]) {
        const { syntax } = analyzeScoreSyntax(source);
        const help = parameterDocAt(source, syntax, position);
        assert.ok(help?.doc.includes(parameter), source);
    }
    for (const source of ["1 2 3", "@unknown(1)"]) {
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
    assert.equal(query("@up(1"), null);
    assert.equal(query("@page(width=100"), null);
    assert.equal(query("@unknown("), null);
});

test("parameter completion replaces the complete name but preserves its value", () => {
    for (const [source, expected] of [
        ["@page(heig=100px)", "@page(height=100px)"],
        ["@page(he", "@page(height="],
    ]) {
        const start = source.indexOf("he");
        const edit = parameterCompletionEdit(analyzeScoreSyntax(source).syntax, { start, end: start + 2 }, "height");
        assert.equal(source.slice(0, edit.span.start) + edit.text + source.slice(edit.span.end), expected);
    }
});