import assert from "node:assert/strict";
import test from "node:test";
import { compilePlayback, compileScore } from "jpfun";
import {
    applyScoreEditAction,
    applySourceEditsToText,
    createScoreEditIndex,
    reflowLineBreaks,
} from "../dist/index.js";

function runReflow(source, options = {}) {
    const compiled = compileScore(source, { textMeasurer: options.textMeasurer });
    const edits = reflowLineBreaks(source, compiled, options);
    const next = applySourceEditsToText(source, edits);
    const nextCompiled = compileScore(next, { textMeasurer: options.textMeasurer });
    assert.deepEqual(
        nextCompiled.diagnostics.filter(d => d.severity === "error"),
        [],
        `Reflowed score must compile without errors:\n${next}`,
    );
    return { edits, next, compiled, nextCompiled };
}

function playbackSignature(lowering) {
    const plan = compilePlayback(lowering);
    return plan.events.map(e => {
        switch (e.kind) {
            case "note-on":
            case "note-off":
                return `${e.kind}@${e.at.toString()}:t${e.track}:m${e.midi}`;
            case "program-change":
                return `prog@${e.at.toString()}:t${e.track}:p${e.program}`;
            case "tempo":
                return `tempo@${e.at.toString()}:${e.bpm}`;
            case "time-signature":
                return `meter@${e.at.toString()}:${e.numerator}/${e.denominator}`;
        }
    });
}

test("unlabeled @tie and bare @ placeholders receive fresh labels and become explicit calls", () => {
    const { next, compiled, nextCompiled } = runReflow(
        "1@ 2@ @tie() 3 4 | 5 5 ^ $tr @tie(height=0.8em) 6 7 |",
        { barsPerLine: 1 },
    );
    assert.equal(
        next,
        "1@t1 2@t2 3 4 | @tie(t1, t2)\n\n5@t3 5@t4 ^ $tr 6 7 | @tie(t3, t4, height=0.8em)",
    );
    assert.deepEqual(playbackSignature(nextCompiled.lowering), playbackSignature(compiled.lowering));
});

test("cross-barline unlabeled @tie inside @voice survives splitting across N: systems", () => {
    const source = '@voice({1 2 3 1 | 1 @tie() 2 3 4 |}, 主唱, "一 二 三 四 @ 五 六 七")';
    const { next, compiled, nextCompiled } = runReflow(source, { barsPerLine: 1 });
    assert.equal(
        next,
        "N(主唱): 1 2 3 1@t1 |\nL: 一二三四\n\nN: 1@t2 2 3 4 |\nL: @ 五六七\n@tie(t1, t2)",
    );
    assert.deepEqual(playbackSignature(nextCompiled.lowering), playbackSignature(compiled.lowering));
    // Idempotent on second run
    assert.deepEqual(runReflow(next, { barsPerLine: 1 }).edits, []);
});

test("explicit @voices and @voice convert uniformly to V:/N:/L: sugar and split cleanly", () => {
    const source = `@voices(
    @voice({1 2 3 4 | 5 6 7 1' |}, 第一轨, 歌词="do re mi fa so la ti do"),
    @voice({5, 6, 7, 1 | 2 3 4 5 |}, , "一二三四五六七八", 副歌="{一音多字} @ @ 四 五 六 七 八"),
    connect="{1-2:钢琴}"
)`;
    const { next, compiled, nextCompiled } = runReflow(source, { barsPerLine: 1 });
    assert.equal(
        next,
        [
            "V{钢琴}:",
            "N(第一轨): 1 2 3 4 |",
            "L(歌词): do re mi fa",
            "N: 5, 6, 7, 1 |",
            "L: 一二三四",
            "L(副歌): {一音多字} @ @ 四",
            "",
            "V{}:",
            "N: 5 6 7 1' |",
            "L: so la ti do",
            "N: 2 3 4 5 |",
            "L: 五六七八",
            "L: 五六七八",
        ].join("\n"),
    );
    assert.deepEqual(playbackSignature(nextCompiled.lowering), playbackSignature(compiled.lowering));

    // Re-merging back to 2 bars per line pulls both systems onto one line cleanly
    const merged = runReflow(next, { barsPerLine: 2 });
    assert.equal(merged.nextCompiled.layout.lineCount, 1);
    assert.deepEqual(playbackSignature(merged.nextCompiled.lowering), playbackSignature(compiled.lowering));

    // Implicit connect (@voices without connect= or bare N:\nN:) keeps @set(voices.connect=...) inheritance without injecting V[]:
    const implicit = runReflow('@set(voices.connect="{-}")\n@voices(@voice({1 2 | 3 4 |}), @voice({5 6 | 7 1\' |}))', { barsPerLine: 1 });
    assert.equal(
        implicit.next,
        '@set(voices.connect="{-}")\nN: 1 2 |\nN: 5 6 |\n\nN: 3 4 |\nN: 7 1\' |',
    );
});

test("non-isomorphic systems (varying L: counts and bare intro) pull into one line and re-cut accurately", () => {
    const source = [
        "N(唱): 1 2 3 4 |",
        "L: 春眠不觉",
        "",
        "N: 5 6 7 1' |",
        "",
        "N: 2' 1' 7 6 |",
        "L: 处处闻啼",
    ].join("\n");

    const byTwo = runReflow(source, { barsPerLine: 2 });
    assert.equal(
        byTwo.next,
        [
            "N(唱): 1 2 3 4 | 5 6 7 1' |",
            "L: 春眠不觉",
            "",
            "N: 2' 1' 7 6 |",
            "L: 处处闻啼",
        ].join("\n"),
    );

    // Split at every 6 beats isn't possible (bars are 4 beats), but re-splitting back to 1 bar/line omits the silent middle L:
    const backToOne = runReflow(byTwo.next, { barsPerLine: 1 });
    assert.equal(backToOne.next, source);

    // Bare intro + N:/L: verse pulls together and pads the intro's lyric slots with @
    const mixed = "1 2 | 3 4 |\n\nN(唱): 5 6 | 7 1' |\nL: 啦啦啪啪";
    const mixedByThree = runReflow(mixed, { barsPerLine: 3 });
    assert.equal(
        mixedByThree.next,
        [
            "N(唱): 1 2 | 3 4 | 5 6 |",
            "L: @ @ @ @ 啦啦",
            "",
            "N: 7 1' |",
            "L: 啪啪",
        ].join("\n"),
    );
});

test("cross-line lyric markdown toggles and melisma spans split without corrupting styles or alignment", () => {
    const styled = [
        "N: 1 2 | 3 4 | 5 6 |",
        "L: *春眠**不觉晓，*",
    ].join("\n");
    const splitStyled = runReflow(styled, { barsPerLine: 1 });
    assert.equal(
        splitStyled.next,
        [
            "N: 1 2 |",
            "L: *春眠*",
            "",
            "N: 3 4 |",
            "L: ***不觉***",
            "",
            "N: 5 6 |",
            "L: ***晓，***",
        ].join("\n"),
    );

    const melisma = [
        "N: 1 2 | 3 4 |",
        "L: {啊@@@}",
    ].join("\n");
    const splitMelisma = runReflow(melisma, { barsPerLine: 1 });
    assert.equal(
        splitMelisma.next,
        [
            "N: 1 2 |",
            "L: {啊@}",
            "",
            "N: 3 4 |",
        ].join("\n"),
    );
});

test("automatic page-width DP breaks long lines and respects unbreakable beams and selection ranges", () => {
    const eightBars = Array.from({ length: 8 }, (_, i) => `1/ 2/ 3/ 4/ 5/ 6/ 7/ ${(i % 7) + 1}'/`).join(" | ") + " |";
    const narrow = `@page(width=420px, left=20px, right=20px)\n${eightBars}`;
    const autoBroken = runReflow(narrow);
    assert.ok(autoBroken.nextCompiled.layout.lineCount >= 3, "narrow page should split 8 dense bars into >= 3 lines");
    assert.deepEqual(runReflow(autoBroken.next).edits, [], "auto-width DP reflow must be idempotent");

    // Manual @beam across a barline must never be broken at that barline
    const beamed = "1/@a 2/ 3/ 4/@b | 5/@c 6/ 7/ 1'/ | @beam(b, c)";
    const beamedResult = runReflow(beamed, { barsPerLine: 1 });
    assert.equal(beamedResult.nextCompiled.layout.lineCount, 1);

    // Selection range only reflows intersecting systems
    const twoSections = [
        "1 2 | 3 4 |",
        "% === 第二段 ===",
        "5 6 | 7 1' |",
    ].join("\n\n");
    const secondStart = twoSections.indexOf("5 6");
    const scoped = runReflow(twoSections, {
        barsPerLine: 1,
        ranges: [{ start: secondStart, end: twoSections.length }],
    });
    assert.ok(scoped.next.startsWith("1 2 | 3 4 |\n\n% === 第二段 ==="));
    assert.ok(scoped.next.endsWith("5 6 |\n\n7 1' |"));
});

test("ScoreEditAction reflow-lines maps active target selection cleanly", () => {
    const source = "1 2 3 4 | 5 6 7 1' |";
    const compiled = compileScore(source);
    const index = createScoreEditIndex(source, compiled);
    const fifthNote = index.streamTargets.find(t => t.kind === "note" && t.pitch === "5");
    assert.ok(fifthNote);
    const res = applyScoreEditAction(source, compiled, index, fifthNote, {
        type: "reflow-lines",
        barsPerLine: 1,
    });
    const next = applySourceEditsToText(source, res.edits);
    assert.equal(next, "1 2 3 4 |\n\n5 6 7 1' |");
    assert.equal(next.slice(res.nextSpan.start, res.nextSpan.end), "5");

    // Relocating a selected relation target (@tie) and a target across collapsed track indices
    const relSource = "1@a 2@b 3 4 | 5 6 7 1' | @tie(a, b)";
    const relCompiled = compileScore(relSource);
    const relIndex = createScoreEditIndex(relSource, relCompiled);
    const tieTarget = relIndex.targets.find(t => t.kind === "relation");
    const relRes = applyScoreEditAction(relSource, relCompiled, relIndex, tieTarget, { type: "reflow-lines", barsPerLine: 1 });
    const relNext = applySourceEditsToText(relSource, relRes.edits);
    assert.equal(relNext.slice(relRes.nextSpan.start, relRes.nextSpan.end), "@tie(a, b)");

    const collapseSource = "1 2 |\n\n@voices(@voice({3 4 |}))";
    const collapseCompiled = compileScore(collapseSource);
    const collapseIndex = createScoreEditIndex(collapseSource, collapseCompiled);
    const note3 = collapseIndex.streamTargets.find(t => t.kind === "note" && t.pitch === "3");
    const collapseRes = applyScoreEditAction(collapseSource, collapseCompiled, collapseIndex, note3, { type: "reflow-lines", barsPerLine: 2 });
    const collapseNext = applySourceEditsToText(collapseSource, collapseRes.edits);
    assert.equal(collapseNext.slice(collapseRes.nextSpan.start, collapseRes.nextSpan.end), "3");
});

test("sequential explicit @voices followed by V[]: without blank line stays sequential after sugar conversion and is CRLF-idempotent", () => {
    const lfSource = [
        '@voices(@voice({1 2 3 4}, 第一轨, 歌词="do re mi fa"), @voice({5 6 7 8}, , "无名歌词"), connect="{1-2}")',
        "V[]:",
        "N(语法糖): 1/ 1/ 5/ 5/ 6/ 6/ 5",
        "L(歌词): 一闪一闪亮晶晶，",
        "N: 5/ 5/ 4/ 4/ 3/ 3/ 2",
        "L: 满天都是小星星。",
    ].join("\r\n");

    const first = runReflow(lfSource);
    assert.deepEqual(playbackSignature(first.nextCompiled.lowering), playbackSignature(first.compiled.lowering));
    const second = runReflow(first.next);
    assert.deepEqual(second.edits, []);
});

test("single-node @voice content, chord @tie(), $symbol @label spacing, and named/shadowed relations all preserve semantics", () => {
    // 1. Unwrapped single-node @voice arguments (NoteFunction, RestFunction, DivFunction)
    assert.equal(runReflow('@voice(1, Solo, "ah")').next, "N(Solo): 1\nL: ah");
    assert.equal(runReflow("@meter(4, 4)\n@voice(@rest(1), Solo)").next, "@meter(4, 4)\nN(Solo): @rest(1)");
    assert.equal(runReflow('@voice({1 2 3 4}/, Solo, "a b c d")').next, "N(Solo): {1 2 3 4}/\nL: a b c d");

    // 2. Implicit @tie() on wrapped and explicit chords without overlapping SourceEdits
    for (const chordSrc of ["{1^3}/ {1^3}/ @tie() |", "@up(1, 3) @up(1, 3) @tie() |", "1 ^ 3 1 ^ 3 @tie() |"]) {
        const res = runReflow(chordSrc, { barsPerLine: 1 });
        assert.deepEqual(playbackSignature(res.nextCompiled.lowering), playbackSignature(res.compiled.lowering));
    }

    // 3. Space preserved between greedy $symbol and trailing @label
    const symLabel = runReflow("5 ^ $tr @a 6@b | @tie(a, b)", { barsPerLine: 1 });
    assert.deepEqual(playbackSignature(symLabel.nextCompiled.lowering), playbackSignature(symLabel.compiled.lowering));

    // 4. Named relation args (@dyn(from=a, to=b, dv=24)) + multi-line trailing relations
    const namedDyn = runReflow("N: 1 ^ $p 2 3 4 | 5@a 6 7 1'@b |\n@dyn(from=a, to=b, dv=24)\n@ottava(a, b, 1)", { barsPerLine: 1 });
    assert.deepEqual(playbackSignature(namedDyn.nextCompiled.lowering), playbackSignature(namedDyn.compiled.lowering));

    // 5. Shadowed/duplicate @label declarations across split and merge do not rebind relations
    const shadowedSplit = runReflow("1@a 2@b @ottava(a, b, 1) | 3@a 4@b @ottava(a, b, 1) |", { barsPerLine: 1 });
    assert.deepEqual(playbackSignature(shadowedSplit.nextCompiled.lowering), playbackSignature(shadowedSplit.compiled.lowering));

    const shadowedMerge = runReflow("1@a 1@b @tie(a, b) |\n\n3@a 3@b @tie(a, b) |", { barsPerLine: 2 });
    assert.equal(shadowedMerge.nextCompiled.layout.lineCount, 1);
    assert.deepEqual(playbackSignature(shadowedMerge.nextCompiled.lowering), playbackSignature(shadowedMerge.compiled.lowering));
});

test("lyric escapes, backslashes, multiline strings, quotes, % headers, @ inside markdown, and punctuation slots round-trip safely", () => {
    // 1. Trailing \\ in L:, % in voice/group names, multiline lyrics, escaped quotes, mixed quotes
    const backslashMerge = runReflow("N: 1 2 |\nL: a \\\\\n\nN: 3 4 |\nL: c d", { barsPerLine: 2 });
    assert.equal(backslashMerge.nextCompiled.voices?.[0] ?? backslashMerge.nextCompiled.layout.lineCount, 1);

    const percentHeader = runReflow('@voice({1 2 3 4 | 5 6 7 1\' |}, "100% Solo", "50% \\"off\\" a b c d e f")', { barsPerLine: 1 });
    assert.deepEqual(
        percentHeader.nextCompiled.ast.content[0].name,
        "100% Solo",
    );

    const multilineLyric = runReflow('@voice({1 2 | 3 4 |}, S, "do re\nmi fa")', { barsPerLine: 2 });
    assert.equal(multilineLyric.nextCompiled.ast.content[0].lyrics[0].tokens.length, 4);

    const mixedQuotes = runReflow('N: 1 2 |\nL: a "b"\n\nN: 3 4 |\nL: "c d"', { barsPerLine: 2 });
    assert.equal(mixedQuotes.nextCompiled.ast.content[0].lyrics[0].tokens.length, 4);

    // 2. Markdown toggles across empty @ slots + clamped melisma + standalone punctuation slots
    for (const src of [
        "N: 1 2 | 3 4 |\nL: *@ a b c*",
        "N: 1 | 2 3 |\nL: *a @* b",
    ]) {
        const res = runReflow(src, { barsPerLine: 1 });
        const mergedBack = runReflow(res.next, { barsPerLine: 2 });
        assert.deepEqual(mergedBack.nextCompiled.ast.content[0].lyrics[0].tokens, res.compiled.ast.content[0].lyrics[0].tokens);
    }

    const overlongMelisma = runReflow("N: 1 2 |\nL: {a@@@}\n\nN: 3 4 |\nL: b c", { barsPerLine: 2 });
    assert.equal(overlongMelisma.nextCompiled.ast.content[0].lyrics[0].tokens.length, 4);

    const punctSlots = runReflow("N: 1 |\nL: a\n\nN: 2 |\nL: ...\n\nN: 3 |\nL: b", { barsPerLine: 3 });
    assert.equal(punctSlots.nextCompiled.ast.content[0].lyrics[0].tokens.length, 3);
});

test("distinct named sections, silent named lyric rows, custom gap, local @set, JE octave scopes, and leading |: stay intact", () => {
    // 1. Sequential named @voice sections never lose section B's name on repeated reflow
    const twoVoices = '@page(width=300px, left=20px, right=20px)\n@voice({1 2 | 3 4 |}, A)\n@voice({1 2 | 3 4 |}, B, "{aaaaaaaaaaaaaaaaaaaaaaaaaaaa} @ {bbbbbbbbbbbbbbbbbbbbbbbbbbbb} @")';
    const pass1 = runReflow(twoVoices);
    const pass2 = runReflow(pass1.next);
    assert.deepEqual(pass2.edits, []);
    assert.ok(pass1.next.includes("N(B):"));

    // 2. Silent first bar on a named lyric row preserves L(1.): @ and keeps L(2.): on row 1
    const twoVerses = runReflow("N: 1 2 3 4 | 5 6 7 1' |\nL(1.): @ @ @ @ a b c d\nL(2.): e f g h i j k l", { barsPerLine: 1 });
    assert.ok(twoVerses.next.includes("L(1.): @\nL(2.): e f g h"));

    // 3. Explicit @voices(gap=...) and @voice({@set(tie.height=...) ...}) are preserved without losing layout options
    const customGap = '@voices(@voice({1 2 | 3 4 |}), @voice({5 6 | 7 1\' |}), gap=2em, minGap=1em)';
    assert.deepEqual(runReflow(customGap, { barsPerLine: 1 }).edits, []);

    const scopedSet = "@voice({@set(tie.height=2em) 1@a 2@b @tie(a, b) | 3 4 |})";
    assert.deepEqual(runReflow(scopedSet, { barsPerLine: 1 }).edits, []);

    // 4. JE octave scopes across barlines auto-close and reopen instead of blocking line breaks or merges
    const jeAcrossBar = runReflow("N: 1 ^ [2 3 4 | 5 6 7 1] |", { barsPerLine: 1 });
    assert.equal(jeAcrossBar.nextCompiled.layout.lineCount, 2);
    assert.equal(jeAcrossBar.next, "N: 1 ^ [2 3 4 | ]\n\nN: [ 5 6 7 1 ] |");
    assert.deepEqual(playbackSignature(jeAcrossBar.nextCompiled.lowering), playbackSignature(jeAcrossBar.compiled.lowering));
    assert.deepEqual(runReflow(jeAcrossBar.next, { barsPerLine: 1 }).edits, []);

    // Unclosed JE bracket at end of N: auto-closes when concatenated with a following N:
    const jeUnclosedMerge = runReflow("N: ( 1 2 3 4 |\n\nN: 5 6 7 1 |", { barsPerLine: 2 });
    assert.equal(jeUnclosedMerge.nextCompiled.layout.lineCount, 1);
    assert.equal(jeUnclosedMerge.next, "N: ( 1 2 3 4 | ) 5 6 7 1 |");
    assert.deepEqual(playbackSignature(jeUnclosedMerge.nextCompiled.lowering), playbackSignature(jeUnclosedMerge.compiled.lowering));

    // Nested multi-octave JE brackets (e.g. [[ ... ]]) split and merge losslessly
    const jeDouble = runReflow("N: [[ 1 2 | 3 4 ]] |", { barsPerLine: 1 });
    assert.equal(jeDouble.next, "N: [[ 1 2 | ]]\n\nN: [[ 3 4 ]] |");
    assert.deepEqual(playbackSignature(jeDouble.nextCompiled.lowering), playbackSignature(jeDouble.compiled.lowering));

    const jeMultiline = runReflow("@voice({ 1 ^ (\n3) 2 | 4 5 | }, S)", { barsPerLine: 1 });
    assert.equal(jeMultiline.nextCompiled.layout.lineCount, 2);
    assert.deepEqual(playbackSignature(jeMultiline.nextCompiled.lowering), playbackSignature(jeMultiline.compiled.lowering));

    // 5. Leading @key/@meter before |: at t=0 does not create a musicless line or off-by-one bar count
    const leadingRepeat = runReflow("@1(C) @meter(4, 4) |: 1 2 3 4 | 5 6 7 1' :|", { barsPerLine: 2 });
    assert.equal(leadingRepeat.nextCompiled.layout.lineCount, 1);

    // 6. Strict-mode sequential @voice blocks with different meters stay sequential in draft measurement
    const strictSeq = "@set(strict=true)\n@voice({@meter(4, 4) 1 2 3 4 | 5 6 7 1' |}, A)\n@voice({@meter(3, 4) 1 2 3 | 4 5 6 |}, B)";
    const strictRes = runReflow(strictSeq);
    assert.deepEqual(playbackSignature(strictRes.nextCompiled.lowering), playbackSignature(strictRes.compiled.lowering));

    // 7. Trailing comment after N: before sequential @voice does not merge @voice into parallel track
    const commentBeforeVoice = runReflow("N(A): 1 2 % c1\nN(A2): 3 4 % c2\n@voice({5 6 |}, B)");
    assert.deepEqual(playbackSignature(commentBeforeVoice.nextCompiled.lowering), playbackSignature(commentBeforeVoice.compiled.lowering));

    // 8. Partial selection on a multi-bar system still normalizes unlabeled @tie() in the rest of that system
    const partialSelSource = "1 2 3 4 | 5 5 @tie() 6 7 |";
    const partialSel = runReflow(partialSelSource, { barsPerLine: 1, ranges: [{ start: 0, end: 5 }] });
    assert.deepEqual(playbackSignature(partialSel.nextCompiled.lowering), playbackSignature(partialSel.compiled.lowering));
});


