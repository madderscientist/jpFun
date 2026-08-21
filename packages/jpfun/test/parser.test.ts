import { test } from "node:test";

import { preprocessSource } from "../src/parser/preprocess.js";
import { analyzeScoreSyntax } from "../src/pipeline.js";
import { assert, createParser, expectDiagnostic, expectSnapshot } from "./helpers.js";

const source = [
    "line-a \\\\",
    "line-b",
    "line-c \\   \t",
    "line-d",
    "line-e \\% trailing comment",
    "line-f",
    "line-g % comment only \\",
    "line-h \\% comment with escaped backslash \\\\",
    "line-i \"100% in string\" % comment after string \\",
    "line-j \\\\\\",
    "line-k \\\\% comment with escaped backslash \\\\",
    "end"
].join("\n");

test("续行与注释掩码保持源码长度和行首偏移", () => {
    const { maskedSource, lineStarts } = preprocessSource(source);
    assert(maskedSource.length === source.length, "掩码不能改变源码长度，否则所有 span 都会错位");
    expectSnapshot("parser-masked", [
        `length=${maskedSource.length}`,
        `masked=${JSON.stringify(maskedSource)}`,
        `lineStarts=${lineStarts.join(", ")}`,
    ].join("\n"));
});

test("未闭合的调用仍然向编辑器暴露语法信息", () => {
    const incomplete = `@page(width=800px, height= % comment`;
    const incompleteResult = analyzeScoreSyntax(incomplete);
    const syntax = incompleteResult.syntax;
    const text = (start: number, end: number) => incomplete.slice(start, end);
    assert(syntax.calls.length === 1, "an incomplete call must remain available to editor tooling");
    assert(syntax.calls[0].closeParenSpan === undefined, "an incomplete call must expose a missing close parenthesis");
    assert(
        syntax.tokens.some(token => token.kind === "function" && text(token.span.start, token.span.end) === "@page"),
        "syntax analysis must identify the written function name",
    );
    assert(
        syntax.tokens.some(token => token.kind === "property" && text(token.span.start, token.span.end) === "width"),
        "syntax analysis must identify named arguments",
    );
    assert(
        syntax.tokens.some(token => token.kind === "length" && text(token.span.start, token.span.end) === "800px"),
        "syntax analysis must classify values from function argument definitions",
    );
    assert(
        syntax.tokens.some(token => token.kind === "comment" && text(token.span.start, token.span.end).startsWith("%")),
        "syntax analysis must preserve comments masked before AST parsing",
    );
    assert(incompleteResult.diagnostics.length > 0, "an incomplete call must report a diagnostic without throwing");
});

test("变长内容暴露嵌套的 atom 与语法糖运算符", () => {
    const nested = analyzeScoreSyntax(`@voices(@voice({1/ 2}, A))`).syntax;
    assert(nested.tokens.some(token => token.kind === "atom"), "variadic content must expose atom syntax");
    assert(nested.tokens.some(token => token.kind === "operator"), "variadic content must expose sugar operators");
});

test("嵌套的未闭合调用同时保留可见性和错误", () => {
    const boundedResult = analyzeScoreSyntax(`{@page(width=1}`);
    assert(boundedResult.syntax.calls.some(call => call.name === "page"), "an incomplete nested call must remain visible");
    assert(boundedResult.diagnostics.some(item => item.code === "E_UNTERMINATED_CALL"), "an incomplete nested call must report its error");
});

test("命名参数与标签保留无歧义的字面量类型", () => {
    const typedExtras = `@set(fontsize=30) 1@a 2@b @tie(a,b,height=0.5em) @up(1,2)`;
    const typedSyntax = analyzeScoreSyntax(typedExtras).syntax;
    const hasToken = (kind: string, value: string) => typedSyntax.tokens.some(token =>
        token.kind === kind && typedExtras.slice(token.span.start, token.span.end) === value
    );
    assert(hasToken("number", "30"), "dynamic set values must use unambiguous literal types");
    assert(hasToken("label", "a") && hasToken("label", "b"), "tie endpoints must use its variadic label contract");
    assert(hasToken("length", "0.5em"), "unknown named arguments must retain unambiguous literal types");
    assert(typedSyntax.tokens.filter(token => token.kind === "atom").length >= 4, "up variadic content must expose nested atoms");
});

test("syntaxOnly 不改变被识别的语法节点", () => {
    const dual = `@set(fontsize=24)\n1 2/ 3. 5^1 @up(2,4) @div({1 2}) 6@x`;
    const grammarShape = (syntaxOnly: boolean) => createParser(dual)
        .parseGrammar(0, dual.length, syntaxOnly)
        .map(node => typeof node === "number"
            ? `text:${node}`
            : `${node.kind}:${node.span.start}-${node.span.end}`)
        .join(" ");
    assert(
        grammarShape(false) === grammarShape(true),
        "syntaxOnly must not change which GrammarNodes are recognized",
    );
    expectSnapshot("parser-grammar-shape", grammarShape(true));
});

test("参数不足的调用在严格与宽容模式下各自处理", () => {
    expectDiagnostic(() => createParser("@tie()").parse(), "E_NOT_ENOUGH_ARGS");

    const strictParser = createParser("@tie()");
    strictParser.strict = true;
    expectDiagnostic(() => strictParser.parseArgWithType(0, 6, "content"), "E_NOT_ENOUGH_ARGS");
    assert(strictParser.diagnostics.length === 0, "strict content parsing must not record a recovered diagnostic");

    const lenientParser = createParser("@tie()");
    lenientParser.strict = false;
    assert(lenientParser.parseArgWithType(0, 6, "content") === null,
        "non-strict content parsing must recover with null");
    assert(lenientParser.diagnostics.some(item => item.code === "E_NOT_ENOUGH_ARGS"),
        "non-strict content parsing must record the swallowed error");
    assert(lenientParser.diagnostics.some(item => item.code === "W_INVALID_CONTENT"),
        "non-strict content parsing must report its fallback");
});
