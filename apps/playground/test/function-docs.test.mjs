import assert from "node:assert/strict";
import { test } from "node:test";
import { CompletionContext } from "@codemirror/autocomplete";
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

function completionsAt(source) {
    const state = stateAt(source);
    const [complete] = state.languageDataAt("autocomplete", state.selection.main.head);
    return complete(new CompletionContext(state, state.selection.main.head, true));
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
        assert.ok(info.doc.includes(`**${position}. ${name}** · \`${type}\``), source);
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

test("voices positional arguments remain content and connect is named-only", () => {
    for (const [source, position] of [
        ["@voices(|)", 1],
        ["@vs(|)", 1],
        ["@voices(@voice(1)|)", 1],
        ["@voices(@voice(1), |)", 2],
        ["@voices(@voice(1), @voice(2), |)", 3],
    ]) {
        const info = parameterDocAt(stateAt(source));
        assert.ok(info.doc.includes(`**${position}. 额外位置参数** · \`content\``), source);
        assert.ok(!info.doc.includes("connect"), source);
    }
    for (const source of [
        '@voices(@voice(1), connect=|)',
        '@voices(@voice(1), CONNECT="[-]"|)',
        '@vs(@voice(1), @voice(2), connect="{-}"|)',
    ]) {
        const info = parameterDocAt(stateAt(source));
        assert.ok(info.doc.includes('**connect** · 仅命名参数 · `string` · 默认 `"[-]"`'), source);
        assert.doesNotMatch(info.doc, /\*\*\d+\. connect\*\*/, source);
    }
});

test("tie height is named-only while endpoint parameters remain labels", () => {
    for (const [source, position] of [["@tie(|)", 1], ["@tie(a, |)", 2], ["@tie(a,b, |)", 3]]) {
        const info = parameterDocAt(stateAt(source));
        assert.ok(info.doc.includes(`**${position}. 额外位置参数** · \`label\``), source);
        assert.ok(!info.doc.includes("height"), source);
    }
    const info = parameterDocAt(stateAt("@tie(a,b,height=|)"));
    assert.ok(info.doc.includes("**height** · 仅命名参数 · `length` · 默认 `0.5em`"));
    const result = completionsAt("1@a 2@b @tie(a, |)");
    assert.ok(result.options.some(option => option.label === "height" && option.type === "parameter" && option.detail === "length"));
    assert.ok(result.options.some(option => option.label === "b" && option.type === "variable"));
});

test("parameter completions sort by declared position", () => {
    const result = completionsAt("@note(|)");
    assert.ok(result);
    assert.deepEqual(result.options.map(option => [option.label, option.sortText, option.type, option.detail]), [
        ["name", "0", "parameter", "string"],
        ["acc", "1", "parameter", "string"],
        ["octave", "2", "parameter", "number"],
        ["color", "3", "parameter", "string"],
    ]);
});

test("voices complete connect only at a parameter-name position", () => {
    for (const source of [
        "@voices(|)",
        "@vs(|)",
        "@voices(con|)",
        "@voices(@voice(1), |)",
        "@voices(@voice(1), @voice(2), con|)",
        "@vs(@voice(1), @voice(2), |",
        '@voices(@voice(1), connect|="[-]")',
    ]) {
        const result = completionsAt(source);
        assert.ok(result, source);
        assert.deepEqual(result.options.map(option => [option.label, option.detail]), [
            ["connect", "string"],
        ], source);
        assert.equal(result.validFor, undefined, source);
    }
    for (const source of [
        "@voices(1|)",
        "@voices(C|)",
        "@voices(1 |)",
        "@voices({|})",
        "@voices({1 con|})",
        "@voices(@voice(1 |))",
        "@voices(@voice(1)|)",
        "@voices(@voice(1), % con|\n)",
        '@voices(@voice(1), connect=|)',
        '@voices(@voice(1), connect="[1-2]{|}")',
        '@voices(@voice(1), connect="[-]", |)',
    ]) {
        assert.equal(completionsAt(source), null, source);
    }
    assert.ok(completionsAt("@voices(@voice(@n(|)))").options.some(option => option.label === "octave"));
    assert.ok(completionsAt("@voices(@vo|)").options.some(option => option.label === "@voice"));
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

test("full docs label named-only arguments without shifting positional numbering", () => {
    const def = defaultFunctions.find(FunctionClass => FunctionClass.def.name.includes("voices")).def;
    const doc = functionDoc(def);
    assert.ok(doc.includes('**connect** · 仅命名参数 · `string` · 默认 `"[-]"`'));
    assert.ok(doc.includes("`content`"));
    assert.doesNotMatch(doc, /\*\*\d+\. connect\*\*/);

    const mixed = functionDoc({
        ...def,
        args: [
            { name: "first", type: "number", default: 1 },
            ...def.args,
            { name: "second", type: "number", default: 2 },
        ],
    });
    assert.ok(mixed.includes("**1. first**"));
    assert.ok(mixed.includes("**2. second**"));
});

test("every fixed argument has a nonempty description included in function docs", () => {
    for (const FunctionClass of defaultFunctions) {
        const def = FunctionClass.def;
        const doc = functionDoc(def);
        for (const argument of def.args) {
            assert.ok(argument.description?.trim(), `${def.name}: ${argument.name}`);
            assert.ok(doc.includes(argument.description));
        }
    }
});
