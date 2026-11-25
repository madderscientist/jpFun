import { test } from "node:test";
import strictAssert from "node:assert/strict";

import { ASTTextNode, type ASTFunctionNode } from "../src/functions/ASTtypes.js";
import { layoutDocument } from "../src/layout/engine.js";
import { isVisualTemporalNode, type VisualTemporalNode } from "../src/functions/temporal.js";
import { pathBounds } from "../src/layout/path.js";
import { compileScore } from "../src/pipeline.js";
import { transformNotes, type NoteTransform } from "../src/functions/note/index.js";
import { assert, expectCompileError, layoutContext, layoutOf, lower, nearly, parse, recordCommands } from "./helpers.js";

function transformed(source: string, operation: NoteTransform, ranges?: { start: number; end: number }[]) {
    let result = source;
    for (const { span, text } of transformNotes(source, lower(source), operation, ranges, lower).reverse()) {
        result = result.slice(0, span.start) + text + result.slice(span.end);
    }
    return result;
}

function noteFacts(source: string) {
    return [...lower(source).astToTemporal.values()].flat()
        .filter(node => "resolvedMidi" in node)
        .sort((left, right) => left.ast.sourceSpan.start - right.ast.sourceSpan.start)
        .map(node => ({ midi: (node as typeof node & { resolvedMidi: number | null }).resolvedMidi,
            time: node.t.toString(), duration: node.T.toString() }));
}

const C = "@set(note.carry=true) ";
const midis = (source: string) => noteFacts(source).map(note => note.midi);

test("note source transformations preserve pitches, timing, selections and JE scopes", () => {
    const source = '@set(note.acc=#) 1 C4 #1 C#4 b1 Cb4 n1 Cn4 @n(1) @n(C4)';
    strictAssert.deepEqual(noteFacts(source).map(note => note.midi), [60, 60, 61, 61, 59, 59, 60, 60, 61, 61]);
    strictAssert.equal(transformed("123", "to-absolute", [{ start: 1, end: 2 }]), "1D4 3");
    strictAssert.equal(transformed("3 7 B4 E4", "semitone-up"), "4 1' C5 F4");
    strictAssert.equal(transformed("1 4 C4 F4", "semitone-down"), "7, 3 B3 E4");

    for (const sample of [
        "1234567 #1 b3 7' 1,, 0 Z 8 9 X C0 C-1 F#4 Bb3",
        "@key(D3) 1 #2 b7 C#4 (1 [2] 3) {C3 D3}>E3",
        'N: C4 D4 | E4 F4\nL: "C4 D4"\nN: G3 A3 | B3 C4',
    ]) {
        const facts = noteFacts(sample);
        for (const operation of ["to-absolute", "to-relative", "semitone-up", "semitone-down"] as const) {
            const result = transformed(sample, operation);
            const delta = operation === "semitone-up" ? 1 : operation === "semitone-down" ? -1 : 0;
            strictAssert.deepEqual(noteFacts(result), facts.map(note => ({ ...note,
                midi: note.midi === null ? null : note.midi + delta })), `${operation}: ${sample}`);
        }
    }

    for (const invalid of ["1 @note(C, octave=bad)", "@note(C, octave=0.5)", "1 @note()"]) {
        strictAssert.throws(() => transformNotes(invalid, compileScore(invalid).lowering, "semitone-up"), invalid);
    }
});

test("rhythm suffixes skip ignored text nodes", () => {
    strictAssert.deepEqual(noteFacts("(1)/ (2)."), [
        { midi: 48, time: "0", duration: "1/2" },
        { midi: 50, time: "1/2", duration: "3/2" },
    ]);
    strictAssert.deepEqual(parse("1 text/").children?.map(node => node instanceof ASTTextNode ? "text" : "function"),
        ["function", "text"]);
});

test("音名的绝对八度完整传入，后置升降号只在无歧义时兼容", () => {
    for (const [source, expected] of [
        [`C0 @note("C2")`, [12, 36]],
        [`@note("C2#")`, [37]],
        [`A3# A3#2`, [58, 57, 63]],   // A3# -> A#3，A3#2 -> A3 和 #2
        [`2#3`, [62, 65]],            // 2 和 #3，而不是 #2 和 3
        [`2'#3`, [74, 65]],
        [`6#,, #6#`, [46, 70]],       // 6#,, -> #6,,，#6# 不能合并成 ##6
    ] as const) {
        strictAssert.deepEqual(midis(source), expected, source);
    }
    expectCompileError(`@note("#6#")`, "E_WRONG_NOTE_NAME");
});

test("升降号贴在数字左上角，与附点一起悬在节奏范围之外", () => {
    const result = layoutOf(`#2.//`);
    const commands = recordCommands(result);
    const number = commands.find(command => command.kind === "text");
    const path = commands.find(command => command.kind === "path");
    const lines = commands.filter(command => command.kind === "rect");
    const dot = commands.find(command => command.kind === "circle");
    assert(number?.kind === "text" && path?.kind === "path" && dot?.kind === "circle" && lines.length === 2,
        "decorated note must emit number, accidental, dot and two div lines");

    const fontSize = number.style.fontSize;
    const numberLeft = number.x - fontSize * 0.31;
    const numberRight = number.x + fontSize * 0.31;
    const bounds = pathBounds(path.commands);
    const gap = numberLeft - (bounds.x + bounds.w);
    assert(lines.every(line => nearly(line.x, numberLeft) && nearly(line.x + line.w, numberRight)),
        "div lines must span exactly the number width");
    assert(gap >= -1e-6 && gap < fontSize * 0.06, "accidental must hang just left of the number cell");
    assert(bounds.y < number.y - fontSize * 0.6, "accidental must be raised to the number upper-left area");
    assert(dot.cx > numberRight, "augmentation dot must stay outside the rhythm range");
    assert(result.bounds.x <= bounds.x, "document bounds must include the complete accidental path");
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

for (const [alias, digit, glyph] of [["X", "9", "X"], ["Z", "0", "0"]]) {
    test(`${alias} 与数字 ${digit} 使用相同的记号语义`, () => {
        const source = `${alias} @note(${alias}) ${digit}`;
        const result = layoutOf(source);
        const glyphs = recordCommands(result)
            .filter(command => command.kind === "text")
            .map(command => command.text);
        const notes = result.objects as (VisualTemporalNode & { resolvedMidi: number | null })[];

        strictAssert.deepEqual(glyphs, [glyph, glyph, glyph]);
        assert(notes.every(note => note.resolvedMidi === null), `${alias} 和 ${digit} 都不具有旋律音高`);
        assert(notes.every(note => note.ast.toString(source).startsWith(`@n(${digit},`)),
            `${alias}、@note(${alias}) 和 ${digit} 的去糖写法必须归一为 ${digit}`);
        assert(nearly(notes[0].box.w, notes[2].box.w) && nearly(notes[0].box.h, notes[2].box.h),
            `${alias} 和 ${digit} 必须使用相同的记谱盒`);
    });
}

test("numberweight controls note, meter and rest with default 700 and lexical scope", () => {
    const source = [
        `@meter(2, 4) 1 | @rest(2) |`,
        `{ @set(numberweight=400) @meter(3, 4) 2 3 4 | @rest(1) | { @set(numberweight=0) 5 } }`,
        `6`,
    ].join(" ");
    const weights = recordCommands(layoutOf(source))
        .filter(command => command.kind === "text")
        .map(command => command.style.fontWeight);
    strictAssert.deepEqual(weights, [700, 700, 700, 700, 400, 400, 400, 400, 400, 400, 700, 700]);

    const annotations = `@set(numberweight=400) @key(C) @tuplet({1@a 2@b 3}, 2) @volta(a, b, 1) @ottava(a, b, 1)`;
    const annotationWeights = recordCommands(layoutOf(annotations))
        .filter(command => command.kind === "text")
        .filter(command => !["1", "2", "3"].includes(command.text))
        .map(command => [command.text, command.style.fontWeight]);
    strictAssert.deepEqual(annotationWeights, [
        ["1=", undefined],
        ["C", undefined],
        ["1.", undefined],
        ["8", undefined],
    ]);
});

test("小节线与音符共享视觉中心轴，并加强附近的弹簧", () => {
    const barAlignmentResult = layoutOf(`1 | 2/ 3, |`);
    const visualAxes = barAlignmentResult.objects.map(object => object.box.y + object.box.visualAxis);
    assert(visualAxes.every(axis => nearly(axis, visualAxes[0])), "bar and note-like objects must share one visual center axis");
    const [noteBeforeBar, firstBar, noteAfterBar] = barAlignmentResult.objects;
    // 朝向小节线的两侧弹簧用 4 倍 mu，背离一侧保持基础值
    strictAssert.deepEqual([noteBeforeBar.springConfig.mu_L, noteBeforeBar.springConfig.mu_R,
        firstBar.springConfig.mu_L, firstBar.springConfig.mu_R, noteAfterBar.springConfig.mu_L], [16, 64, 64, 64, 64]);

    const barAlignmentCommands = recordCommands(barAlignmentResult);
    const alignedNumberCenters = barAlignmentCommands
        .filter(command => command.kind === "text")
        .filter(command => /^[0-9]$/.test(command.text))
        .map(command => command.y - command.style.fontSize * 0.3);
    const alignedBarCenters = barAlignmentCommands
        .filter(command => command.kind === "rect")
        .filter(command => command.style?.fill === "#000" && command.h > command.w)
        .map(command => command.y + command.h / 2);

    strictAssert.equal(alignedNumberCenters.length, 3);
    strictAssert.equal(alignedBarCenters.length, 2);
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

    let radius: number | undefined;
    for (const type of [3, 4, 5]) {
        const base = geometry(`@bar(${type})`);
        const wider = geometry(`@adjust(@bar(${type}), dw=20px)`);
        assert(base.dots.length > 0, `bar type ${type} must draw repeat dots`);
        const expectedRadius = radius ?? base.dots[0].r;
        radius = expectedRadius;
        assert(base.dots.every(dot => nearly(dot.r, expectedRadius)), "repeat bar dots must share one radius");
        const anchorLine = base.lines.reduce((left, right) => type === 3
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

test("双竖线使用两条细线，三竖线使用原终止线样式", () => {
    const linesOf = (source: string) => recordCommands(layoutOf(source))
        .filter(command => command.kind === "rect");
    const double = linesOf("||");
    const final = linesOf("|||");

    assert(double.length === 2 && nearly(double[0].w, double[1].w),
        "|| must render as two equally thin lines");
    assert(final.length === 2 && final[1].w > final[0].w,
        "||| must render as a thin line followed by a thick final line");
    assert(layoutOf("|||").objects.length === 1,
        "||| must parse as one final bar rather than || followed by |");
});

test("不规范的调性先按音高归一化，读不懂才退回 C4，严格模式一律报错", () => {
    /** 源码里数字 1 解析出的 MIDI，说明最终生效的到底是哪个调 */
    const tonicOf = (tonality: string) => {
        const compiled = compileScore(`@1(${tonality}) 1`);
        const key = compiled.layout.objects[0].ast as { tonality?: string };
        const note = compiled.layout.objects[1] as VisualTemporalNode & { resolvedMidi: number };
        return { tonality: key.tonality, midi: note.resolvedMidi, diagnostics: compiled.lowering.diagnostics };
    };

    // parseNoteName 比 tonality2Midi 宽松得多，这些以前会一路蒙混到 lowering 才崩
    const cases: [string, number][] = [
        ["C##", 62],    // 超过一个变音记号：按音高换字母 -> D4
        ["Cbb", 58],    // 一路降到上一个八度 -> Bb3
        ["B#4", 72],    // 升到下一个八度 -> C5
        ["Cn", 60],     // 还原号
        ["c", 60],      // 小写
        ["5", 67],      // 数字音名 -> G4
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

    for (const [tonality, expected] of [["C4", "C4"], ["F#3", "F#3"], ["C", "C4"], ["Bb", "Bb4"]] as const) {
        const result = tonicOf(tonality);
        assert(result.tonality === expected, `合法调性 "${tonality}" 应归一化为 "${expected}"，实际 "${result.tonality}"`);
        assert(!result.diagnostics.some(item => item.code === "W_KEY_TONALITY"),
            `合法调性 "${tonality}" 不应报警`);
    }
});

test("tempo 与 key 自己上谱，set 纯词法，不可见事件不分配布局资源", () => {
    const loweredState = lower(`@tempo(90) @1(D4) @program(1) @set(note.color=#f00) 1 @br()`);
    const stateResult = layoutDocument(loweredState, layoutContext);
    const invisibleStateEvents = loweredState.columns
        .flat()
        .filter(event => !isVisualTemporalNode(event));
    const stateNote = stateResult.objects[2] as VisualTemporalNode & {
        resolvedMidi: number;
        ast: ASTFunctionNode & { color: string };
    };

    const noteColumn = loweredState.columns.find(column => column.includes(stateNote))!;
    assert(stateResult.objects.length === 3, "tempo and key draw themselves; set stays purely lexical");
    assert(noteColumn.bpm === 90, "tempo must be frozen into the column at its score position");
    assert(stateNote.resolvedMidi === 62, "key D4 must resolve jianpu 1 to MIDI 62");
    assert(stateNote.ast.color === "#f00", "set must solidify the note color during parsing");
    assert(invisibleStateEvents.every(event => event.box === undefined && event.springConfig === undefined
        && event.ports === undefined && event.decorations === undefined),
    "invisible state events must not allocate box, springs, ports or decorations");
    strictAssert.deepEqual(invisibleStateEvents.map(event => event.addon), [undefined, { breakBefore: 1 }],
        "only the boundary control needs addon; an ordinary program state event must not allocate it");
});

test("JE 谱括号按局部作用域调整八度，去糖后不重复应用", () => {
    // 支持嵌套，离开大括号作用域后恢复八度
    strictAssert.deepEqual(midis(`(1 [2] 3) 4 [[5]] {(6} 7`), [48, 62, 52, 65, 91, 57, 71]);

    const source = `(@note(1))`;
    const { ast } = compileScore(source).layout.objects[0];
    const replaced = source.slice(0, ast.sourceSpan.start) + ast.toString(source) + source.slice(ast.sourceSpan.end);
    // 替换为音符的去糖写法后，外层 JE 括号不能重复施加偏移
    strictAssert.deepEqual([...midis(source), ...midis(replaced)], [48, 48]);
});

test("carry：数字音名按本小节前文读谱，同列互不影响，八度、小节线、转调与声部各自独立", () => {
    strictAssert.deepEqual(midis(`${C}#1 1 1' 1 | 1`), [61, 61, 72, 61, 60]);
    strictAssert.deepEqual(midis(`${C}#1 1 n1 1`), [61, 61, 60, 60]);
    strictAssert.deepEqual(midis(`${C}1 ^ #1 1`), [60, 61, 61]);
    strictAssert.deepEqual(midis(`${C}#4 4 @key(F4) 4`), [66, 66, 70]);
    strictAssert.deepEqual(midis(`${C}\nN: #1 1 |\nN: 1 1 |`), [61, 61, 60, 60]);
    strictAssert.deepEqual(midis("#1 1"), [61, 60], "默认关闭，与现状一致");
});

test("carry：倚音主线与宿主共享记忆，额外声部隔离，按时间先后生效", () => {
    strictAssert.deepEqual(midis(`${C}{#1 1}>2 1`), [61, 61, 62, 61]);
    strictAssert.deepEqual(midis(`${C}#1 1>2`), [61, 61, 62]);
    strictAssert.deepEqual(midis(`${C}2<{#1} 1`), [62, 61, 61]);
    strictAssert.deepEqual(midis(`${C}#1<{1}`), [61, 61]);
    strictAssert.deepEqual(midis(`${C}{1 & #1}>2 1`), [60, 61, 62, 60]);
    strictAssert.deepEqual(midis(`${C}#1>1>2 1`), [61, 61, 62, 61]);
    strictAssert.deepEqual(midis(`${C}{2>1} ^ #1`), [62, 60, 61]);
    strictAssert.deepEqual(midis(`${C}1 ^ {#1>2} 1`), [61, 61, 62, 61], "前倚音早于同列的和弦音");
    strictAssert.deepEqual(midis(`${C}1 ^ {2<#1} 1`), [60, 62, 61, 61], "后倚音晚于同列的和弦音");
    strictAssert.deepEqual(midis(`${C}#1 ^ {2<1} 1`), [61, 62, 61, 61], "后倚音读得到同列和弦音的写入");
    strictAssert.deepEqual(midis(`${C}{#1 @key(C) 1}>2 1`), [61, 60, 62, 60], "倚音内的转调只影响之后的成员");
});

test("carry：字母音名按记忆省略或补记显示记号，转相对后音高不变", () => {
    strictAssert.equal(transformed(`${C}C#4 C#4 C4 C#4`, "to-relative"), `${C}#1 1 n1 #1`);
    strictAssert.equal(transformed(`${C}C#4 | C#4@tie() C4`, "to-relative"), `${C}#1 | #1@tie() n1`);
    const absolute = transformed(`${C}#1 1 n1 1`, "to-absolute");
    strictAssert.deepEqual(midis(absolute), [61, 61, 60, 60]);
    strictAssert.equal(transformed(absolute, "to-relative"), `${C}#1 1 n1 1`);
    strictAssert.equal(transformed("C#4 C#4", "to-relative"), "#1 #1", "默认关闭，与现状一致");
});

test("carry：升降半音为保持其他音高不变做最少补记", () => {
    const at = (start: number, end = start + 1) => [{ start: C.length + start, end: C.length + end }];
    for (const [source, operation, ranges, expected] of [
        ["1 1", "semitone-up", at(0), "#1 n1"],
        ["#1 1", "semitone-down", at(3), "#1 n1"],
        ["#1 1 1", "semitone-down", at(0, 2), "1 #1 1"],
        ["2 #1 1", "semitone-up", undefined, "#2 n2 2"],
        ["#1 {1 ^ #1} 1", "semitone-down", at(4), "#1 {n1 ^ #1} #1"],
        ["{n1 ^ 1} 1", "semitone-up", at(6), "{n1 ^ #1} 1"],
        ["@grace(1, {1 1}, side=pre)", "semitone-up", at(11), "@grace(1, {#1 n1}, side=pre)"],
    ] as const) {
        const before = midis(C + source);
        const result = transformed(C + source, operation, ranges && [...ranges]);
        strictAssert.equal(result, C + expected, source);
        const changed = before.filter((_, index) => midis(result)[index] !== before[index]);
        strictAssert.equal(changed.length, ranges ? 1 : before.length, `${source} 只改变选中音`);
    }
    strictAssert.throws(() => transformNotes(`${C}1 1`, lower(`${C}1 1`), "semitone-up"),
        (error: { code?: string }) => error.code === "E_NOTE_TRANSFORM");
    const apply = (source: string, ranges?: { start: number; end: number }[]) => transformNotes(source, lower(source), "semitone-up", ranges)
        .reverse().reduce((text, { span, text: edit }) => text.slice(0, span.start) + edit + text.slice(span.end), source);
    strictAssert.equal(apply(`${C}C4 C4`, at(0, 2)), `${C}C#4 C4`, "只有字母音名时不需要 relower");
    strictAssert.equal(apply("1 1"), "#1 #1", "默认关闭时不需要 relower");
});

test("carry、force 为 false 时去糖后显式保留，避免继承外层的 true", () => {
    const note = (source: string) => compileScore(source).ast.content
        .find(node => "carry" in node) as ASTFunctionNode & { carry: boolean; force: boolean };
    for (const flag of ["carry", "force"] as const) {
        const set = `@set(note.${flag}=true) `;
        const source = `${set}@n(1, ${flag}=false)`;
        const text = note(source).toString(source);
        strictAssert.match(text, new RegExp(`${flag}=false`));
        strictAssert.equal(note(set + text)[flag], false);
    }
    strictAssert.doesNotMatch(note("@n(1)").toString("@n(1)"), /carry|force/);
    strictAssert.equal(note(note("C4!").toString("C4!")).force, true, "! 去糖为 force=true");
});

test("force / !：强制显示实际生效的变音号，不改变音高", () => {
    const shown = (source: string) => [...lower(source).astToTemporal.values()].flat()
        .filter(node => "resolvedMidi" in node)
        .sort((left, right) => left.ast.sourceSpan.start - right.ast.sourceSpan.start)
        .map(node => {
            const note = node as typeof node & { name: string; acc: string; displayAcc?: string; resolvedMidi: number | null };
            return `${note.displayAcc ?? note.acc}${note.name}:${note.resolvedMidi}`;
        });
    strictAssert.deepEqual(shown("C4! C#4! #1! 1! 0! 8! 9!"), ["n1:60", "#1:61", "#1:61", "n1:60", "0:null", "8:null", "9:null"]);
    strictAssert.deepEqual(shown(`${C}C#4 C#4! C4! C4`), ["#1:61", "#1:61", "n1:60", "1:60"]);
    strictAssert.deepEqual(shown(`${C}#1 1! 1 | 1!`), ["#1:61", "#1:61", "1:61", "n1:60"]);
    strictAssert.deepEqual(shown("1#,! 6#!3 C!4"), ["#1:49", "#6:70", "3:64", "n1:60", "4:65"], "! 只能写在音名末尾");
    strictAssert.deepEqual(shown('@n("C#4!") @n(C!, #, 4) @n(1, #, 0, #000, true) {@set(note.force=true) C4 @n(1, force=false)} C4'),
        ["#1:61", "#1:61", "#1:61", "n1:60", "1:60", "1:60"]);
    expectCompileError("@n(C!, force=false)", "E_NOTE_FORCE_CONFLICT");
    expectCompileError('@n(C!, "", 4, #000, false)', "E_NOTE_FORCE_CONFLICT");

    strictAssert.equal(transformed("C#4 C4! D4!", "to-relative"), "#1 n1! n2!");
    strictAssert.equal(transformed(`${C}1 1!`, "semitone-up", [{ start: C.length, end: C.length + 1 }]), `${C}#1 n1!`);
    strictAssert.equal(transformed('@n("1!") @n(1!, #)', "semitone-up"), '@n("#1!") @n(2!, "")');
    strictAssert.equal(transformed("@n(C, force=true) {@set(note.force=true) C4}", "to-relative"),
        "@n(n1, force=true) {@set(note.force=true) n1}", "force 实参和 @set 不改写");
});
