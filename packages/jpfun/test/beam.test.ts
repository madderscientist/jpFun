import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";

import { divLinePortName } from "../src/functions/div/index.js";
import { TemporalNodeBase } from "../src/functions/temporal.js";
import {
    assert,
    attachmentCommands,
    commandsOfKind,
    expectLoweringError,
    layoutOf,
    lower,
    nearly,
    recordCommands,
} from "./helpers.js";

function rectCount(layout: ReturnType<typeof layoutOf>) {
    return recordCommands(layout).filter(command => command.kind === "rect").length;
}

function expectBeams(cases: readonly (readonly [string, number])[]) {
    for (const [source, count] of cases) strictEqual(layoutOf(source).attachments.length, count, source);
}

test("相邻分割音符自动连梁，连梁内的音符间距更紧凑", () => {
    const auto = layoutOf(`1/ 2// 3/`);
    const disabled = layoutOf(`@set(div.autobeam=false) 1/ 2// 3/`);
    assert(auto.attachments.length === 1 && disabled.attachments.length === 0,
        "autobeam=false must keep separately written divs independent");
    for (let i = 1; i < disabled.objects.length; i++) {
        const gap = auto.objects[i].box.x - auto.objects[i - 1].box.x;
        assert(gap < disabled.objects[i].box.x - disabled.objects[i - 1].box.x, "连梁内侧应比独立分割音符更紧凑");
    }
    // 自动连梁合并共享层并保留一条内层短梁；关闭后各自在本地绘制
    deepStrictEqual([rectCount(auto), rectCount(disabled)], [2, 4]);
    strictEqual(layoutOf(`1// @text("barrier") 2//`).attachments.length, 0);
});

test("一个 div 作用域总是连成一条梁，层数决定线数，autobeam=false 不断开作用域内部", () => {
    const scope = layoutOf(`@div({1 2 -}, 2)`);
    assert(scope.attachments.length === 1 && scope.attachments[0].regions[0].w > 0,
        "one multi-object div scope must always create one beam");
    strictEqual(attachmentCommands(scope.attachments[0]).filter(command => command.kind === "rect").length, 2);
    const disabled = layoutOf(`@set(div.autobeam=false) @div({1 2}, 1)`);
    assert(disabled.attachments.length === 1 && rectCount(disabled) === 1,
        "autobeam=false must not disable connections inside one div");
});

test("autobeam 可以只关掉单个 div", () => expectBeams([
    [`1/ @div(2, 1) 3/`, 1],
    // 被关掉的 div 是分隔符而不是被跳过，所以两侧也连不起来
    [`1/ @div(2, 1, autobeam=false) 3/`, 0],
    // n=0 的空操作 div 或不产生可见事件的兄弟 div 不应污染复合宿主的作用域与 autobeam
    [`@div({@up(1/, 3) | @up(2/, 4)}, 0)`, 0],
    [`@div(@up(1/, 3), 0, autobeam=false) 2/`, 1],
    [`{@div(@set(bpm=120), 1, autobeam=false) 1/} ^ 3 2/`, 1],
]));

test("自动连梁在拍点、换行、小节线与并行轨处分组", () => expectBeams([
    [`1/ 2/ 3/ 4/`, 2],
    [`1/ 2// @br() 1/2/`, 2],
    [`1// 2// | 3// 4// 5// 6//`, 2],
    [`@stack({1// 2//}, {3// 4//})`, 2],
    [`@div({@div({1 2}, 1) 3}, 1)`, 1],
]));

test("同一 div 内连成一组的减时线不能跨谱面行", () => {
    for (const source of [`{1 2 @br() 3 4}/`, `@div({1 @br(3) 2}, 2)`, `0 {{1 2}/ @br() 3}/`]) {
        const { span } = expectLoweringError(source, "E_DIV_CROSS_LINE");
        // 报错范围是最外层 div，而不是某个端点
        strictEqual(source.slice(span.start, span.end), source.replace(/^0 /, ""), source);
    }
});

// 6/8、行中切换与折叠 @meter 的分组由下一个用例按实际端点检查
test("自动连梁随 @meter 拍号切换分拍单位与小节相位", () => expectBeams([
    [`@meter(3,8) | 1/ 2/ 3/ |`, 1],
    [`@meter(9,8) | 1/ 2/ 3/ 4/ 5/ 6/ 7/ 1'/ 2'/ |`, 3],
    [`@meter(12,8) | 1/ 2/ 3/ 4/ 5/ 6/ 7/ 1'/ 2'/ 3'/ 4'/ 5'/ |`, 4],
    [`@meter(6,16) | 1// 2// 3// 4// 5// 6// |`, 2],
    [`@meter(6,16) | 1/. 2// 3// 4// |`, 1],
    // 2/8 中八分音符是整拍，只有十六分音符在拍内连梁
    [`@meter(2,8) | 1/ 2/ |`, 0],
    [`@meter(2,8) | 1// 2// 3// 4// |`, 2],
    [`@meter(2,8) | 1// 2/ 3// |`, 0],
    // 简谱 2/2 仍按四分音符分拍
    [`@meter(2,2) | 1/ 2/ 3/ 4/ 5/ 6/ 7/ 1'/ |`, 4],
    [`H.signature: 1=C 6/8\n1/ 2/ 3/ 4/ 5/ 6/ |`, 2],
    [`@meter(6,8) 1/ 2/ 3/ | @meter(0,0) 1/ 2/ 3/ 4/ 5/ 6/`, 4],
]));

test("自动连梁的实际端点遵循拍号、切换位置及同列最终拍号", () => {
    const cases: [string, number[][]][] = [
        ["@meter(6,8) | 1/ 2/ 3/ 4/ 5/ 6/ |", [[0, 0.5, 1], [1.5, 2, 2.5]]],
        ["@meter(2,4) 1/ 2/ 3/ 4/ @meter(6,8) 1/ 2/ 3/ 4/ 5/ 6/",
            [[0, 0.5], [1, 1.5], [2, 2.5, 3], [3.5, 4, 4.5]]],
        ["1/ {2/ ^ @meter(6,8)} 3/ 4/ 5/ 6/ 7/", [[0.5, 1, 1.5], [2, 2.5, 3]]],
        // 折叠成员按实际回调顺序生效，不是按源码顺序。
        ["1/ {2/ ^ @meter(6,8) ^ @meter(2,8)} 3/ 4/ 5/ 6/ 7/",
            [[0.5, 1, 1.5], [2, 2.5, 3]]],
        ["1/ {2/ ^ @meter(2,8) ^ @meter(6,8)} 3/ 4/", []],
    ];
    for (const [source, expected] of cases) {
        const groups = lower(source).attachments.map(attachment => {
            assert("endPoints" in attachment && Array.isArray(attachment.endPoints),
                "automatic beam must expose its actual endpoints");
            return attachment.endPoints.map((node: unknown) => {
                assert(node instanceof TemporalNodeBase, "beam endpoint must be a temporal node");
                return node.t.numerator / node.t.denominator;
            });
        });
        deepStrictEqual(groups, expected, source);
    }
});

test("显式 @beam 只连接相邻端点，否则报错", () => {
    const explicit = layoutOf(`@set(div.autobeam=false) 1/@a 2/@b @beam(a,b)`);
    assert(explicit.attachments.length === 1 && rectCount(explicit) === 1,
        "explicit beam must replace local lines while auto beam is disabled");
    strictEqual(commandsOfKind(`@div({1@a 2@b @beam(a,b)}, 1)`, "rect").length, 1);

    for (const source of [
        `@set(div.autobeam=false) 1/@a 2/ 3/@b @beam(a,b)`,
        `1/@a | 2/ 3/@b @beam(a,b)`,
        `1/@a | @text("barrier") 2/@b @beam(a,b)`,
        `1/@a | @br() 2/@b @beam(a,b)`,
        `1/@a | 2/@b @beam(b,a)`,
        `1/@a @up(3/, @bar()) 2/@b @beam(a,b)`,
        `@set(div.autobeam=false) 1/@a @br() 2/@b @beam(a,b)`,
        `@set(div.autobeam=false) @stack({1/@a}, {2/@b}) @beam(a,b)`,
        `@set(div.autobeam=false) 1/@a 2/@b @beam(b,a)`,
    ]) {
        expectLoweringError(source, "E_NON_ADJACENT_BEAM");
    }

    // 其他轨上的事件不打断显式连梁的相邻关系
    expectBeams([[`@set(div.autobeam=false) @stack({1/@a 2/@b @beam(a,b)}, {3})`, 1]]);
});

test("增时线可显式连梁，也参与最近两个端点的回退", () => {
    for (const relation of ["@beam(a,b)", "@beam()"]) {
        const layout = layoutOf(`@set(div.autobeam=false) 1/ 2/@a -/@b ${relation}`);
        assert(layout.attachments.length === 1, "one explicit beam must be created");
        const lines = attachmentCommands(layout.attachments[0]).filter(command => command.kind === "rect");
        const [, start, end] = layout.objects;
        assert(lines.length === 1
            && nearly(lines[0].x, start.box.x + start.ports[divLinePortName(0, "left")].x)
            && nearly(lines[0].x + lines[0].w, end.box.x + end.ports[divLinePortName(0, "right")].x),
        "the beam must connect the second note and the dash");
    }
});

test("显式 beam 跨小节线连接，保留小节线间距与自动分组边界", () => {
    for (const barrier of ["|", "||", "|||", "|:", ":|", "| ^ @text(A)"]) {
        const source = `1//@a ${barrier} 2//@b`;
        const automatic = layoutOf(source);
        const explicit = layoutOf(`${source} @beam(a,b)`);
        assert(automatic.attachments.length === 0, "bar lines must still break automatic beams");
        assert(explicit.attachments.length === 1, "explicit beams must cross bar lines");
        const lines = attachmentCommands(explicit.attachments[0]).filter(command => command.kind === "rect");
        assert(lines.length === 2, "both div levels must connect across the bar line");
        const first = explicit.objects[0];
        const last = explicit.objects.at(-1)!;
        for (const line of lines) {
            assert(line.h > 0, "cross-bar beams must remain horizontal");
            assert(line.x < explicit.objects[1].box.x && line.x + line.w > explicit.objects[1].box.x,
                "beam lines must span the bar line");
        }
        assert(nearly(lines[0].x, first.box.x + first.ports[divLinePortName(0, "left")].x),
            "beam must start at the first note div port");
        assert(nearly(lines[0].x + lines[0].w, last.box.x + last.ports[divLinePortName(0, "right")].x),
            "beam must end at the last note div port");
        for (let index = 0; index < explicit.objects.length; index++) {
            assert(nearly(explicit.objects[index].box.x, automatic.objects[index].box.x),
                "cross-bar beams must preserve horizontal spacing");
        }
    }
});

test("写在 up 成员上的标签是合法的 beam 端点", () => expectBeams([
    [`@set(div.autobeam=false) @up(1/@a, 3) 2/@b @beam(a,b)`, 1],
    [`@set(div.autobeam=false) @up(1, 3/@a) 2/@b @beam(a,b)`, 1],
    [`@set(div.autobeam=false) @up(@up(1/@a, 3), 5) 2/@b @beam(a,b)`, 1],
]));

// 下八度点与最后一条减时线的间距由 decoration.test.ts 检查
test("减时线在数字与下八度点之间保持水平", () => {
    const layout = layoutOf(`@div({1 2,}, 1)`);
    const beamY = (node: typeof layout.objects[number]) => node.box.y + node.ports[divLinePortName(0, "left")].y;
    assert(nearly(beamY(layout.objects[0]), beamY(layout.objects[1])),
        "same-level div lines must stay horizontal across lower-octave notes");
    const commands = recordCommands(layout);
    const numberTexts = commands.filter(command => command.kind === "text");
    const lines = commands.filter(command => command.kind === "rect");
    assert(numberTexts.length === 2 && lines.length === 1 && lines[0].w > 0 && lines[0].h > 0,
        "one connected div level must emit exactly one merged line");
    const numberBottom = Math.max(...numberTexts.map(command => command.y + command.style.fontSize * 0.2));
    const divVisualGap = lines[0].y - numberBottom;
    assert(divVisualGap >= -2 && divVisualGap < 1, "div line must stay close to the number box with at most a slight overlap");
});

test("折叠宿主的减时线被连梁接管后只绘制一次", () => {
    for (const source of [
        `{1^3}/ 2/`,
        `{1_3}/ 2/`,
        `@up({1^3},5)/ 2/`,
        `{@set(fontsize=40px) 1^3}/ 2/`,
        `{1^3}/ {@set(fontsize=40px) 2/}`,
        `@set(div.autobeam=false) {1^3}/@a 2/@b @beam(a,b)`,
        `{{1^3} 2}>4`,
    ]) {
        const layout = layoutOf(source);
        const lines = recordCommands(layout).filter(command => command.kind === "rect");
        strictEqual(layout.attachments.length, 1, source);
        const beamLines = attachmentCommands(layout.attachments[0]).filter(command => command.kind === "rect");
        // 被接管的折叠减时线不能再画一条本地线，剩下的唯一线段覆盖整条梁
        assert(beamLines.length === 1 && lines.length === 1
            && nearly(lines[0].x, beamLines[0].x) && nearly(lines[0].w, beamLines[0].w), source);
    }
});

test("折叠与倚音相互嵌套时共享宿主的减时线接管状态", () => {
    for (const source of [`@grace({1^3},4)/ 2/`, `@up({4>1},3)/ 2/`]) {
        const layout = layoutOf(source);
        // 只剩主梁与未连梁的倚音减时线
        assert(layout.attachments.length === 1 && rectCount(layout) === 2, source);
    }
});

test("折叠宿主保留未被连梁接管的减时线级别", () => {
    for (const [source, count] of [
        [`{1^3}/`, 1],
        [`@set(div.autobeam=false) {1^3}/ 2/`, 2],
        // 只有共享层被接管，折叠宿主多出的一层仍在本地绘制
        [`{1^3}// 2/`, 2],
    ] as const) strictEqual(commandsOfKind(source, "rect").length, count, source);
});

test("连梁线宽随端点字号缩放", () => {
    const [small, large] = [20, 40].map(size =>
        commandsOfKind(`@set(div.autobeam=false) 1/@a 2/@b @beam(a,b)`, "rect", size)[0]);
    assert(nearly(large.h, small.h * 2), "beam stroke width must scale with the largest endpoint font size");
});
