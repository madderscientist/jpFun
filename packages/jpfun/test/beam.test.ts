import { test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";

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

test("相邻分割音符自动连梁，连梁内的音符间距更紧凑", () => {
    const adjacentAutoBeamResult = layoutOf(`1/ 2// 3/`);
    assert(adjacentAutoBeamResult.attachments.length === 1, "separate divided notes must auto-connect by default");
    const unconnected = layoutOf(`@set(div.autobeam=false) 1/ 2// 3/`).objects;
    for (let i = 1; i < unconnected.length; i++) {
        const gap = adjacentAutoBeamResult.objects[i].box.x - adjacentAutoBeamResult.objects[i - 1].box.x;
        assert(gap < unconnected[i].box.x - unconnected[i - 1].box.x, "连梁内侧应比独立分割音符更紧凑");
    }
    assert(recordCommands(adjacentAutoBeamResult).filter(command => command.kind === "line").length === 2,
        "default auto beam must merge the shared level and keep one inner beamlet");

    const visibleBarrierBeamResult = layoutOf(`1// @text("barrier") 2//`);
    assert(visibleBarrierBeamResult.attachments.length === 0, "a visible zero-duration element must break automatic beam adjacency");
});

test("一个 div 作用域总是连成一条梁，层数决定线数", () => {
    const autoBeamResult = layoutOf(`@div({1 2 -}, 2)`);
    assert(autoBeamResult.attachments.length === 1, "one multi-object div scope must always create one beam");
    assert(autoBeamResult.attachments[0].regions[0].w > 0, "scope beam must connect at least two divided objects");
    assert(attachmentCommands(autoBeamResult.attachments[0]).filter(command => command.kind === "line").length === 2,
        "two div levels must create two scope beam lines");
});

test("autobeam=false 只断开分写的 div，不断开一个作用域内部", () => {
    const disabledAutoBeamResult = layoutOf(`@set(div.autobeam=false) 1/ 2// 3/`);
    assert(disabledAutoBeamResult.attachments.length === 0, "autobeam=false must keep separately written divs independent");
    assert(recordCommands(disabledAutoBeamResult).filter(command => command.kind === "line").length === 4,
        "disabled auto beam must paint separately written div lines locally");

    const disabledScopeBeamResult = layoutOf(`@set(div.autobeam=false) @div({1 2}, 1)`);
    assert(disabledScopeBeamResult.attachments.length === 1, "autobeam=false must not disable connections inside one div");
    assert(recordCommands(disabledScopeBeamResult).filter(command => command.kind === "line").length === 1,
        "one div scope must keep one merged line while auto beam is disabled");
});

test("autobeam 可以只关掉单个 div", () => {
    // 两份源码只差 autobeam 这一个参数
    const connected = layoutOf(`1/ @div(2, 1) 3/`).attachments;
    assert(connected.length === 1, "three adjacent divs must connect by default");

    // 被关掉的 div 是分隔符而不是被跳过，所以两侧也连不起来
    const broken = layoutOf(`1/ @div(2, 1, autobeam=false) 3/`).attachments;
    assert(broken.length === 0, "a disabled div must break the run instead of being skipped");
});

test("自动连梁在拍点、换行、小节线与并行轨处分组", () => {
    assert(layoutOf(`1/ 2/ 3/ 4/`).attachments.length === 2,
        "automatic beams must split at quarter-note beat boundaries");
    assert(layoutOf(`1/ 2// @br() 1/2/`).attachments.length === 2,
        "a new layout line must reset the automatic beam beat phase");
    assert(layoutOf(`1// 2// | 3// 4// 5// 6//`).attachments.length === 2,
        "bar lines must end the current beam and reset the following beat phase");
    assert(layoutOf(`@stack({1// 2//}, {3// 4//})`).attachments.length === 2,
        "automatic beams must group parallel tracks independently");
    assert(layoutOf(`@div({@div({1 2}, 1) 3}, 1)`).attachments.length === 1,
        "nested div scopes must share one non-overlapping beam attachment");
});

test("自动连梁随 @meter 拍号切换分拍单位与小节相位", () => {
    assert(layoutOf(`@meter(6,8) | 1/ 2/ 3/ 4/ 5/ 6/ |`).attachments.length === 2,
        "6/8 must group six eighth notes into two dotted-quarter beats of three");
    assert(layoutOf(`@meter(3,8) | 1/ 2/ 3/ |`).attachments.length === 1,
        "3/8 must group three eighth notes into one dotted-quarter beat");
    assert(layoutOf(`@meter(9,8) | 1/ 2/ 3/ 4/ 5/ 6/ 7/ 1'/ 2'/ |`).attachments.length === 3,
        "9/8 must group nine eighth notes into three beats of three");
    assert(layoutOf(`@meter(12,8) | 1/ 2/ 3/ 4/ 5/ 6/ 7/ 1'/ 2'/ 3'/ 4'/ 5'/ |`).attachments.length === 4,
        "12/8 must group twelve eighth notes into four beats of three");
    assert(layoutOf(`@meter(6,16) | 1// 2// 3// 4// 5// 6// |`).attachments.length === 2,
        "6/16 must group six sixteenth notes into two dotted-eighth beats of three");
    assert(layoutOf(`@meter(6,16) | 1/. 2// 3// 4// |`).attachments.length === 1,
        "a full dotted-eighth beat note in 6/16 must not auto-beam with the next beat");

    assert(layoutOf(`@meter(2,8) | 1/ 2/ |`).attachments.length === 0,
        "in 2/8 each eighth note is a full beat and must not auto-beam across beats");
    assert(layoutOf(`@meter(2,8) | 1// 2// 3// 4// |`).attachments.length === 2,
        "in 2/8 sixteenth notes must auto-beam within each eighth-note beat");
    assert(layoutOf(`@meter(2,8) | 1// 2/ 3// |`).attachments.length === 0,
        "in 2/8 a full-beat eighth note must break adjacent sixteenth notes");

    assert(layoutOf(`@meter(2,2) | 1/ 2/ 3/ 4/ 5/ 6/ 7/ 1'/ |`).attachments.length === 4,
        "2/2 must keep quarter-note beat grouping in Jianpu");

    assert(layoutOf(`H.signature: 1=C 6/8\n1/ 2/ 3/ 4/ 5/ 6/ |`).attachments.length === 2,
        "meter declared in @head must drive subsequent auto-beam grouping");
    assert(layoutOf(`@meter(2,4) 1/ 2/ 3/ 4/ @meter(6,8) 1/ 2/ 3/ 4/ 5/ 6/`).attachments.length === 4,
        "a mid-line @meter change must flush active beams, reset phase, and switch beat unit");
    assert(layoutOf(`1/ {2/ ^ @meter(6,8)} 3/ 4/ 5/ 6/ 7/`).attachments.length === 2,
        "a folded @meter must reset the beat phase at its host column");
    assert(layoutOf(`@meter(6,8) 1/ 2/ 3/ | @meter(0,0) 1/ 2/ 3/ 4/ 5/ 6/`).attachments.length === 4,
        "switching to free meter @meter(0,0) must restore 1 QN quarter-note beat grouping");
});

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
    const explicitBeamResult = layoutOf(`@set(div.autobeam=false) 1/@a 2/@b @beam(a,b)`);
    assert(explicitBeamResult.attachments.length === 1, "explicit beam must connect separate divs while autobeam is disabled");
    assert(recordCommands(explicitBeamResult).filter(command => command.kind === "line").length === 1,
        "explicit beam must replace local lines while auto beam is disabled");
    assert(commandsOfKind(`@div({1@a 2@b @beam(a,b)}, 1)`, "line").length === 1,
        "explicit beam over divided notes must emit one merged line");

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

    const parallelExplicitBeamResult = layoutOf(`@set(div.autobeam=false) @stack({1/@a 2/@b @beam(a,b)}, {3})`);
    assert(parallelExplicitBeamResult.attachments.length === 1, "events on another track must not break explicit beam adjacency");
});

test("增时线可显式连梁，也参与最近两个端点的回退", () => {
    for (const relation of ["@beam(a,b)", "@beam()"]) {
        const layout = layoutOf(`@set(div.autobeam=false) 1/ 2/@a -/@b ${relation}`);
        assert(layout.attachments.length === 1, "one explicit beam must be created");
        const lines = attachmentCommands(layout.attachments[0]).filter(command => command.kind === "line");
        const [, start, end] = layout.objects;
        assert(lines.length === 1
            && nearly(lines[0].x1, start.box.x + start.ports[divLinePortName(0, "left")].x)
            && nearly(lines[0].x2, end.box.x + end.ports[divLinePortName(0, "right")].x),
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
        const lines = attachmentCommands(explicit.attachments[0]).filter(command => command.kind === "line");
        assert(lines.length === 2, "both div levels must connect across the bar line");
        const first = explicit.objects[0];
        const last = explicit.objects.at(-1)!;
        for (const line of lines) {
            assert(nearly(line.y1, line.y2), "cross-bar beams must remain horizontal");
            assert(line.x1 < explicit.objects[1].box.x && line.x2 > explicit.objects[1].box.x,
                "beam lines must span the bar line");
        }
        assert(nearly(lines[0].x1, first.box.x + first.ports[divLinePortName(0, "left")].x),
            "beam must start at the first note div port");
        assert(nearly(lines[0].x2, last.box.x + last.ports[divLinePortName(0, "right")].x),
            "beam must end at the last note div port");
        for (let index = 0; index < explicit.objects.length; index++) {
            assert(nearly(explicit.objects[index].box.x, automatic.objects[index].box.x),
                "cross-bar beams must preserve horizontal spacing");
        }
    }
});

test("写在 up 成员上的标签是合法的 beam 端点", () => {
    for (const source of [
        `@set(div.autobeam=false) @up(1/@a, 3) 2/@b @beam(a,b)`,
        `@set(div.autobeam=false) @up(1, 3/@a) 2/@b @beam(a,b)`,
        `@set(div.autobeam=false) @up(@up(1/@a, 3), 5) 2/@b @beam(a,b)`,
    ]) {
        assert(layoutOf(source).attachments.length === 1, `label on an up member must beam through its chord: ${source}`);
    }
});

test("减时线在数字与下八度点之间保持水平", () => {
    const lowerOctaveBeamResult = layoutOf(`@div({1 2,}, 1)`);
    const normalBeamPort = lowerOctaveBeamResult.objects[0].ports[divLinePortName(0, "left")];
    const lowerOctaveBeamPort = lowerOctaveBeamResult.objects[1].ports[divLinePortName(0, "left")];
    const normalBeamY = lowerOctaveBeamResult.objects[0].box.y + normalBeamPort.y;
    const lowerOctaveBeamY = lowerOctaveBeamResult.objects[1].box.y + lowerOctaveBeamPort.y;

    assert(nearly(normalBeamY, lowerOctaveBeamY), "same-level div lines must stay horizontal across lower-octave notes");
    assert(lowerOctaveBeamPort.y < lowerOctaveBeamResult.objects[1].box.h, "lower octave dots must reserve space after the div line");
    const lowerOctaveDivCommands = recordCommands(lowerOctaveBeamResult);
    const numberTexts = lowerOctaveDivCommands.filter(command => command.kind === "text");
    const numberBaselines = numberTexts.map(command => command.y);
    const mergedDivLines = lowerOctaveDivCommands.filter(command => command.kind === "line");
    const divLineYs = mergedDivLines.map(command => command.y1);
    const lowerOctaveDotYs = lowerOctaveDivCommands
        .filter(command => command.kind === "circle")
        .map(command => command.cy);

    assert(numberBaselines.length === 2, "two notes must emit two centered number texts");
    assert(mergedDivLines.length === 1, "one connected div level must emit exactly one merged line");
    assert(mergedDivLines[0].x1 < mergedDivLines[0].x2, "the merged div line must cover the complete endpoint range");
    assert(nearly(mergedDivLines[0].y1, mergedDivLines[0].y2), "the merged div line must be horizontal");
    assert(lowerOctaveDotYs.length === 1, "one lower-octave mark must emit one dot");
    assert(Math.max(...numberBaselines) < divLineYs[0], "div lines must be below note numbers");
    assert(divLineYs[0] < lowerOctaveDotYs[0], "lower-octave dots must be below div lines");

    const numberBottom = Math.max(...numberTexts.map(command => command.y + command.style.fontSize * 0.2));
    const divStrokeWidth = mergedDivLines[0].style?.strokeWidth ?? 0;
    const divVisualGap = divLineYs[0] - divStrokeWidth / 2 - numberBottom;
    assert(divVisualGap >= -2 && divVisualGap < 1, "div line must stay close to the number box with at most a slight overlap");
});

const EXPLICIT_BEAM = `@set(div.autobeam=false) 1/@a 2/@b @beam(a,b)`;

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
        const lines = recordCommands(layout).filter(command => command.kind === "line");
        assert(layout.attachments.length === 1, `${source}: the sample must create one beam attachment`);
        const beamLines = attachmentCommands(layout.attachments[0]).filter(command => command.kind === "line");
        assert(beamLines.length === 1, `${source}: the beam must paint one complete line`);
        assert(lines.length === 1, `${source}: a claimed folded div must not paint a duplicate local line`);
        assert(nearly(lines[0].x1, beamLines[0].x1) && nearly(lines[0].x2, beamLines[0].x2),
            `${source}: the remaining line must span the complete beam`);
    }
});

test("折叠与倚音相互嵌套时共享宿主的减时线接管状态", () => {
    for (const source of [`@grace({1^3},4)/ 2/`, `@up({4>1},3)/ 2/`]) {
        const layout = layoutOf(source);
        assert(layout.attachments.length === 1, "the two main events must share one beam");
        assert(recordCommands(layout).filter(command => command.kind === "line").length === 2,
            `only the main beam and the unconnected grace line must remain: ${source}`);
    }
});

test("折叠宿主保留未被连梁接管的减时线级别", () => {
    assert(commandsOfKind(`1/`, "line").length === 1,
        "an unconnected divided note must keep one local line");
    assert(commandsOfKind(`{1^3}/`, "line").length === 1,
        "an isolated folded div must keep its local line");
    assert(commandsOfKind(`@set(div.autobeam=false) {1^3}/ 2/`, "line").length === 2,
        "disabled auto beam must preserve both local lines");
    assert(commandsOfKind(`{1^3}// 2/`, "line").length === 2,
        "only the shared level is claimed; the extra folded level must remain local");
});

test("连梁线宽随端点字号缩放", () => {
    const smallBeamLine = commandsOfKind(EXPLICIT_BEAM, "line", 20)[0];
    const largeBeamLine = commandsOfKind(EXPLICIT_BEAM, "line", 40)[0];
    assert(smallBeamLine !== undefined && largeBeamLine !== undefined, "scaled beam samples must emit merged lines");
    assert(
        nearly(largeBeamLine.style?.strokeWidth ?? 0, (smallBeamLine.style?.strokeWidth ?? 0) * 2),
        "beam stroke width must scale with the largest endpoint font size",
    );
});
