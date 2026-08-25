import { test } from "node:test";

import { DivNode, divLinePortName } from "../src/functions/div/index.js";
import {
    assert,
    attachmentCommands,
    commandsOfKind,
    expectLoweringError,
    layoutOf,
    nearly,
    parse,
    recordCommands,
} from "./helpers.js";

test("autobeam 开关在解析期就冻结在 div 节点上", () => {
    const autoBeamFlagAst = parse(`1/ @set(div.autobeam=false) 2/`);
    const parsedDivs = autoBeamFlagAst.content.filter(node => node instanceof DivNode);
    assert(parsedDivs.length === 2, "two divided notes must create two DivNode instances");
    assert(parsedDivs[0].autoBeamEnabled, "autobeam must default to enabled during parsing");
    assert(!parsedDivs[1].autoBeamEnabled, "set(autobeam=false) must be frozen on following div nodes");
});

test("相邻分割音符自动连梁，并按比例缩短内侧弹簧", () => {
    const adjacentAutoBeamResult = layoutOf(`1/ 2// 3/`);
    assert(adjacentAutoBeamResult.attachments.length === 1, "separate divided notes must auto-connect by default");
    const [beamFirst, beamMiddle, beamLast] = adjacentAutoBeamResult.objects;
    assert(beamFirst.springConfig.alpha_L === 6, "a beam must not shorten the outside left spring");
    assert(nearly(beamFirst.springConfig.alpha_R as number, 4.8), "a beam must shorten its first inside spring to 80%");
    assert(nearly(beamMiddle.springConfig.alpha_L as number, 4.8), "a middle beam element must shorten its left spring");
    assert(nearly(beamMiddle.springConfig.alpha_R as number, 4.8), "a middle beam element must shorten its right spring");
    assert(nearly(beamLast.springConfig.alpha_L as number, 4.8), "a beam must shorten its final inside spring");
    assert(beamLast.springConfig.alpha_R === 6, "a beam must not shorten the outside right spring");
    assert(nearly(beamMiddle.springConfig.beta_L as number, 1 / 6), "beam alpha changes must not implicitly recompute completed beta");

    const visibleBarrierBeamResult = layoutOf(`1// @text("barrier") 2//`);
    assert(visibleBarrierBeamResult.attachments.length === 0, "a visible zero-duration element must break automatic beam adjacency");
});

test("一个 div 作用域总是连成一条梁，层数决定线数", () => {
    const autoBeamResult = layoutOf(`@div({1 2 -}, 2)`);
    assert(autoBeamResult.attachments.length === 1, "one multi-object div scope must always create one beam");
    assert(autoBeamResult.attachments[0].box.w > 0, "scope beam must connect at least two divided objects");
    assert(attachmentCommands(autoBeamResult.attachments[0]).filter(command => command.kind === "line").length === 2,
        "two div levels must create two scope beam lines");
});

test("autobeam=false 只断开分写的 div，不断开一个作用域内部", () => {
    const disabledAutoBeamResult = layoutOf(`@set(div.autobeam=false) 1/ 2// 3/`);
    assert(disabledAutoBeamResult.attachments.length === 0, "autobeam=false must keep separately written divs independent");
    assert(
        disabledAutoBeamResult.objects.every(object => object.springConfig.alpha_L === 6 && object.springConfig.alpha_R === 6),
        "independent divs must keep their base spring lengths when autobeam is disabled",
    );

    const disabledScopeBeamResult = layoutOf(`@set(div.autobeam=false) @div({1 2}, 1)`);
    assert(disabledScopeBeamResult.attachments.length === 1, "autobeam=false must not disable connections inside one div");
    assert(nearly(disabledScopeBeamResult.objects[0].springConfig.alpha_R as number, 4.8), "one div scope must shorten its inside right spring");
    assert(nearly(disabledScopeBeamResult.objects[1].springConfig.alpha_L as number, 4.8), "one div scope must shorten its inside left spring");
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

test("显式 @beam 只连接相邻端点，否则报错", () => {
    const explicitBeamResult = layoutOf(`@set(div.autobeam=false) 1/@a 2/@b @beam(a,b)`);
    assert(explicitBeamResult.attachments.length === 1, "explicit beam must connect separate divs while autobeam is disabled");

    for (const source of [
        `@set(div.autobeam=false) 1/@a 2/ 3/@b @beam(a,b)`,
        `@set(div.autobeam=false) 1/@a @br() 2/@b @beam(a,b)`,
        `@set(div.autobeam=false) @stack({1/@a}, {2/@b}) @beam(a,b)`,
        `@set(div.autobeam=false) 1/@a 2/@b @beam(b,a)`,
    ]) {
        expectLoweringError(source, "E_NON_ADJACENT_BEAM");
    }

    const parallelExplicitBeamResult = layoutOf(`@set(div.autobeam=false) @stack({1/@a 2/@b @beam(a,b)}, {3})`);
    assert(parallelExplicitBeamResult.attachments.length === 1, "events on another track must not break explicit beam adjacency");
});

test("写在 up 成员上的标签是合法的 beam 端点", () => {
    for (const source of [
        `@set(div.autobeam=false) @up(1/@a, 3) 2/@b @beam(a,b)`,
        `@set(div.autobeam=false) @up(1, 3/@a) 2/@b @beam(a,b)`,
        `@set(div.autobeam=false) @up(@up(1/@a, 3), 5) 2/@b @beam(a,b)`,
    ]) {
        assert(layoutOf(source).attachments.length === 1, `label on an up member must beam through its chord: ${source}`);
    }
    expectLoweringError(`@up({1/@a 2/@b}, 3)`, "E_UP_INVALID_CHILD");
});

test("同层减时线跨下八度音符仍保持水平", () => {
    const lowerOctaveBeamResult = layoutOf(`@div({1 2,}, 1)`);
    const normalBeamPort = lowerOctaveBeamResult.objects[0].ports[divLinePortName(0, "left")];
    const lowerOctaveBeamPort = lowerOctaveBeamResult.objects[1].ports[divLinePortName(0, "left")];
    const normalBeamY = lowerOctaveBeamResult.objects[0].box.y + normalBeamPort.y;
    const lowerOctaveBeamY = lowerOctaveBeamResult.objects[1].box.y + lowerOctaveBeamPort.y;

    assert(nearly(normalBeamY, lowerOctaveBeamY), "same-level div lines must stay horizontal across lower-octave notes");
    assert(lowerOctaveBeamPort.y < lowerOctaveBeamResult.objects[1].box.h, "lower octave dots must reserve space after the div line");
});

test("减时线在数字与下八度点之间保持水平", () => {
    const lowerOctaveDivCommands = recordCommands(layoutOf(`@div({1 2,}, 1)`));
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
    assert(divLineYs.every(y => nearly(y, divLineYs[0])), "all same-level div segments must be horizontal");
    assert(lowerOctaveDotYs.length === 1, "one lower-octave mark must emit one dot");
    assert(Math.max(...numberBaselines) < divLineYs[0], "div lines must be below note numbers");
    assert(divLineYs[0] < lowerOctaveDotYs[0], "lower-octave dots must be below div lines");

    const numberBottom = Math.max(...numberTexts.map(command => command.y + command.style.fontSize * 0.2));
    const divStrokeWidth = mergedDivLines[0].style?.strokeWidth ?? 0;
    const divVisualGap = divLineYs[0] - divStrokeWidth / 2 - numberBottom;
    assert(divVisualGap >= -2 && divVisualGap < 1, "div line must stay close to the number box with at most a slight overlap");
});

const EXPLICIT_BEAM = `@set(div.autobeam=false) 1/@a 2/@b @beam(a,b)`;

test("减时线的合并与拆分遵循连梁语义", () => {
    assert(commandsOfKind(`@div({1@a 2@b @beam(a,b)}, 1)`, "line").length === 1,
        "explicit beam over divided notes must emit one merged line");
    assert(commandsOfKind(`1/`, "line").length === 1,
        "an unconnected divided note must keep one local line");
    assert(commandsOfKind(`1/ 2// 3/`, "line").length === 2,
        "default auto beam must merge the shared level and keep one inner beamlet");
    assert(commandsOfKind(`@set(div.autobeam=false) 1/ 2// 3/`, "line").length === 4,
        "disabled auto beam must paint separately written div lines locally");
    assert(commandsOfKind(`@set(div.autobeam=false) @div({1 2}, 1)`, "line").length === 1,
        "one div scope must keep one merged line while auto beam is disabled");
    assert(commandsOfKind(EXPLICIT_BEAM, "line").length === 1,
        "explicit beam must replace local lines while auto beam is disabled");
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
