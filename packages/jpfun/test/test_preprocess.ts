import { analyzeScoreSyntax } from "../src/pipeline.js";
import { defaultFunctions } from "../src/functions/default.js";
import { ParserContext } from "../src/parser/parserContext.js";
import { preprocessSource } from "../src/parser/preprocess.js";

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

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

const { maskedSource, lineStarts } = preprocessSource(source);

console.log("=== before ===");
console.log(source);
console.log(source.length);
console.log("=== after ===");
console.log(maskedSource);
console.log(maskedSource.length);
console.log("=== escaped(after) ===");
console.log(JSON.stringify(maskedSource));
console.log("=== lineStarts ===");
console.log(lineStarts.join(", "));

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

const nested = analyzeScoreSyntax(`@voices(@voice({1/ 2}, A))`).syntax;
assert(nested.tokens.some(token => token.kind === "atom"), "variadic content must expose atom syntax");
assert(nested.tokens.some(token => token.kind === "operator"), "variadic content must expose sugar operators");

const bounded = `{@page(width=1}`;
const boundedResult = analyzeScoreSyntax(bounded);
const boundedSyntax = boundedResult.syntax;
assert(boundedSyntax.calls.some(call => call.name === "page"), "an incomplete nested call must remain visible");
assert(boundedResult.diagnostics.some(item => item.code === "E_UNTERMINATED_CALL"), "an incomplete nested call must report its error");

const typedExtras = `@set(fontsize=30) 1@a 2@b @tie(a,b,height=0.5em) @up(1,2)`;
const typedSyntax = analyzeScoreSyntax(typedExtras).syntax;
const hasToken = (kind: string, value: string) => typedSyntax.tokens.some(token =>
    token.kind === kind && typedExtras.slice(token.span.start, token.span.end) === value
);
assert(hasToken("number", "30"), "dynamic set values must use unambiguous literal types");
assert(hasToken("label", "a") && hasToken("label", "b"), "tie endpoints must use its variadic label contract");
assert(hasToken("length", "0.5em"), "unknown named arguments must retain unambiguous literal types");
assert(typedSyntax.tokens.filter(token => token.kind === "atom").length >= 4, "up variadic content must expose nested atoms");

const dual = `@set(fontsize=24)\n1 2/ 3. 5^1 @up(2,4) @div({1 2}) 6@x`;
const grammarShape = (syntaxOnly: boolean) => {
    const parser = new ParserContext({ source: dual });
    parser.registerFunctions(defaultFunctions);
    return parser.parseGrammar(0, dual.length, syntaxOnly)
        .map(node => typeof node === "number"
            ? `text:${node}`
            : `${node.kind}:${node.span.start}-${node.span.end}`)
        .join(" ");
};
assert(
    grammarShape(false) === grammarShape(true),
    "syntaxOnly must not change which GrammarNodes are recognized",
);
