import { test } from "node:test";

import { ASTFunctionNode } from "../src/functions/ASTtypes.js";
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

test("align 只接受 left 和 center", () => {
    expectCompileError(`@text("上行", align=middle)`, "E_TEXT_INVALID_ALIGN");
});
