import { test } from "node:test";

import { ASTFunctionNode } from "../src/functions/ASTtypes.js";
import { compileScore } from "../src/pipeline.js";
import {
    assert,
    commandsOfKind,
    expectLoweringError,
    layoutOf,
    nearly,
    recordCommands,
} from "./helpers.js";

const texts = (source: string) => recordCommands(layoutOf(source))
    .filter(command => command.kind === "text");

test("head 使用全局弹簧分开左中右三槽", () => {
    const source = `@head(
        left={@text(L)},
        center={@text(C)},
        right={@text(R)}
    ) @br() 1`;
    const layout = layoutOf(source);
    const commands = texts(source);
    const left = commands.find(command => command.text === "L")!;
    const center = commands.find(command => command.text === "C")!;
    const right = commands.find(command => command.text === "R")!;
    assert(left.x < center.x && center.x < right.x, "head slots must form distinct horizontal regions");
    const centerObject = layout.objects.find(object => object.box.x === center.x)!;
    assert(nearly(centerObject.box.x + centerObject.box.anchor, 397),
        "center slot must align to the page content center");
});

test("head 侧栏底部对齐且较高侧贴住标题下侧", () => {
    const layout = layoutOf(`@head(
        left={@text(L1) @text(L2) @text(L3)},
        center={@text(T, 2em)},
        right={@text(R)}
    )`);
    const boxes: Record<string, typeof layout.objects[number]["box"]> = {};
    for (const object of layout.objects) {
        const ast = object.ast;
        if (!(ast instanceof ASTFunctionNode) || ast.callName !== "text"
            || !("lines" in ast) || !Array.isArray(ast.lines)) continue;
        const text = ast.lines[0];
        if (typeof text === "string") boxes[text] = object.box;
    }
    const leftTop = Math.min(boxes.L1.y, boxes.L2.y, boxes.L3.y);
    const leftBottom = Math.max(
        boxes.L1.y + boxes.L1.h,
        boxes.L2.y + boxes.L2.h,
        boxes.L3.y + boxes.L3.h,
    );
    const rightTop = boxes.R.y;
    const rightBottom = boxes.R.y + boxes.R.h;
    assert(nearly(leftBottom, rightBottom),
        "left and right slots must share one bottom edge");
    assert(nearly(leftTop, boxes.T.y + boxes.T.h),
        "the taller side slot must start at the title bottom");
    assert(rightTop > leftTop, "the shorter side slot must start lower above the shared bottom");
});

test("head 以 center 首个有视觉占用的行作为标题行", () => {
    const layout = layoutOf(`@head(
        left={@text(L)},
        center={@set(foo=bar) @text(T, 2em)}
    )`);
    const boxes = Object.fromEntries(layout.objects.flatMap(object => {
        const ast = object.ast;
        if (!(ast instanceof ASTFunctionNode) || ast.callName !== "text"
            || !("lines" in ast) || !Array.isArray(ast.lines)) return [];
        return [[ast.lines[0], object.box]];
    }));
    assert(nearly(boxes.L.y, boxes.T.y + boxes.T.h),
        "non-visual center rows must not detach side slots from the title bottom");
});

test("head 三槽独立计算内部行距", () => {
    const positions = (rightSize: string) => {
        const layout = layoutOf(`@head(
            left={@text(L1) @text(L2)},
            center={@text(C1) @text(C2) @text(C3)},
            right={@text(R1, ${rightSize}) @text(R2)}
        )`);
        const axes: Record<string, number> = {};
        for (const object of layout.objects) {
            const ast = object.ast;
            if (!(ast instanceof ASTFunctionNode) || ast.callName !== "text"
                || !("lines" in ast) || !Array.isArray(ast.lines)) continue;
            const text = ast.lines[0];
            if (typeof text === "string") axes[text] = object.box.y + object.box.visualAxis;
        }
        return axes;
    };
    const normal = positions("1em");
    const tallRight = positions("3em");
    assert(nearly(normal.C3 - normal.C2, tallRight.C3 - tallRight.C2),
        "right row height must not change center row spacing");
    assert(nearly(normal.L2 - normal.L1, tallRight.L2 - tallRight.L1),
        "right row height must not change left row spacing");
    assert(tallRight.R2 - tallRight.R1 > normal.R2 - normal.R1,
        "right row height must still affect later rows in the right slot");
});

test("head 侧栏按顶层元素紧凑排列", () => {
    const layout = layoutOf(`H.left: @key(D4)@meter(4,4)
H.left: @tempo(96)@text("96")
H.right: {@text(A) @text(B)}`);
    const find = (name: string, text?: string) => layout.objects.find(object => {
        const ast = object.ast;
        if (!(ast instanceof ASTFunctionNode) || ast.callName !== name) return false;
        return text === void 0 || ("lines" in ast && Array.isArray(ast.lines) && ast.lines[0] === text);
    })!;
    const key = find("key");
    const meter = find("meter");
    const tempo = find("tempo");
    const text = find("text", "96");
    const rightA = find("text", "A");
    const rightB = find("text", "B");
    const gap = key.ast.size * 0.25;
    assert(nearly(meter.box.x - key.box.x - key.box.w, gap),
        "left key and meter must use the fixed item gap");
    assert(nearly(text.box.x - tempo.box.x - tempo.box.w, gap),
        "left tempo and text must use the fixed item gap");
    assert(nearly(rightB.box.x - rightA.box.x - rightA.box.w, gap),
        "right items must preserve writing order with the fixed item gap");
});

test("head 内 attachment 进入全局布局", () => {
    const commands = recordCommands(layoutOf(`@head(center={@box(@text(测试), padding=0.2em)}) @br() 1`));
    assert(commands.some(command => command.kind === "rect"), "box inside head must be painted");
    assert(commands.some(command => command.kind === "text" && command.text === "测试"),
        "box content inside head must remain visible");
});

test("head 拒绝正时长内容", () => {
    expectLoweringError(`@head(center={1})`, "E_HEAD_NONZERO_DURATION");
});

test("H 声明合并并保持一次声明一行", () => {
    const source = `H.title: 标题
H.subtitle: 副标题
H.author: 作者
H.left: @text(A) @text(B)
@br()
1`;
    const layout = layoutOf(source);
    const commands = recordCommands(layout).filter(command => command.kind === "text");
    const title = commands.find(command => command.text === "标题")!;
    const subtitle = commands.find(command => command.text === "副标题")!;
    const leftA = commands.find(command => command.text === "A")!;
    const leftB = commands.find(command => command.text === "B")!;
    assert(title.y < subtitle.y, "title and subtitle must occupy consecutive center rows");
    assert(nearly(leftA.y, leftB.y), "one H declaration must remain one visual row");
    assert(layout.objects.filter(object =>
        object.ast instanceof ASTFunctionNode && object.ast.callName === "note"
    ).length === 1,
        "consecutive H declarations must compile as one head block");
});

test("H 显式 call 与 brace 的内部换行不终止声明", () => {
    const commands = texts(`H.center: {@text(A)
@text(B)}
H.right: @text("R1
R2")
@br()
1`);
    const a = commands.find(command => command.text === "A")!;
    const b = commands.find(command => command.text === "B")!;
    const r1 = commands.find(command => command.text === "R1")!;
    const r2 = commands.find(command => command.text === "R2")!;
    assert(nearly(a.y, b.y), "brace-internal newline must remain inside one head row");
    assert(r1.y < r2.y, "call-internal newline must remain inside one text call");
});

test("H.author 多行共享右边缘", () => {
    const source = `H.author: 短
H.author: 很长的作者信息
@br()
1`;
    const commands = commandsOfKind(source, "text").filter(command =>
        command.text === "短" || command.text === "很长的作者信息"
    );
    assert(commands.length === 2 && nearly(commands[0].x, commands[1].x),
        "author rows must share one right-aligned anchor");
    assert(commands.every(command => command.style.textAlign === "right"),
        "author rows must use right text alignment");
});

test("H 显式内容使用完整全局 attachment 生命周期", () => {
    const commands = recordCommands(layoutOf(`H.title: @box({@text(A) @text(B)}, width=300px)
@br()
1`));
    const box = commands.find(command => command.kind === "rect");
    assert(box && nearly(box.w, 300), "fixed-width box inside H.title must run its global horizontal hook");
});

test("H 调号速度直接作用于后续正文", () => {
    const layout = layoutOf(`H.signature: 1=D4 4/4
H.tempo: 90
@br()
1 2 3 4 |`);
    const note = layout.objects.find(object =>
        object.ast instanceof ASTFunctionNode && object.ast.callName === "note"
    ) as typeof layout.objects[number] & { activeBpm: number; resolvedMidi: number };
    assert(note.activeBpm === 90 && note.resolvedMidi === 62,
        "head state temporals must participate directly in the global state flow");
});

test("H.signature 为调号和拍号保留各自源码范围", () => {
    const source = `H.signature: 1 = C  4 / 4`;
    const objects = compileScore(source).layout.objects;
    const key = objects.find(object => object.ast instanceof ASTFunctionNode && object.ast.callName === "key")!;
    const meter = objects.find(object => object.ast instanceof ASTFunctionNode && object.ast.callName === "meter")!;
    assert(source.slice(key.ast.sourceSpan.start, key.ast.sourceSpan.end) === "1 = C",
        "signature key must map only to the 1=tonality source");
    assert(source.slice(meter.ast.sourceSpan.start, meter.ast.sourceSpan.end) === "4 / 4",
        "signature meter must map only to the fraction source");
});

test("head 可以与正文共享逻辑谱面行", () => {
    const layout = layoutOf(`@head(center={@text(A)}) 1`);
    const headText = layout.objects.find(object =>
        object.ast instanceof ASTFunctionNode && object.ast.callName === "text"
    );
    const note = layout.objects.find(object =>
        object.ast instanceof ASTFunctionNode && object.ast.callName === "note"
    );
    assert(headText && note && headText.layoutLine === note.layoutLine,
        "inline head and following content must share one layout line");
});

test("空行结束连续 H 声明组合", () => {
    const result = compileScore(`H.title: A

H.title: B`);
    const heads = result.ast.content.filter(node =>
        node instanceof ASTFunctionNode && node.callName === "head"
    );
    assert(heads.length === 2, "a blank line must start a new head block");
});

test("head 去糖结果按槽和视觉行换行缩进", () => {
    const source = `@head(left={{@key(D4) @meter(4,4)}}, center={@text(A)})`;
    const head = compileScore(source).ast.content[0];
    const expected = [
        "@head(",
        "  left={",
        "    {@1(D4)@meter(4, 4)}",
        "  },",
        "  center={",
        "    @text(\"A\", size=22px, lineheight=1.25, align=left)",
        "  }",
        ")",
    ].join("\n");
    assert(head.toString(source) === expected, "head toString must expose its slot and row structure");
});

test("head 内关系 attachment 使用真实全局端点", () => {
    const commands = recordCommands(layoutOf(`@head(center={{
        @up(@text(A))@a @up(@text(B))@b @tie(a,b)
    }}) @br() 1`));
    assert(commands.some(command => command.kind === "path"),
        "tie inside head must paint through the global attachment lifecycle");
});

test("head 可以嵌套在内容作用域中", () => {
    const result = compileScore(`{@head(center={@text(A)})}`);
    assert(recordCommands(result.layout).some(command => command.kind === "text" && command.text === "A"),
        "nested head content must participate in normal layout");
});
