import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PAGE_CONFIG, compileScore } from "jpfun";
import {
    adjacentEditTarget,
    applyRelationCommand,
    applyScoreEditAction,
    applySourceEditsToText,
    createScoreEditIndex,
    editHitAt,
    insertSlotAfter,
    mapSpanThroughEdits,
    stepOctave,
} from "@jpfun/editor-tools/edit";
import { createPreviewNavigationMap } from "@jpfun/editor-tools/navigation";

// target：streamTargets 下标、`index => target` 选择器或 null；action 也可为 `index => action`
function runEdit(source, target, action) {
    const compiled = compileScore(source);
    const index = createScoreEditIndex(source, compiled);
    const resolved = typeof target === "number" ? index.streamTargets[target]
        : typeof target === "function" ? target(index) : null;
    if (target !== null) assert.ok(resolved);
    const result = applyScoreEditAction(source, compiled, index, resolved, typeof action === "function" ? action(index) : action);
    const nextSource = applySourceEditsToText(source, result.edits);
    const nextCompiled = compileScore(nextSource);
    const nextIndex = createScoreEditIndex(nextSource, nextCompiled);
    return { nextSource, nextCompiled, nextIndex, result };
}

function assertEdits(cases) {
    for (const [source, target, action, expected] of cases) {
        const { nextSource, nextCompiled } = runEdit(source, target, action);
        assert.equal(nextSource, expected, source);
        assert.deepEqual(nextCompiled.diagnostics, [], source);
    }
}

const selectedText = ({ nextSource, result }) => nextSource.slice(result.nextSpan.start, result.nextSpan.end);
const rhythm = (div, dot = 0) => ({ type: "set-rhythm", rhythm: { div, dot } });
const appendNote = pitch => index => ({ type: "insert-note", slot: index.defaultInsertSlot, pitch, rhythm: { div: 0, dot: 0 } });

test("melody insertion with rhythm preset and auto-barline on full measure", () => {
    let source = "H.signature: 1=C 4/4";
    let compiled = compileScore(source);
    let index = createScoreEditIndex(source, compiled);
    let slot = index.defaultInsertSlot;
    const insert = (pitch, div) => {
        const res = applyScoreEditAction(source, compiled, index, null, { type: "insert-note", slot, pitch, rhythm: { div, dot: 0 } });
        source = applySourceEditsToText(source, res.edits);
        compiled = compileScore(source);
        index = createScoreEditIndex(source, compiled);
        slot = insertSlotAfter(source, compiled, index, res.nextSpan);
    };

    // 连续输入 4 个八分音符（占 2 拍，未满 4/4 拍，不自动加小节线）
    for (const pitch of ["1", "2", "3", "5"]) insert(pitch, 1);
    assert.equal(source.trim(), "H.signature: 1=C 4/4\n1/ 2/ 3/ 5/");
    assert.equal(slot.measureUsed.toNumber(), 2);
    assert.equal(slot.measureRemaining?.toNumber(), 2);

    // 再输入一个四分音符 `6` 和一根增时线 `-`（各占 1 拍），正好凑满 4 拍，自动补上 ` |`
    for (const pitch of ["6", "-"]) insert(pitch, 0);
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

    const trailing = compileScore("1 @br()");
    const trailingIndex = createScoreEditIndex("1 @br()", trailing);
    const first = trailingIndex.streamTargets[0];
    assert.equal(trailingIndex.defaultInsertSlot.region.x, DEFAULT_PAGE_CONFIG.marginLeft);
    assert.equal(trailingIndex.defaultInsertSlot.region.y, first.region.y + first.region.h + 18);
});

test("selecting existing note modifies pitch with advance, octave, accidental, rhythm, and shared div splitting", () => {
    // 1. 修改音高（或改为增时线 `-`）并自动步进到下一音符，末音自动切入 insert 模式
    const step1 = runEdit("1/ 2/ 3/", 0, { type: "set-pitch", pitch: "5" });
    assert.equal(step1.nextSource, "5/ 2/ 3/");
    assert.equal(step1.result.nextMode, "select");
    assert.equal(selectedText(step1), "2/");

    const stepLast = runEdit(step1.nextSource, 2, { type: "set-pitch", pitch: "9" });
    assert.equal(stepLast.nextSource, "5/ 2/ 9/");
    assert.equal(stepLast.nextIndex.streamTargets[2].pitch, "9");
    assert.equal(stepLast.result.nextMode, "insert");

    // 八度编辑上限与面板一致为 ±3，已超出的源码八度只允许向内收
    assert.deepEqual(runEdit("5'''", 0, { type: "adjust-octave", delta: 1 }).result.edits, []);
    assert.deepEqual([stepOctave(3, 1), stepOctave(5, 1), stepOctave(5, -1), stepOctave(-4, -1)], [3, 5, 4, -4]);

    assertEdits([
        // 2. 升降号切换与八度增减
        ["5/ 2/", 0, { type: "set-accidental", acc: "#" }, "#5/ 2/"],
        ["#5/ 2/", 0, { type: "set-accidental", acc: "#" }, "5/ 2/"],
        ["5/ 2/", 0, { type: "adjust-octave", delta: 1 }, "5'/ 2/"],
        ["5/ 2/", 0, { type: "adjust-octave", delta: -2 }, "5,,/ 2/"],
        // 函数实参内含双引号 `{` 时，后续裸音符降八度仍正确加 `{...}` 保护逗号
        ['@div("{" 1)', 0, { type: "adjust-octave", delta: -1 }, '@div("{" {1,})'],
        // 3. 减时线与附点作为两个独立状态修改（八分 `5/` -> 八分附点 `5/.` -> 四分附点 `5.`）
        ["5/ 2/", 0, { type: "set-rhythm", rhythm: { dot: 1 } }, "5/. 2/"],
        ["5/. 2/", 0, { type: "set-rhythm", rhythm: { div: 0 } }, "5. 2/"],
        // 4. 共享减时块 `{1 2}/`、`{1 | 2}/`、`{6>1 2}/` 单独修改其中一个音的时值时保留内部结构并拆块
        ["{1 2}/", 0, rhythm(0), "1 2/"],
        ["{1 | 2}/", 0, rhythm(0), "1 | 2/"],
        ["{6>1 2}/", 1, rhythm(0), "6>1 2/"],
        // 5. 显式 `@up(1,3)` 修改时值时保留全部和弦成员
        ["@up(1,3) 2", 0, rhythm(1), "@up(1/,3) 2"],
        // 6. 嵌套共享减时块 `{{1 2}/ 3}/` 拆解时保持所有兄弟节点的真实时值
        ["{{1 2}/ 3}/", 0, rhythm(0), "1 2// 3/"],
        // 8. 音名末尾的 `!`（force）不属于音高，原位改写时保留
        ["#1! 2", 0, { type: "adjust-octave", delta: 1 }, "#1'! 2"],
        ["@n(1!) 2", 0, { type: "set-accidental", acc: "#" }, "@n(#1!) 2"],
    ]);

    // 5. 外层带 `/` 的折叠结构 `{1^$accent}/` 修改时值时不会重复叠加外层 `/`
    const foldedOuterDiv = runEdit("{1^$accent}/", 0, rhythm(2));
    assert.equal(foldedOuterDiv.nextSource, "1//^$accent");
    assert.equal(foldedOuterDiv.nextIndex.streamTargets[0].rhythm.div, 2);

    // 7. 显式 `@note` 在 `@set(note.acc=#)` 下修改音高或升降号不会重复叠加默认 `#`
    for (const [action, expected, acc] of [
        [{ type: "set-pitch", pitch: "3" }, '@set(note.acc=#) @note(3, acc="#")', "#"],
        [{ type: "set-accidental", acc: "#" }, '@set(note.acc=#) @note(1, acc="")', ""],
    ]) {
        const res = runEdit("@set(note.acc=#) @note(1)", 0, action);
        assert.equal(res.nextSource, expected);
        assert.equal(res.nextIndex.streamTargets[0].acc, acc);
    }
});

test("toggling symbols and grace notes on a note", () => {
    let source = "1/ 2";
    for (const [symbol, expected, symbols] of [
        ["staccato", "1/^$staccato 2", ["staccato"]],
        ["accent", "1/^$staccato ^$accent 2", ["staccato", "accent"]],
        ["staccato", "1/^$accent 2", ["accent"]],
        ["accent", "1/ 2", []],
    ]) {
        const res = runEdit(source, 0, { type: "toggle-symbol", symbol });
        assert.equal(res.nextSource, expected);
        assert.deepEqual(res.nextIndex.streamTargets[0].symbols, symbols);
        source = res.nextSource;
    }

    assertEdits([
        // 插入前倚音并删除还原
        ["1 2", 0, { type: "insert-grace", side: "pre", pitch: "6" }, "6>1 2"],
        ["6>1 2", 0, { type: "delete" }, "1 2"],
        // 删除倚音宿主时连同倚音整体删除，不将倚音转移给后继音符
        ["6>1 2", 1, { type: "delete" }, "2"],
        // 后倚音保持宿主原有的减时线与附点
        ["1/. 2", 0, { type: "insert-grace", side: "post", pitch: "6" }, "1/.<6 2"],
    ]);
});

test("multi-note relation commands (@tie, @gliss, @tuplet) and orphan label cleanup on delete", () => {
    const source = "1/ 2/ 3/ 5/";
    const { streamTargets } = createScoreEditIndex(source, compileScore(source));
    const relation = kind => index => index.targets.find(t => t.kind === "relation" && t.relationKind === kind);

    // 拾取第 1 个和第 3 个音符创建 @tie
    const tieRes = applyRelationCommand(source, { kind: "tie", targets: [streamTargets[0], streamTargets[2]] });
    const tiedSource = applySourceEditsToText(source, tieRes.edits);
    assert.equal(tiedSource, "1/@t1 2/ 3/@t2 @tie(t1, t2) 5/");
    assert.deepEqual(compileScore(tiedSource).diagnostics, []);

    // 删除该连音线时，自动清理不再使用的 @t1 和 @t2 标签，且选中紧邻的前驱音符 3/
    const delTie = runEdit(tiedSource, relation("tie"), { type: "delete" });
    assert.equal(delTie.nextSource, "1/ 2/ 3/ 5/");
    assert.equal(selectedText(delTie), "3/");

    // 删除中后段音符时，选中紧邻的前一个音符（而非曲首调号或第一个音符）
    const delThirdNote = runEdit("H.signature: 1=C 4/4\n1 2 3", 4, { type: "delete" });
    assert.equal(delThirdNote.nextSource.trim(), "H.signature: 1=C 4/4\n1 2");
    assert.equal(selectedText(delThirdNote), "2");
    // 全角空格与普通空格同样是分隔空白，删除时一并吞掉
    assert.equal(runEdit("1\u30002\u30003", 1, { type: "delete" }).nextSource, "1\u30003");

    // 删除被多个关系引用的带标签音符时，一并清理所有关联关系与孤立标签
    const multiRelDel = runEdit("1@a 2@b 3@c @tie(a, b) @gliss(b, c)", 1, { type: "delete" });
    assert.equal(multiRelDel.nextSource.trim(), "1 3");
    assert.equal(selectedText(multiRelDel), "1");
    // 关系调用嵌在 @tuplet 内时，只删除该关系，外层连音保持不动
    assert.equal(runEdit("@tuplet({1@a 2@b @tie(a,b) 3 4}, 2) 5", 0, { type: "delete" }).nextSource, "@tuplet({2 3 4}, 2) 5");

    // 拾取前 3 个音符创建三连音 @tuplet，再点击删除解包还原
    const tupletRes = applyRelationCommand(source, { kind: "tuplet", targets: [streamTargets[0], streamTargets[2]], normal: 2 });
    const tupletSource = applySourceEditsToText(source, tupletRes.edits);
    assert.equal(tupletSource, "@tuplet({1/ 2/ 3/}, 2) 5/");
    assert.equal(runEdit(tupletSource, relation("tuplet"), { type: "delete" }).nextSource, "1/ 2/ 3/ 5/");
});

test("mid-score meter change, barline type change, and barline reflow", () => {
    // 1. 选中第一条小节线 `|`，在其后插入中途变拍 `@meter(3, 4)`
    const meterInsert = runEdit("H.signature: 1=C 4/4\n1 2 3 4 | 5 6 7 1' | 2 3 |", index => index.streamTargets.find(t => t.kind === "bar"), {
        type: "set-meter",
        numerator: 3,
        denominator: 4,
    });
    assert.equal(meterInsert.nextSource, "H.signature: 1=C 4/4\n1 2 3 4 | @meter(3, 4) 5 6 7 1' | 2 3 |");

    assertEdits([
        // 2. 对新的 @meter(3, 4) 执行一键重排后续小节线（4+2=6拍 -> 自动重排为 3+3 两小节！）
        [meterInsert.nextSource, index => index.streamTargets.find(t => t.kind === "meter" && !t.inHeader), { type: "reflow-bars" },
            "H.signature: 1=C 4/4\n1 2 3 4 | @meter(3, 4) 5 6 7 | 1' 2 3 |"],
        // 3. 含 @tuplet 的小节重排与末尾插入不会破坏三连音时值
        ["@meter(2,4) @tuplet({1/ 2/ 3/}, 2) 4 |", 0, { type: "reflow-bars" }, "@meter(2,4) @tuplet({1/ 2/ 3/}, 2) 4 |"],
        ["@tuplet({1/ 2/ 3/}, 2)", null, appendNote("4"), "@tuplet({1/ 2/ 3/}, 2) 4"],
        // 4. 含和弦的小节重排与共享 @div 末尾插入
        ["@meter(2,4) 1^3 2 |", 0, { type: "reflow-bars" }, "@meter(2,4) 1^3 2 |"],
        ["{1 2}/", null, appendNote("3"), "{1 2}/ 3"],
        // 6. 顶层换行优先使用两个回车 `\n\n` 语法糖，块内使用 `@br()`
        ["1 2 3 4 |", null, { type: "insert-line-break" }, "1 2 3 4 |\n\n"],
        ["1 2 3 4 |\n\n", null, appendNote("5"), "1 2 3 4 |\n\n5"],
        ["1 2\u3000\u30003", 1, { type: "insert-line-break" }, "1 2\n\n3"],
    ]);

    // 5. 删除被 @tie 引用的带标签音符时一并清理失效关系调用
    assert.equal(runEdit("1 2@b @tie(b, b)", 1, { type: "delete" }).nextSource.trim(), "1");
});

test("barline reflow only rewrites the track of the first note after the meter", () => {
    for (const [source, expected] of [
        ["H.signature: 1=C 2/4\nN: 1 2 3 4 | 5 6 |\nN: 1 2 | 3 4 5 6 |", "H.signature: 1=C 2/4\nN: 1 2 | 3 4 | 5 6 |\nN: 1 2 | 3 4 5 6 |"],
        ["H.signature: 1=C 2/4\n1 2 @stack({3 4 | 5}, {1 | 2 3 4}) 6 |", "H.signature: 1=C 2/4\n1 2 | @stack({3 4 | 5}, {1 | 2 3 4}) 6 |"],
    ]) {
        const res = runEdit(source, index => index.streamTargets.find(t => t.kind === "meter"), { type: "reflow-bars" });
        assert.equal(res.nextSource, expected);
    }
});

test("barline reflow uses the nearest preceding meter of the selection or insert slot", () => {
    const source = "@meter(2,4) 1 2 3 4 @meter(3,4) 5 6 7 1 2 3";
    const first = "@meter(2,4) 1 2 | 3 4 | @meter(3,4) 5 6 7 1 2 3";
    const second = "@meter(2,4) 1 2 3 4 @meter(3,4) 5 6 7 | 1 2 3 |";
    const compiled = compileScore(source);
    const reflowAfter = n => index => ({ type: "reflow-bars", slot: insertSlotAfter(source, compiled, index, index.streamTargets[n].span) });
    // 只重排锚点所在的拍号段，另一段保持原样
    for (const [target, action, expected] of [
        // 选中态：选 `5` 用 3/4，选 `4` 用 2/4
        [6, { type: "reflow-bars" }, second],
        [4, { type: "reflow-bars" }, first],
        // 插入态：以插入槽为锚点；`4` 之后仍属 2/4，`@meter(3,4)` 之后属 3/4；无槽时取谱尾默认槽
        [null, reflowAfter(4), first],
        [null, reflowAfter(5), second],
        [null, { type: "reflow-bars" }, second],
    ]) assert.equal(runEdit(source, target, action).nextSource, expected);
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
    const hitCenter = ({ region }, activeSlot) =>
        editHitAt(index, navigation, region.x + region.w / 2, region.y + region.h / 2, 4, activeSlot);
    const [note0, note1] = index.streamTargets;

    assert.equal(hitCenter(slot, slot)?.kind, "insert");

    // 当插入槽在音符 1 之后时，点击音符 2 仍优先命中音符 2，不被相邻插入槽拦截
    const hitNote1 = hitCenter(note1, insertSlotAfter(source, compiled, index, note0.span));
    assert.equal(hitNote1?.kind, "target");
    assert.equal(hitNote1.target.span.start, note1.span.start);

    const hitNote = hitCenter(note0, slot);
    assert.equal(hitNote?.kind, "target");
    assert.equal(hitNote.target.kind, "note");
    assert.equal(adjacentEditTarget(index, note0.span, 1)?.span.start, note1.span.start);
});
