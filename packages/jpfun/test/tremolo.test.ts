import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { layoutDocument } from "../src/layout/engine.js";
import type { LoweringAttachment } from "../src/lowering/types.js";
import { compilePlayback } from "../src/playback/compile.js";
import type { PlaybackFlow } from "../src/playback/types.js";
import { renderLayoutPagesToSvg } from "../src/render/svg.js";
import {
    assert,
    attachmentCommands,
    compileValid,
    expectCompileError,
    layoutContext,
    lower,
    parse,
    playedNotes,
} from "./helpers.js";

test("单音震音在右下角绘制 1..3 条平行斜杠并预留水平空间", () => {
    for (const n of [1, 2, 3]) {
        const { layout } = compileValid(`1 @tremolo(5, n=${n}) 3`);
        const host = layout.objects[1];
        const next = layout.objects[2];
        const path = attachmentCommands(layout.attachments[0]).find(item => item.kind === "path");
        assert(path?.kind === "path", "tremolo paints a path");
        strictEqual(path.commands.length, n * 2);
        for (let i = 0; i < n; i++) {
            const move = path.commands[i * 2];
            const line = path.commands[i * 2 + 1];
            assert(move.op === "M" && line.op === "L", "each slash is M..L");
            assert(line.x > move.x && line.y < move.y, "slashes slant upward to the right");
            assert(move.x > host.box.x + host.box.w && line.x < next.box.x, "slashes sit in reserved space on the right");
            const midY = (move.y + line.y) / 2;
            assert(midY > host.box.y + host.box.visualAxis, "single-note slashes sit at the lower-right of the note");
        }
    }

    const withDash = compileValid("@tremolo({5 - -}) 3").layout;
    const lastDash = withDash.objects[2];
    const afterDash = withDash.objects[3];
    const dashSlash = attachmentCommands(withDash.attachments[0]).find(item => item.kind === "path");
    assert(dashSlash?.kind === "path" && dashSlash.commands[0].op === "M" && dashSlash.commands[1].op === "L", "dash slash path");
    assert(dashSlash.commands[0].x > lastDash.box.x + lastDash.box.w && dashSlash.commands[1].x < afterDash.box.x,
        "sustained single-note tremolo places slashes after the final dash");
});

test("双音震音在两组音符或和弦之间居中绘制斜杠并保留自动连梁", () => {
    const chordPair = compileValid("@meter(2, 4) @tremolo({#5,^7, 2^4}) | @tremolo({#5,/^7,/ 2/^4/}) @tremolo({#5,^7, 2^4})/").layout;
    const [, first, second] = chordPair.objects;
    const path = attachmentCommands(chordPair.attachments[0]).find(item => item.kind === "path");
    assert(path?.kind === "path" && path.commands.length === 6, "default n=3 draws 3 slashes");
    const [m0, l0] = path.commands;
    assert(m0.op === "M" && l0.op === "L", "first slash segment");
    assert(m0.x > first.box.x + first.box.w && l0.x < second.box.x,
        "two-note tremolo slashes sit between the two chord columns");

    // 后两个八分双音震音应各自生成一条自动连梁（共 3 个 tremolo + 2 条 beam）
    strictEqual(chordPair.attachments.length, 5);
});

test("单音震音按 1/2^n 四分音符细分并在延音与连音上持续生效", () => {
    for (const [source, count, stepDen] of [
        ["@tremolo(5, n=1)", 2, 2],
        ["@tremolo(5, n=2)", 4, 4],
        ["@tremolo(5)", 8, 8],
        ["@set(tremolo.n=2) @tremolo(5)", 4, 4],
        ["@tremolo({5 - - -})", 32, 8],
        ["@tremolo(5) - - -", 32, 8],
        ["@tremolo(5@a) 5@b @tie(a, b)", 16, 8],
        ["@tremolo(9, n=2)", 4, 4],
    ] as const) {
        const notes = playedNotes(compilePlayback(compileValid(source).lowering));
        strictEqual(notes.length, count, source);
        for (let i = 0; i < count; i++) {
            assert(notes[i].start.equals(i, stepDen) && notes[i].duration.equals(1, stepDen), source);
        }
    }

    const chordNotes = playedNotes(compilePlayback(compileValid("@tremolo({1 ^ 3}, n=2)").lowering));
    strictEqual(chordNotes.length, 8);
    deepStrictEqual(chordNotes.map(note => note.midi), [64, 60, 64, 60, 64, 60, 64, 60]);

    // 反向连音：前音为普通音、后音带单音震音时，前音与震音首个子音合并，剩余子音继续震音
    const reverseTied = playedNotes(compilePlayback(compileValid("5@a @tremolo(5@b, n=2) @tie(a, b)").lowering));
    strictEqual(reverseTied.length, 4);
    assert(reverseTied[0].start.equals(0) && reverseTied[0].end.equals(5, 4), "first note merges with first tremolo subnote");
    assert(reverseTied[1].start.equals(5, 4) && reverseTied[3].end.equals(2), "remaining subnotes stay in second beat");

    // 两端均有单音震音：各自独立展开，仅在边界处合并相邻同音子音
    const bothTied = playedNotes(compilePlayback(compileValid("@tremolo(5@a, n=1) @tremolo(5@b, n=1) @tie(a, b)").lowering));
    strictEqual(bothTied.length, 3);
    assert(bothTied[0].start.equals(0) && bothTied[0].end.equals(1, 2), "first subnote of first tremolo");
    assert(bothTied[1].start.equals(1, 2) && bothTied[1].end.equals(3, 2), "boundary subnotes merge across tie");
    assert(bothTied[2].start.equals(3, 2) && bothTied[2].end.equals(2), "last subnote of second tremolo");

    // 与 $staccato、$accent 组合
    const staccatoTremolo = playedNotes(compilePlayback(compileValid("@tremolo(5 ^ $staccato ^ $accent, n=2)").lowering));
    strictEqual(staccatoTremolo.length, 2);
    assert(staccatoTremolo.every(note => note.velocity === 100), "accent applies to all tremolo subnotes");
    assert(staccatoTremolo[0].start.equals(0) && staccatoTremolo[1].end.equals(1, 2),
        "staccato halves the window before tremolo subdivision");
});

test("双音震音在两组音或和弦的总时值内按 1/2^n 交替发声", () => {
    const simple = playedNotes(compilePlayback(compileValid("@tremolo({1 2}, n=3)").lowering));
    strictEqual(simple.length, 16);
    for (let i = 0; i < 16; i++) {
        strictEqual(simple[i].midi, i % 2 === 0 ? 60 : 62);
        assert(simple[i].start.equals(i, 8) && simple[i].duration.equals(1, 8), "1/8 QN alternating steps");
    }

    const innerDiv = playedNotes(compilePlayback(compileValid("@tremolo({#5,/^7,/ 2/^4/})").lowering));
    const outerDiv = playedNotes(compilePlayback(compileValid("@tremolo({#5,^7, 2^4})/").lowering));
    strictEqual(innerDiv.length, 16); // 8 steps * 2 notes per chord
    deepStrictEqual(
        innerDiv.map(n => `${n.midi}@${n.start}:${n.duration}`),
        outerDiv.map(n => `${n.midi}@${n.start}:${n.duration}`),
    );
    for (let step = 0; step < 8; step++) {
        const pair = innerDiv.slice(step * 2, step * 2 + 2).map(n => n.midi).sort((a, b) => a - b);
        deepStrictEqual(pair, step % 2 === 0 ? [56, 59] : [62, 65]);
        assert(innerDiv[step * 2].start.equals(step, 8) && innerDiv[step * 2].duration.equals(1, 8), "chord step timing");
    }

    // 不同音数的和弦也能正常交替，并保留各自的连音线与反复
    const uneven = playedNotes(compilePlayback(compileValid("|: @tremolo({1 3^5}, n=1) :|").lowering));
    // 每遍 2 拍，n=1 分为 4 步（1, 3^5, 1, 3^5 -> 6 个音），两遍共 12 个音
    strictEqual(uneven.length, 12);
    assert(uneven.at(-1)!.end.equals(4), "two passes cover 4 QN");

    // 首尾与外部同音连音线合并，内部同音连音线只画弧不吞并交替
    const tiedInner = playedNotes(compilePlayback(compileValid("@tremolo({1@a 1@b}, n=1) @tie(a, b)").lowering));
    strictEqual(tiedInner.length, 4);
    const tiedOuter = playedNotes(compilePlayback(compileValid("1@x @tremolo({1@a 2@b}, n=1) 2@y @tie(x, a) @tie(b, y)").lowering));
    strictEqual(tiedOuter.length, 4);
    assert(tiedOuter[0].start.equals(0) && tiedOuter[0].end.equals(3, 2), "leading tie merges into first tremolo attack");
    assert(tiedOuter[3].start.equals(5, 2) && tiedOuter[3].end.equals(4), "trailing tie sustains final tremolo attack");
});

test("tremolo 支持局部子域、外框、微调、延长记号与重复布局幂等", () => {
    for (const source of [
        "@grace(1, @tremolo(2))",
        "@grace(1, @tremolo({2 3}))",
        "@tremolo(2 > 1)",
        "@tremolo({2 > 1  3})",
        "@tremolo({1  2 > 3})",
        "@tremolo({{2 > 1} ^ 3  4})",
        "@up(1, @tremolo(3))",
        "@box(@tremolo(1))",
        "@box(@tremolo({1 2}))",
        "@adjust(@tremolo(1), dx=2px, dy=3px)",
        "@adjust(@tremolo({1 2}), dx=2px, dy=3px)",
        "@tuplet(@tremolo({1 2}), 3)",
        "@tremolo({1^$fermata 2})",
        "@tremolo({1^$staccato 2^$staccato})",
        "@tremolo({1 2}) & {3/ 4/ 5/ 6/}",
        "@tremolo({1 2}) @tie()",
        "@tremolo({1/ 2/}) @beam()",
        "@tremolo({1@a 2})@b @tie(a, b)",
        "@tremolo({5 -})@a 5@b @gliss(a, b)",
    ]) {
        const result = compileValid(source);
        assert(result.layout.bounds.w > 0 && result.layout.bounds.h > 0, source);
        assert(!renderLayoutPagesToSvg(result.layout).join("").includes("NaN"), source);
        const plan = compilePlayback(result.lowering);
        assert(playedNotes(plan).length >= 2, source);
    }

    const lowered = lower("@tremolo({1 2}, n=2)");
    const firstLayout = layoutDocument(lowered, layoutContext);
    const secondLayout = layoutDocument(lowered, layoutContext);
    deepStrictEqual(attachmentCommands(secondLayout.attachments[0]), attachmentCommands(firstLayout.attachments[0]));
    deepStrictEqual(secondLayout.objects.map(n => n.box), firstLayout.objects.map(n => n.box));
    strictEqual(
        parse("@tremolo(5, 2)").content[0].toString("@tremolo(5, 2)"),
        '@tremolo(@n(5, "", 0, #000), n=2)',
    );

    // 同一份 lowering 在控制流中途截断后再完整重编译，不应残留跨次状态
    let stopAtSecond = true;
    const reusable = lower("@tremolo({1 2}, n=1)");
    reusable.attachments.push({
        playbackFlow: () => ({
            run: cursor => stopAtSecond && cursor.column === 1 ? { kind: "stop" } : undefined,
        }),
    } as LoweringAttachment & PlaybackFlow);
    const interrupted = playedNotes(compilePlayback(reusable));
    strictEqual(interrupted.length, 1);
    assert(interrupted[0].start.equals(0) && interrupted[0].end.equals(1), "unpaired first note plays normally");
    stopAtSecond = false;
    const fullRun = playedNotes(compilePlayback(reusable));
    strictEqual(fullRun.length, 4);
    deepStrictEqual(fullRun.map(note => note.midi), [60, 62, 60, 62]);
});

test("tremolo 校验斜杠数与内容合法性", () => {
    for (const badN of ["0", "4", "-1", "1.5"]) {
        expectCompileError(`@tremolo(1, n=${badN})`, "E_TREMOLO_INVALID_N");
    }
    for (const badContent of [
        "{}",
        "0",
        "8",
        "@rest(1)",
        "-",
        "{1 0}",
        "{0 1}",
        "{1 2 3}",
        "{1 - 2}",
        "{1 2 -}",
        "{1 | 2}",
        '{1 "文字" 2}',
        "@tremolo(1)",
        "{@tremolo(1) 2}",
        "1 ^ @tremolo(3)",
        "2 > @tremolo(1)",
    ]) {
        expectCompileError(`@tremolo(${badContent})`, "E_TREMOLO_CONTENT");
    }
    expectCompileError("@tremolo({1/ 2})", "E_TREMOLO_DURATION_MISMATCH");
    expectCompileError("@tremolo({1 @br() 2})", "E_TREMOLO_CROSS_LINE");
    expectCompileError("@tremolo({1 & 3})", "E_TREMOLO_CROSS_TRACK");
});
