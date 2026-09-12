import { test } from "node:test";
import { deepStrictEqual } from "node:assert";

import { ASTFunctionNode, type FunctionArgs, type FunctionDef, type paramValue } from "../src/functions/ASTtypes.js";
import { ParserContext } from "../src/parser/parserContext.js";
import { compileScore } from "../src/pipeline.js";
import { assert, commandsOfKind, createParser, layoutOf, nearly } from "./helpers.js";

test("system variable declarations share types and reset defaults", () => {
    for (const [name, type, input, expected] of [
        ["fontsize", "length", "2em", 44], ["font", "string", '"Ordinary"', "Ordinary"],
        ["numberfont", "string", '"Digits"', "Digits"], ["strict", "boolean", "false", false],
    ] as const) {
        const parser = createParser(`@set(${name}=${input})`);
        parser.parse();
        deepStrictEqual([ParserContext.systemVariables[name].type, parser.variables[name], parser.diagnostics],
            [type, expected, []]);
        parser.setVariable(name, undefined);
        deepStrictEqual(parser.variables[name], ParserContext.systemVariables[name].default);
    }
    const parser = createParser('@set(constructor="Custom", tostring="Other")');
    parser.parse();
    deepStrictEqual([parser.variables.constructor, parser.variables.tostring, parser.diagnostics], ["Custom", "Other", []]);
    for (const name of ["custom", "constructor", "toString"]) {
        for (const value of [false, 0, "", undefined]) {
            parser.setVariable(name, value);
            deepStrictEqual(parser.variables[name], value);
        }
    }
});

test("通用参数解析保留 0、false 和空字符串", () => {
    class ValueFunction extends ASTFunctionNode {
        static override def: FunctionDef = {
            name: "value", description: "", details: "", allowExtraArgs: false,
            args: [
                { name: "count", type: "number", default: 1 },
                { name: "enabled", type: "boolean", default: true },
                { name: "label", type: "string", default: "Default" },
            ],
        };
    }
    const context = new ParserContext({ source: "" });
    const node = new ValueFunction({ start: 0, end: 0 });
    context.variables = { "value.count": 2, "value.enabled": true, "value.label": "Preset" };
    const positional: FunctionArgs = new Map<string | number, paramValue>([[0, 0], [1, false], [2, ""]]);
    deepStrictEqual(node.getArgValue(positional, context), [0, false, ""]);
    const named: FunctionArgs = new Map<string | number, paramValue>([
        ["count", 0], ["enabled", false], ["label", ""], [0, 2], [1, true], [2, "Position"],
    ]);
    deepStrictEqual(node.getArgValue(named, context), [0, false, ""]);
    context.variables = { "value.count": 0, "value.enabled": false, "value.label": "" };
    deepStrictEqual(node.getArgValue(new Map(), context), [0, false, ""]);
});

test("默认值按目标参数的声明类型固化", () => {
    // 旧实现把值一律存成 raw text，length 类型的默认值到不了 length2px
    const size = layoutOf(`@set(text.size=2em) @text(A)`).objects[0].ast.size;
    assert(nearly(size, 44), `expected 2em to freeze to 44px, got ${size}`);
});

test("别名写法归一到主名", () => {
    const [digit] = commandsOfKind(`@set(n.color=#f00) 1`, "text");
    assert(digit.style.fill === "#f00", `alias must reach note.color, got ${digit.style.fill}`);
});

test("fontsize 写 em 时相对当前字号", () => {
    const size = layoutOf(`@set(fontsize=2em) @text(A, size=1em)`).objects[0].ast.size;
    assert(nearly(size, 44), `expected 2em to resolve against 22px, got ${size}`);
});

test("bool 默认值不会被当成非空字符串", () => {
    // 旧实现存字符串 "false"，恒为真，反而打开了 strict
    const { diagnostics } = compileScore(`@set(strict=false) @nosuchfn()`);
    assert(diagnostics.some(item => item.code === "W_UNKNOWN_FUNCTION"),
        "strict=false must keep the unknown function tolerant");
});

test("目标参数不存在时报警而不是静默无效", () => {
    for (const target of ["text.sizee", ...["note", "n", "key", "meter", "tuplet", "head", "symbol", "volta", "voice", "v", "voices", "vs"].map(name => `${name}.font`)]) {
        const source = `@set(${target}="Unused")`;
        const parser = createParser(source);
        parser.parse();
        deepStrictEqual(parser.diagnostics.map(item => [item.code, source.slice(item.span.start, item.span.end)]),
            [["W_SET_UNKNOWN_TARGET", target]]);
        assert(!Object.hasOwn(parser.variables, target), "unknown target must not be stored");
    }
});
