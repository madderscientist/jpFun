import { deepStrictEqual, throws } from "node:assert/strict";
import { test } from "node:test";

import { Diagnostic } from "../src/diagnostic.js";
import { ASTLabelNode, ASTNodeBase, ASTTextNode } from "../src/functions/ASTtypes.js";
import { DashNode } from "../src/functions/dash/index.js";
import { readCall } from "../src/parser/parse-utils/call-utils.js";
import { preprocessSource } from "../src/parser/preprocess.js";
import { analyzeScoreSyntax, compileScore } from "../src/pipeline.js";
import { assert, createParser, expectDiagnostic, parse } from "./helpers.js";

test("numeric arguments reject infinities and overflowing lengths", () => {
    for (const value of ["Infinity", "-Infinity", "1e309"]) {
        const result = compileScore(`@div(1, ${value})`);
        assert(result.diagnostics.some(item => item.code === "W_INVALID_NUMBER"), "non-finite numbers must be diagnosed");
        assert(result.lowering.duration.equals(1, 2), "invalid count must fall back to one division");
    }
    const result = compileScore(`@set(fontsize=${"9".repeat(309)}px) 1`);
    assert(result.diagnostics.some(item => item.code === "W_INVALID_LENGTH"), "overflowing length must be diagnosed");
    assert(result.layout.objects.every(node => Number.isFinite(node.box.w) && Number.isFinite(node.box.x)), "fallback geometry must be finite");
    for (const source of ["@div(1, 1024)", "@dot(1, 1024)", "@dot(@dot(1, 800), 800)"]) {
        throws(() => compileScore(source), RangeError, "finite counts must not hang when fraction arithmetic overflows");
    }
});

test("key octave parsing consumes the entire value", () => {
    for (const tonality of ["C4junk", "C4#"]) {
        expectDiagnostic(() => compileScore(`@key(${tonality}) 1`, { variables: { strict: true } }), "E_KEY_TONALITY");
        assert(compileScore(`@key(${tonality}) 1`).diagnostics.some(item => item.code === "W_KEY_TONALITY"), "invalid spelling must be diagnosed");
    }
    assert(compileScore("@key(C#4) 1").diagnostics.length === 0, "canonical spelling must remain valid");
});

test("续行与注释掩码保持源码长度和行首偏移", () => {
    for (const [source, expected] of [
        ["1\\\n2", "1  2"],
        ["1\\ % comment\n2", `1${" ".repeat(12)}2`],
        ["1\\\\\n2", "1 \\\n2"],
        ['"100%"\n% comment\n2', `"100%"\n${" ".repeat(9)}\n2`],
    ]) {
        const { maskedSource, lineStarts } = preprocessSource(source);
        deepStrictEqual(maskedSource, expected);
        deepStrictEqual(maskedSource.length, source.length);
        deepStrictEqual(lineStarts, [0, ...[...source.matchAll(/\n/g)].map(match => match.index + 1)]);
    }
});

test("CRLF preprocessing masks CR outside strings without shifting source spans", () => {
    for (const [source, expected] of [
        ["1\r\n2", "1 \n2"],
        ["1\r\n\r\n2", "1 \n \n2"],
        ['"a\r\n% b"\r\n2', '"a\r\n% b" \n2'],
        ["1\\\r\n2", "1   2"],
        ["1\\\\\r\n2", "1 \\ \n2"],
        ["1\r2", "1\r2"],
    ]) {
        const result = preprocessSource(source);
        deepStrictEqual(result.maskedSource, expected);
        deepStrictEqual(result.maskedSource.length, source.length);
        deepStrictEqual(result.lineStarts, [
            0, ...[...source.matchAll(/\r\n|\r|\n/g)].map(match => match.index + match[0].length),
        ]);
        deepStrictEqual(result.commentSpans, []);
    }
    const source = '1 % comment\r\n@div(1, nope)';
    const result = preprocessSource(source);
    deepStrictEqual(result.commentSpans, [{ start: source.indexOf("%"), end: source.indexOf("\r") }]);
    deepStrictEqual(result.maskedSource, `1${" ".repeat(source.indexOf("\n") - 1)}\n@div(1, nope)`);
    const { syntax } = analyzeScoreSyntax(source);
    deepStrictEqual(syntax.calls[0].span.start, source.indexOf("@div"));
    const diagnostic = compileScore(source).diagnostics.find(item => item.code === "W_INVALID_NUMBER")!;
    deepStrictEqual(diagnostic.span, { start: source.indexOf("nope"), end: source.indexOf("nope") + 4 });
});

test("引号必须配对才算字符串", () => {
    for (const [source, comments] of [
        [`"100% in string" % comment`, 1],
        [`5" 英寸\n% comment`, 1],
        [`"a\\" % b" 1`, 0],
    ] as const) {
        deepStrictEqual(preprocessSource(source).commentSpans.length, comments, source);
    }
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

});

test("readCall locates first top-level equals, resets at commas and preserves empty args", () => {
    const call = readCall('x@f(, a=b=c, "k=v", @g(k=v), {k=v,(}, =x=y, key = "a=b"', 1, 55)!;
    deepStrictEqual(
        call.args.map(arg => [
            arg.nameSpan ? "x@f(, a=b=c, \"k=v\", @g(k=v), {k=v,(}, =x=y, key = \"a=b\"".slice(arg.nameSpan.start, arg.nameSpan.end) : null,
            "x@f(, a=b=c, \"k=v\", @g(k=v), {k=v,(}, =x=y, key = \"a=b\"".slice(arg.valueSpan.start, arg.valueSpan.end),
        ]),
        [[null, ""], ["a", "b=c"], [null, '"k=v"'], [null, "@g(k=v)"], [null, "{k=v,(}"], [null, "=x=y"], ["key", '"a=b"']],
    );
    deepStrictEqual(call.closeParenSpan, undefined);
    for (const empty of ["@f()", "@f( )", "@f(", "@f( "]) {
        deepStrictEqual(readCall(empty, 0, empty.length)?.args, [], empty);
    }
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

test("voice connection declarations are complete operator tokens, not notes or bars", () => {
    for (const marker of ["V{}:", "V[]:", "V|:", "V{钢琴}:", "V[合唱]:", 'V{"Piano [I]"}:']) {
        for (const source of [`  ${marker} % group\nN: 1\nN: 2`, `1 ${marker}N:1 N:2`, `{${marker} N:1 N:2}`]) {
            const { syntax, diagnostics } = analyzeScoreSyntax(source);
            deepStrictEqual(diagnostics, []);
            const start = source.indexOf(marker);
            const end = start + marker.length;
            deepStrictEqual(syntax.tokens.filter(token => token.span.start >= start && token.span.start < end),
                [{ kind: "operator", span: { start, end } }], `${marker} must be a single complete operator`);
        }
    }
    for (const incomplete of ["V", "V{", "V{}", "V{钢琴", "V{钢琴}", "V[", "V[]", "V[合唱", "V[合唱]", 'V{"unclosed}:', "V|"]) {
        analyzeScoreSyntax(incomplete);
    }
    for (const source of ['"V{}: V[]: V|:"', "N:1\nL: V{}: V[]: V|:", "% V{}: V[]: V|:"]) {
        const { syntax } = analyzeScoreSyntax(source);
        assert(!syntax.tokens.some(token => token.kind === "operator" && /^V/.test(source.slice(token.span.start, token.span.end))),
            "strings, lyrics and comments must not start connection groups");
    }
});

test("嵌套的未闭合调用同时保留可见性和错误", () => {
    const boundedResult = analyzeScoreSyntax(`{@page(width=1}`);
    assert(boundedResult.syntax.calls.some(call => call.name === "page"), "an incomplete nested call must remain visible");
    assert(boundedResult.diagnostics.some(item => item.code === "E_UNTERMINATED_CALL"), "an incomplete nested call must report its error");
});

test("语法 token 在跨越被掩码注释时保持有序、不重叠且不越界", () => {
    const samples = [
        `1 @gliss(a, b)\n\n% 滑音连接非常自由\n1@a 2 3@b`,
        `N: 1 2\nL: 啦 啦 % 行尾注释\nN: 3 4`,
        `@text(第一行 % 参数内注释\n第二行)`,
        `1 \\ % 续行注释\n2`,
    ];
    for (const source of samples) {
        const { tokens } = analyzeScoreSyntax(source).syntax;
        let offset = 0;
        for (const token of tokens) {
            assert(token.span.start < token.span.end && token.span.end <= source.length,
                "token span must be nonempty and inside the source");
            assert(token.span.start >= offset, `token [${token.span.start}, ${token.span.end}) overlapped previous end ${offset}`);
            offset = token.span.end;
        }
    }
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
});

test("参数不足的调用在严格与宽容模式下各自处理", () => {
    expectDiagnostic(() => createParser("@tie()").parse(), "E_NOT_ENOUGH_ARGS");

    const strictParser = createParser("@tie()");
    strictParser.setVariable("strict", true);
    expectDiagnostic(() => strictParser.parseArgWithType({ start: 0, end: 6 }, "content"), "E_NOT_ENOUGH_ARGS");
    assert(strictParser.diagnostics.length === 0, "strict content parsing must not record a recovered diagnostic");

    const lenientParser = createParser("@tie()");
    lenientParser.setVariable("strict", false);
    assert(lenientParser.parseArgWithType({ start: 0, end: 6 }, "content") === null,
        "non-strict content parsing must recover with null");
    assert(lenientParser.diagnostics.some(item => item.code === "E_NOT_ENOUGH_ARGS"),
        "non-strict content parsing must record the swallowed error");
    assert(lenientParser.diagnostics.some(item => item.code === "W_INVALID_CONTENT"),
        "non-strict content parsing must report its fallback");
});

test("content recovery discards failed inner labels while preserving valid outer labels", () => {
    const parser = createParser("@head(center={1 @tie()}) 2");
    const nodes = parser.parse();
    deepStrictEqual(parser.labelableNodes, [nodes.at(-1)]);
    deepStrictEqual(parser.diagnostics.map(item => item.code), ["E_NOT_ENOUGH_ARGS", "W_INVALID_CONTENT"]);
    expectDiagnostic(() => compileScore("@head(center={1 @tie()}) 2 @tie()"), "E_NOT_ENOUGH_ARGS");
    expectDiagnostic(() => compileScore("1 @head(center={@x @tie()}) 2 @tie(x)"), "E_UNKNOWN_LABEL");

    for (const source of ["@div({1@x}) 2@y @tie(x,y)", "1 @div({@x}) 2@y @tie(x,y)"]) {
        const result = compileScore(source);
        deepStrictEqual(result.diagnostics, []);
        assert(result.lowering.attachments.length === 1, "successful labels must remain valid tie endpoints");
    }
});

test("增时线独立承载标签，时值包装透明，小节线保持透明", () => {
    for (const dash of ["-", "-/.", "@dash()", "@div(-,1)", "@box(-)"]) {
        const parser = createParser(`1@a ${dash}@b`);
        parser.parse();
        const targets = parser.labelableNodes.filter(node => node?.label);
        assert(targets.length === 2 && targets[0]?.label === "a"
            && targets[1] instanceof DashNode && targets[1].label === "b",
        "the dash must carry its own label without replacing the preceding note label");
        assert(parser.diagnostics.length === 0, "labeling a dash must not warn");
    }
    const parser = createParser(`1 |@a`);
    parser.parse();
    assert(parser.labelableNodes.length === 1 && parser.labelableNodes[0]?.label === "a",
        "bar lines must remain transparent to labels");
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

    for (const source of ["1 ^ $p @a", "1 ^ 2 @a", "1 ^ (2)"]) {
        const root = parse(source);
        if (source.includes("@a")) {
            const labels = labelsOf(root);
            assert(labels.length === 1 && labels[0].label === "a", `${source} must retain its ASTLabelNode in the AST`);
        } else {
            assert(root.content.some(node => node instanceof ASTTextNode), `${source} must retain JE bracket text nodes`);
        }
    }
});

test("后缀语法糖包装带标签目标时保留标签，合并重复后缀时更新源码跨度", () => {
    for (const source of [
        "1@a / 2@b @tie(a,b)",
        "1@a . 2@b @tie(a,b)",
        "1@a /. 2@b @tie(a,b)",
        "1/ @a / 2@b @tie(a,b)",
    ]) {
        const before = compileScore(source);
        deepStrictEqual(before.diagnostics, [], source);
        const first = before.ast.content[0];
        const replaced = first.toString(source) + source.slice(first.sourceSpan.end);
        const after = compileScore(replaced);
        deepStrictEqual(after.diagnostics, [], replaced);
        assert(after.lowering.attachments.some(item => "endPoints" in item),
            `replacing ${source} with ${replaced} must preserve the labeled tie endpoint`);
    }

    for (const source of ["1/ /", "1. .", "1@a / /"]) {
        const node = parse(source).content[0];
        deepStrictEqual(node.sourceSpan, { start: 0, end: source.length }, source);
    }
});

test("诊断保留结构化参数并支持自定义格式化", () => {
    const missing = expectDiagnostic(() => compileScore("@meter(4)"), "E_MISSING_REQUIRED_ARG");
    deepStrictEqual(missing.params, { fn: "meter", arg: '"den"' });

    const meter = compileScore("@meter(4, 4) | 1 2 3 |").diagnostics.find(item => item.code === "W_METER_MISMATCH")!;
    deepStrictEqual(meter.params, { duration: "3", num: "4", den: "4" });

    const symbol = compileScore("$foo").diagnostics.find(item => item.code === "W_UNKNOWN_SYMBOL")!;
    deepStrictEqual(symbol.params, { name: "foo" });

    const originalFormat = Diagnostic.format;
    try {
        Diagnostic.format = (code, message, params) =>
            code === "W_METER_MISMATCH" && params
                ? JSON.stringify(params)
                : originalFormat(code, message, params);
        const custom = compileScore("@meter(4, 4) | 1 2 3 |").diagnostics.find(item => item.code === "W_METER_MISMATCH")!;
        deepStrictEqual(JSON.parse(custom.message), custom.params);
    } finally {
        Diagnostic.format = originalFormat;
    }
});
