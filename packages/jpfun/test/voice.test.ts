import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";

import { compileScore } from "../src/pipeline.js";
import { ASTNodeBase } from "../src/functions/ASTtypes.js";
import { quote, removeQuote } from "../src/parser/parse-utils/string-utils.js";
import { assert, attachmentCommands, commandsOfKind, expectSnapshot, layoutContext, layoutOf, nearly, parse, recordCommands } from "./helpers.js";

const axisOf = (object: { box: { y: number; visualAxis: number } }) => object.box.y + object.box.visualAxis;
/** 无名声部的名称占位盒只为括线预留横向空间，高度为 0；纵向断言只关心真正可见的对象 */
const drawn = (source: string) => layoutOf(source).objects.filter(object => object.box.h > 0);

test("voice serialization roundtrips names, lyric slots and nested LF/tab", () => {
    const lyric = String.raw`{你好} {hello world} @ \@ {你\}好} {\{brace\}} {back\\slash} {hel\-lo} {"quoted",word} @`;
    const multiline = "{line\n\tbreak} {tab\tinside} {back\\\\slash\nline} @";
    const tokens = ["line\n\tbreak", "tab\tinside", "back\\slash\nline", ""];
    const cases: [string, string, { name: string; tokens: string[] }[]][] = [
        ["", "", []],
        ['Lead "quoted", \\', "", []],
        ['Lead "quoted", {name} \\ @ -', `, ${quote(lyric)}, "", row="{named row}", other="@"`, [
            { name: "", tokens: ["你好", "hello world", "", "@", "你}好", "{brace}", "back\\slash", "hel-lo", '"quoted",word', ""] },
            { name: "", tokens: [] },
            { name: "row", tokens: ["named row"] },
            { name: "other", tokens: [""] },
        ]],
        ['Lead\\name\n\t"quoted"\n', `, ${quote(multiline)}, row=${quote(multiline)}`, [
            { name: "", tokens }, { name: "row", tokens },
        ]],
    ];
    for (const [name, args, lyrics] of cases) {
        strictEqual(removeQuote(quote(name)), name);
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
        const result = layoutOf(`@voice({1 2 3 4 5 6 7 1 2 3 4 5}, , ${JSON.stringify(text)})`);
        const actual = attachmentCommands(result.attachments[0])
            .filter(command => command.kind === "text")
            .map(command => command.text);
        assert(JSON.stringify(actual) === JSON.stringify(expected),
            `${text}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

    const lyrics = voiceResult.attachments[0];
    const lastVoiceNote = voiceResult.objects[3];
    assert(lyrics.box.y > lastVoiceNote.box.y, "lyrics must be placed below the note row");
    assert(lyrics.box.h > voiceResult.objects[0].ast.size * 1.5, "two lyric rows must reserve more than one text line");
    assert(voiceResult.bounds.y + voiceResult.bounds.h >= lyrics.box.y + lyrics.box.h, "document bounds must include all lyrics");

    expectSnapshot("voice-lyrics",
        `objects=${voiceResult.objects.length} lyricHeight=${lyrics.box.h.toFixed(2)}`
        + ` totalHeight=${voiceResult.bounds.h.toFixed(2)}`);
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
    assert(crossLineLyrics.box.y > crossLineVoiceResult.objects[0].box.y, "cross-line lyrics must remain below their first note row");
    assert(crossLineLyrics.box.y + crossLineLyrics.box.h > crossLineVoiceResult.objects[3].box.y + crossLineVoiceResult.objects[3].box.h,
        "lyric bounds must include the final system tokens");

    expectSnapshot("voice-cross-line", `lyricBaselines=${[...lyricBaselines].join(",")}`);
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

    expectSnapshot("voice-vertical",
        `hostAxis=${axisOf(twoVoices[0]).toFixed(2)}`
        + ` voices=${axisOf(twoVoices[1]).toFixed(2)}/${axisOf(twoVoices[2]).toFixed(2)}`);
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

test("空声部保留一个默认高度的槽位并参与居中", () => {
    const emptyVoice = drawn(`1 @voices(@voice({}), @voice({3})) 4`);
    assert(axisOf(emptyVoice[1]) > axisOf(emptyVoice[0]),
        "an empty first voice must still occupy a slot and push the remaining voice below the host axis");
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
    const bracket = bracketed.attachments.find(item => item.layer === "background");
    assert(bracket !== undefined && bracket.box.h > 0, "a multi-voice block must draw one bracket");
    const bracketVoices = bracketed.objects.filter(object => !object.T.isZero());
    assert(bracket.box.y < axisOf(bracketVoices[0]) && bracket.box.y + bracket.box.h > axisOf(bracketVoices[2]),
        "the bracket must span from the first voice to the last voice");
    const bracketName = bracketed.objects.find(object => object.T.isZero());
    assert(bracketName !== undefined
        && bracket.box.x > bracketName.box.x + bracketName.box.anchor
        && bracket.box.x + bracket.box.w < bracketVoices[0].box.x,
        "the bracket must sit between the voice names and the notes");
    assert(layoutOf(`@voices(@voice({1}, 上))`).attachments.every(item => item.box.h === 0),
        "a single-voice block must not draw a bracket");
});
