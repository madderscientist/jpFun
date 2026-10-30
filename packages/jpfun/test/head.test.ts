import { test } from "node:test";

import { ASTFunctionNode } from "../src/functions/ASTtypes.js";
import type { VisualTemporalNode } from "../src/functions/temporal.js";
import { compileScore } from "../src/pipeline.js";
import { compilePlayback } from "../src/playback/compile.js";
import {
    assert,
    commandsOfKind,
    expectLoweringError,
    layoutOf,
    lower,
    nearly,
    playedNotes,
    recordCommands,
} from "./helpers.js";

const texts = (source: string) => recordCommands(layoutOf(source))
    .filter(command => command.kind === "text");

const CONTENT_LEFT = 40;
const CONTENT_RIGHT = 754;
const PAGE_CENTER = (CONTENT_LEFT + CONTENT_RIGHT) / 2;
// 居中由两根强弹簧的对称性保证，但求解器按合力收敛，落到坐标上留下亚像素残差
const SOLVER_TOLERANCE = 0.05;

const textObjects = (source: string) => {
    const found = new Map<string, ReturnType<typeof layoutOf>["objects"][number]>();
    for (const object of layoutOf(source).objects) {
        const ast = object.ast;
        if (!(ast instanceof ASTFunctionNode) || ast.callName !== "text"
            || !("text" in ast) || typeof ast.text !== "string") continue;
        if (!found.has(ast.text)) found.set(ast.text, object);
    }
    return found;
};

test("head 分开左中右三槽，center 不受两侧宽度影响", () => {
    const source = `@head(
        left={@text(L)},
        center={@text(C)},
        right={@text(R)}
    ) @br() 1`;
    const commands = texts(source);
    const left = commands.find(command => command.text === "L")!;
    const center = commands.find(command => command.text === "C")!;
    const right = commands.find(command => command.text === "R")!;
    assert(left.x < center.x && center.x < right.x, "head slots must form distinct horizontal regions");
    const centerBox = textObjects(source).get("C")!.box;
    assert(Math.abs(centerBox.x + centerBox.w / 2 - PAGE_CENTER) < SOLVER_TOLERANCE,
        "center slot must align to the page content center");
    for (const [leftText, rightText] of [["LLLLLLLLLLLLLLLLLLLL", "R"], ["L", "RRRRRRRRRRRRRRRRRRRR"]]) {
        const box = textObjects(
            `@head(left={@text(${leftText})}, center={@text(C)}, right={@text(${rightText})}) @br() 1`
        ).get("C")!.box;
        assert(nearly(box.x + box.w / 2, centerBox.x + centerBox.w / 2),
            `wider side slots must not move the center: ${leftText}, ${rightText}`);
    }
});

test("侧槽各行贴住纸面左右边缘", () => {
    const layout = layoutOf(`H.signature: 1=C 4/4
H.tempo: 94
H.author: 作者
@br()
1`);
    const byName = (name: string) => layout.objects.find(object =>
        object.ast instanceof ASTFunctionNode && object.ast.callName === name)!;
    const key = byName("key");
    const tempo = byName("tempo");
    const author = byName("text");
    assert(Math.abs(key.box.x - CONTENT_LEFT) < SOLVER_TOLERANCE
        && Math.abs(tempo.box.x - CONTENT_LEFT) < SOLVER_TOLERANCE,
        "every left row must start at the page content left edge");
    assert(Math.abs(author.box.x + author.box.w - CONTENT_RIGHT) < SOLVER_TOLERANCE,
        "the right slot must end at the page content right edge");
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
            || !("text" in ast) || typeof ast.text !== "string") continue;
        boxes[ast.text] = object.box;
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
            || !("text" in ast) || typeof ast.text !== "string") return [];
        return [[ast.text, object.box]];
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
                || !("text" in ast) || typeof ast.text !== "string") continue;
            axes[ast.text] = object.box.y + object.box.visualAxis;
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

test("head 行间距默认 5px 并支持 gap 参数", () => {
    const rowGap = (gap = "") => {
        const objects = textObjects(`@head(center={@text(A) @text(B)}${gap})`);
        const first = objects.get("A")!.box;
        const second = objects.get("B")!.box;
        return second.y - first.y - first.h;
    };
    assert(nearly(rowGap(), 5), "head rows must use the default 5px gap");
    assert(nearly(rowGap(", gap=11px"), 11), "the head gap argument must override the default");
});

test("head 侧栏按顶层元素紧凑排列", () => {
    const layout = layoutOf(`H.left: @key(D4)@meter(4,4)
H.left: @tempo(96)@text("96")
H.right: {@text(A) @text(B)}`);
    const find = (name: string, text?: string) => layout.objects.find(object => {
        const ast = object.ast;
        if (!(ast instanceof ASTFunctionNode) || ast.callName !== name) return false;
        return text === void 0 || ("text" in ast && ast.text === text);
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

test("head 拒绝正时长内容", () => {
    for (const source of [
        "@head(center={1})",
        "@head(left=@rest(2))",
        "@head(center=@up(@rest(2), @text(X)))",
        "@head(right=@grace(@rest(2), 1))",
        "@head(center=@head(right=@rest(2)))",
        "@stack({@head(left=@rest(2))}, {@text(X)})",
    ]) {
        expectLoweringError(`@meter(4,4) ${source}`, "E_HEAD_NONZERO_DURATION");
    }
});

test("head 的末边界校验支持多个、嵌套和并行谱头", () => {
    for (const source of [
        "@head(left=@text(L)) @head(right=@text(R))",
        "@head(center=@head(right=@text(R)))",
        "@stack({@head(left=@text(L))}, {@head(right=@text(R))})",
    ]) {
        assert(lower(source).duration.isZero(), "zero-duration heads must remain valid");
    }
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

    const boxes = textObjects(source);
    for (const name of ["标题", "副标题"]) {
        const box = boxes.get(name)!.box;
        assert(Math.abs(box.x + box.w / 2 - PAGE_CENTER) < SOLVER_TOLERANCE,
            "every center row must sit on the page content centre line");
    }
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

test("head 与 H 内容使用完整全局 attachment 生命周期", () => {
    for (const source of [
        "@head(center={@box(@text(测试), padding=0.2em)}) @br() 1",
        "H.title: @box({@text(A) @text(B)}, width=300px)\n@br()\n1",
    ]) {
        const commands = recordCommands(layoutOf(source));
        const box = commands.find(command => command.kind === "rect");
        assert(box, "box inside head must be painted");
        if (source.startsWith("H.")) {
            assert(nearly(box.w, 300), "fixed-width box inside H.title must run its global horizontal hook");
        }
        for (const text of source.startsWith("@head") ? ["测试"] : ["A", "B"]) {
            assert(commands.some(command => command.kind === "text" && command.text === text),
                `box content inside head must remain visible: ${text}`);
        }
    }
});

// 侧槽在弹簧链上收缩成一个点，但块内的相对布局保留在刚性列的偏移里
test("侧槽内的定宽 box 保留自己的宽度且不影响 center", () => {
    const source = `H.left: @box({@text(A) @text(B)}, width=300px)
H.title: 标题
@br()
1`;
    const box = recordCommands(layoutOf(source)).find(command => command.kind === "rect");
    assert(box && nearly(box.w, 300), "a fixed-width box inside a side slot must keep its width");
    const title = textObjects(source).get("标题")!.box;
    assert(Math.abs(title.x + title.w / 2 - PAGE_CENTER) < SOLVER_TOLERANCE,
        "a fixed-width box inside a side slot must not shift the center slot");
});

test("H 调号速度作用于正文，保留源码范围并支持空行分段", () => {
    const source = `H.signature: 1 = D4  4 / 4\nH.tempo: 90\n@br()\n1 2 3 4 |`;
    const objects = compileScore(source).layout.objects;
    const key = objects.find(object => object.ast instanceof ASTFunctionNode && object.ast.callName === "key")!;
    const meter = objects.find(object => object.ast instanceof ASTFunctionNode && object.ast.callName === "meter")!;
    assert(source.slice(key.ast.sourceSpan.start, key.ast.sourceSpan.end) === "1 = D4", "key span");
    assert(source.slice(meter.ast.sourceSpan.start, meter.ast.sourceSpan.end) === "4 / 4", "meter span");
    const note = objects.find(object => object.ast instanceof ASTFunctionNode && object.ast.callName === "note") as VisualTemporalNode & { resolvedMidi: number };
    assert(note.resolvedMidi === 62 && playedNotes(compilePlayback(lower(source)))[0].bpm === 90, "head state applies to score");

    const twoHeads = compileScore(`H.title: A\n\nH.title: B`).ast.content
        .filter(node => node instanceof ASTFunctionNode && node.callName === "head");
    assert(twoHeads.length === 2, "a blank line must start a new head block");
});
