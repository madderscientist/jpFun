import { test } from "node:test";
import { deepStrictEqual } from "node:assert";

import { ASTFunctionNode, type ASTNodeBase, type FunctionArgs, type FunctionDef, type paramValue } from "../src/functions/ASTtypes.js";
import { ParserContext } from "../src/parser/parserContext.js";
import { compileScore } from "../src/pipeline.js";
import { assert, commandsOfKind, compileValid, createParser, expectDiagnostic, layoutOf, nearly } from "./helpers.js";

test("自定义变量允许与原型属性同名，并保留假值", () => {
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

test("仅命名选项不占用位置参数，必需的位置参数仍会校验", () => {
    class OptionsFunction extends ASTFunctionNode {
        static override def: FunctionDef = {
            name: "options", description: "", details: "", allowExtraArgs: true, extraArgType: "content",
            args: [
                { name: "style", type: "string", default: "[-]", namedOnly: true },
                { name: "count", type: "number", default: null },
            ],
        };
    }
    const node = new OptionsFunction({ start: 0, end: 0 });
    const context = new ParserContext({ source: "" });
    context.variables["options.style"] = "";
    const args: FunctionArgs = new Map<string | number, paramValue>([[0, 7], [1, "extra"]]);
    deepStrictEqual(node.getArgValue(args, context), ["", 7]);
    args.set("style", "{-}");
    deepStrictEqual(node.getArgValue(args, context), ["{-}", 7]);
    expectDiagnostic(() => node.getArgValue(new Map([["style", "[-]"]]), context), "E_MISSING_REQUIRED_ARG");
});

test("别名写法归一到主名", () => {
    const [digit] = commandsOfKind(`@set(n.color=#f00) 1`, "text");
    assert(digit.style.fill === "#f00", `alias must reach note.color, got ${digit.style.fill}`);
});

test("长度默认值与 em 字号按声明类型和当前字号解析", () => {
    for (const source of ["@set(text.size=2em) @text(A)", "@set(fontsize=2em) @text(A, size=1em)"]) {
        assert(nearly(layoutOf(source).objects[0].ast.size, 44), source);
    }
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

test("voice connection defaults preserve empty strings, scopes and final block arity", () => {
    const source = [
        '@set(vs.connect="[-2]{3-}")',
        "N: 1", "N: 2", "N: 3", "N: 4", "",
        "{", '@set(voices.connect="")', "N: 5", "N: 6", "}", "",
        "N: 1", "N: 2", "N: 3", "",
        'V|:', "N: 1", "N: 2",
    ].join("\n");
    const result = compileValid(source);
    const values: string[] = [];
    const visit = (node: ASTNodeBase) => {
        if (node instanceof ASTFunctionNode && node.callName === "voices") {
            values.push([...node.toString(source).matchAll(/connect="([^"]*)"/g)].at(-1)![1]);
        }
        for (const child of node.children ?? []) visit(child);
    };
    visit(result.ast);
    deepStrictEqual(values, ["[-2]{3-}", "", "[-2]{3-}", ""]);
});
