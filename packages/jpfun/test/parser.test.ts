import { test } from "node:test";

import { ASTLabelNode, ASTNodeBase } from "../src/functions/ASTtypes.js";
import { preprocessSource } from "../src/parser/preprocess.js";
import { analyzeScoreSyntax } from "../src/pipeline.js";
import { assert, createParser, expectDiagnostic, expectSnapshot, parse } from "./helpers.js";

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

test("引号必须配对才算字符串", () => {
    const paired = preprocessSource(`"100% in string" % comment`);
    assert(paired.commentSpans.length === 1, "配对引号内的 % 不是注释");

    // 未配对引号若开启字符串状态，后文所有 % 都会失去注释语义
    const unpaired = preprocessSource(`5" 英寸\n% comment`);
    assert(unpaired.commentSpans.length === 1, "孤立引号之后的 % 仍然是注释");

    const escaped = preprocessSource(`"a\\" % b" 1`);
    assert(escaped.commentSpans.length === 0, "转义引号不闭合字符串");
});

test("head 行语法糖只标记前缀并递归显式内容", () => {
    const source = `H.title: jpFun 简谱示例
H.title: @box(@text(测试))`;
    const syntax = analyzeScoreSyntax(source).syntax;
    const tokenText = (token: typeof syntax.tokens[number]) => source.slice(token.span.start, token.span.end);
    assert(syntax.tokens.some(token => token.kind === "operator" && tokenText(token) === "H.title:"),
        "head declaration prefix must be one operator token");
    assert(!syntax.tokens.some(token => tokenText(token) === "H.title: jpFun 简谱示例"),
        "bare head text must not be included in the operator token");
    assert(!syntax.tokens.some(token => token.kind === "atom" && tokenText(token) === "F"),
        "bare head text must not be scanned as note sugar");
    assert(syntax.tokens.some(token => token.kind === "function" && tokenText(token) === "@box")
        && syntax.tokens.some(token => token.kind === "function" && tokenText(token) === "@text"),
    "explicit head content must retain nested function tokens");

    const first = createParser(source).parseGrammar(0, source.length)[0];
    assert(typeof first !== "number" && first.kind === "sugar"
        && tokenText({ kind: "operator", span: first.span }) === "H.title:",
    "parseGrammar must emit a short head sugar node");
    assert(typeof first !== "number" && first.kind === "sugar"
        && Object.keys(first.data).sort().join(",") === "class,field",
    "head sugar data must contain only dispatch class and field");
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
    expectDiagnostic(() => strictParser.parseArgWithType({ start: 0, end: 6 }, "content"), "E_NOT_ENOUGH_ARGS");
    assert(strictParser.diagnostics.length === 0, "strict content parsing must not record a recovered diagnostic");

    const lenientParser = createParser("@tie()");
    lenientParser.strict = false;
    assert(lenientParser.parseArgWithType({ start: 0, end: 6 }, "content") === null,
        "non-strict content parsing must recover with null");
    assert(lenientParser.diagnostics.some(item => item.code === "E_NOT_ENOUGH_ARGS"),
        "non-strict content parsing must record the swallowed error");
    assert(lenientParser.diagnostics.some(item => item.code === "W_INVALID_CONTENT"),
        "non-strict content parsing must report its fallback");
});

test("标签的 target 指向被标注对象，不随容器改写", () => {
    const labelsOf = (root: ASTNodeBase) => {
        const found: ASTLabelNode[] = [];
        const visit = (node: ASTNodeBase) => {
            if (node instanceof ASTLabelNode) found.push(node);
            for (const child of node.children ?? []) visit(child);
        };
        visit(root);
        return found;
    };

    // 根 ASTBraceNode 会把顶层节点的 parent 改写成自己，target 必须幸免
    const flat = parse(`1@x 2@y`);
    const flatLabels = labelsOf(flat);
    assert(flatLabels.length === 2, "every bound label must stay reachable through children");
    assert(flatLabels[0].target.sourceSpan.start === 0 && flatLabels[1].target.sourceSpan.start === 4,
        "a label target must be the annotated node, not the container that adopted the label");
    assert(flatLabels.every(label => label.parent === flat),
        "parent must keep meaning the AST container");

    // 同名标签可以反复使用，各自指向自己那个对象
    const reused = labelsOf(parse(`1@x 2@y @tie(x,y) 3@x 4@y @tie(x,y)`));
    assert(reused.filter(label => label.label === "x").map(label => label.target.sourceSpan.start).join() === "0,18",
        "reusing a label name must bind each declaration to its own object");

    const nested = labelsOf(parse(`@div({1@x})`));
    assert(nested.length === 1 && nested[0].target.sourceSpan.start === 6,
        "a label nested in braces must still point at the annotated node");
});
