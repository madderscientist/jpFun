import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { ASTFunctionNode, type ASTNodeBase } from "../src/functions/ASTtypes.js";
import { compileScore } from "../src/pipeline.js";
import { JIANPU_NUMBER_FONT, defaultTextMeasurer } from "../src/render/text.js";
import type { TextStyle } from "../src/render/types.js";
import { createParser, createLowering, layoutContext, recordCommands } from "./helpers.js";
import { ASTBraceNode } from "../src/functions/ASTtypes.js";
import { layoutDocument } from "../src/layout/engine.js";

const cases = [
    { name: "note", call: "@note(1", text: "1" },
    { name: "key", call: "@key(C", text: "1=" },
    { name: "meter", call: "@meter(4,4", text: "4" },
    { name: "tuplet", call: "@tuplet({1 2 4},2", text: "3" },
] as const;

function findFunction(node: ASTNodeBase, name: string): ASTFunctionNode | undefined {
    if (node instanceof ASTFunctionNode && node.callName === name) return node;
    for (const child of node.children ?? []) {
        const found = findFunction(child, name);
        if (found) return found;
    }
    return undefined;
}

for (const entry of cases) {
    test(`${entry.name}: scoped numberfont, shared styles and serialization`, () => {
        const escapedFont = 'Custom "Face", Back\\Slash';
        for (const [settings, argument, expected] of [
            ['', '', JIANPU_NUMBER_FONT],
            ['@set(font="Ordinary", numberfont="")', '', JIANPU_NUMBER_FONT],
            [`@set(numberfont="Global", ${entry.name}.font="Preset")`, ', font="Explicit"', 'Global'],
            [`@set(numberfont=${JSON.stringify(escapedFont)})`, '', escapedFont],
        ] as const) {
            const source = `${settings} ${entry.call}${argument}) @set(numberfont="Later")`;
            const measured: { text: string; style: TextStyle }[] = [];
            const compiled = compileScore(source, {
                textMeasurer: {
                    measureText(text, style) {
                        measured.push({ text, style: { ...style } });
                        return defaultTextMeasurer.measureText(text, style);
                    },
                },
            });
            equal(compiled.diagnostics.filter(item => item.code === "W_SET_UNKNOWN_TARGET").length, settings.includes(`${entry.name}.font=`) ? 1 : 0);
            const drawn = recordCommands(compiled.layout).find(command => command.kind === "text" && command.text === entry.text);
            ok(drawn?.kind === "text");
            equal(drawn.style.fontFamily, expected, source);
            const measurement = measured.find(item => item.text === (entry.name === "note" ? "0" : entry.text)
                && item.style.fontFamily === expected);
            ok(measurement, source);
            deepEqual(drawn.style, measurement.style);
            const ast = findFunction(compiled.ast, entry.name);
            ok(ast);
            const serialized = ast.toString(source);
            ok(!serialized.includes("font="));
            const replay = compileScore(`${settings} ${serialized}`);
            const replayText = recordCommands(replay.layout).find(command => command.kind === "text" && command.text === entry.text);
            ok(replayText?.kind === "text");
            equal(replayText.style.fontFamily, expected);
        }
    });
}

test("numberfont scopes restore and parsed AST remains frozen during lowering/layout", () => {
    const parser = createParser('@set(numberfont="Outer") 1 { @set(numberfont="Inner") 2 } 3');
    const ast = new ASTBraceNode({ start: 0, end: parser.source.length }, parser.parse());
    const freeze = (node: ASTNodeBase) => {
        for (const child of node.children ?? []) freeze(child);
        Object.freeze(node);
    };
    freeze(ast);
    parser.setVariable("numberfont", "Later");
    const layout = layoutDocument(createLowering().lowerDocument(ast), layoutContext);
    const texts = recordCommands(layout).filter(command => command.kind === "text");
    deepEqual(texts.map(command => command.style.fontFamily), ["Outer", "Inner", "Outer"]);
});

test("symbol preserves its fixed font and vector geometry", () => {
    const base = recordCommands(compileScore('$fine').layout).find(command => command.kind === "text");
    ok(base?.kind === "text");
    const source = '@set(font="Ordinary", numberfont="Digits", symbol.font="Preset") @symbol(fine, font="Explicit") $tr';
    const measured: TextStyle[] = [];
    const compiled = compileScore(source, { textMeasurer: { measureText(text, style) {
        measured.push({ ...style });
        return defaultTextMeasurer.measureText(text, style);
    } } });
    const drawn = recordCommands(compiled.layout).find(command => command.kind === "text");
    ok(drawn?.kind === "text");
    equal(drawn.style.fontFamily, base.style.fontFamily);
    deepEqual(drawn.style, measured[0]);
    equal(findFunction(compiled.ast, "symbol")!.toString(source), '@symbol(fine)');
    deepEqual(recordCommands(compiled.layout), recordCommands(compileScore('$fine $tr').layout));
});

test("volta captures category font without consuming variadic passes", () => {
    for (const [settings, expected] of [
        ['', JIANPU_NUMBER_FONT], ['@set(font="Ordinary", numberfont="")', JIANPU_NUMBER_FONT],
        ['@set(numberfont="Digits")', 'Digits'],
    ] as const) {
        const source = `${settings} 1@a 2@b @volta(a,b,3,1,2,3) @set(numberfont="Later")`;
        const compiled = compileScore(source);
        const text = recordCommands(compiled.layout).find(command => command.kind === "text" && command.text === "1.2.3.");
        ok(text?.kind === "text");
        equal(text.style.fontFamily, expected);
        equal(findFunction(compiled.ast, "volta")!.toString(source), '@volta(a, b, 1, 2, 3)');
    }
    const scoped = compileScore('@set(numberfont="Outer") 1@a 2@b { @set(numberfont="Inner") @volta(a,b,1) } @volta(a,b,2)');
    deepEqual(recordCommands(scoped.layout).filter(command => command.kind === "text").filter(command => ["1.", "2."].includes(command.text))
        .map(command => command.style.fontFamily), ["Inner", "Outer"]);
});

test("volta ignores unknown named args and uses numeric extra-arg diagnostics", () => {
    const source = '1@a 2@b @volta(a,b,1,2,3,font="Explicit")';
    const compiled = compileScore(source);
    deepEqual(compiled.diagnostics, []);
    equal(findFunction(compiled.ast, "volta")!.toString(source), '@volta(a, b, 1, 2, 3)');
    deepEqual(compileScore('1@a 2@b @volta(a,b,1,2,"Custom")').diagnostics.map(item => item.code), ["W_INVALID_NUMBER"]);
});