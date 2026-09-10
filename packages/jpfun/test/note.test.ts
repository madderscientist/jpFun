import { test } from "node:test";

import type { ASTFunctionNode } from "../src/functions/ASTtypes.js";
import { layoutDocument } from "../src/layout/engine.js";
import { isVisualTemporalNode, type VisualTemporalNode } from "../src/functions/temporal.js";
import type { PathCommand } from "../src/render/types.js";
import { compileScore } from "../src/pipeline.js";
import { assert, expectCompileError, layoutContext, layoutOf, lower, nearly, recordCommands } from "./helpers.js";

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

test("音名中的绝对八度完整传入显式和语法糖音符", () => {
    const shorthand = compileScore(`C0`).layout.objects[0] as VisualTemporalNode & {
        resolvedMidi: number | null;
        ast: ASTFunctionNode & { octave: number };
    };
    const explicit = compileScore(`@note("C2")`).layout.objects[0] as VisualTemporalNode & {
        resolvedMidi: number | null;
        ast: ASTFunctionNode & { octave: number };
    };
    const postfixAccidental = compileScore(`@note("C2#")`).layout.objects[0] as VisualTemporalNode & {
        resolvedMidi: number | null;
        ast: ASTFunctionNode & { acc: string; octave: number };
    };
    const shorthandPostfix = compileScore(`A3# A3#2`).layout.objects as (VisualTemporalNode & {
        resolvedMidi: number | null;
    })[];

    assert(shorthand.ast.octave === 0 && shorthand.resolvedMidi === 12,
        "C0 语法糖必须保留绝对八度 0");
    assert(explicit.ast.octave === 2 && explicit.resolvedMidi === 36,
        "显式 @note 必须采用名称中的绝对八度");
    assert(postfixAccidental.ast.acc === "#" && postfixAccidental.ast.octave === 2
        && postfixAccidental.resolvedMidi === 37,
        "显式 @note 必须兼容无歧义的后置升降号");
    assert(shorthandPostfix.map(note => note.resolvedMidi).join() === "58,57,63",
        "A3# 必须兼容为 A#3，而 A3#2 必须解析为 A3 和 #2");
    expectCompileError(`@note("#6#")`, "E_WRONG_NOTE_NAME");
});

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

test("X 与数字 9 使用相同的节拍记号语义", () => {
    const source = `X @note(X) 9`;
    const result = layoutOf(source);
    const glyphs = recordCommands(result)
        .filter(command => command.kind === "text")
        .map(command => command.text);
    const notes = result.objects as (VisualTemporalNode & { resolvedMidi: number | null })[];

    assert(glyphs.join("") === "XXX", "X 和 9 都必须绘制为 X");
    assert(notes.every(note => note.resolvedMidi === null), "X 和 9 都不具有旋律音高，打击键由播放事件指定");
    assert(notes.every(note => note.ast.toString(source).startsWith("@n(9,")),
        "X、@note(X) 和 9 的去糖写法必须归一为 9");
    assert(nearly(notes[0].box.w, notes[2].box.w) && nearly(notes[0].box.h, notes[2].box.h),
        "X 和 9 必须使用相同的记谱盒");
});

test("Z 与数字 0 使用相同的休止符语义", () => {
    const source = `Z @note(Z) 0`;
    const result = layoutOf(source);
    const glyphs = recordCommands(result)
        .filter(command => command.kind === "text")
        .map(command => command.text);
    const notes = result.objects as (VisualTemporalNode & { resolvedMidi: number | null })[];

    assert(glyphs.join("") === "000", "Z 和 0 都必须绘制为休止符 0");
    assert(notes.every(note => note.resolvedMidi === null), "Z 和 0 都必须推进节拍而不发音");
    assert(notes.every(note => note.ast.toString(source).startsWith("@n(0,")),
        "Z、@note(Z) 和 0 的去糖写法必须归一为 0");
    assert(nearly(notes[0].box.w, notes[2].box.w) && nearly(notes[0].box.h, notes[2].box.h),
        "Z 和 0 必须使用相同的记谱盒");
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

test("反复线落在指定线条的 anchor 上，adjust 扩位不移动墨迹", () => {
    const geometry = (source: string) => {
        const result = layoutOf(source);
        const anchor = result.objects[0].box.x + result.objects[0].box.anchor;
        const commands = recordCommands(result);
        return {
            anchor,
            lines: commands.filter(command => command.kind === "rect"),
            dots: commands.filter(command => command.kind === "circle"),
        };
    };

    for (const type of [2, 3, 4]) {
        const base = geometry(`@bar(${type})`);
        const wider = geometry(`@adjust(@bar(${type}), dw=20px)`);
        const anchorLine = base.lines.reduce((left, right) => type === 2
            ? (left.w > right.w ? left : right)
            : (left.w < right.w ? left : right));
        assert(nearly(anchorLine.x + anchorLine.w / 2, base.anchor),
            `bar type ${type} designated line must sit on its anchor`);
        assert(base.lines.length === wider.lines.length && base.dots.length === wider.dots.length,
            `bar type ${type} must preserve all ink when dw changes`);
        for (let i = 0; i < base.lines.length; i++) {
            assert(nearly(base.lines[i].x - base.anchor, wider.lines[i].x - wider.anchor)
                && nearly(base.lines[i].w, wider.lines[i].w),
            `bar type ${type} lines must stay fixed relative to the anchor`);
        }
        for (let i = 0; i < base.dots.length; i++) {
            assert(nearly(base.dots[i].cx - base.anchor, wider.dots[i].cx - wider.anchor)
                && nearly(base.dots[i].r, wider.dots[i].r),
            `bar type ${type} dots must stay fixed relative to the anchor`);
        }
    }
});

test("三种反复线的圆点大小一致", () => {
    const radiusOf = (type: number) => recordCommands(layoutOf(`@bar(${type})`))
        .find(command => command.kind === "circle")?.r;
    const radii = [2, 3, 4].map(radiusOf);
    assert(radii.every(radius => radius !== undefined && nearly(radius, radii[0]!)),
        `repeat bar dots must share one radius, got ${radii.join(", ")}`);
});

test("不规范的调性先按音高归一化，读不懂才退回 C4，严格模式一律报错", () => {
    /** 源码里数字 1 解析出的 MIDI，说明最终生效的到底是哪个调 */
    const tonicOf = (tonality: string) => {
        const compiled = compileScore(`@1(${tonality}) 1`);
        const note = compiled.layout.objects[1] as VisualTemporalNode & { resolvedMidi: number };
        return { midi: note.resolvedMidi, diagnostics: compiled.lowering.diagnostics };
    };

    // parseNoteName 比 tonality2Midi 宽松得多，这些以前会一路蒙混到 lowering 才崩
    const cases: [string, number][] = [
        ["C##", 62],    // 超过一个变音记号：按音高换字母 -> D4
        ["Cbb", 58],    // 一路降到上一个八度 -> Bb3
        ["B#4", 72],    // 升到下一个八度 -> C5
        ["Cn", 60],     // 还原号
        ["c", 60],      // 小写
        ["5'", 79],     // 数字音名加相对八度 -> G5
    ];
    for (const [tonality, midi] of cases) {
        const { midi: actual, diagnostics } = tonicOf(tonality);
        assert(actual === midi, `调性 "${tonality}" 应归一化到 MIDI ${midi}，实际 ${actual}`);
        assert(diagnostics.some(item => item.code === "W_KEY_TONALITY"),
            `调性 "${tonality}" 归一化后应报 W_KEY_TONALITY`);
        expectCompileError(`@set(strict=true) @1(${tonality}) 1`, "E_KEY_TONALITY");
    }

    for (const tonality of ["X", "H4"]) {
        assert(tonicOf(tonality).midi === 60, `读不懂的调性 "${tonality}" 应退回 C4`);
        expectCompileError(`@set(strict=true) @1(${tonality}) 1`, "E_KEY_TONALITY");
    }

    for (const tonality of ["C4", "F#3", "Bb", "5"]) {
        assert(!tonicOf(tonality).diagnostics.some(item => item.code === "W_KEY_TONALITY"),
            `合法调性 "${tonality}" 不应报警`);
    }
});

test("tempo 与 key 自己上谱，set 纯词法，不可见事件不分配布局资源", () => {
    const loweredState = lower(`@tempo(90) @1(D4) @set(note.color=#f00) 1 @br()`);
    const stateResult = layoutDocument(loweredState, layoutContext);
    const invisibleStateEvents = loweredState.columns
        .flat()
        .filter(event => !isVisualTemporalNode(event));
    const stateNote = stateResult.objects[2] as VisualTemporalNode & {
        resolvedMidi: number;
        ast: ASTFunctionNode & { color: string };
    };

    assert(stateResult.objects.length === 3, "tempo and key draw themselves; set stays purely lexical");
    assert(stateNote.playbackState?.bpm === 90, "tempo must be frozen into the notes at its score position");
    assert(stateNote.resolvedMidi === 62, "key D4 must resolve jianpu 1 to MIDI 62");
    assert(stateNote.ast.color === "#f00", "set must solidify the note color during parsing");
    assert(invisibleStateEvents.every(event => event.box === undefined), "invisible state events must not allocate LayoutBox");
    assert(invisibleStateEvents.every(event => event.springConfig === undefined), "invisible state events must not allocate HorizontalSpringConfig");
    assert(invisibleStateEvents.every(event => event.ports === undefined), "invisible state events must not allocate layout ports");
    assert(invisibleStateEvents.every(event => event.decorations === undefined), "invisible state events must not allocate decorations");
    assert(invisibleStateEvents.every(event => event.addon === undefined), "undecorated state events must not allocate addon");
});

test("JE 谱括号按局部作用域调整八度", () => {
    const source = `(1 [2] 3) 4 [[5]] {(6} 7`;
    const notes = compileScore(source).layout.objects as (VisualTemporalNode & {
        octave: number;
        resolvedMidi: number | null;
    })[];

    assert(notes.map(note => note.octave).join() === "-1,0,-1,0,2,-1,0",
        "JE 括号必须支持嵌套，并在离开大括号作用域后恢复八度");
    assert(notes.map(note => note.resolvedMidi).join() === "48,62,52,65,91,57,71",
        "JE 括号必须让音高随每层括号改变 12 个半音");
});

test("JE 谱括号内的音符去糖不会重复应用八度", () => {
    const source = `(@note(1))`;
    const note = compileScore(source).layout.objects[0] as VisualTemporalNode & {
        octave: number;
        resolvedMidi: number | null;
        ast: ASTFunctionNode;
    };
    const replacement = note.ast.toString(source);
    const replacedSource = source.slice(0, note.ast.sourceSpan.start)
        + replacement
        + source.slice(note.ast.sourceSpan.end);
    const replaced = compileScore(replacedSource).layout.objects[0] as VisualTemporalNode & {
        octave: number;
        resolvedMidi: number | null;
    };

    assert(note.octave === -1 && note.resolvedMidi === 48, "显式音符也必须读取 JE 八度作用域");
    assert(replaced.octave === -1 && replaced.resolvedMidi === 48,
        "替换为音符的去糖写法后，外层 JE 括号不能重复施加偏移");
});

test("数字音名只在无歧义时兼容后置升降号", () => {
    const notes = compileScore(`2#3`).layout.objects as (VisualTemporalNode & {
        resolvedMidi: number | null;
    })[];
    const notesAfterOctave = compileScore(`2'#3`).layout.objects as (VisualTemporalNode & {
        resolvedMidi: number | null;
    })[];

    assert(notes.map(note => note.resolvedMidi).join() === "62,65",
        "2#3 必须解析为 2 和 #3，而不是 #2 和 3");
    assert(notesAfterOctave.map(note => note.resolvedMidi).join() === "74,65",
        "2'#3 必须解析为 2' 和 #3，而不是 #2' 和 3");

    const compatible = compileScore(`6#,, #6#`).layout.objects as (VisualTemporalNode & {
        resolvedMidi: number | null;
    })[];
    assert(compatible.map(note => note.resolvedMidi).join() === "46,70",
        "6#,, 必须兼容为 #6,,，而 #6# 不能合并成 ##6");
});
