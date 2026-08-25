import { test } from "node:test";

import type { DocumentLayoutResult } from "../src/layout/engine.js";
import type { PlacedAttachment, Rect } from "../src/layout/types.js";
import { assert, attachmentCommands, commandsOfKind, expectLoweringError, layoutOf, lower, nearly } from "./helpers.js";

test("dx/dy 在排版之后平移，邻居完全不动", () => {
    const base = layoutOf(`1 2`);
    const moved = layoutOf(`@adjust({1}, dx=3px, dy=-4px) 2`);

    assert(nearly(moved.objects[0].box.x, base.objects[0].box.x + 3), "dx 必须精确平移目标");
    assert(nearly(moved.objects[0].box.y, base.objects[0].box.y - 4), "dy 必须精确平移目标");
    assert(nearly(moved.objects[1].box.x, base.objects[1].box.x), "平移不参与排版，右邻不能移动");
    assert(nearly(moved.objects[1].box.y, base.objects[1].box.y), "平移不能改变行内纵向布局");
});

test("dw/dh 在排版之前生效，邻居会让开", () => {
    const wider = layoutOf(`@adjust({1}, dw=10px) 2`);
    const base = layoutOf(`1 2`);
    assert(nearly(
        wider.objects[0].box.anchor / wider.objects[0].box.w,
        base.objects[0].box.anchor / base.objects[0].box.w,
    ), "dw 必须按原左右占位比例分配");
    assert(nearly(wider.objects[1].box.x, base.objects[1].box.x + 10), "dw 必须把右邻推开同样的距离");

    const taller = layoutOf(`@adjust({1}, dh=10px) @br() 2`);
    const twoLines = layoutOf(`1 @br() 2`);
    assert(nearly(taller.objects[1].box.y, twoLines.objects[1].box.y + 10), "dh 必须把下一行推开同样的距离");
});

test("括住多个对象时逐个施加同一增量", () => {
    const base = layoutOf(`1 2 3`);
    const moved = layoutOf(`@adjust({1 2 3}, dy=-4px)`);
    assert(moved.objects.length === 3, "内容组必须保留全部对象");
    for (let i = 0; i < 3; i++) {
        assert(nearly(moved.objects[i].box.y, base.objects[i].box.y - 4), `第 ${i + 1} 个对象必须一起平移`);
        assert(nearly(moved.objects[i].box.x, base.objects[i].box.x), `第 ${i + 1} 个对象的横向位置不变`);
    }
});

test("嵌套 adjust 的位置与尺寸增量逐层叠加", () => {
    const base = layoutOf(`1 2`);
    const nested = layoutOf(`@adjust(@adjust(1, dx=2px, dy=-3px, dw=4px, dh=5px), dx=7px, dy=-11px, dw=6px, dh=8px) 2`);
    assert(nearly(nested.objects[0].box.x, base.objects[0].box.x + 9), "嵌套 dx 必须叠加");
    assert(nearly(nested.objects[0].box.y, base.objects[0].box.y - 14), "嵌套 dy 必须叠加");
    assert(nearly(nested.objects[0].box.w, base.objects[0].box.w + 10), "嵌套 dw 必须叠加");
    assert(nearly(nested.objects[0].box.h, base.objects[0].box.h + 13), "嵌套 dh 必须叠加");
    assert(nearly(nested.objects[1].box.x, base.objects[1].box.x + 10), "右邻只受累计 dw 影响");

    const clamped = layoutOf(`@adjust(@adjust(1, dw=-100px, dh=-100px), dw=100px, dh=100px)`);
    assert(nearly(clamped.objects[0].box.w, 100), "嵌套 dw 必须先执行内层截断，再执行外层增量");
    assert(nearly(clamped.objects[0].box.h, 100), "嵌套 dh 必须先执行内层截断，再执行外层增量");
});

test("折叠成员也能微调：@up 的上方标记与倚音", () => {
    // 和弦成员不进入全局 columns，只能从绘制结果观察
    const chordBase = textCommands(`1 ^ @tempo(94)`);
    const chordMoved = textCommands(`1 ^ @adjust(@tempo(94), dy=-4px)`);
    assert(nearly(findText(chordMoved, "94").y, findText(chordBase, "94").y - 4), "@up 的非首成员必须能被微调");
    assert(nearly(findText(chordMoved, "1").y, findText(chordBase, "1").y), "同一和弦的其他成员不受影响");

    const graceBase = textCommands(`2>1`);
    const graceMoved = textCommands(`@adjust(2, dy=-3px)>1`);
    assert(nearly(findText(graceMoved, "2").y, findText(graceBase, "2").y - 3), "倚音成员必须能被微调");
    assert(nearly(findText(graceMoved, "1").y, findText(graceBase, "1").y), "宿主不受影响");
});

test("连音线跟着被微调的端点走", () => {
    const base = layoutOf(`1@x 2@y @tie(x,y)`);
    const moved = layoutOf(`@adjust({1@x}, dy=-4px) 2@y @tie(x,y)`);

    // 连音线抬高后会申报更多上方占用，整行因此下移，所以只有相对关系是不变量
    assert(nearly(moved.objects[0].box.y - moved.objects[1].box.y, base.objects[0].box.y - base.objects[1].box.y - 4),
        "被微调的音符必须比邻居高 4px");
    assert(nearly(tieStart(moved).y - moved.objects[0].box.y, tieStart(base).y - base.objects[0].box.y),
        "弧线起点必须黏在被微调的音符上");
});

test("作用域里没有对象时，平移的是关系对象本身", () => {
    const base = layoutOf(`1@x 2@y @tie(x,y)`);
    const moved = layoutOf(`1@x 2@y @adjust(@tie(x,y), dy=-6px)`);
    assert(nearly(tieOf(moved).box.y - moved.objects[0].box.y, tieOf(base).box.y - base.objects[0].box.y - 6),
        "整条连音线必须离主体更远 6px");
    assert(nearly(tieOf(moved).regions[0].y, tieOf(moved).box.y), "regions 必须与外接盒一起平移");

    // 框内的关系对象被替换成包装对象，外层 box 必须仍能取到它的边界
    const boxedBase = layoutOf(`@box({1@a 2@b @tie(a,b)}, padding=0px, stroke=1px)`);
    const boxed = layoutOf(`@box({1@a 2@b @adjust(@tie(a,b), dy=-6px)}, padding=0px, stroke=1px)`);
    assert(contains(frameOf(boxed), tieOf(boxed).box), "框必须包住微调之后的连音线");
    assert(nearly(frameOf(boxed).h, frameOf(boxedBase).h + 6), "框必须跟着微调后的连音线长高");
});

test("重排两轮时平移只施加一次", () => {
    // 高连音线会撑开轨道占用，触发第二轮纵向放置
    const base = layoutOf(`1@a 2@b @tie(a,b,height=60px)`);
    const moved = layoutOf(`@adjust({1@a}, dx=5px) 2@b @tie(a,b,height=60px)`);
    assert(nearly(moved.objects[0].box.x, base.objects[0].box.x + 5), "两轮放置也只能平移一次");

    const enclosed = layoutOf(`@adjust({1@a 2@b @tie(a,b,height=60px)}, dx=5px)`);
    const start = tieStart(enclosed);
    assert(nearly(start.x, enclosed.objects[0].box.x + enclosed.objects[0].box.anchor),
        "内部关系对象在第二轮也只能读取一次偏移后的端点");
});

test("外包复合函数时保留对象身份与既有布局机制", () => {
    const fixed = layoutOf(`@adjust(@box({1 2 3}, padding=0px, stroke=0px, width=120px), dx=5px) 4`);
    const frame = frameOf(fixed);
    assert(nearly(frame.w, 120), "adjust 外包定宽 box 时不能让其横向约束失效");

    const headBase = textCommands(`@head(left={@text(L)}, center={@text(C)}, right={@text(R)}) @br() 1`);
    const headMoved = textCommands(`@adjust(@head(left={@text(L)}, center={@text(C)}, right={@text(R)}), dy=-2px) @br() 1`);
    for (const text of ["L", "C", "R"]) {
        assert(nearly(findText(headMoved, text).x, findText(headBase, text).x),
            `adjust 外包 head 时不能破坏 ${text} 的横向对齐`);
    }
});

test("外包含关系对象的 box 时保留 attachment 依赖", () => {
    const layout = layoutOf(`@adjust(@box({1@a 2@b @tie(a,b)}, padding=0px, stroke=1px), dy=-2px)`);
    assert(contains(frameOf(layout), tieOf(layout).box), "box 必须仍能读取内部关系对象的边界");
});

test("adjust 不绕过 attachment 自身的语义校验", () => {
    expectLoweringError(`@adjust(@tuplet({1 2 @br() 3}, 2))`, "E_TUPLET_CROSS_LINE");
});

test("负 dw/dh 缩小占位但最终尺寸保持非负", () => {
    const base = layoutOf(`1`).objects[0].box;
    const shrunk = layoutOf(`@adjust(1, dw=-5px, dh=-5px)`).objects[0].box;
    assert(nearly(shrunk.w, Math.max(0, base.w - 5)), "负 dw 必须缩小宽度");
    assert(nearly(shrunk.h, Math.max(0, base.h - 5)), "负 dh 必须缩小高度");
    assert(nearly(shrunk.anchor / shrunk.w, base.anchor / base.w), "缩小时也必须保持左右占位比例");

    const collapsed = layoutOf(`@adjust(1, dw=-100px, dh=-100px)`).objects[0].box;
    assert(collapsed.w === 0 && collapsed.h === 0, "尺寸增量不能产生负宽高");
    assert(collapsed.anchor === 0, "宽度归零时左右占位也必须归零");
});

test("没有作用对象时报警告", () => {
    const result = lower(`@adjust(@set(div.autobeam=false), dy=-4px)`);
    assert(result.diagnostics.some(item => item.code === "W_ADJUST_NO_TARGET"), "落空的微调必须给出警告");
});

function textCommands(source: string) {
    return commandsOfKind(source, "text");
}

function findText(commands: ReturnType<typeof textCommands>, text: string) {
    const command = commands.find(item => item.text.includes(text));
    assert(command, `绘制结果里必须有文本 ${text}`);
    return command;
}

function tieOf(layout: DocumentLayoutResult): PlacedAttachment {
    const tie = layout.attachments.find(item => item.layer === "foreground");
    assert(tie, "必须生成一条连音线");
    return tie;
}

function frameOf(layout: DocumentLayoutResult): Rect {
    const frame = layout.attachments.find(item => item.layer === "background");
    assert(frame, "必须生成一个 box 边框");
    return frame.box;
}

function tieStart(layout: DocumentLayoutResult) {
    const path = attachmentCommands(tieOf(layout)).find(item => item.kind === "path");
    assert(path?.kind === "path", "连音线必须画成路径");
    const move = path.commands[0];
    assert(move.op === "M", "连音线路径必须从起点开始");
    return move;
}

function contains(outer: Rect, inner: Rect) {
    return outer.x <= inner.x
        && outer.y <= inner.y
        && outer.x + outer.w >= inner.x + inner.w
        && outer.y + outer.h >= inner.y + inner.h;
}
