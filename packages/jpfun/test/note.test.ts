import { test } from "node:test";

import type { ASTFunctionNode } from "../src/functions/ASTtypes.js";
import { layoutDocument } from "../src/layout/engine.js";
import { isVisualTemporalNode, type VisualTemporalNode } from "../src/lowering/types.js";
import type { PathCommand } from "../src/render/types.js";
import { assert, layoutContext, layoutOf, lower, nearly, recordCommands } from "./helpers.js";

/** 固定图形只给出路径命令，取包围盒才能和数字盒比较位置 */
function commandBounds(commands: readonly PathCommand[]) {
    const xs: number[] = [];
    const ys: number[] = [];
    const point = (x: number, y: number) => {
        xs.push(x);
        ys.push(y);
    };

    for (const command of commands) {
        if (command.op === "Z") continue;
        if (command.op === "Q") point(command.cx, command.cy);
        if (command.op === "C") {
            point(command.cx1, command.cy1);
            point(command.cx2, command.cy2);
        }
        point(command.x, command.y);
    }

    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

test("升降号贴在数字左上角且不侵入数字单元", () => {
    const accidentalCommands = recordCommands(layoutOf(`#1`));
    const accidentalPath = accidentalCommands.find(command => command.kind === "path");
    const accidentalNumberText = accidentalCommands.find(command => command.kind === "text");
    assert(accidentalPath?.kind === "path", "sharp note must emit one accidental path");
    assert(accidentalNumberText?.kind === "text", "sharp note must emit one centered number text");

    const accidentalBounds = commandBounds(accidentalPath.commands);
    const numberWidth = accidentalNumberText.style.fontSize * 0.62;
    const numberLeft = accidentalNumberText.x - numberWidth / 2;
    const accidentalRight = accidentalBounds.x + accidentalBounds.w;
    const numberTop = accidentalNumberText.y - accidentalNumberText.style.fontSize * 0.8;
    const accidentalGap = numberLeft - accidentalRight;

    assert(accidentalGap >= 0, "accidental must stay to the left of the number cell");
    assert(accidentalGap < accidentalNumberText.style.fontSize * 0.06, "accidental must sit close to the number left edge");
    assert(accidentalBounds.y < numberTop + accidentalNumberText.style.fontSize * 0.2,
        "accidental must be raised to the number upper-left area");
});

test("升降号与附点悬在节奏范围之外", () => {
    const hangingAccidentalResult = layoutOf(`#2.//`);
    const plainDecoratedResult = layoutOf(`2.//`);
    const hangingCommands = recordCommands(hangingAccidentalResult);
    const hangingNumber = hangingCommands.find(command => command.kind === "text");
    const hangingPath = hangingCommands.find(command => command.kind === "path");
    const hangingLines = hangingCommands.filter(command => command.kind === "line");
    const hangingDot = hangingCommands.find(command => command.kind === "circle");

    assert(hangingNumber?.kind === "text", "decorated note must emit its number text");
    assert(hangingPath?.kind === "path", "decorated note must emit its hanging accidental");
    assert(hangingDot?.kind === "circle", "decorated note must emit its augmentation dot");
    assert(hangingLines.length === 2, "double-divided note must emit two local lines");
    assert(
        hangingAccidentalResult.objects[0].box.w > plainDecoratedResult.objects[0].box.w,
        "accidental must increase the complete decorated note LayoutBox width",
    );

    const hangingNumberHalfWidth = hangingNumber.style.fontSize * 0.62 / 2;
    const hangingNumberLeft = hangingNumber.x - hangingNumberHalfWidth;
    const hangingNumberRight = hangingNumber.x + hangingNumberHalfWidth;
    const hangingPathBounds = commandBounds(hangingPath.commands);
    assert(
        hangingLines.every(line => nearly(line.x1, hangingNumberLeft)),
        "div lines must start at the number left edge",
    );
    assert(
        hangingLines.every(line => nearly(line.x2, hangingNumberRight)),
        "div lines must end at the number right edge",
    );
    assert(hangingPathBounds.x + hangingPathBounds.w < hangingNumberLeft,
        "hanging accidental must stay outside the rhythm range");
    assert(hangingDot.cx > hangingNumberRight, "augmentation dot must stay outside the rhythm range");
    assert(hangingAccidentalResult.bounds.x <= hangingPathBounds.x,
        "document bounds must include the complete accidental path");
});

test("升降号不移动对齐中心，也不改变核心范围", () => {
    const [plainNumber, accidentalNumber] = layoutOf(`@stack({1}, {#1})`).objects;
    const coreLeft = (object: typeof plainNumber) => object.box.anchor - (object.ports["body.left"]?.x ?? 0);
    const coreRight = (object: typeof plainNumber) =>
        (object.ports["body.right"]?.x ?? object.box.w) - object.box.anchor;

    assert(nearly(plainNumber.box.x + plainNumber.box.anchor, accidentalNumber.box.x + accidentalNumber.box.anchor),
        "accidentals must not move the aligned number center");
    assert(nearly(plainNumber.box.w - plainNumber.box.anchor, accidentalNumber.box.w - accidentalNumber.box.anchor),
        "accidentals must only extend the box to the left of the number anchor");
    assert(accidentalNumber.box.w > plainNumber.box.w, "accidentals must be included in the complete LayoutBox width");
    assert(nearly(coreLeft(plainNumber), coreLeft(accidentalNumber)), "accidentals must not change the core left extent");
    assert(nearly(coreRight(plainNumber), coreRight(accidentalNumber)), "accidentals must not change the core right extent");
});

test("附点优先使用宿主端口，缺失时才退回右边界", () => {
    const dottedNoteCommands = recordCommands(layoutOf(`1.`));
    const dottedNumber = dottedNoteCommands.find(command => command.kind === "text");
    const augmentationDot = dottedNoteCommands.find(command => command.kind === "circle");
    assert(dottedNumber?.kind === "text" && augmentationDot?.kind === "circle", "dotted note must emit number text and one dot");
    assert(
        nearly(augmentationDot.cy, dottedNumber.y - dottedNumber.style.fontSize * 0.16),
        "augmentation dot must use its named port instead of the visual alignment axis",
    );

    const defaultDotResult = layoutOf(`@dot(@text("x"), 1)`);
    const defaultDot = recordCommands(defaultDotResult).find(command => command.kind === "circle");
    const defaultDotTarget = defaultDotResult.objects[0];
    assert(defaultDot?.kind === "circle", "a target without a dot port must still emit an augmentation dot");
    assert(defaultDotTarget.ports["dot"] === undefined, "the generic dot fallback must not mutate target ports");
    assert(
        nearly(defaultDot.cy, defaultDotTarget.box.y + defaultDotTarget.box.visualAxis),
        "a missing dot port must fall back to the target right edge and visual axis",
    );
});

test("小节线与音符共享视觉中心轴，并加强附近的弹簧", () => {
    const barAlignmentResult = layoutOf(`1 | 2/ 3, |`);
    const visualAxes = barAlignmentResult.objects.map(object => object.box.y + object.box.visualAxis);
    assert(visualAxes.every(axis => nearly(axis, visualAxes[0])), "bar and note-like objects must share one visual center axis");
    const [noteBeforeBar, firstBar, noteAfterBar] = barAlignmentResult.objects;
    assert(noteBeforeBar.springConfig.mu_R === 64, "the spring facing an anchor from the left must use 4x mu");
    assert(firstBar.springConfig.mu_L === 64, "an anchor left spring must use 4x mu");
    assert(firstBar.springConfig.mu_R === 64, "an anchor right spring must use 4x mu");
    assert(noteAfterBar.springConfig.mu_L === 64, "the spring facing an anchor from the right must use 4x mu");
    assert(noteBeforeBar.springConfig.mu_L === 16, "the side away from an anchor must keep its base mu");
});

test("小节线几何中心与数字视觉中心对齐", () => {
    const barAlignmentCommands = recordCommands(layoutOf(`1 | 2/ 3, |`));
    const alignedNumberCenters = barAlignmentCommands
        .filter(command => command.kind === "text")
        .filter(command => /^[0-9]$/.test(command.text))
        .map(command => command.y - command.style.fontSize * 0.3);
    const alignedBarCenters = barAlignmentCommands
        .filter(command => command.kind === "rect")
        .filter(command => command.style?.fill === "#000")
        .map(command => command.y + command.h / 2);

    assert(alignedNumberCenters.length === 3, "bar alignment sample must contain three number centers");
    assert(alignedBarCenters.length === 2, "bar alignment sample must contain two bar centers");
    assert(
        [...alignedNumberCenters, ...alignedBarCenters].every(center => nearly(center, alignedNumberCenters[0])),
        "bar geometry centers must align with number visual centers",
    );
});

test("tempo 与 key 自己上谱，set 纯词法，不可见事件不分配布局资源", () => {
    const loweredState = lower(`@tempo(90) @1(D4) @set(note.color=#f00) 1 @br()`);
    const stateResult = layoutDocument(loweredState, layoutContext);
    const invisibleStateEvents = loweredState.columns
        .flat()
        .filter(event => !isVisualTemporalNode(event));
    const stateNote = stateResult.objects[2] as VisualTemporalNode & {
        activeBpm: number;
        resolvedMidi: number;
        ast: ASTFunctionNode & { color: string };
    };

    assert(stateResult.objects.length === 3, "tempo and key draw themselves; set stays purely lexical");
    assert(stateNote.activeBpm === 90, "tempo must be frozen into following notes");
    assert(stateNote.resolvedMidi === 62, "key D4 must resolve jianpu 1 to MIDI 62");
    assert(stateNote.ast.color === "#f00", "set must solidify the note color during parsing");
    assert(invisibleStateEvents.every(event => event.box === undefined), "invisible state events must not allocate LayoutBox");
    assert(invisibleStateEvents.every(event => event.springConfig === undefined), "invisible state events must not allocate HorizontalSpringConfig");
    assert(invisibleStateEvents.every(event => event.ports === undefined), "invisible state events must not allocate layout ports");
    assert(invisibleStateEvents.every(event => event.decorations === undefined), "invisible state events must not allocate decorations");
    assert(invisibleStateEvents.every(event => event.addon === undefined), "undecorated state events must not allocate addon");
});
