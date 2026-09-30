import assert from "node:assert/strict";
import { test } from "node:test";
import { CompletionContext, insertCompletionText, pickedCompletion } from "@codemirror/autocomplete";
import { EditorSelection, EditorState } from "@codemirror/state";
import { defaultFunctions } from "jpfun";
import { functionDoc, jpFunLanguage, parameterDocAt } from "../jpfun-language.ts";

function stateAt(source) {
    const ranges = [];
    const doc = source.replace(/\|/g, (_, offset) => {
        // 偏移扣掉此前已删除的光标标记
        ranges.push(EditorSelection.cursor(offset - ranges.length));
        return "";
    });
    assert.ok(ranges.length, "source must mark its cursor positions");
    return EditorState.create({
        doc,
        selection: EditorSelection.create(ranges, 0),
        extensions: [jpFunLanguage, EditorState.allowMultipleSelections.of(true)],
    });
}

function completionsAt(source) {
    const state = typeof source === "string" ? stateAt(source) : source;
    const [complete] = state.languageDataAt("autocomplete", state.selection.main.head);
    return complete(new CompletionContext(state, state.selection.main.head, true));
}

function acceptSuggestion(state, label, type = "parameter", result = completionsAt(state)) {
    const option = result?.options.find(option => option.label === label && option.type === type);
    assert.ok(option, `missing ${type} completion: ${label}`);
    let transaction;
    const view = {
        state,
        dispatch(spec) {
            assert.equal(transaction, undefined, "completion must dispatch once");
            transaction = state.update(spec);
        },
    };
    const to = result.to ?? state.selection.main.head;
    if (typeof option.apply === "function") option.apply(view, option, result.from, to);
    else view.dispatch({
        ...insertCompletionText(state, option.apply ?? option.label, result.from, to),
        annotations: pickedCompletion.of(option),
    });
    assert.ok(transaction);
    assert.equal(transaction.annotation(pickedCompletion), option);
    assert.ok(transaction.isUserEvent("input.complete"));
    return transaction.state;
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

test("accepting parameter completions preserves existing equals signs, values and spacing", () => {
    for (const [source, label, expected] of [
        ["@voices(con|)", "connect", "@voices(connect=)"],
        ["@note(1, col|)", "color", "@note(1, color=)"],
        ['@voices(@voice(1), connect|="[-]")', "connect", '@voices(@voice(1), connect="[-]")'],
        ['@voices(@voice(1), con|nect="[1-2]{3-}")', "connect", '@voices(@voice(1), connect="[1-2]{3-}")'],
        ['@vs(@voice(1), CON|NECT="")', "connect", '@vs(@voice(1), connect="")'],
        ['@voices(@voice(1), |connect  =  "{-}")', "connect", '@voices(@voice(1), connect  =  "{-}")'],
        ['@note(1, co|lor = "#f00")', "color", '@note(1, color = "#f00")'],
        ["1@a 2@b @tie(a,b,hei|ght=1em)", "height", "1@a 2@b @tie(a,b,height=1em)"],
        ["1@a 2@b @tie(a,b,height | = 1em)", "height", "1@a 2@b @tie(a,b,height  = 1em)"],
        ["@adjust(@text(A, si|ze=2em), dx=1px)", "size", "@adjust(@text(A, size=2em), dx=1px)"],
    ]) {
        const state = acceptSuggestion(stateAt(source), label);
        assert.equal(state.doc.toString(), expected, source);
    }
});

test("parameter names do not offer labels, but label arguments still complete normally", () => {
    const name = completionsAt("1@a 2@b @tie(a,b,hei|ght=1em)");
    assert.deepEqual(name.options.map(option => option.label), ["height"]);
    for (const [source, expected] of [
        ["1@a 2@b @tie(a, |)", "1@a 2@b @tie(a, b)"],
        ["1@a 2@b @dyn(from=a|,to=b,dv=3)", "1@a 2@b @dyn(from=b,to=b,dv=3)"],
    ]) {
        const state = acceptSuggestion(stateAt(source), "b", "variable");
        assert.equal(state.doc.toString(), expected);
    }
});

test("parameter completion replaces matching names at multiple cursors", () => {
    const state = stateAt('@note(1, co|LOR="#f00")\n@note(2, co|LOR="#0f0")');
    const updated = acceptSuggestion(state, "color");
    assert.equal(updated.doc.toString(), '@note(1, color="#f00")\n@note(2, color="#0f0")');
    assert.equal(updated.selection.ranges.length, 2);
});

test("cached parameter completions use the current name span after typing", () => {
    const source = '@note(1, co|lor="#f00")';
    const state = stateAt(source);
    const result = completionsAt(state);
    const pos = state.selection.main.head;
    const edit = state.update({ changes: { from: pos, insert: "L" }, selection: { anchor: pos + 1 } });
    const mapped = {
        ...result,
        from: edit.changes.mapPos(result.from),
        to: edit.changes.mapPos(result.to ?? pos, 1),
    };
    const updated = acceptSuggestion(edit.state, "color", "parameter", mapped);
    assert.equal(updated.doc.toString(), '@note(1, color="#f00")');
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
            { name: "leading", type: "boolean", default: false, namedOnly: true },
            { name: "first", type: "number", default: 1 },
            ...def.args,
            { name: "second", type: "number", default: 2 },
            { name: "trailing", type: "boolean", default: false, namedOnly: true },
        ],
    });
    assert.ok(mixed.includes("**1. first**"));
    assert.ok(mixed.includes("**2. second**"));
    for (const name of ["leading", "connect", "trailing"]) {
        assert.ok(mixed.includes(`**${name}** · 仅命名参数`));
        assert.doesNotMatch(mixed, new RegExp(`\\*\\*\\d+\\. ${name}\\*\\*`));
    }
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
