import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";

import { compileScore } from "../src/pipeline.js";
import { pathBounds } from "../src/layout/path.js";
import { ASTFunctionNode, ASTNodeBase } from "../src/functions/ASTtypes.js";
import { parseConnections } from "../src/functions/voice/connections.js";
import { parseString, quote } from "../src/parser/parse-utils/string-utils.js";
import { assert, attachmentCommands, commandsOfKind, compileValid, expectCompileError, expectDiagnostic, layoutContext, layoutOf, nearly, parse, recordCommands } from "./helpers.js";

const axisOf = (object: { box: { y: number; visualAxis: number } }) => object.box.y + object.box.visualAxis;
/** 无名声部的名称占位盒只为括线预留横向空间，高度为 0；纵向断言只关心真正可见的对象 */
const drawn = (source: string) => layoutOf(source).objects.filter(object => object.box.h > 0);

test("nested voices collect only their direct name hosts", () => {
    for (const source of [
        "@voices(@voice({1}), @voice({@voices(@voice({2}))}))",
        "@voices(@voice({1}, A), @voice({@voices(@voice({2}, B), @voice({3}, C))}, D))",
    ]) {
        const result = compileScore(source);
        assert(result.diagnostics.length === 0, "nested voices must compile without diagnostics");
        assert(result.layout.attachments.every(attachment => attachment.regions.every(region => Number.isFinite(region.y))),
            "nested braces must have finite geometry");
    }
});

test("lyrics preserve supplementary Unicode characters as single slots", () => {
    const word = "\u{20bb7}\u91ce";
    const result = layoutOf(`@voice({1 2}, , ${quote(word)})`);
    const lyrics = attachmentCommands(result.attachments[0]).filter(command => command.kind === "text");
    deepStrictEqual(lyrics.map(command => command.text), [...word]);
});

test("quoted voice names and lyrics share Unicode escapes across explicit calls and sugar", () => {
    for (const source of [
        String.raw`@voice({1 2}, "\u004Cead", row="\uD842\uDFB7\u91CE")`,
        String.raw`N("\u004Cead"): 1 2` + "\n" + String.raw`L("\u0072ow"): "\uD842\uDFB7\u91CE"`,
    ]) {
        const node = compileValid(source).ast.content[0];
        assert("name" in node && node.name === "Lead" && "lyrics" in node, "voice name must decode");
        deepStrictEqual(node.lyrics, [{ name: "row", tokens: [[{ text: "\uD842\uDFB7", mask: 0 }], [{ text: "野", mask: 0 }]] }]);
    }
});

test("voice serialization roundtrips names, lyric slots and nested LF/tab", () => {
    const plainTokens = (items: string[]) => items.map(text => text ? [{ text, mask: 0 }] : []);
    const lyric = String.raw`{你好} {hello world} @ \@ {你\}好} {\{brace\}} {back\\slash} {hel\-lo} {"quoted",word} @`;
    const multiline = "{line\n\tbreak} {tab\tinside} {back\\\\slash\nline} @";
    const tokens = plainTokens(["line\n\tbreak", "tab\tinside", "back\\slash\nline", ""]);
    const cases: [string, string, { name: string; tokens: { text: string; mask: number }[][] }[]][] = [
        ["", "", []],
        ['Lead "quoted", \\', "", []],
        ['Lead "quoted", {name} \\ @ -', `, ${quote(lyric)}, "", row="{named row}", other="@"`, [
            { name: "", tokens: plainTokens(["你好", "hello world", "", "@", "你}好", "{brace}", "back\\slash", "hel-lo", '"quoted",word', ""]) },
            { name: "", tokens: [] },
            { name: "row", tokens: plainTokens(["named row"]) },
            { name: "other", tokens: plainTokens([""]) },
        ]],
        ['Lead\\name\n\t"quoted"\n', `, ${quote(multiline)}, row=${quote(multiline)}`, [
            { name: "", tokens }, { name: "row", tokens },
        ]],
    ];
    for (const [name, args, lyrics] of cases) {
        strictEqual(parseString(quote(name)), name);
        const voice = `@voice({1 2}, ${quote(name)}${args})`;
        const check = (node: ASTNodeBase): number => {
            if ("name" in node && node.name === name && "lyrics" in node) {
                deepStrictEqual(node.lyrics, lyrics);
                return 1;
            }
            return (node.children ?? []).reduce((count, child) => count + check(child), 0);
        };
        const sources = name.includes("\n")
            ? [voice, `@voices(${voice})`, `@voices(@voice({@voices(${voice})}))`] : [voice];
        for (const source of sources) {
            const original = parse(source).content[0];
            const serialized = original.toString(source);
            const restored = parse(serialized).content[0];
            strictEqual(check(original), 1);
            strictEqual(check(restored), 1);
            strictEqual(restored.toString(serialized), serialized);
        }
    }
});

test("voice font preserves positional lyrics and reaches row labels", () => {
    const result = layoutOf('@set(font="Voice Font") @voice({1 2}, Lead, "hello world", "one two", Row="la la", font="three four")');
    const texts = recordCommands(result)
        .filter(command => command.kind === "text").filter(command =>
        ["Lead", "row", "hello", "world", "la", "one", "two", "font", "three", "four"].includes(command.text));
    assert(texts.some(command => command.text === "hello"), "first positional lyric must remain a lyric");
    assert(texts.length === 11, "all four lyric rows and their names must be preserved");
    assert(texts.every(command => command.style.fontFamily === "Voice Font"), "all voice text must use its frozen font");
});

test("歌词标点附着正文，不单独消耗音符槽", () => {
    const cases: [string, string[]][] = [
        ["你好，世界！", ["你", "好，", "世", "界！"]],
        ["“你好！”", ["“你", "好！”"]],
        ["（你）【好】", ["（你）", "【好】"]],
        ["你……好？！", ["你……", "好？！"]],
        ["{你好，}啊", ["你好，", "啊"]],
        ["“{你好}！”", ["“你好！”"]],
        ["hello, world!", ["hello,", "world!"]],
        ["don't stop", ["don't", "stop"]],
        ["hel-lo 你 @ 好", ["hel-", "lo", "你", "好"]],
        ["你， @ “好”", ["你，", "“好”"]],
        [String.raw`hel\-lo \@ {你\}好}`, ["hel-lo", "@", "你}好"]],
    ];
    for (const [text, expected] of cases) {
        for (const source of [
            `@voice({1 2 3 4 5 6 7 1 2 3 4 5}, , "${text}")`,
            `N: 1 2 3 4 5 6 7 1 2 3 4 5\nL: ${text}`,
        ]) {
            const result = layoutOf(source);
            const actual = attachmentCommands(result.attachments[0])
                .filter(command => command.kind === "text")
                .map(command => command.text);
            assert(JSON.stringify(actual) === JSON.stringify(expected),
                `${source}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
    }
});

test("歌词首尾标点悬挂，不改变正文中心和音符间距", () => {
    const cases: [string, string, string[]][] = [
        ["你好世界", "你好，世界！", ["", "", "", ""]],
        ["你好", "“你”“好！”", ["“", "“"]],
        ["你好", "（你）【好】", ["（", "【"]],
        ["{你好}世界", "“{你好，}”世界……", ["“", "", ""]],
        ["internationalization characterization", "internationalization, characterization!", ["", ""]],
        ["don't stop", "don't stop!", ["", ""]],
        ["{你，好}啊", "“{你，好}！”啊", ["“", ""]],
    ];
    for (const [plain, punctuated, prefixes] of cases) {
        for (const notes of ["1 2 3 4", "1 @br() 2 3 4"]) {
            const baseline = layoutOf(`@voice({${notes}}, , ${JSON.stringify(plain)})`);
            const result = layoutOf(`@voice({${notes}}, , ${JSON.stringify(punctuated)})`);
            assert(result.objects.length === baseline.objects.length, "punctuation must not add notes");
            for (let index = 0; index < result.objects.length; index++) {
                assert(nearly(result.objects[index].box.x, baseline.objects[index].box.x),
                    `${punctuated}: punctuation must not move note ${index}`);
            }
            const plainRegions = baseline.attachments[0].regions;
            const regions = result.attachments[0].regions;
            const texts = attachmentCommands(result.attachments[0]).filter(command => command.kind === "text");
            assert(regions.length === plainRegions.length, "punctuation must not consume lyric slots");
            for (let index = 0; index < regions.length; index++) {
                const prefixWidth = prefixes[index]
                    ? layoutContext.textMeasurer.measureText(prefixes[index], texts[index].style).w : 0;
                assert(nearly(regions[index].x + prefixWidth, plainRegions[index].x),
                    `${punctuated}: lyric body ${index} must remain aligned`);
                assert(nearly(regions[index].w,
                    layoutContext.textMeasurer.measureText(texts[index].text, texts[index].style).w),
                    "drawing regions must include punctuation");
                assert(result.bounds.x <= regions[index].x + 1e-6
                    && result.bounds.x + result.bounds.w >= regions[index].x + regions[index].w - 1e-6,
                    "document bounds must include hanging punctuation");
            }
        }
    }
});

test("歌词分组内部标点保留间距，多行歌词按正文宽度避让", () => {
    const plain = layoutOf(`@voice({1 2}, , "{你好}啊")`);
    const internal = layoutOf(`@voice({1 2}, , "{你，好}啊")`);
    assert(internal.objects[1].box.x - internal.objects[0].box.x
        > plain.objects[1].box.x - plain.objects[0].box.x,
        "internal punctuation must still contribute to grouped lyric spacing");

    const baseline = layoutOf(`@voice({1 2}, , "{你好}啊", "internationalization characterization")`);
    const result = layoutOf(`@voice({1 2}, , "“{你好}！”啊", "internationalization, characterization!")`);
    assert(result.objects.every((object, index) => nearly(object.box.x, baseline.objects[index].box.x)),
        "multiple lyric rows must reserve only their widest body");
});

test("声部的名称不推进时间，歌词行归一个附件并计入文档边界", () => {
    const voiceResult = layoutOf(`@voice({1 2 3}, 主, 男="你 好 啊", 女="我 也 是")`);

    assert(voiceResult.objects.length === 4, "voice name and three notes must create four visible objects");
    assert(voiceResult.objects[0].T.isZero(), "voice name must not advance musical time");
    assert(voiceResult.attachments.length === 1, "all lyric rows must belong to one voice attachment");

    const regions = voiceResult.attachments[0].regions;
    const lastVoiceNote = voiceResult.objects[3];
    const top = Math.min(...regions.map(region => region.y));
    const bottom = Math.max(...regions.map(region => region.y + region.h));
    assert(top > lastVoiceNote.box.y, "lyrics must be placed below the note row");
    assert(bottom - top > voiceResult.objects[0].ast.size * 1.5, "two lyric rows must reserve more than one text line");
    assert(voiceResult.bounds.y + voiceResult.bounds.h >= bottom, "document bounds must include all lyrics");

});

test("歌词行共用基线且随声部字号缩放", () => {
    const lyricBaselines = commandsOfKind(`@voice({1/ 2 3}, , "一 二 三")`, "text")
        .filter(command => /[一二三]/.test(command.text))
        .map(command => command.y);
    assert(lyricBaselines.length === 3, "the lyric row must contain all three tokens");
    assert(lyricBaselines.every(y => nearly(y, lyricBaselines[0])), "all tokens in one lyric row must share a baseline");

    const scaledLyric = commandsOfKind(`@voice({1}, , "词")`, "text", 40)
        .find(command => command.text === "词");
    assert(scaledLyric !== undefined, "scaled voice must emit its lyric");
    assert(nearly(scaledLyric.style.fontSize, 32.8), "voice lyric size must use the voice parse-time font size");
});

test("长英文歌词把宽度折算到对应音符", () => {
    const result = layoutOf(`@voice({1/ 2/}, , "internationalization characterization")`);
    const regions = result.attachments[0].regions;

    assert(regions.length === 2, "both lyric tokens must produce regions");
    assert(regions[0].x + regions[0].w <= regions[1].x,
        "adjacent long lyric tokens must not overlap");
});

test("跨行歌词在每个含词的系统各用一条基线", () => {
    const crossLineVoiceResult = layoutOf(`@voice({1 2 @br() 3 4}, , "一 二 三 四")`);
    const crossLineLyrics = crossLineVoiceResult.attachments[0];
    const lyricBaselines = new Set(attachmentCommands(crossLineLyrics)
        .filter(command => command.kind === "text")
        .map(command => command.y.toFixed(6)));

    assert(lyricBaselines.size === 2, "voice lyrics must use one baseline in each system containing tokens");
    assert(crossLineLyrics.regions[0].y > crossLineVoiceResult.objects[0].box.y, "cross-line lyrics must remain below their first note row");
    const lastRegion = crossLineLyrics.regions.at(-1)!;
    assert(lastRegion.y + lastRegion.h > crossLineVoiceResult.objects[3].box.y + crossLineVoiceResult.objects[3].box.h,
        "lyric bounds must include the final system tokens");

});

test("stack 的分支各自占轨，同时刻音符共享横向对齐点", () => {
    const stacked = compileScore(`@stack({1 2}, {3 4})`, { rowGap: 12 });
    const [firstUpper, firstLower] = stacked.layout.objects;
    assert(stacked.layout.objects.length === 4, "two stack branches with two notes must create four visible objects");
    assert(firstUpper.track === stacked.lowering.rootTrack, "the first stack member must stay on the host track");
    assert(firstUpper.track !== firstLower.track, "later stack branches must use their own tracks");
    assert(nearly(firstUpper.box.x + firstUpper.box.anchor, firstLower.box.x + firstLower.box.anchor),
        "simultaneous stack notes must share one horizontal anchor");
    assert(firstLower.box.y < firstUpper.box.y, "later stack branches must be placed above the host track");
});

test("voices 块把首末声部基线的中点对齐到宿主轴", () => {
    const twoVoices = drawn(`1 @voices(@voice({2}), @voice({3})) 4`);
    assert(nearly((axisOf(twoVoices[1]) + axisOf(twoVoices[2])) / 2, axisOf(twoVoices[0])),
        "a voices block must center the first and last voice baselines on the host axis");
    assert(twoVoices[1].track !== twoVoices[0].track && twoVoices[2].track !== twoVoices[0].track,
        "no voice may reuse the host track");

    const threeVoices = drawn(`1 @voices(@voice({2}), @voice({3}), @voice({4})) 5`);
    assert(nearly((axisOf(threeVoices[1]) + axisOf(threeVoices[3])) / 2, axisOf(threeVoices[0])),
        "an odd voices block must still center on the first and last baselines");
    assert(nearly(axisOf(threeVoices[2]), axisOf(threeVoices[0])),
        "a symmetric three-voice block must put the middle voice on the host axis");

});

test("嵌套 stack 只撑开相邻基线，不移动 voices 的语义中心", () => {
    const nestedVoices = drawn(`1 @voices(@voice({2}), @voice({@stack({3},{9})}), @voice({4})) 5`);
    const [nestedHost, nestedFirst, nestedMiddle, nestedBranch, nestedLast] = nestedVoices;
    assert(nearly((axisOf(nestedFirst) + axisOf(nestedLast)) / 2, axisOf(nestedHost)),
        "a nested stack must not move the semantic center of its voices block");
    assert(axisOf(nestedBranch) < axisOf(nestedMiddle), "a stack nested in a voice must stay above that voice");
    assert(axisOf(nestedMiddle) - axisOf(nestedFirst) > axisOf(nestedLast) - axisOf(nestedMiddle),
        "a nested stack must widen the gap towards the previous voice");
});

test("声部内的普通连音线借用声部间距，超高外扩与 gap/minGap 参数按行生效", () => {
    const gapOf = (source: string) => {
        const notes = drawn(source);
        return notes[1].box.y - (notes[0].box.y + notes[0].box.h);
    };
    assert(nearly(gapOf(`@voices(@voice({1 2}), @voice({3@a 4@b @tie(a,b)}))`), 22 * 0.75),
        "an ordinary tie in the lower voice must not widen voice spacing");
    const tall = layoutOf(`@voices(@voice({1 2}), @voice({3@a 4@b @tie(a,b,height=30px)}))`);
    const upper = tall.objects.find(object => object.box.h > 0)!;
    const tie = tall.attachments.find(attachment => attachment.layer === "foreground")!.regions[0];
    assert(nearly(tie.y - (upper.box.y + upper.box.h), 22 * 0.35),
        "an oversized tie in the lower voice must keep minimum voice clearance");

    for (const [source, expected] of [
        [`@voices(@voice({1}), @voice({2}), gap=30px)`, 30],
        [`@set(voices.gap=28px)\nN: 1\nN: 2`, 28],
        [`@set(vs.gap=2em) @vs(@voice({1}), @voice({2}))`, 44],
        [`@voices(@voice({1}), @voice({3^4}), gap=20px, minGap=14px)`, 14],
        [`@set(voices.minGap=15px)\nN: 1\nN: 3^4`, 15],
    ] as const) {
        assert(nearly(gapOf(source), expected), `${source}: expected ${expected}`);
    }
    const configured = compileValid(`@set(voices.gap=32px, voices.minGap=12px)\nN: 1\nN: 2`);
    const serialized = configured.ast.toString("");
    deepStrictEqual(recordCommands(compileValid(serialized).layout), recordCommands(configured.layout));
    expectCompileError(`@voices(@voice({1}), @voice({2}), gap=-1px)`, "E_INVALID_VOICES_GAP");
    expectCompileError(`@voices(@voice({1}), @voice({2}), minGap=-1px)`, "E_INVALID_VOICES_GAP");

    // 同一宿主下同声部数的 voices 共用音轨；间距不一致时取较大值并报警
    for (const pair of [
        `{\n@set(voices.gap=2em)\nN: 1\nN: 2\n}{\n@set(voices.gap=20em)\nN: 3\nN: 4\n}`,
        `{\n@set(voices.gap=20em)\nN: 1\nN: 2\n}{\n@set(voices.gap=2em)\nN: 3\nN: 4\n}`,
    ]) {
        const sameLine = compileScore(pair);
        assert(sameLine.diagnostics.some(item => item.code === "W_VOICES_GAP_CONFLICT"), pair);
        const [u1, l1, u2, l2] = sameLine.layout.objects.filter(object => object.box.h > 0);
        assert(u1.track === u2.track && l1.track === l2.track
            && nearly(u1.box.y, u2.box.y) && nearly(l1.box.y, l2.box.y)
            && nearly(l1.box.y - (u1.box.y + u1.box.h), 440), pair);
    }
});

test("空声部保留一个默认高度的槽位并参与居中", () => {
    const emptyVoice = drawn(`1 @voices(@voice({}), @voice({3})) 4`);
    const namedEmpty = drawn(`1 @voices(@voice({}, A), @voice({3}, B)) 4`).filter(node => !node.T.isZero());
    assert(axisOf(emptyVoice[1]) > axisOf(emptyVoice[0])
        && nearly(axisOf(namedEmpty[1]), axisOf(emptyVoice[1])),
        "an empty first voice (with or without a name) must occupy a full default slot");
});

test("成员数相同的块共用音轨，不同的各自占轨", () => {
    const mixedArity = drawn(
        `1 @voices(@voice({2}), @voice({3})) 4 @voices(@voice({5}), @voice({6}), @voice({7})) 8`,
    );
    assert(nearly((axisOf(mixedArity[1]) + axisOf(mixedArity[2])) / 2, axisOf(mixedArity[0]))
        && nearly((axisOf(mixedArity[4]) + axisOf(mixedArity[6])) / 2, axisOf(mixedArity[0])),
        "voices blocks with different arities must each center on the host axis");
    assert(mixedArity[1].track !== mixedArity[4].track,
        "voices blocks with different arities must not share lanes");

    const sameArity = drawn(
        `1 @voices(@voice({2}), @voice({3})) 4 @voices(@voice({5}), @voice({6})) 7`,
    );
    assert(sameArity[1].track === sameArity[4].track && sameArity[2].track === sameArity[5].track,
        "voices blocks with the same arity must reuse the same lanes");
    assert(nearly(axisOf(sameArity[1]), axisOf(sameArity[4])), "reused lanes must keep one baseline per line");

    const twoStacks = drawn(`@stack({1},{2}) 3 @stack({4},{5})`);
    assert(twoStacks[1].track === twoStacks[4].track, "stacks on one host must reuse their branch lanes");
    assert(nearly(axisOf(twoStacks[1]), axisOf(twoStacks[4])), "reused stack lanes must share one baseline");
});

test("stack 与 voices 不串轨，分支始终在宿主整块之上", () => {
    const mixedTopology = compileScore(`@voices(@voice({1}), @voice({@stack({2},{3})}))`);
    const mixedTracks = new Set(
        mixedTopology.layout.objects.filter(object => object.box.h > 0).map(object => object.track),
    );
    assert(mixedTracks.size === 3 && !mixedTracks.has(mixedTopology.lowering.rootTrack),
        "voices(A, stack(B, C)) must create three content tracks plus an empty host track");

    const voicesAsStackHost = drawn(`@stack({@voices(@voice({1}), @voice({2}))}, {3})`);
    const voicesStackAnchors = voicesAsStackHost.map(object => object.box.x + object.box.anchor);
    assert(voicesStackAnchors.every(anchor => nearly(anchor, voicesStackAnchors[0])),
        "a stack branch must align with the first note column after a voices label column");
    const voicesStackBranch = voicesAsStackHost.reduce((latest, object) =>
        object.ast.sourceSpan.start > latest.ast.sourceSpan.start ? object : latest);
    const voicesStackHostTop = Math.min(...voicesAsStackHost
        .filter(object => object !== voicesStackBranch)
        .map(object => object.box.y));
    assert(voicesStackBranch.box.y + voicesStackBranch.box.h <= voicesStackHostTop,
        "a stack branch must stay above the complete voices host block");

    const completeStackHost = drawn(`1&2 3^4`);
    const completeStackBranch = completeStackHost.find(object => object.ast.sourceSpan.start === 2);
    assert(completeStackBranch !== undefined, "the stack branch must remain addressable by its source span");
    const completeStackHostTop = Math.min(...completeStackHost
        .filter(object => object !== completeStackBranch)
        .map(object => object.box.y));
    assert(completeStackBranch.box.y + completeStackBranch.box.h <= completeStackHostTop,
        "a stack branch must stay above the complete host track");
});

test("多声部括线画在声部名与音符之间，纵向跨足首末声部", () => {
    const bracketed = layoutOf(`@voices(@voice({1}, 上), @voice({2}, 中), @voice({3}, 下))`);
    const bracket = bracketed.attachments.find(item => item.layer === "background")?.regions[0];
    assert(bracket !== undefined && bracket.h > 0, "a multi-voice block must draw one bracket");
    const bracketVoices = bracketed.objects.filter(object => !object.T.isZero());
    assert(bracket.y < axisOf(bracketVoices[0]) && bracket.y + bracket.h > axisOf(bracketVoices[2]),
        "the bracket must span from the first voice to the last voice");
    const bracketName = bracketed.objects.find(object => object.T.isZero());
    assert(bracketName !== undefined
        && bracket.x > bracketName.box.x + bracketName.box.anchor
        && bracket.x + bracket.w < bracketVoices[0].box.x,
        "the bracket must sit between the voice names and the notes");
    assert(layoutOf(`@voices(@voice({1}, 上))`).attachments.length === 0,
        "a single-voice block without lyrics must not register empty attachments");
});

const fourVoices = '@voice({1 2}, A), @voice({3 4}, B), @voice({5 6}, C), @voice({7 1}, D)';
const connectionSpecsOf = (source: string) => parseConnections(source, { start: 0, end: source.length });

test("voice connections parse, validate, serialize and render partial braces", () => {
    for (const [connect, expanded] of [
        ["[3]", "[3-3]"],
        ["{1-2}[3]", "{1-2}[3-3]"],
    ]) {
        deepStrictEqual(connectionSpecsOf(connect), connectionSpecsOf(expanded));
        const result = compileValid(`@voices(${fourVoices}, connect=${quote(connect)})`);
        deepStrictEqual(recordCommands(result.layout),
            recordCommands(compileValid(`@voices(${fourVoices}, connect=${quote(expanded)})`).layout));
    }

    for (const connect of ["[]", "{}", "[0-2]", "[2-1]", "[1-5]", "{1.5-2}", "[1-2}", "[1-2]oops", "[1 2-3]"]) {
        expectDiagnostic(() => compileScore(`@voices(${fourVoices}, connect=${quote(connect)})`, {
            variables: { strict: true },
        }), "E_VOICES_CONNECT");
    }

    const emptyConn = layoutOf(`@voices(${fourVoices}, connect="")`);
    const emptyCmds = attachmentCommands(emptyConn.attachments.find(a => a.layer === "background")!);
    strictEqual(emptyCmds.length, 1);
    strictEqual(emptyCmds[0].kind, "rect");

    const members = Array.from({ length: 5 }, (_, i) => `@voice({${i + 1}}, Voice${i + 1})`).join(",");
    const partial = layoutOf(`@voices(${members}, connect="{2-4}")`, 22);
    const partialCmds = attachmentCommands(partial.attachments.find(a => a.layer === "background")!);
    const curves = partialCmds.filter(c => c.kind === "path");
    const notes = partial.objects.filter(o => !o.T.isZero());
    const curveBounds = pathBounds(curves[0].commands);
    assert(nearly(curveBounds.y, axisOf(notes[1]) - 11) && nearly(curveBounds.y + curveBounds.h, axisOf(notes[3]) + 11),
        "partial brace must span voices 2..4");
});

test("V declarations group simultaneous voices, handle inline/CRLF syntax and reject empty groups", () => {
    const source = "V{}:\nN(A): 1 2\nN(B): 3 4\nV[]:\nN(C): 5 6\nL: la la\nN(D): 7 1";
    const result = compileValid(source);
    strictEqual(result.ast.content[0].children!.length, 4);
    assert(result.lowering.duration.equals(2), "group markers must not sequence voice groups");
    const serialized = result.ast.content[0].toString(source);
    assert(serialized.includes('connect="{1-2}[3-4]"'), serialized);
    deepStrictEqual(recordCommands(compileValid(serialized).layout), recordCommands(result.layout));

    for (const [inline, expanded] of [
        ["1 V{}: N:2 N:3", '1 @voices(@voice(2), @voice(3), connect="{1-2}")'],
        ["V{}:N:1 N:2 V[]:N:3 N:4 V|:N:5",
            '@voices(@voice(1), @voice(2), @voice(3), @voice(4), @voice(5), connect="{1-2}[3-4]")'],
    ]) {
        const res = compileValid(inline, { variables: { strict: true } });
        deepStrictEqual(recordCommands(res.layout), recordCommands(compileValid(expanded).layout), inline);
    }

    const crlf = 'V{}:\r\nN:1\r\nL:"la"\r\nV[]:\r\nN:2\r\nN:3';
    deepStrictEqual(recordCommands(compileValid(crlf).layout),
        recordCommands(compileValid(crlf.replaceAll("\r\n", "\n")).layout));

    for (const empty of ["V{}:", "V{}:\n\nN: 1", "V{}:\nV[]:\nN: 1"]) {
        expectCompileError(empty, "E_VOICES_GROUP_EMPTY");
    }
    expectCompileError("N: 1\nV{}:\nL: la\nN: 2", "E_LYRICS_WITHOUT_VOICE_NOTES");
});

test("connect group names parse, validate and roundtrip with V sugar", () => {
    deepStrictEqual(connectionSpecsOf('{1-2:钢琴}[ 3 - 4 : Mixed Choir 1 ]{-:总谱}[2:"Solo: [I]"]'), [
        { kind: "brace", from: 1, to: 2, name: "钢琴" },
        { kind: "bracket", from: 3, to: 4, name: "Mixed Choir 1" },
        { kind: "brace", from: undefined, to: undefined, name: "总谱" },
        { kind: "bracket", from: 2, to: 2, name: "Solo: [I]" },
    ]);
    for (const invalid of [
        "{钢琴}", "{:钢琴}", "[合唱]", "[:合唱]", "{1-2:}", "{1-2:   }", '{1-2:""}',
        "{1-2:钢琴", "[1-2:钢琴}", "{1-2:a:b}", '{1-2:"unclosed}', '{1-2:"\\u12"}', "{1-2}钢琴",
    ]) {
        expectDiagnostic(() => compileScore(`@voices(${fourVoices}, connect=${quote(invalid)})`, {
            variables: { strict: true },
        }), "E_VOICES_CONNECT");
    }

    const sugarSource = 'V{钢琴}:\nN(右手): 1 2\nN(左手): 3 4\nV["Mixed: [I]"]:\nN(女高): 5 6\nN(女低): 7 1';
    const explicitSource = `@voices(@voice({1 2}, 右手), @voice({3 4}, 左手), @voice({5 6}, 女高), @voice({7 1}, 女低), connect=${quote('{1-2:钢琴}[3-4:"Mixed: [I]"]')})`;
    const sugarResult = compileValid(sugarSource, { variables: { strict: true } });
    const explicitResult = compileValid(explicitSource, { variables: { strict: true } });
    const serialized = sugarResult.ast.toString(sugarSource);
    assert(serialized.includes(`connect=${quote('{1-2:钢琴}[3-4:"Mixed: [I]"]')}`), serialized);
    deepStrictEqual(recordCommands(sugarResult.layout), recordCommands(explicitResult.layout));
    deepStrictEqual(recordCommands(compileValid(serialized).layout), recordCommands(sugarResult.layout));
});

test("connector group names center on their own connector and offset left of inner voice labels", () => {
    // 组内无声部名时，分组总名称紧贴大括号左侧；组内有声部名时向左错开
    const mixed = compileValid(`@set(font="Group Font") @voices(
        @voice({1 2}, 右手),
        @voice({3 4}, 左手),
        @voice({5 6}),
        @voice({7 1}),
        connect="{1-2:钢琴}[3-4:伴奏][-:总谱]"
    )`);
    const connector = mixed.layout.attachments.find(attachment => attachment.layer === "background")!;
    const connectorTexts = attachmentCommands(connector).filter(command => command.kind === "text");
    deepStrictEqual(connectorTexts.map(command => command.text), ["钢琴", "伴奏", "总谱"]);
    assert(connectorTexts.every(command => command.style.fontFamily === "Group Font"), "group names must use frozen voices font");

    const nameNodes = mixed.layout.objects.filter(object => object.T.isZero());
    const notes = mixed.layout.objects.filter(object => !object.T.isZero());
    const anchorX = nameNodes[0].box.x + nameNodes[0].box.anchor;
    const innerRight = Math.max(
        layoutContext.textMeasurer.measureText("右手", connectorTexts[0].style).w,
        layoutContext.textMeasurer.measureText("左手", connectorTexts[0].style).w,
    );
    const [piano, accomp, tutti] = connectorTexts;

    // "伴奏" 所在 3-4 声部无声部名，直接对齐到 anchorX；"钢琴" 与 "总谱" 包含有名称的 1-2 声部，向左错开 0.5em
    assert(nearly(accomp.x, anchorX), "group without inner voice names must align to the label anchor");
    assert(nearly(piano.x, anchorX - innerRight - 22 * 0.5), "group with inner voice names must sit left of those names");
    assert(nearly(tutti.x, piano.x), "overlapping group must offset only by its own inner voice names without extra avoidance");

    // Y 坐标各自取所属连接范围首末声部视觉轴的中点，重叠谱号不做纵向避让
    const expectedBaselineY = (firstIndex: number, lastIndex: number, text: string) => {
        const metrics = layoutContext.textMeasurer.measureText(text, piano.style);
        const centerY = (axisOf(notes[firstIndex]) + axisOf(notes[lastIndex])) / 2;
        return centerY - metrics.h / 2 + metrics.baseline;
    };
    assert(nearly(piano.y, expectedBaselineY(0, 1, "钢琴")), "piano label must center on voices 1-2");
    assert(nearly(accomp.y, expectedBaselineY(2, 3, "伴奏")), "accompaniment label must center on voices 3-4");
    assert(nearly(tutti.y, expectedBaselineY(0, 3, "总谱")), "overlapping tutti label must center on voices 1-4");

    // 文档边界与横向布局必须完整容纳最左侧分组总名称
    const pianoWidth = layoutContext.textMeasurer.measureText("钢琴", piano.style).w;
    const connectorLeft = Math.min(...connector.regions.map(region => region.x));
    assert(connectorLeft <= piano.x - pianoWidth + 1e-6, "connector bounds must include the leftmost group name");
    assert(mixed.layout.bounds.x <= connectorLeft + 1e-6 && connectorLeft >= 0,
        "horizontal layout must reserve left space so group names stay inside positive document bounds");

    // 同一行前序声部在上方轨道有长尾内容时，后续多声部块的所有轨道都必须预留分组总名称宽度，不能重叠
    const inline = layoutOf(`
        @voices(@voice({1 "这是一段非常非常长的行内文字"}), @voice({1 2}))
        @voices(@voice({3}, 右手, 男声="词"), @voice({4}, 左手), connect="{1-2:非常长的分组总名称}")
    `);
    const inlineText = inline.objects.find(object => object.ast instanceof ASTFunctionNode && object.ast.callName === "text")!;
    const secondBrace = inline.attachments.filter(attachment => attachment.layer === "background")[1]!;
    assert(Math.min(...secondBrace.regions.map(region => region.x)) >= inlineText.box.x + inlineText.box.w,
        "group name on the following voices block must not overlap trailing content on upper tracks");
});

test("歌词跨音符槽 Markdown 包裹、标点悬挂与往返序列化", () => {
    const source = `V{_合唱_}:\nN(女高): 1 2 3 4 5\nL(*领*): *春眠* **不觉** ^晓^\nN(**女低**): 1 2 3 4 5\nL: _hel-lo_ *你 @ ^好^*`;
    const compiled = compileValid(source);
    const serialized = compiled.ast.toString(source);
    const restored = compileValid(serialized);
    deepStrictEqual(recordCommands(restored.layout), recordCommands(compiled.layout),
        "lyrics and voice names with Markdown must roundtrip losslessly");

    // 槽内相邻不同掩码切换、有无双引号的转义规则与末尾反斜杠闭合花括号往返不失真
    const escapedCases = [
        String.raw`@voice({1 2 3 4 5}, , "hel\-lo \@ {你\}好} {\*字面\*} {a\\b}")`,
        String.raw`N: 1 2 3 4 5` + "\n" + String.raw`L: "hel\-lo \@ {你\}好} {\*字面\*} {a\\b}"`,
        String.raw`N: 1 2 3 4 5` + "\n" + String.raw`L: hel\-lo \@ {你\}好} {\*字面\*} {a\\b}`,
    ];
    for (const tricky of [
        `@voice({1 2}, , "*a_b_* c")`,
        `@voice({1 2}, , "a\\\\ b")`,
        `@voice({1 2}, , "{a\\\\\\\\} b")`,
        ...escapedCases,
    ]) {
        const orig = compileValid(tricky);
        const rt = compileValid(orig.ast.toString(tricky));
        deepStrictEqual(recordCommands(rt.layout), recordCommands(orig.layout), tricky);
    }
    for (const src of escapedCases) {
        const tokens = attachmentCommands(layoutOf(src).attachments[0])
            .filter(cmd => cmd.kind === "text")
            .map(cmd => cmd.text);
        deepStrictEqual(tokens, ["hel-lo", "@", "你}好", "*字面*", String.raw`a\b`], src);
    }

    const textCmds = recordCommands(compiled.layout).filter(cmd => cmd.kind === "text");
    const sopranoLabel = textCmds.find(cmd => cmd.text === "女高")!;
    const altoLabel = textCmds.find(cmd => cmd.text === "女低")!;
    const lyricRowLabel = textCmds.find(cmd => cmd.text === "领")!;
    assert(!sopranoLabel.style.fontWeight, "声部名默认不应加粗");
    strictEqual(altoLabel.style.fontWeight, "bold", "**包裹的声部名应加粗");
    strictEqual(lyricRowLabel.style.fontStyle, "italic", "*包裹的歌词行名应为斜体");
    assert(!lyricRowLabel.style.fontWeight, "歌词行名默认不应加粗");

    for (const ch of ["春", "眠", "你", "好"]) {
        const cmd = textCmds.find(t => t.text === ch)!;
        strictEqual(cmd.style.fontStyle, "italic", `${ch} 应继承跨音符槽斜体`);
    }
    for (const ch of ["不", "觉"]) {
        const cmd = textCmds.find(t => t.text === ch)!;
        strictEqual(cmd.style.fontWeight, "bold", `${ch} 应继承跨音符槽粗体`);
    }

    for (const src of [
        String.raw`V{\*}:` + "\nN:1\nN:2",
        String.raw`@voices(@voice({1}), @voice({2}), connect="{1-2:\*}")`,
    ]) {
        const res = compileValid(src);
        const label = recordCommands(res.layout).find(cmd => cmd.kind === "text" && cmd.text === "*");
        assert(label !== undefined, `${src}: escaped * in connector label must render as literal *`);
        const rt = res.ast.toString(src);
        assert(rt.includes(String.raw`connect="{1-2:\\*}"`), rt);
        deepStrictEqual(recordCommands(compileValid(rt).layout), recordCommands(res.layout));
    }

    // 富文本歌词与首尾静音标点悬挂组合时，不改变正文对齐中心与音符间距
    const plainLayout = layoutOf(`@voice({1 2}, , "你好")`);
    for (const lyric of [`"“*你好*！”"`, `"*“你好！”*"`, `"_**你好**！_"`]) {
        const richLayout = layoutOf(`@voice({1 2}, , ${lyric})`);
        for (let i = 0; i < plainLayout.objects.length; i++) {
            assert(nearly(richLayout.objects[i].box.x, plainLayout.objects[i].box.x),
                `${lyric}: note ${i} position must match plain lyric`);
        }
    }
});


