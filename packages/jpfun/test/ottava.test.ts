import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";

import { getLayoutBounds, layoutDocument } from "../src/layout/engine.js";
import { transformNotes } from "../src/functions/note/index.js";
import { compilePlayback } from "../src/playback/compile.js";
import { defaultTextMeasurer } from "../src/render/text.js";
import {
    assert, attachmentCommands, compileValid, expectCompileError, expectLoweringError,
    layoutContext, layoutOf, lower, nearly, playedNotes,
} from "./helpers.js";

function pitches(source: string) {
    return playedNotes(compilePlayback(lower(source))).map(note => note.midi);
}

function ottavaCommands(source: string, fontSize?: number) {
    const layout = layoutOf(source, fontSize);
    const attachment = layout.attachments.find(item => item.sourceSpan?.start === source.indexOf("@ottava"))!;
    return { layout, attachment, commands: attachmentCommands(attachment) };
}

test("八度号包含首末音，端点顺序不限，不改变记谱音高或时值", () => {
    const plain = layoutOf("1 2 3. 4");
    for (const shift of [2, -3]) {
        for (const ends of ["a,b", "b,a"]) {
            const source = `1 2@a 3.@b 4 @ottava(${ends},${shift})`;
            const result = compileValid(source);
            deepStrictEqual(playedNotes(compilePlayback(result.lowering)).map(note => note.midi),
                [60, 62 + 12 * shift, 64 + 12 * shift, 65]);
            assert(result.layout.objects.length === plain.objects.length, "八度号不产生时间列");
            for (let i = 0; i < plain.objects.length; i++) {
                const note = result.layout.objects[i];
                assert(nearly(note.box.w, plain.objects[i].box.w)
                    && nearly(note.box.h, plain.objects[i].box.h)
                    && note.T.equals(plain.objects[i].T), "记谱八度点、宽高与时值不变");
            }
        }
    }
    deepStrictEqual(pitches("1@a 2 @ottava(a,a)"), [72, 62]);
});

test("八度号只影响同轨，和弦及倚音随宿主移调，休止与节拍不发旋律音", () => {
    deepStrictEqual(pitches("@stack({1@a 2@b 3}, {4 5 6}) @ottava(a,b,1)"),
        [72, 65, 74, 67, 64, 69]);
    deepStrictEqual(pitches("@up(1@a,3,5) 2 @ottava(a,a,-1)"), [55, 52, 48, 62]);
    deepStrictEqual(pitches("1@a 0 8 9 2@b 3 @ottava(a,b,1)"), [72, 37, 74, 64]);
    deepStrictEqual(pitches("@grace(1,2)@a 3 @ottava(a,a,1)"), [74, 72, 64]);
});

test("八度号延续增时线，反复编译不叠加偏移", () => {
    const lowered = lower("|: 1@a 2 -@b :| 3 @ottava(a,b,2)");
    for (let i = 0; i < 2; i++) {
        const plan = compilePlayback(lowered);
        const notes = playedNotes(plan);
        deepStrictEqual(notes.map(note => note.midi), [84, 86, 84, 86, 64]);
        assert(notes[1].duration.equals(2) && notes[3].duration.equals(2), "完整保留末音延时");
        assert(plan.performanceDuration.equals(7), "八度号不改变反复次数或总时值");
    }
});

test("八度号的重叠偏移可叠加或抵消，区间结束后恢复原音高", () => {
    deepStrictEqual(pitches("1@a 2@b 3@c 4 @ottava(a,c,1) @ottava(b,b,1)"),
        [72, 86, 76, 65]);
    deepStrictEqual(pitches("1@a 2@b 3@c 4 @ottava(b,b,-1) @ottava(a,c,1)"),
        [72, 62, 76, 65]);
    deepStrictEqual(pitches("1@a 2@b 3@c 4 @ottava(a,c,3) @ottava(b,b,-2)"),
        [96, 74, 100, 65]);
});

test("八度号同时移调装饰音，并按实际音高决定延音线连接", () => {
    const plain = pitches("1^$prall 2");
    for (const shift of [2, -3]) {
        const shifted = pitches(`{1^$prall}@a 2 @ottava(a,a,${shift})`);
        deepStrictEqual(shifted, plain.map((midi, i) => i < plain.length - 1 ? midi + shift * 12 : midi));
    }
    deepStrictEqual(pitches("1@a 1''@b @tie(a,b) @ottava(a,a,2)"), [84]);
    deepStrictEqual(pitches("1@a 1@b @tie(a,b) @ottava(a,a,1)"), [72, 60]);
});

test("八度号不污染音符源码转换，与渐强渐弱共享播放状态", () => {
    const source = "1@a 2@b @dyn(a,b,20) @ottava(a,b,1)";
    const lowered = lower(source);
    deepStrictEqual(transformNotes(source, lowered, "to-absolute").map(edit => edit.text), ["C4", "D4"]);
    const notes = playedNotes(compilePlayback(lowered));
    deepStrictEqual(notes.map(note => note.midi), [72, 74]);
    deepStrictEqual(notes.map(note => note.velocity), [80, 100]);
});

test("高低多八度号分别在上下方，虚线避开文字，只有末端向音符折回", () => {
    for (const [shift, text] of [[1, "8"], [-1, "8"], [2, "15"], [-2, "15"],
        [3, "22"], [-3, "22"], [4, "29"], [10, "71"]] as const) {
        const { layout, attachment, commands } = ottavaCommands(`1@a 2 3@b @ottava(a,b,${shift})`);
        const labels = commands.filter(command => command.kind === "text");
        const lines = commands.filter(command => command.kind === "line");
        const horizontal = lines.filter(line => nearly(line.y1, line.y2));
        const hooks = lines.filter(line => nearly(line.x1, line.x2));
        assert(labels.length === 1, "首段绘制一个数字标签");
        assert(labels[0].text === text && labels[0].style.fontStyle === "italic",
            "标签按八度数显示斜体数字");
        assert(horizontal.length > 2, "应绘制断开的虚线，而非实线");
        assert(hooks.length === 1, "只有末端有折钩");
        const hook = hooks[0];
        assert((hook.y2 - hook.y1) * shift > 0, "高八度下折，低八度上折");
        const region = attachment.regions[0];
        const bounds = layout.objects.map(object => getLayoutBounds(object));
        const top = Math.min(...bounds.map(box => box.y));
        const bottom = Math.max(...bounds.map(box => box.y + box.h));
        assert(shift > 0 ? region.y + region.h < top : region.y > bottom,
            "字形、虚线与折钩均应避让音符");
        const label = labels[0];
        const metrics = defaultTextMeasurer.measureText(label.text, label.style);
        assert(horizontal[0].x1 > label.x + metrics.w, "虚线必须从标签的右边开始");
        assert(nearly(label.x, region.x), "标签左沿与八度号范围对齐");
        const labelTop = label.y - metrics.baseline;
        const labelBottom = labelTop + metrics.h;
        const regionBottom = region.y + region.h;
        assert((labelTop >= region.y || nearly(labelTop, region.y))
            && (labelBottom <= regionBottom || nearly(labelBottom, regionBottom)),
        "文字度量必须包含在避让范围内");
        assert(horizontal.every((line, i) => i === 0 || line.x1 > horizontal[i - 1].x2),
            "虚线段之间必须有空隙");
    }
});

test("八度号贴所在音轨的端点主体，不吸附小节线或后续增时线，支持端点微调", () => {
    const source = "@stack({| 1 2 | #3@a 4 -@b - :| 5}, {#5' #6' #7' #1'' #2'' #3'' #4''}) @ottava(a,b)";
    const { layout, attachment, commands } = ottavaCommands(source);
    const head = layout.objects.find(object => source.slice(object.ast.sourceSpan.start, object.ast.sourceSpan.end) === "#3")!;
    const tail = layout.objects.filter(object => object.ast.toString("") === "-")[0];
    const left = head.box.x + head.ports["body.left"].x;
    const right = tail.box.x + (tail.ports["body.right"]?.x ?? tail.box.w);
    const hook = commands.find(command => command.kind === "line" && nearly(command.x1, command.x2))!;
    assert(nearly(attachment.regions[0].x, left), "8 的左沿对齐起点数字左沿");
    assert(hook.kind === "line" && nearly(hook.x1, right), "末钩只对齐显式终点的右沿");
    const moved = layoutOf("@adjust({1@a}, dx=700px) 2@b @ottava(a,b)");
    assert(moved.attachments[0].regions.every(region => region.w >= 0 && region.h >= 0),
        "后置微调不产生负宽高");
});

test("短区间不缩小标签或移动端点，容不下虚线时不绘制或登记虚线占用", () => {
    for (const [size, shift] of [[14, 1], [28, -1], [28, 2], [56, -3], [28, 15]]) {
        const { layout, attachment, commands } = ottavaCommands(`1@a @ottava(a,a,${shift})`, size);
        const note = layout.objects[0];
        const label = commands.find(command => command.kind === "text")!;
        const horizontal = commands.find(command => command.kind === "line" && command.x1 < command.x2
            && nearly(command.y1, command.y2));
        const hook = commands.find(command => command.kind === "line" && nearly(command.x1, command.x2))!;
        assert(label.kind === "text" && nearly(label.style.fontSize, size * 0.6), "标签字号不因区间变短而缩小");
        assert(nearly(label.x, note.box.x + note.ports["body.left"].x), "标签仍对齐起点左沿");
        assert(hook.kind === "line"
            && nearly(hook.x1, note.box.x + note.ports["body.right"].x), "末钩仍贴终点右沿");
        const metrics = defaultTextMeasurer.measureText(label.text, label.style);
        const fits = label.x + metrics.w + size * 0.08 < hook.x1;
        assert(Boolean(horizontal) === fits, "只有标签右侧还有空间时才绘制虚线");
        if (horizontal?.kind === "line") {
            assert(horizontal.x1 > label.x + metrics.w, "虚线不穿过文字");
        }
        assert(nearly(attachment.regions[0].x + attachment.regions[0].w,
            Math.max(label.x + metrics.w, hook.x1 + hook.style!.strokeWidth! / 2)),
        "不为未绘制的虚线额外扩张边界");
    }
});

test("跨行含空白行续画，首尾标记不重复，后声明的八度号向外避让", () => {
    for (const shift of [2, -3]) {
        const { layout, attachment, commands } = ottavaCommands(
            `1@a @br(2) | 2@b @ottava(a,b,${shift}) @ottava(a,b,${shift})`);
        assert(attachment.regions.length === 3, "跨行中间空行也要续画");
        assert(commands.filter(command => command.kind === "text").length === 1, "续行不重复标数字");
        const hooks = commands.filter(command => command.kind === "line" && nearly(command.x1, command.x2));
        assert(hooks.length === 1, "换行边界不画折钩");
        const last = layout.objects.at(-1)!;
        assert(hooks[0].kind === "line"
            && nearly(hooks[0].x1, last.box.x + last.box.w), "末段终止于末音右沿");
        const middle = attachment.regions[1];
        assert(middle.w > attachment.regions[0].w, "中间空行延伸到版心边缘");
        const [inner, outer] = layout.attachments;
        for (let i = 0; i < 3; i++) {
            assert(shift > 0
                ? outer.regions[i].y + outer.regions[i].h < inner.regions[i].y
                : outer.regions[i].y > inner.regions[i].y + inner.regions[i].h,
            "上下方向在空白行也要避让先前附件");
        }
    }
});

test("八度号布局可复用，参数可设默认，非法偏移及跨轨端点明确报错", () => {
    const lowered = lower("1@a 2@b @ottava(a,b,-1)");
    const first = layoutDocument(lowered, layoutContext);
    const second = layoutDocument(lowered, layoutContext);
    deepStrictEqual(first.attachments[0].regions, second.attachments[0].regions);
    deepStrictEqual(pitches("@set(ottava.shift=-2) 1@a @ottava(a,a)"), [36]);
    for (const shift of [0, 0.5, Number.MAX_SAFE_INTEGER]) {
        expectLoweringError(`1@a @ottava(a,a,${shift})`, "E_OTTAVA_INVALID_SHIFT");
    }
    expectLoweringError("@stack({1@a},{2@b}) @ottava(a,b)", "E_OTTAVA_CROSS_TRACK");
});

test("八度号的两个标签只接受位置参数，shift 仍可命名传入", () => {
    for (const args of ["", "a", "from=a,to=b", "a=b,b=a", "a,to=b"]) {
        expectCompileError(`1@a 2@b @ottava(${args})`, "E_MISSING_REQUIRED_ARG");
    }
    const result = compileValid("1@a 2@b @ottava(a,b,shift=-2)");
    deepStrictEqual(playedNotes(compilePlayback(result.lowering)).map(note => note.midi), [36, 38]);
});
