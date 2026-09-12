import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { defaultFunctions } from "jpfun";
import { functionDoc, jpFunLanguage, parameterDocAt } from "../jpfun-language.ts";

function stateAt(source) {
    return EditorState.create({
        doc: source.replace("|", ""),
        selection: EditorSelection.cursor(source.indexOf("|")),
        extensions: [jpFunLanguage],
    });
}

test("parameter docs follow positional, empty, named and nested arguments", () => {
    for (const [source, name, type, position] of [
        ["@adjust(|)", "\u4f4d\u7f6e\u53c2\u6570", "content", 1],
        ["@adjust(1, |)", "dx", "length", 2],
        ["@adjust(, , |)", "dy", "length", 3],
        ["@adjust(1, dy=|)", "dy", "length", 3],
        ["@adjust(1, DY=|)", "dy", "length", 3],
        ["@adjust(1, dh=2px, dx=|)", "dx", "length", 2],
        ["@adjust(1, | dx=2px, dy=1px)", "dx", "length", 2],
        ["@adjust(1, dx=2px | , dy=1px)", "dx", "length", 2],
        ["@adjust(@text(hi, size=|), dx=2px)", "size", "length", 2],
        ["@adjust(@text(hi), |)", "dx", "length", 2],
        ['@text("a,b", |)', "size", "length", 2],
        ["@adjust(1, dx=|", "dx", "length", 2],
    ]) {
        const info = parameterDocAt(stateAt(source));
        assert.ok(info, source);
        assert.ok(info.doc.includes(name), source);
        assert.ok(info.doc.includes(`\`${type}\``), source);
        assert.ok(info.doc.includes(`**${position}. ${name}**`), source);
    }
});

test("parameter docs contain only the current parameter description", () => {
    const def = defaultFunctions.find(FunctionClass => FunctionClass.def.name.includes("adjust")).def;
    const info = parameterDocAt(stateAt("@adjust(1, dx=|)"));
    assert.ok(info.doc.includes(def.args[1].description));
    for (const argument of def.args.filter((_, index) => index !== 1)) {
        assert.ok(!info.doc.includes(argument.description));
    }
});

test("parameter docs handle extras and disappear outside calls or selections", () => {
    assert.ok(parameterDocAt(stateAt("@tie(a, |)")).doc.includes("`label`"));
    assert.ok(parameterDocAt(stateAt("@tie(a, |)")).doc.includes("**2. "));
    assert.ok(parameterDocAt(stateAt("@set(fontsize=|)")).doc.includes("fontsize"));
    for (const source of ["|@adjust(1)", "@adjust(1)|", "@unknown(|)", "@adjust(@unknown(|))"]) {
        assert.equal(parameterDocAt(stateAt(source)), null, source);
    }
    const state = stateAt("@adjust(1, dx=|)");
    assert.equal(parameterDocAt(state.update({ selection: { anchor: 8, head: 9 } }).state), null);
});

test("full function docs include aliases, parameter metadata and examples", () => {
    const def = defaultFunctions.find(FunctionClass => FunctionClass.def.name.includes("adjust")).def;
    const doc = functionDoc(def);
    assert.ok(doc.includes(def.description));
    assert.ok(doc.includes("@adj"));
    assert.ok(doc.includes(def.details));
    assert.ok(doc.indexOf(def.details) < doc.indexOf("**1. "));
    for (const argument of def.args) {
        assert.ok(doc.includes(argument.description));
        assert.ok(doc.includes(`\`${argument.type}\``));
    }
    assert.ok(doc.includes("`0px`"));
});

test("every fixed argument has a nonempty description included in function docs", () => {
    for (const FunctionClass of defaultFunctions) {
        const def = FunctionClass.def;
        for (const argument of def.args) {
            assert.ok(argument.description?.trim(), `${def.name}: ${argument.name}`);
            assert.ok(functionDoc(def).includes(argument.description));
        }
    }
});
