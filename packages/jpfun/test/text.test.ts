import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";

import { ASTFunctionNode } from "../src/functions/ASTtypes.js";
import { WarningDiagnostic } from "../src/diagnostic.js";
import { analyzeScoreSyntax, compileScore } from "../src/pipeline.js";
import { parseString, quote } from "../src/parser/parse-utils/string-utils.js";
import { assert, commandsOfKind, compileValid, expectCompileError, layoutOf, nearly, parse, recordCommands } from "./helpers.js";

/** 只写一个 @text 时它就是唯一的可见对象 */
function textBox(source: string) {
    const objects = layoutOf(source).objects;
    assert(objects.length === 1, `Expected one visible object, got ${objects.length}`);
    return { box: objects[0].box, size: objects[0].ast.size };
}

test("文本盒子按最长行、行高倍数与首字符锚点测量", () => {
    for (const [source, width, height] of [
        ['@text("进入")', 2, 1],
        ['@text("上行\n下面这行更长")', 6, 2.25],
        ['@text("上行\n下行", lineheight=2)', 2, 3],
    ] as const) {
        const { box, size } = textBox(source);
        assert(nearly(box.w, size * width) && nearly(box.h, size * height), `${source}: measured dimensions`);
        assert(nearly(box.anchor, size / 2), `${source}: first character anchor`);
        assert(nearly(box.visualAxis, box.h / 2), `${source}: block center axis`);
    }
});

test("每行单独绘制且左对齐", () => {
    const commands = commandsOfKind(`@text("上行\n下行")`, "text");
    assert(commands.length === 2, `Expected one draw per line, got ${commands.length}`);

    const [first, second] = commands;
    assert(first.text === "上行" && second.text === "下行", "each line must be drawn as written");
    assert(nearly(first.x, second.x), "lines must be left aligned");
    assert(nearly(second.y - first.y, first.style.fontSize * 1.25),
        "baseline distance must be the line advance");
});

test("括号内的换行不打断 N: 声部语法糖", () => {
    // 换行属于 @text 这一个语法节点，voice 的断行判定看不见它
    const content = parse(`N: 1 2 @text("上行\n下行") 3`).content;
    assert(content.length === 1, `Expected the whole line to stay in one voice, got ${content.length} nodes`);

    const voice = content[0];
    assert(voice instanceof ASTFunctionNode && voice.callName === "voice",
        "the N: sugar must still produce exactly one voice");
});

test("align=center 时锚点与各行都取整块中心", () => {
    const result = layoutOf(`@text("上行\n下面这行更长", align=center)`);
    const box = result.objects[0].box;
    assert(nearly(box.anchor, box.w / 2), "centered text must anchor at the block center");

    const [first, second] = recordCommands(result);
    assert(first?.kind === "text" && second?.kind === "text", "each line must still be one draw command");
    assert(first.style.textAlign === "center", "the painter must center each line itself");
    assert(nearly(first.x, box.x + box.w / 2) && nearly(second.x, box.x + box.w / 2),
        "centered lines must share the block center line");
});

test("align=right 时锚点取末字符中心，各行取整块右缘", () => {
    const result = layoutOf(`@text("短\n下面这行更长", align=right)`);
    const box = result.objects[0].box;
    const [first, second] = recordCommands(result).filter(command => command.kind === "text");
    assert(box.anchor < box.w && box.anchor > box.w - first.style.fontSize,
        "right-aligned text must anchor at the first line's last character center");
    assert(first.style.textAlign === "right" && second.style.textAlign === "right",
        "the painter must right-align every line");
    assert(nearly(first.x, second.x) && nearly(first.x, box.x + box.w),
        "right-aligned lines must share the block right edge");
});

test("align 只接受 left、center 和 right", () => {
    expectCompileError(`@text("上行", align=middle)`, "E_TEXT_INVALID_ALIGN");
});

test("双引号语法糖等价于 @text", () => {
    const sugar = textBox(`"进入"`).box;
    const explicit = textBox(`@text("进入")`).box;
    assert(nearly(sugar.w, explicit.w) && nearly(sugar.h, explicit.h) && nearly(sugar.anchor, explicit.anchor),
        "sugar and explicit call must produce the same box");
});

test("语法糖里的逗号、括号和换行都属于文本", () => {
    const commands = commandsOfKind(`"a,b)c\n第二行"`, "text");
    assert(commands.map(command => command.text).join("|") === "a,b)c|第二行",
        "argument separators lose their meaning inside a string literal");
});

test("字符串在编码层仅解码 \\\"、\\\\ 与 \\uXXXX，其余 \\X 原样保留给下游函数", () => {
    const sugar = commandsOfKind(`"说\\"你好\\""`, "text");
    const explicit = commandsOfKind(`@text("说\\"你好\\"")`, "text");
    assert(sugar[0].text === `说"你好"`, `escaped quote must survive, got ${sugar[0].text}`);
    assert(explicit[0].text === sugar[0].text, "both paths must share one unescape rule");
});

test("Unicode 转义解码且只处理一次", () => {
    for (const [literal, expected] of [
        [String.raw`"\uE050"`, "\uE050"],
        [String.raw`"\uD834\uDD1E"`, "\uD834\uDD1E"],
        [String.raw`"\\uE050"`, String.raw`\uE050`],
        [String.raw`"\u005CuE050"`, String.raw`\uE050`],
    ]) {
        for (const source of [literal, `@text(${literal})`]) {
            const commands = recordCommands(compileValid(source).layout).filter(command => command.kind === "text");
            deepStrictEqual(commands.map(command => command.text).join("\n"), expected, source);
        }
    }
    const music = commandsOfKind(String.raw`@text("\uE050", font="\u0042ravura")`, "text")[0];
    assert(music.text === "\uE050" && music.style.fontFamily === "Bravura", "music glyph and font must reach the painter");
    assert(parseString(String.raw`\uE050`) === "\uE050", "bare and quoted strings share Unicode escape decoding");
    assert(parseString(String.raw`"\n\t\q"`) === String.raw`\n\t\q` && parseString(String.raw`\n\t\q`) === String.raw`\n\t\q`,
        "non-encoding escapes remain untouched for downstream consumers");
});

test("非法 Unicode 转义始终警告，且不打断词法分析", () => {
    for (const escape of [String.raw`\u123`, String.raw`\u12G4`, String.raw`\u{E050}`]) {
        const decoded = parseString(`"${escape}"`);
        assert(decoded instanceof WarningDiagnostic, "decoder must return a warning, not throw");
        for (const source of [
            `1\r\n  @text("\\u0041${escape}")`,
            `1\r\n  "${escape}"`,
            `N(  "${escape}"  ): 1`,
            `N: 1\nL: "${escape}"`,
        ]) {
            for (const prefix of ["", "@set(strict=true) "]) {
                const input = prefix + source;
                const result = compileScore(input);
                const [warning] = result.diagnostics;
                assert(result.diagnostics.length === 1 && warning instanceof WarningDiagnostic
                    && warning.code === "W_STRING_INVALID_UNICODE_ESCAPE", "invalid escapes must produce a warning");
                const start = input.indexOf(escape);
                deepStrictEqual(warning.span, { start, end: start + Math.min(escape.length, 6) }, input);
                const syntaxSource = `${input}\n2`;
                const { syntax } = analyzeScoreSyntax(syntaxSource);
                assert(syntax.tokens.some(token => token.kind === "atom"
                    && syntaxSource.slice(token.span.start, token.span.end) === "2"), "later notes remain available");
            }
        }
    }
    const result = compileScore(String.raw`@text("\u0041\u12G4")`);
    const texts = recordCommands(result.layout).filter(command => command.kind === "text");
    deepStrictEqual(texts.map(command => command.text), [String.raw`\u0041\u12G4`], "failed strings stay unchanged");
});

test("文本源码往返保留换行、制表符和字体字符串", () => {
    for (const value of [
        "上行\n下行", "a\tb", '"Font Name", sans-serif', 'a\\b/"c"',
        "\uE050\uD834\uDD1E \\uE050",
    ]) {
        const source = `@text(${quote(value)}, font=${quote(value)})`;
        const restored = parse(source).content[0].toString(source);
        const commands = commandsOfKind(restored, "text");
        assert(commands.map(command => command.text).join("\n") === value, "text must survive serialization");
        assert(commands.every(command => command.style.fontFamily === value), "font must survive serialization");
        const page = `@page(numbering=${quote(value)}, font=${quote(value)})`;
        const serializedPage = parse(page).content[0].toString(page);
        const node = parse(serializedPage).content[0];
        assert("font" in node && node.font === value, "page must preserve the font string");
        assert("numbering" in node && node.numbering === value, "page must preserve its numbering string");

        const set = `@set(font=${quote(value)})`;
        const serializedSet = parse(set).content[0].toString(set);
        assert(commandsOfKind(`${serializedSet} @text(Label)`, "text")[0].style.fontFamily === value,
            "set must preserve the font string");
    }
});

test("引号未配对时不去糖也不抛出", () => {
    const source = `"没闭合 1 2`;
    assert(!analyzeScoreSyntax(source).syntax.tokens.some(token => token.kind === "string"),
        "an unpaired quote must not be colored as a string");
    assert(layoutOf(source).objects.length === 2, "the notes after an unpaired quote must still compile");
});

test("语法糖着色为字符串并覆盖两侧引号", () => {
    const source = `1 "渐强"`;
    const tokens = analyzeScoreSyntax(source).syntax.tokens.filter(token => token.kind === "string");
    assert(tokens.length === 1 && source.slice(tokens[0].span.start, tokens[0].span.end) === `"渐强"`,
        "the string token must cover the quotes themselves");
});

test("Markdown 粗体、斜体、下划线、上标及组合样式测量与绘制", () => {
    const plain = textBox(`"进入"`).box;
    const styled = textBox(`"**_*进入*_**"`).box;
    assert(nearly(styled.w, plain.w) && nearly(styled.h, plain.h) && nearly(styled.anchor, plain.anchor),
        "Markdown 标记本身不应计入盒子宽度或偏移首字符锚点");

    const layout = layoutOf(`"普通 *斜体* **粗体** ***粗斜*** _下划线_ C^7^"`);
    const commands = recordCommands(layout);
    const texts = commands.filter(cmd => cmd.kind === "text");
    const lines = commands.filter(cmd => cmd.kind === "line");

    deepStrictEqual(texts.map(t => [t.text, t.style.fontWeight ?? "normal", t.style.fontStyle ?? "normal"]), [
        ["普通 ", "normal", "normal"],
        ["斜体", "normal", "italic"],
        [" ", "normal", "normal"],
        ["粗体", "bold", "normal"],
        [" ", "normal", "normal"],
        ["粗斜", "bold", "italic"],
        [" ", "normal", "normal"],
        ["下划线", "normal", "normal"],
        [" C", "normal", "normal"],
        ["7", "normal", "normal"],
    ]);
    const baseText = texts[0];
    const supText = texts.at(-1)!;
    assert(nearly(supText.style.fontSize, baseText.style.fontSize * 0.7), "superscript must scale font size by 0.7");
    assert(nearly(supText.y, baseText.y - baseText.style.fontSize * 0.35), "superscript must shift baseline up");
    assert(lines.length === 1, `Expected 1 underline, got ${lines.length}`);
    const [underline] = lines;
    assert(underline.y1 > baseText.y && nearly(underline.y1, underline.y2), "underline must sit below baseline");

    const supDecorated = recordCommands(layoutOf(`"_^7^_"`));
    const supGlyph = supDecorated.find(cmd => cmd.kind === "text")!;
    const supUnderline = supDecorated.find(cmd => cmd.kind === "line")!;
    assert(nearly(supUnderline.y1, supGlyph.y + supGlyph.style.fontSize * 0.12),
        "superscript underline must follow the superscript baseline and size");
});

test("连续下划线跨多段样式时合并为单条线段，未闭合标记持續生效且支持转义", () => {
    assert(commandsOfKind(`"_普通 **粗体** 普通_"`, "line").length === 1,
        "contiguous underline across styled runs must merge into one line");

    // 未闭合时状态机将样式保持到末尾（含跨行）
    const unclosedCmds = commandsOfKind(`"*第一行\n**第二行"`, "text");
    deepStrictEqual(unclosedCmds.map(t => [t.text, t.style.fontWeight ?? "normal", t.style.fontStyle ?? "normal"]), [
        ["第一行", "normal", "italic"],
        ["第二行", "bold", "italic"],
    ]);

    const escaped = String.raw`\*字面星号\* \_下划线\_ \^上标\^ a\\b`;
    const expected = String.raw`*字面星号* _下划线_ ^上标^ a\b`;
    for (const source of [
        `"${escaped}"`,
        `@text("${escaped}")`,
        `@text(${escaped})`,
    ]) {
        const textCmds = commandsOfKind(source, "text");
        const lineCmds = commandsOfKind(source, "line");
        deepStrictEqual(textCmds.map(t => t.text).join(""), expected, source);
        assert(textCmds.every(t => !t.style.fontWeight && !t.style.fontStyle), "escaped markers must not trigger bold/italic");
        assert(lineCmds.length === 0, "escaped markers must not trigger underline");
        const roundtripped = parse(source).content[0].toString(source);
        deepStrictEqual(commandsOfKind(roundtripped, "text").map(t => t.text).join(""), expected);
    }

    // 字面反斜杠后紧接斜体开关：\\\\* 经编码层与富文本层后产出字面 \ 并开启斜体
    const slashItalic = commandsOfKind(String.raw`"\\\\*斜体*"`, "text");
    deepStrictEqual(slashItalic.map(t => [t.text, t.style.fontStyle ?? "normal"]), [
        ["\\", "normal"],
        ["斜体", "italic"],
    ]);

    // 倚音缩放 @text 字号时，行距与 toString() 中的 lineheight 倍数保持一致
    const graceSource = `@grace(1, @text("上\n下", lineheight=1.5))`;
    const [upper, lower] = commandsOfKind(graceSource, "text").filter(cmd => cmd.text === "上" || cmd.text === "下");
    assert(nearly(lower.y - upper.y, upper.style.fontSize * 1.5), "grace multiline text must scale line spacing with size");
    assert(parse(graceSource).toString(graceSource).includes("lineheight=1.5"), "grace multiline text must preserve lineheight ratio on roundtrip");
});


