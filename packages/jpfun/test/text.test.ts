import { test } from "node:test";

import { ASTFunctionNode } from "../src/functions/ASTtypes.js";
import { analyzeScoreSyntax } from "../src/pipeline.js";
import { assert, commandsOfKind, expectCompileError, layoutOf, nearly, parse, recordCommands } from "./helpers.js";

/** 只写一个 @text 时它就是唯一的可见对象 */
function textBox(source: string) {
    const objects = layoutOf(source).objects;
    assert(objects.length === 1, `Expected one visible object, got ${objects.length}`);
    return { box: objects[0].box, size: objects[0].ast.size };
}

test("单行文本的盒子与默认测量一致", () => {
    const { box, size } = textBox(`@text("进入")`);

    assert(nearly(box.w, size * 2), "single line width must be the measured text width");
    assert(nearly(box.h, size), "single line height must stay one font size");
    assert(nearly(box.anchor, size / 2), "anchor must be half of the first character");
    assert(nearly(box.visualAxis, size / 2), "visualAxis must stay at the block center");
});

test("括号内的换行按多行排版", () => {
    const { box, size } = textBox(`@text("上行\n下面这行更长")`);

    assert(nearly(box.w, size * 6), "width must come from the widest line");
    assert(nearly(box.h, size * 1.25 + size), "height must be one line advance plus the last line");
    assert(nearly(box.anchor, size / 2), "anchor must still follow the first character of the first line");
    assert(nearly(box.visualAxis, box.h / 2), "visualAxis must stay at the block center");
});

test("lineheight 是自身字号的倍数", () => {
    const { box, size } = textBox(`@text("上行\n下行", lineheight=2)`);

    assert(nearly(box.h, size * 3), "line advance must be lineheight times the font size");
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

test("字符串把 \\X 反转义成 X", () => {
    const sugar = commandsOfKind(`"说\\"你好\\""`, "text");
    const explicit = commandsOfKind(`@text("说\\"你好\\"")`, "text");
    assert(sugar[0].text === `说"你好"`, `escaped quote must survive, got ${sugar[0].text}`);
    assert(explicit[0].text === sugar[0].text, "both paths must share one unescape rule");
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
