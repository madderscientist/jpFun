import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScore } from "jpfun";
import {
    adjacentEditTarget,
    applyRelationCommand,
    applyScoreEditAction,
    applySourceEditsToText,
    createScoreEditIndex,
    editHitAt,
    editTargetAt,
    insertSlotAfter,
    mapSpanThroughEdits,
    stepOctave,
} from "@jpfun/editor-tools/edit";
import { createPreviewNavigationMap } from "@jpfun/editor-tools/navigation";

function runEdit(source, targetSpanOrIndex, action) {
    const compiled = compileScore(source);
    const index = createScoreEditIndex(source, compiled);
    const target = typeof targetSpanOrIndex === "number"
        ? index.streamTargets[targetSpanOrIndex]
        : targetSpanOrIndex
            ? editTargetAt(index, targetSpanOrIndex)
            : null;
    const result = applyScoreEditAction(source, compiled, index, target, action);
    const nextSource = applySourceEditsToText(source, result.edits);
    const nextCompiled = compileScore(nextSource);
    const nextIndex = createScoreEditIndex(nextSource, nextCompiled);
    return { nextSource, nextCompiled, nextIndex, result };
}

test("melody insertion with rhythm preset and auto-barline on full measure", () => {
    let source = "H.signature: 1=C 4/4";
    let compiled = compileScore(source);
    let index = createScoreEditIndex(source, compiled);
    let slot = index.defaultInsertSlot;

    // 连续输入 4 个八分音符（占 2 拍，未满 4/4 拍，不自动加小节线）
    for (const pitch of ["1", "2", "3", "5"]) {
        const res = applyScoreEditAction(source, compiled, index, null, {
            type: "insert-note",
            slot,
            pitch,
            rhythm: { div: 1, dot: 0 },
        });
        source = applySourceEditsToText(source, res.edits);
        compiled = compileScore(source);
        index = createScoreEditIndex(source, compiled);
        slot = insertSlotAfter(source, compiled, index, res.nextSpan);
    }
    assert.equal(source.trim(), "H.signature: 1=C 4/4\n1/ 2/ 3/ 5/");
    assert.equal(slot.measureUsed.toNumber(), 2);
    assert.equal(slot.measureRemaining?.toNumber(), 2);

    // 再输入一个四分音符 `6` 和一根增时线 `-`（各占 1 拍），正好凑满 4 拍，自动补上 ` |`
    for (const pitch of ["6", "-"]) {
        const res = applyScoreEditAction(source, compiled, index, null, {
            type: "insert-note",
            slot,
            pitch,
            rhythm: { div: 0, dot: 0 },
        });
        source = applySourceEditsToText(source, res.edits);
        compiled = compileScore(source);
        index = createScoreEditIndex(source, compiled);
        slot = insertSlotAfter(source, compiled, index, res.nextSpan);
    }
    assert.deepEqual(compiled.diagnostics, []);
    assert.equal(source.trim(), "H.signature: 1=C 4/4\n1/ 2/ 3/ 5/ 6 - |");
    assert.equal(slot.measureUsed.toNumber(), 0);
});

test("insertion slot meter progress only counts the preceding element's voice", () => {
    const source = "H.signature: 1=C 4/4\n@voices(@voice({1 2 3}, A), @voice({4}, B))";
    const compiled = compileScore(source);
    const index = createScoreEditIndex(source, compiled);
    const [a3, b4] = index.streamTargets.slice(-2);
    assert.equal(insertSlotAfter(source, compiled, index, a3.span).measureUsed.toNumber(), 3);
    assert.equal(insertSlotAfter(source, compiled, index, b4.span).measureUsed.toNumber(), 1);
    assert.equal(index.defaultInsertSlot.measureUsed.toNumber(), 1);
});

test("insertion slot after a line break follows the next line onto the next page", () => {
    const source = "@page(height=230px) 1 @br() 2 @br() 3 @br() 4 @br() 5";
    const compiled = compileScore(source);
    const index = createScoreEditIndex(source, compiled);
    const four = index.streamTargets.at(-2), five = index.streamTargets.at(-1);
    assert.ok(five.region.y > 230, "the last line should be laid out on the second page");
    const { region } = insertSlotAfter(source, compiled, index, four.span);
    assert.equal(region.y + region.h / 2, five.region.y + five.region.h / 2);
});

test("selecting existing note modifies pitch with advance, octave, accidental, rhythm, and shared div splitting", () => {
    // 1. 修改音高（或改为增时线 `-`）并自动步进到下一音符，末音自动切入 insert 模式
    const step1 = runEdit("1/ 2/ 3/", 0, { type: "set-pitch", pitch: "5" });
    assert.equal(step1.nextSource, "5/ 2/ 3/");
    assert.equal(step1.result.nextMode, "select");
    assert.equal(step1.nextSource.slice(step1.result.nextSpan.start, step1.result.nextSpan.end), "2/");

    const stepLast = runEdit(step1.nextSource, 2, { type: "set-pitch", pitch: "9" });
    assert.equal(stepLast.nextSource, "5/ 2/ 9/");
    assert.equal(stepLast.nextIndex.streamTargets[2].pitch, "9");
    assert.equal(stepLast.result.nextMode, "insert");

    // 2. 升降号切换与八度增减保持当前选中
    const acc1 = runEdit("5/ 2/", 0, { type: "set-accidental", acc: "#" });
    assert.equal(acc1.nextSource, "#5/ 2/");
    const accToggleOff = runEdit(acc1.nextSource, 0, { type: "set-accidental", acc: "#" });
    assert.equal(accToggleOff.nextSource, "5/ 2/");

    const octUp = runEdit("5/ 2/", 0, { type: "adjust-octave", delta: 1 });
    assert.equal(octUp.nextSource, "5'/ 2/");
    const octDown = runEdit("5/ 2/", 0, { type: "adjust-octave", delta: -2 });
    assert.equal(octDown.nextSource, "5,,/ 2/");
    // 八度编辑上限与面板一致为 ±3，已超出的源码八度只允许向内收
    assert.deepEqual(runEdit("5'''", 0, { type: "adjust-octave", delta: 1 }).result.edits, []);
    assert.deepEqual([stepOctave(3, 1), stepOctave(5, 1), stepOctave(5, -1), stepOctave(-4, -1)], [3, 5, 4, -4]);

    // 函数实参内含双引号 `{` 时，后续裸音符降八度仍正确加 `{...}` 保护逗号
    const octDownAfterQuotedBrace = runEdit('@div("{" 1)', 0, { type: "adjust-octave", delta: -1 });
    assert.equal(octDownAfterQuotedBrace.nextSource, '@div("{" {1,})');
    assert.deepEqual(octDownAfterQuotedBrace.nextCompiled.diagnostics, []);

    // 3. 减时线与附点作为两个独立状态修改（八分 `5/` -> 八分附点 `5/.` -> 四分附点 `5.`）
    const addDot = runEdit("5/ 2/", 0, { type: "set-rhythm", rhythm: { dot: 1 } });
    assert.equal(addDot.nextSource, "5/. 2/");
    const toDottedQuarter = runEdit(addDot.nextSource, 0, { type: "set-rhythm", rhythm: { div: 0 } });
    assert.equal(toDottedQuarter.nextSource, "5. 2/");

    // 4. 共享减时块 `{1 2}/`、`{1 | 2}/`、`{6>1 2}/` 单独修改其中一个音的时值时保留内部结构并拆块
    const splitShared = runEdit("{1 2}/", 0, { type: "set-rhythm", rhythm: { div: 0, dot: 0 } });
    assert.equal(splitShared.nextSource, "1 2/");
    assert.deepEqual(splitShared.nextCompiled.diagnostics, []);

    const splitWithBar = runEdit("{1 | 2}/", 0, { type: "set-rhythm", rhythm: { div: 0, dot: 0 } });
    assert.equal(splitWithBar.nextSource, "1 | 2/");

    const splitWithGrace = runEdit("{6>1 2}/", 1, { type: "set-rhythm", rhythm: { div: 0, dot: 0 } });
    assert.equal(splitWithGrace.nextSource, "6>1 2/");

    // 5. 外层带 `/` 的折叠结构 `{1^$accent}/` 修改时值时不会重复叠加外层 `/`，显式 `@up(1,3)` 保留全部和弦成员
    const foldedOuterDiv = runEdit("{1^$accent}/", 0, { type: "set-rhythm", rhythm: { div: 2, dot: 0 } });
    assert.equal(foldedOuterDiv.nextSource, "1//^$accent");
    assert.equal(foldedOuterDiv.nextIndex.streamTargets[0].rhythm.div, 2);

    const chordRhythm = runEdit("@up(1,3) 2", 0, { type: "set-rhythm", rhythm: { div: 1, dot: 0 } });
    assert.equal(chordRhythm.nextSource, "@up(1/,3) 2");

    // 6. 嵌套共享减时块 `{{1 2}/ 3}/` 拆解时保持所有兄弟节点的真实时值
    const nestedShared = runEdit("{{1 2}/ 3}/", 0, { type: "set-rhythm", rhythm: { div: 0, dot: 0 } });
    assert.equal(nestedShared.nextSource, "1 2// 3/");

    // 7. 显式 `@note` 在 `@set(note.acc=#)` 下修改音高或升降号不会重复叠加默认 `#`
    const explicitSetAcc = runEdit("@set(note.acc=#) @note(1)", 0, { type: "set-pitch", pitch: "3" });
    assert.equal(explicitSetAcc.nextSource, '@set(note.acc=#) @note(3, acc="#")');
    assert.equal(explicitSetAcc.nextIndex.streamTargets[0].acc, "#");
    const explicitClearAcc = runEdit("@set(note.acc=#) @note(1)", 0, { type: "set-accidental", acc: "#" });
    assert.equal(explicitClearAcc.nextSource, '@set(note.acc=#) @note(1, acc="")');
    assert.equal(explicitClearAcc.nextIndex.streamTargets[0].acc, "");
});

test("toggling symbols and grace notes on a note", () => {
    const addStaccato = runEdit("1/ 2", 0, { type: "toggle-symbol", symbol: "staccato" });
    assert.equal(addStaccato.nextSource, "1/^$staccato 2");
    assert.deepEqual(addStaccato.nextIndex.streamTargets[0].symbols, ["staccato"]);

    const addAccent = runEdit(addStaccato.nextSource, 0, { type: "toggle-symbol", symbol: "accent" });
    assert.equal(addAccent.nextSource, "1/^$staccato ^$accent 2");
    assert.deepEqual(addAccent.nextIndex.streamTargets[0].symbols, ["staccato", "accent"]);

    const removeStaccato = runEdit(addAccent.nextSource, 0, { type: "toggle-symbol", symbol: "staccato" });
    assert.equal(removeStaccato.nextSource, "1/^$accent 2");

    const removeAccent = runEdit(removeStaccato.nextSource, 0, { type: "toggle-symbol", symbol: "accent" });
    assert.equal(removeAccent.nextSource, "1/ 2");

    // 插入前倚音并删除还原
    const withGrace = runEdit("1 2", 0, { type: "insert-grace", side: "pre", pitch: "6" });
    assert.equal(withGrace.nextSource, "6>1 2");
    const delGrace = runEdit(withGrace.nextSource, 0, { type: "delete" });
    assert.equal(delGrace.nextSource, "1 2");

    // 删除倚音宿主时连同倚音整体删除，不将倚音转移给后继音符
    const delGraceHost = runEdit("6>1 2", 1, { type: "delete" });
    assert.equal(delGraceHost.nextSource, "2");

    // 后倚音保持宿主原有的减时线与附点
    const postGrace = runEdit("1/. 2", 0, { type: "insert-grace", side: "post", pitch: "6" });
    assert.equal(postGrace.nextSource, "1/.<6 2");
});

test("multi-note relation commands (@tie, @gliss, @tuplet) and orphan label cleanup on delete", () => {
    const source = "1/ 2/ 3/ 5/";
    const compiled = compileScore(source);
    const index = createScoreEditIndex(source, compiled);

    // 拾取第 1 个和第 3 个音符创建 @tie
    const tieRes = applyRelationCommand(source, {
        kind: "tie",
        targets: [index.streamTargets[0], index.streamTargets[2]],
    });
    const tiedSource = applySourceEditsToText(source, tieRes.edits);
    assert.equal(tiedSource, "1/@t1 2/ 3/@t2 @tie(t1, t2) 5/");
    const tiedCompiled = compileScore(tiedSource);
    assert.deepEqual(tiedCompiled.diagnostics, []);

    // 删除该连音线时，自动清理不再使用的 @t1 和 @t2 标签，且选中紧邻的前驱音符 3/
    const tiedIndex = createScoreEditIndex(tiedSource, tiedCompiled);
    const relationTarget = tiedIndex.targets.find(t => t.kind === "relation" && t.relationKind === "tie");
    assert.ok(relationTarget);
    const delTie = applyScoreEditAction(tiedSource, tiedCompiled, tiedIndex, relationTarget, { type: "delete" });
    const untiedSource = applySourceEditsToText(tiedSource, delTie.edits);
    assert.equal(untiedSource, "1/ 2/ 3/ 5/");
    assert.equal(untiedSource.slice(delTie.nextSpan.start, delTie.nextSpan.end), "3/");

    // 删除中后段音符时，选中紧邻的前一个音符（而非曲首调号或第一个音符）
    const delThirdNote = runEdit("H.signature: 1=C 4/4\n1 2 3", 4, { type: "delete" });
    assert.equal(delThirdNote.nextSource.trim(), "H.signature: 1=C 4/4\n1 2");
    assert.equal(delThirdNote.nextSource.slice(delThirdNote.result.nextSpan.start, delThirdNote.result.nextSpan.end), "2");
    // 全角空格与普通空格同样是分隔空白，删除时一并吞掉
    assert.equal(runEdit("1\u30002\u30003", 1, { type: "delete" }).nextSource, "1\u30003");

    // 删除被多个关系引用的带标签音符时，一并清理所有关联关系与孤立标签
    const multiRelDel = runEdit("1@a 2@b 3@c @tie(a, b) @gliss(b, c)", 1, { type: "delete" });
    assert.equal(multiRelDel.nextSource.trim(), "1 3");
    assert.equal(multiRelDel.nextSource.slice(multiRelDel.result.nextSpan.start, multiRelDel.result.nextSpan.end), "1");
    // 关系调用嵌在 @tuplet 内时，只删除该关系，外层连音保持不动
    const nestedRelDel = runEdit("@tuplet({1@a 2@b @tie(a,b) 3 4}, 2) 5", 0, { type: "delete" });
    assert.equal(nestedRelDel.nextSource, "@tuplet({2 3 4}, 2) 5");

    // 拾取前 3 个音符创建三连音 @tuplet，再点击删除解包还原
    const tupletRes = applyRelationCommand(source, {
        kind: "tuplet",
        targets: [index.streamTargets[0], index.streamTargets[2]],
        normal: 2,
    });
    const tupletSource = applySourceEditsToText(source, tupletRes.edits);
    assert.equal(tupletSource, "@tuplet({1/ 2/ 3/}, 2) 5/");
    const tupletCompiled = compileScore(tupletSource);
    const tupletIndex = createScoreEditIndex(tupletSource, tupletCompiled);
    const tupletRel = tupletIndex.targets.find(t => t.kind === "relation" && t.relationKind === "tuplet");
    assert.ok(tupletRel);
    const unwrapRes = applyScoreEditAction(tupletSource, tupletCompiled, tupletIndex, tupletRel, { type: "delete" });
    assert.equal(applySourceEditsToText(tupletSource, unwrapRes.edits), "1/ 2/ 3/ 5/");
});

test("mid-score meter change, barline type change, and barline reflow", () => {
    const source = "H.signature: 1=C 4/4\n1 2 3 4 | 5 6 7 1' | 2 3 |";
    const compiled = compileScore(source);
    const index = createScoreEditIndex(source, compiled);

    // 1. 选中第一条小节线 `|`，在其后插入中途变拍 `@meter(3, 4)`
    const firstBar = index.streamTargets.find(t => t.kind === "bar");
    assert.ok(firstBar);
    const meterInsert = applyScoreEditAction(source, compiled, index, firstBar, {
        type: "set-meter",
        numerator: 3,
        denominator: 4,
    });
    const midMeterSource = applySourceEditsToText(source, meterInsert.edits);
    assert.equal(midMeterSource, "H.signature: 1=C 4/4\n1 2 3 4 | @meter(3, 4) 5 6 7 1' | 2 3 |");

    // 2. 对新的 @meter(3, 4) 执行一键重排后续小节线（4+2=6拍 -> 自动重排为 3+3 两小节！）
    const midCompiled = compileScore(midMeterSource);
    const midIndex = createScoreEditIndex(midMeterSource, midCompiled);
    const midMeterTarget = midIndex.streamTargets.find(t => t.kind === "meter" && !t.inHeader);
    assert.ok(midMeterTarget);
    const reflowRes = applyScoreEditAction(midMeterSource, midCompiled, midIndex, midMeterTarget, {
        type: "reflow-bars",
    });
    const reflowedSource = applySourceEditsToText(midMeterSource, reflowRes.edits);
    const reflowedCompiled = compileScore(reflowedSource);
    assert.deepEqual(reflowedCompiled.diagnostics, []);
    assert.equal(reflowedSource, "H.signature: 1=C 4/4\n1 2 3 4 | @meter(3, 4) 5 6 7 | 1' 2 3 |");

    // 3. 含 @tuplet 的小节重排与末尾插入不会破坏三连音时值
    const tupletBarSource = "@meter(2,4) @tuplet({1/ 2/ 3/}, 2) 4 |";
    const tupletBarCompiled = compileScore(tupletBarSource);
    const tupletBarIndex = createScoreEditIndex(tupletBarSource, tupletBarCompiled);
    const reflowTuplet = applyScoreEditAction(tupletBarSource, tupletBarCompiled, tupletBarIndex, tupletBarIndex.streamTargets[0], {
        type: "reflow-bars",
    });
    assert.equal(applySourceEditsToText(tupletBarSource, reflowTuplet.edits).trim(), "@meter(2,4) @tuplet({1/ 2/ 3/}, 2) 4 |");

    const endTupletSource = "@tuplet({1/ 2/ 3/}, 2)";
    const endTupletCompiled = compileScore(endTupletSource);
    const endTupletIndex = createScoreEditIndex(endTupletSource, endTupletCompiled);
    const appendAfterTuplet = applyScoreEditAction(endTupletSource, endTupletCompiled, endTupletIndex, null, {
        type: "insert-note",
        slot: endTupletIndex.defaultInsertSlot,
        pitch: "4",
        rhythm: { div: 0, dot: 0 },
    });
    assert.equal(applySourceEditsToText(endTupletSource, appendAfterTuplet.edits).trim(), "@tuplet({1/ 2/ 3/}, 2) 4");

    // 4. 含和弦的小节重排与共享 @div 末尾插入
    const chordBarSource = "@meter(2,4) 1^3 2 |";
    const chordBarCompiled = compileScore(chordBarSource);
    const chordBarIndex = createScoreEditIndex(chordBarSource, chordBarCompiled);
    const reflowChord = applyScoreEditAction(chordBarSource, chordBarCompiled, chordBarIndex, chordBarIndex.streamTargets[0], {
        type: "reflow-bars",
    });
    assert.equal(applySourceEditsToText(chordBarSource, reflowChord.edits).trim(), "@meter(2,4) 1^3 2 |");

    const sharedAppendSource = "{1 2}/";
    const sharedAppendCompiled = compileScore(sharedAppendSource);
    const sharedAppendIndex = createScoreEditIndex(sharedAppendSource, sharedAppendCompiled);
    const appendAfterShared = applyScoreEditAction(sharedAppendSource, sharedAppendCompiled, sharedAppendIndex, null, {
        type: "insert-note",
        slot: sharedAppendIndex.defaultInsertSlot,
        pitch: "3",
        rhythm: { div: 0, dot: 0 },
    });
    assert.equal(applySourceEditsToText(sharedAppendSource, appendAfterShared.edits).trim(), "{1 2}/ 3");

    // 5. 删除被 @tie 引用的带标签音符时一并清理失效关系调用
    const tiedNoteDel = runEdit("1 2@b @tie(b, b)", 1, { type: "delete" });
    assert.equal(tiedNoteDel.nextSource.trim(), "1");

    // 6. 顶层换行优先使用两个回车 `\n\n` 语法糖，块内使用 `@br()`
    const topBr = runEdit("1 2 3 4 |", null, { type: "insert-line-break" });
    assert.equal(topBr.nextSource, "1 2 3 4 |\n\n");
    const nextNoteOnNewLine = applyScoreEditAction(
        topBr.nextSource,
        topBr.nextCompiled,
        topBr.nextIndex,
        null,
        { type: "insert-note", slot: topBr.nextIndex.defaultInsertSlot, pitch: "5", rhythm: { div: 0, dot: 0 } },
    );
    assert.equal(applySourceEditsToText(topBr.nextSource, nextNoteOnNewLine.edits), "1 2 3 4 |\n\n5");
    assert.equal(runEdit("1 2\u3000\u30003", 1, { type: "insert-line-break" }).nextSource, "1 2\n\n3");
});

test("barline reflow only rewrites the track of the first note after the meter", () => {
    for (const [source, expected] of [
        ["H.signature: 1=C 2/4\nN: 1 2 3 4 | 5 6 |\nN: 1 2 | 3 4 5 6 |", "H.signature: 1=C 2/4\nN: 1 2 | 3 4 | 5 6 |\nN: 1 2 | 3 4 5 6 |"],
        ["H.signature: 1=C 2/4\n1 2 @stack({3 4 | 5}, {1 | 2 3 4}) 6 |", "H.signature: 1=C 2/4\n1 2 | @stack({3 4 | 5}, {1 | 2 3 4}) 6 |"],
    ]) {
        const compiled = compileScore(source);
        const index = createScoreEditIndex(source, compiled);
        const meter = index.streamTargets.find(t => t.kind === "meter");
        const result = applyScoreEditAction(source, compiled, index, meter, { type: "reflow-bars" });
        assert.equal(applySourceEditsToText(source, result.edits), expected);
    }
});

test("span mapping absorbs the replacement text of partially overlapping edits", () => {
    const span = { start: 5, end: 10 };
    assert.deepEqual(mapSpanThroughEdits(span, [{ span: { start: 3, end: 7 }, text: "" }]), { start: 3, end: 6 });
    assert.deepEqual(mapSpanThroughEdits(span, [{ span: { start: 3, end: 7 }, text: "xy" }]), { start: 3, end: 8 });
    assert.deepEqual(mapSpanThroughEdits(span, [{ span: { start: 8, end: 12 }, text: "" }]), { start: 5, end: 8 });
    assert.deepEqual(mapSpanThroughEdits(span, [{ span: { start: 8, end: 12 }, text: "xyz" }]), { start: 5, end: 11 });
    assert.deepEqual(mapSpanThroughEdits(span, [{ span: { start: 4, end: 11 }, text: "ab" }]), { start: 4, end: 6 });
    assert.deepEqual(mapSpanThroughEdits(span, [
        { span: { start: 0, end: 1 }, text: "" },
        { span: { start: 3, end: 7 }, text: "" },
        { span: { start: 9, end: 12 }, text: "q" },
    ]), { start: 2, end: 5 });
});

test("preview hit detection resolves both existing targets and the insertion slot", () => {
    const source = "1 2 3";
    const compiled = compileScore(source);
    const navigation = createPreviewNavigationMap(compiled);
    const index = createScoreEditIndex(source, compiled);
    const slot = index.defaultInsertSlot;

    const hitSlot = editHitAt(index, navigation, slot.region.x + slot.region.w / 2, slot.region.y + slot.region.h / 2, 4, slot);
    assert.equal(hitSlot?.kind, "insert");

    // 当插入槽在音符 1 之后时，点击音符 2 仍优先命中音符 2，不被相邻插入槽拦截
    const slotAfter1 = insertSlotAfter(source, compiled, index, index.streamTargets[0].span);
    const note1 = index.streamTargets[1];
    const hitNote1 = editHitAt(index, navigation, note1.region.x + note1.region.w / 2, note1.region.y + note1.region.h / 2, 4, slotAfter1);
    assert.equal(hitNote1?.kind, "target");
    assert.equal(hitNote1.target.span.start, note1.span.start);

    const note0 = index.streamTargets[0];
    const hitNote = editHitAt(index, navigation, note0.region.x + note0.region.w / 2, note0.region.y + note0.region.h / 2, 4, slot);
    assert.equal(hitNote?.kind, "target");
    assert.equal(hitNote.target.kind, "note");
    assert.equal(adjacentEditTarget(index, note0.span, 1)?.span.start, index.streamTargets[1].span.start);
});
