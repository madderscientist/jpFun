import { test } from "node:test";
import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { compileScore } from "../src/pipeline.js";
import { createLayoutPrepareContext } from "../src/layout/default.js";
import { layoutDocument } from "../src/layout/engine.js";
import { defaultFunctions } from "../src/functions/default.js";
import { ASTBraceNode, ASTFunctionNode } from "../src/functions/ASTtypes.js";
import type { TextStyle } from "../src/render/types.js";
import { DEFAULT_TEXT_FONT, JIANPU_NUMBER_FONT } from "../src/render/text.js";
import { DEFAULT_FONT_SIZE, ParserContext } from "../src/parser/parserContext.js";
import { createLowering, createParser, recordCommands } from "./helpers.js";

test("ParserContext variables preserve defaults, resets and child scope", () => {
    const parent = new ParserContext({ source: "" });
    const defaults = { font: DEFAULT_TEXT_FONT, numberfont: JIANPU_NUMBER_FONT, fontsize: DEFAULT_FONT_SIZE, strict: false };
    deepStrictEqual(parent.variables, defaults);
    parent.setVariable("font", "Ordinary");
    parent.setVariable("numberfont", "Digits");
    parent.setVariable("fontsize", { value: 30, unit: "px" });
    parent.setVariable("strict", true);
    const child = new ParserContext(parent);
    deepStrictEqual(child.variables, parent.variables);
    child.setVariable("font", "");
    child.setVariable("numberfont", "");
    child.setVariable("fontsize", undefined);
    child.setVariable("strict", false);
    deepStrictEqual(child.variables, defaults);
    deepStrictEqual(parent.variables, { font: "Ordinary", numberfont: "Digits", fontsize: 30, strict: true });
    for (const name of Object.keys(defaults)) child.setVariable(name, undefined);
    deepStrictEqual(child.variables, defaults);
    deepStrictEqual(new ParserContext({ source: "" }).variables, defaults);
});

test("ParserContext preserves raw root overrides independently and setVariable resets defaults", () => {
    for (const variables of [
        { font: "Custom", numberfont: "Digits", fontsize: 30, strict: true, custom: "" },
        { font: "", numberfont: undefined, fontsize: 0, strict: false, custom: undefined },
        { font: undefined, numberfont: "", fontsize: NaN, strict: null, custom: 0 },
    ]) {
        const original = { ...variables };
        const root = new ParserContext({ source: "", variables });
        const independent = new ParserContext({ source: "", variables });
        deepStrictEqual(root.variables, original);
        root.setVariable("fontsize", { value: 0, unit: "px" });
        strictEqual(root.variables.fontsize, DEFAULT_FONT_SIZE);
        deepStrictEqual(independent.variables, original);
        deepStrictEqual(variables, original);
    }
});

test("setVariable converts fontsize once and resets converted zero", () => {
    const context = new ParserContext({ source: "" });
    context.setVariable("fontsize", { value: 2, unit: "em" });
    strictEqual(context.variables.fontsize, DEFAULT_FONT_SIZE * 2);
    context.setVariable("fontsize", { value: 2, unit: "em" });
    strictEqual(context.variables.fontsize, DEFAULT_FONT_SIZE * 4);
    context.setVariable("fontsize", { value: 18, unit: "px" });
    strictEqual(context.variables.fontsize, 18);
    for (const unit of ["px", "em"] as const) {
        context.setVariable("fontsize", { value: 0, unit });
        strictEqual(context.variables.fontsize, DEFAULT_FONT_SIZE);
    }
    const zero = new ParserContext({ source: "", variables: { fontsize: 0 } });
    zero.setVariable("fontsize", { value: 2, unit: "em" });
    strictEqual(zero.variables.fontsize, DEFAULT_FONT_SIZE);
});

function texts(source: string) {
    return recordCommands(compileScore(source).layout).filter(command => command.kind === "text");
}

test("empty text font overrides the function preset and falls back to the category", () => {
    strictEqual(texts('@set(font="Global", text.font="Text") @text(Label)')[0].style.fontFamily, "Text");
    strictEqual(texts('@set(font="Global", text.font="Text") @text(Label, font="")')[0].style.fontFamily, "Global");
    strictEqual(texts('@set(text.font="Text") @text(Label, font="")')[0].style.fontFamily, DEFAULT_TEXT_FONT);
    strictEqual(texts('@set(font="", text.font="") @text(Label, font="")')[0].style.fontFamily, DEFAULT_TEXT_FONT);
});

for (const [name, call, label] of [
    ["page", '@page(numbering="page 1"', "page 1"],
] as const) {
    test(`${name} font precedence and serialization`, () => {
        for (const [settings, explicit, expected] of [
            ["", "", "sans-serif"],
            ['@set(font="")', ', font=""', "sans-serif"],
            ['@set(font="Global")', "", "Global"],
            [`@set(font="Global", ${name}.font="Function")`, "", "Function"],
            [`@set(font="Global", ${name}.font="Function")`, ', font=""', "Global"],
            [`@set(font="Global", ${name}.font="Function")`, ', font="Explicit"', "Explicit"],
        ]) {
            const source = `${settings} ${call}${explicit}) 3`;
            const compiled = compileScore(source);
            strictEqual(recordCommands(compiled.layout).filter(command => command.kind === "text")
                .find(command => command.text === label)?.style.fontFamily, expected);
            const node = compiled.ast.content.find(node => node instanceof ASTFunctionNode && node.callName === name)!;
            const serialized = node.toString(source);
            ok(serialized.includes(`font=${JSON.stringify(expected)}`));
            strictEqual(texts(`@set(font="Later", ${name}.font="Later") ${serialized} 3`)
                .find(command => command.text === label)?.style.fontFamily, expected);
        }
    });
}

test("tempo inherits the context font and serializes without a font argument", () => {
    const source = '@set(font="Outer") @tempo(96, 19px) { @set(font="Inner") @tempo(120) } @tempo(144)';
    deepStrictEqual(texts(source).map(command => command.style.fontFamily), ["Outer", "Inner", "Outer"]);
    const compiled = compileScore(source);
    const tempo = compiled.ast.content.find(node => node instanceof ASTFunctionNode && node.callName === "tempo")!;
    strictEqual(tempo.toString(source), "@tempo(96, size=19px)");
    strictEqual(texts(`@set(font="Later") ${tempo.toString(source)}`)[0].style.fontFamily, "Later");
    strictEqual(texts("@tempo(96)")[0].style.fontFamily, DEFAULT_TEXT_FONT);
});

test("head generated text uses text settings without a head font override", () => {
    for (const [settings, expected] of [
        ["", "sans-serif"],
        ['@set(font="Global")', "Global"],
        ['@set(font="Global", text.font="Text")', "Text"],
        ['@set(font="Global", text.font="Text", head.font="Head")', "Text"],
    ]) {
        const source = `${settings}\nH.title: Title\nH.subtitle: Subtitle\nH.author: Author\nH.left: Left\nH.center: Center\nH.right: Right`;
        const compiled = compileScore(source);
        const commands = recordCommands(compiled.layout).filter(command => command.kind === "text");
        strictEqual(commands.length, 6);
        ok(commands.every(command => command.style.fontFamily === expected));
        deepStrictEqual(commands.map(command => command.style.fontSize), [17.6, 44, 18.7, 17.6, 17.6, 17.6]);
        const head = compiled.ast.content.find(node => node instanceof ASTFunctionNode && node.callName === "head")!;
        const roundTrip = texts(`@set(font="Later", text.font="Later") ${head.toString(source)}`);
        ok(roundTrip.every(command => command.style.fontFamily === expected));
    }
});

test("head leaves font selection to its text children", () => {
    const source = '@set(font="Global", text.font="Text", head.font="Head")\nH.title: Generated\nH.left: @text(Child, font="Child")\nH.right: @text(Preset)';
    deepStrictEqual(texts(source).map(command => [command.text, command.style.fontFamily]),
        [["Child", "Child"], ["Generated", "Text"], ["Preset", "Text"]]);
    const explicit = '@set(font="Global", text.font="Text", head.font="Head") @head(center={@text(Preset)}, font="Override")';
    strictEqual(texts(explicit)[0].style.fontFamily, "Text");
    const emptyChild = '@set(font="Global", text.font="Text", head.font="Head") @head(center={@text(Child, font="")}, font="Override")';
    strictEqual(texts(emptyChild)[0].style.fontFamily, "Global");
    const head = compileScore(explicit).ast.content.find(node => node instanceof ASTFunctionNode && node.callName === "head")!;
    ok(!head.toString(explicit).includes('font="Override"'));
});

test("ordinary text and head preserve lexical fonts through serialization", () => {
    const source = '@set(font="Outer") @text(Before) { @set(font="Inner", text.font="Preset") @text(Inside)\nH.title: Title\n} @text(After)';
    const expected = [["Before", "Outer"], ["Inside", "Preset"], ["Title", "Preset"], ["After", "Outer"]];
    deepStrictEqual(texts(source).map(command => [command.text, command.style.fontFamily]), expected);
    const serialized = compileScore(source).ast.toString(source);
    deepStrictEqual(texts(serialized).map(command => [command.text, command.style.fontFamily]), expected);
    const plain = compileScore('@text(Default)').ast.toString('@text(Default)');
    strictEqual(texts(`@set(font="Later", text.font="Later") ${plain}`)[0].style.fontFamily, DEFAULT_TEXT_FONT);
});

test("voice all measurement and attachment paths match painted styles", () => {
    const measured: { text: string; style: TextStyle }[] = [];
    const source = '@set(font="Wide") @voices(@voice({1 2 @br() 3}, Lead, "(hello) world again", LongRow="la la la"), @voice({4 5 @br() 6}, Other, "one two three"))';
    const compiled = compileScore(source, { textMeasurer: {
        measureText(text, style) {
            measured.push({ text, style: { ...style } });
            return { w: text.length * (style.fontFamily === "Wide" ? 30 : 3), h: style.fontSize, baseline: style.fontSize * 0.8 };
        },
    } });
    const labels = ["Lead", "Other", "longrow", "(hello)", "world", "again", "la", "one", "two", "three"];
    const commands = recordCommands(compiled.layout).filter(command => command.kind === "text").filter(command => labels.includes(command.text));
    for (const label of labels) ok(commands.some(command => command.text === label), label);
    for (const command of commands) {
        strictEqual(command.style.fontFamily, "Wide");
        ok(measured.some(item => item.text === command.text && JSON.stringify(item.style) === JSON.stringify(command.style)), command.text);
    }
    for (const label of ["hello", "(", "M"]) {
        const samples = measured.filter(item => item.text === label);
        ok(samples.length > 0, label);
        ok(samples.every(item => item.style.fontFamily === "Wide"), label);
    }
    const name = compiled.layout.objects.find(object => object.ast instanceof ASTFunctionNode && object.ast.callName === "voice")!;
    strictEqual(name.box.anchor, "LongRow".length * 30);
});

test("font is frozen before lowering and later context changes", () => {
    for (const [settings, expected] of [
        ["", DEFAULT_TEXT_FONT],
        ['@set(font="Frozen")', "Frozen"],
    ]) {
        const parser = createParser(`${settings} @text(Label) "Sugar" @voice({1}, Lead, "hello") @tempo(96) @page(numbering="page 1")`);
        const nodes = parser.parse();
        const ast = new ASTBraceNode({ start: 0, end: parser.source.length }, nodes);
        parser.setVariable("font", "Later");
        for (const node of nodes) Object.freeze(node);
        const layout = layoutDocument(createLowering().lowerDocument(ast), createLayoutPrepareContext(defaultFunctions));
        const commands = recordCommands(layout).filter(command => command.kind === "text")
            .filter(command => ["Label", "Sugar", "Lead", "hello", "= 96", "page 1"].includes(command.text));
        strictEqual(commands.length, 6);
        ok(commands.every(command => command.style.fontFamily === expected));
    }
});

test("voice sugar inherits nested font settings and serializes grouped lyrics", () => {
    const font = 'Voice "Quoted"\\Family';
    const source = `@set(font="Outer") { @set(font=${JSON.stringify(font)})\nN(Lead): 1 2\nL(row): {hello world} again\nN(Other): 3 4\nL: one two\n}`;
    const compiled = compileScore(source);
    const labels = ["Lead", "Other", "row", "hello world", "again", "one", "two"];
    const original = recordCommands(compiled.layout).filter(command => command.kind === "text")
        .filter(command => labels.includes(command.text));
    strictEqual(original.length, labels.length);
    ok(original.every(command => command.style.fontFamily === font));
    const voices = compiled.ast.content[1].children!.find(node => node instanceof ASTFunctionNode && node.callName === "voices")!;
    const serialized = voices.toString(source);
    ok(!serialized.includes("font="));
    const restored = texts(`@set(font=${JSON.stringify(font)}) ${serialized}`).filter(command => labels.includes(command.text));
    deepStrictEqual(restored.map(command => [command.text, command.style.fontFamily]),
        original.map(command => [command.text, command.style.fontFamily]));
});

test("voice category fonts restore after local settings", () => {
    const source = '@set(font="Outer") @voice({1}, Before, "first") { @set(font="Inner") @v({2}, Inside, "second") } @voice({3}, After, "third")';
    deepStrictEqual(texts(source).filter(command => ["Before", "Inside", "After"].includes(command.text))
        .map(command => [command.text, command.style.fontFamily]), [["Before", "Outer"], ["Inside", "Inner"], ["After", "Outer"]]);
});

test("tempo and page measure and paint the same frozen TextStyle", () => {
    const measured: { text: string; style: TextStyle }[] = [];
    const source = '@set(font="Wide") @page(400px, 120px, 20px, 32px, 20px, 20px, 10px, "page 1", "Page") @tempo(96, 19px) 1 @br() 2 @br() 3 @br() 4';
    const compiled = compileScore(source, { textMeasurer: {
        measureText(text, style) {
            measured.push({ text, style: { ...style } });
            return { w: text.length * 12, h: style.fontSize, baseline: style.fontSize * 0.8 };
        },
    } });
    const commands = recordCommands(compiled.layout).filter(command => command.kind === "text")
        .filter(command => command.text.startsWith("page ") || command.text === "= 96");
    ok(commands.length >= 3);
    for (const command of commands) {
        const isPage = command.text.startsWith("page ");
        strictEqual(command.style.fontFamily, isPage ? "Page" : "Wide");
        strictEqual(command.style.fontSize, isPage ? 16 : 19);
        ok(measured.some(item => item.text === command.text && JSON.stringify(item.style) === JSON.stringify(command.style)));
    }
});