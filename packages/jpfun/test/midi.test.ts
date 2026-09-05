import test from "node:test";

import {
    compileScore,
    DEFAULT_PAGE_CONFIG,
    midiJsonToJpFun,
    type MidiJson,
    type MidiJsonNote,
} from "../src/index.js";
import { convertMidiJsonToJpFun } from "../src/converter/midi/convert.js";
import { compilePlayback } from "../src/playback/compile.js";
import { assert, lower, playedNotes } from "./helpers.js";

function midi(
    tracks: readonly (readonly MidiJsonNote[])[],
    options: {
        tick?: number;
        names?: readonly string[];
        tempos?: MidiJson["header"]["tempos"];
        timeSignatures?: MidiJson["header"]["timeSignatures"];
    } = {},
): MidiJson {
    return {
        header: {
            name: "",
            tick: options.tick ?? 480,
            tempos: options.tempos ?? [],
            timeSignatures: options.timeSignatures ?? [],
        },
        tracks: tracks.map((notes, index) => ({
            channel: index,
            name: options.names?.[index] ?? "",
            controlChanges: [],
            instruments: [],
            notes,
        })),
    };
}

function note(ticks: number, durationTicks: number, pitch: number, intensity = 100): MidiJsonNote {
    return { ticks, durationTicks, midi: pitch, intensity };
}

function naturalSystemWidths(source: string) {
    const layout = compileScore(`@page(width=1000000px, height=0px, top=0px, bottom=0px, left=0px, right=0px)\n${source}`).layout;
    return Array.from({ length: layout.lineCount - 1 }, (_, index) => {
        const objects = layout.objects.filter(node => node.layoutLine === index + 1 && node.box.w > 0);
        return Math.max(...objects.map(node => node.box.x + node.box.w))
            - Math.min(...objects.map(node => node.box.x));
    });
}

test("MIDI JSON 按音符时长自适应量化并生成无诊断的 jpFun", () => {
    const source = midiJsonToJpFun(midi([[
        note(61, 358, 60),
        note(480, 240, 64),
    ]]));
    const plan = compilePlayback(lower(source));
    const notes = playedNotes(plan);

    assert(plan.diagnostics.length === 0, `转换结果不应产生诊断：${source}`);
    assert(!source.includes("@head(")
        && source.includes("H.signature: 1=C4 4/4") && source.includes("H.tempo: 120"),
        `初始状态必须使用 head 语法糖：${source}`);
    assert(notes.length === 2, `应生成两个音符，实际为 ${notes.length}: ${source}`);
    assert(notes[0].midi === 60 && notes[0].start.equals(1, 8) && notes[0].duration.equals(3, 4),
        `首音应量化为 C4@1/8×3/4，实际源码为 ${source}`);
    assert(notes[1].midi === 64 && notes[1].start.equals(1) && notes[1].duration.equals(1, 2),
        `次音应保持 E4@1×1/2，实际源码为 ${source}`);
});

test("非连续二进制时值不会被错误合并为附点", () => {
    const source = midiJsonToJpFun(midi([[note(0, 300, 60)]]));
    const played = playedNotes(compilePlayback(lower(source)));
    assert(played.length === 1 && played[0].duration.equals(5, 8),
        `五个八分之一拍应保持 5/8，不得写成附点二分音符：${source}`);
});

test("等起止音符合成低音在下的 up，不等长重叠拆成 stack", () => {
    const chordSource = midiJsonToJpFun(midi([[
        note(0, 480, 67),
        note(0, 480, 60),
        note(0, 480, 64),
    ]]));
    assert(chordSource.includes("{C4 ^ E4 ^ G4}"),
        `和弦应按低到高生成：${chordSource}`);
    const chord = playedNotes(compilePlayback(lower(chordSource)));
    assert(chord.length === 3 && chord.every(item => item.start.equals(0) && item.duration.equals(1)),
        "up 的所有成员应同起同止");

    const overlapSource = midiJsonToJpFun(midi([[
        note(0, 960, 60),
        note(480, 960, 67),
    ]]));
    assert(overlapSource.includes("@stack("), `不等长重叠应拆成 stack：${overlapSource}`);
    const overlap = playedNotes(compilePlayback(lower(overlapSource)));
    const low = overlap.find(item => item.midi === 60);
    const high = overlap.find(item => item.midi === 67);
    assert(low?.start.equals(0) && low.duration.equals(2)
        && high?.start.equals(1) && high.duration.equals(2),
    `stack 应保留两个重叠区间：${overlapSource}`);
});

test("重叠区域结束后回到单线输出", () => {
    const source = midiJsonToJpFun(midi([[
        note(0, 1440, 60),
        note(480, 480, 72),
        note(1440, 480, 62),
    ]]), { barsPerLine: 4 });
    assert(source.includes("@stack({ C4 - - }, { 0 C5 0 }) D4 |"),
        `后续 D4 应离开已结束的重叠区域并回到单线：${source}`);
    const notes = playedNotes(compilePlayback(lower(source)));
    assert(notes.some(item => item.midi === 62 && item.start.equals(3) && item.duration.equals(1)),
        `局部 stack 不得改变 D4 的起止时间：${source}`);
});

test("普通片段之间只为重叠区间生成局部 stack", () => {
    const source = midiJsonToJpFun(midi([[
        note(0, 480, 60),
        note(480, 960, 62),
        note(960, 960, 67),
        note(1920, 480, 64),
    ]]), { barsPerLine: 4 });
    assert((source.match(/@stack\(/g) ?? []).length === 1
        && /N: \{ C4 @stack\([\s\S]*\) \| E4/.test(source),
    `只有 D4/G4 的传递重叠区间应使用 stack，前后音符保持单线：${source}`);
    const notes = playedNotes(compilePlayback(lower(source)));
    assert(notes.length === 4
        && notes.some(item => item.midi === 62 && item.start.equals(1) && item.duration.equals(2))
        && notes.some(item => item.midi === 67 && item.start.equals(2) && item.duration.equals(2)),
    `局部 stack 必须保持重叠音符的起止时间：${source}`);
});

test("钢琴双轨保持两个 N，手内重叠仅生成局部 stack", () => {
    const hand = (base: number) => [
        note(0, 480, base),
        note(480, 960, base + 2),
        note(960, 960, base + 7),
        note(1920, 480, base + 4),
    ];
    const source = midiJsonToJpFun(midi([hand(60), hand(48)], { names: ["RH", "LH"] }), { barsPerLine: 4 });
    assert((source.match(/^N/gm) ?? []).length === 2
        && (source.match(/@stack\(/g) ?? []).length === 2
        && source.includes('N("RH"):') && source.includes('N("LH"):'),
    `钢琴左右手应保持两个命名 N，每手只在重叠片段使用局部 stack：${source}`);
    assert(playedNotes(compilePlayback(lower(source))).length === 8,
        `钢琴局部 stack 不得丢失音符：${source}`);
});

test("局部 stack 边界恰逢换行时不产生空声部", () => {
    const source = midiJsonToJpFun(midi([[
        note(0, 1440, 60), note(480, 480, 67),
        note(1920, 1440, 62), note(2400, 480, 69),
    ]]), { barsPerLine: 1 });
    const systems = source.split("\n\n").slice(1);
    assert(systems.length === 2 && systems.every(system => (system.match(/^N:/gm) ?? []).length === 1)
        && systems.every(system => system.includes("@stack(")),
    `换行两侧的局部 stack 应各自留在一个非空 N 中：${source}`);
    assert(playedNotes(compilePlayback(lower(source))).length === 4,
        `region 边界换行不得改变播放音符：${source}`);
});

test("局部 stack 内跨小节持续音保持 tie 和时值", () => {
    const source = midiJsonToJpFun(midi([[
        note(0, 2880, 60),
        note(480, 960, 67),
    ]]), { barsPerLine: 2 });
    assert(source.includes("@stack(") && source.includes("@tie("),
        `局部 stack 内跨小节长音应重写并用 tie 连接：${source}`);
    const notes = playedNotes(compilePlayback(lower(source)));
    const sustained = notes.find(item => item.midi === 60);
    assert(sustained?.start.equals(0) && sustained.duration.equals(6),
        `局部 stack 内跨小节 tie 应保持六拍长音：${source}`);
});

test("同 tick 的不同长度音符共享量化起点", () => {
    const source = midiJsonToJpFun(midi([[
        note(61, 120, 60),
        note(61, 480, 64),
    ]]));
    const notes = playedNotes(compilePlayback(lower(source)));
    assert(notes.length === 2 && notes[0].start.equals(notes[1].start),
        `同 tick 音符不得因各自时值精度而错开：${source}`);
});

test("MIDI 八分三连音使用专用三分网格，普通十六分不误判", () => {
    const triplet = midiJsonToJpFun(midi([[
        note(0, 160, 60),
        note(160, 160, 62),
        note(320, 160, 64),
    ]]));
    const humanized = midiJsonToJpFun(midi([[
        note(3, 158, 60),
        note(158, 164, 62),
        note(323, 157, 64),
    ]]));
    const straight = midiJsonToJpFun(midi([[
        note(0, 120, 60),
        note(120, 120, 62),
        note(240, 120, 64),
    ]]));
    for (const source of [triplet, humanized]) {
        const notes = playedNotes(compilePlayback(lower(source)));
        assert(source.includes("@tuplet(")
            && notes.length === 3
            && notes[0].start.equals(0) && notes[0].duration.equals(1, 3)
            && notes[1].start.equals(1, 3) && notes[1].duration.equals(1, 3)
            && notes[2].start.equals(2, 3) && notes[2].duration.equals(1, 3),
        `八分三连音应精确落在一拍的三个三分槽：${source}`);
    }
    assert(!straight.includes("@tuplet("), `普通十六分音符不得误判为三连音：${straight}`);
});

test("MIDI 四分与十六分三连音保持各自书面时值", () => {
    const quarter = midiJsonToJpFun(midi([[
        note(0, 320, 60), note(320, 320, 62), note(640, 320, 64),
    ]]));
    const sixteenth = midiJsonToJpFun(midi([[
        note(0, 80, 60), note(80, 80, 62), note(160, 80, 64),
    ]]));
    const quarterNotes = playedNotes(compilePlayback(lower(quarter)));
    const sixteenthNotes = playedNotes(compilePlayback(lower(sixteenth)));
    assert(quarter.includes("@tuplet({C4 D4 E4}, 2)")
        && quarterNotes.every(note => note.duration.equals(2, 3)),
    `四分三连音应写三个普通音并缩放为 2/3 QN：${quarter}`);
    assert(sixteenth.includes("@tuplet({C4// D4// E4//}, 2)")
        && sixteenthNotes.every(note => note.duration.equals(1, 6)),
    `十六分三连音应写三个双减时音并缩放为 1/6 QN：${sixteenth}`);
});

test("MIDI 三连和弦按槽识别，不吞并持续低音或不完整候选", () => {
    const source = midiJsonToJpFun(midi([[
        note(0, 480, 36),
        note(0, 160, 60), note(0, 160, 64),
        note(160, 160, 62), note(160, 160, 65),
        note(320, 160, 64), note(320, 160, 67),
    ]]));
    const incomplete = midiJsonToJpFun(midi([[
        note(0, 160, 60), note(320, 160, 64),
    ]]));
    const changedTempo = midiJsonToJpFun(midi([[
        note(0, 160, 60), note(160, 160, 62), note(320, 160, 64),
    ]], { tempos: [{ ticks: 160, bpm: 90 }] }));
    const notes = playedNotes(compilePlayback(lower(source)));
    assert(source.includes("@stack(") && source.includes("@tuplet(")
        && notes.some(note => note.midi === 36 && note.duration.equals(1))
        && notes.filter(note => note.midi !== 36).every(note => note.duration.equals(1, 3)),
    `持续低音应独立成 lane，三连和弦每槽保持 1/3 QN：${source}`);
    assert(!incomplete.includes("@tuplet("), `缺少中间槽不得识别为三连音：${incomplete}`);
    assert(!changedTempo.includes("@tuplet("), `组内速度变化不得被三连音作用域吞掉：${changedTempo}`);
});

test("MIDI 三连音支持偏移起点、奇数 PPQ，并按槽而非和弦音数评分", () => {
    const shifted = midiJsonToJpFun(midi([[
        note(480, 320, 60), note(800, 320, 62), note(1120, 320, 64),
    ]]));
    const oddPpq = midiJsonToJpFun(midi([[
        note(0, 80, 60), note(80, 80, 62), note(160, 80, 64),
    ]], { tick: 481 }));
    const chordWeighted = midiJsonToJpFun(midi([[
        ...[48, 52, 55, 60, 64, 67, 72].map(pitch => note(0, 160, pitch)),
        note(160, 160, 62), note(320, 160, 64),
    ]]));
    assert(shifted.includes("@tuplet({C4 D4 E4}, 2)"),
        `四分三连音可从任意四分拍起点开始：${shifted}`);
    assert(oddPpq.includes("@tuplet({C4// D4// E4//}, 2)")
        && playedNotes(compilePlayback(lower(oddPpq))).every(note => note.duration.equals(1, 6)),
    `奇数 PPQ 也应按分数目标识别十六分三连音：${oddPpq}`);
    assert(chordWeighted.includes("@tuplet("),
        `首槽和弦成员数不得压倒其余两个槽的拟合权重：${chordWeighted}`);
});

test("MIDI 三连音支持低 PPQ，并严格排除容差边界外 onset", () => {
    const lowPpq = midiJsonToJpFun(midi([[
        note(0, 4, 60), note(4, 4, 62), note(8, 4, 64),
    ]], { tick: 24 }));
    const outside = midiJsonToJpFun(midi([[
        note(0, 80, 60), note(91, 80, 62), note(160, 80, 64),
    ]], { tick: 481 }));
    assert(lowPpq.includes("@tuplet({C4// D4// E4//}, 2)"),
        `低 PPQ 的精确三连音不得因相对容差下限被跳过：${lowPpq}`);
    assert(!outside.includes("@tuplet("),
        `超出槽容差的 onset 不得被二分切片上界误收：${outside}`);
});

test("MIDI 三连音不跨小节，且 onset 与 duration 使用同一容差", () => {
    const crossBar = midiJsonToJpFun(midi([[
        note(960, 320, 60), note(1280, 320, 62), note(1600, 320, 64),
    ]], { timeSignatures: [{ ticks: 0, timeSignature: [3, 4] }] }));
    const looseDuration = midiJsonToJpFun(midi([[
        note(0, 180, 60), note(160, 180, 62), note(320, 180, 64),
    ]]));
    const alignedMeter = midiJsonToJpFun(midi([[
        note(0, 320, 60), note(320, 320, 62), note(640, 320, 64),
    ]], { timeSignatures: [{ ticks: 480, timeSignature: [3, 4] }] }));
    assert(!crossBar.includes("@tuplet("), `三连音不得吞掉组内小节线：${crossBar}`);
    assert(!looseDuration.includes("@tuplet("), `时值偏差超过容差不得吸附为三连音：${looseDuration}`);
    assert(alignedMeter.includes("@tuplet("),
        `拍号变化对齐到零时刻后不得在原 tick 位置伪造 blocker：${alignedMeter}`);
});

test("三连音存在时组外元事件仍落在二进制时间网格", () => {
    const source = midiJsonToJpFun(midi([[
        note(0, 160, 60), note(160, 160, 62), note(320, 160, 64),
        note(480, 480, 67),
    ]], { tempos: [{ ticks: 610, bpm: 90 }] }));
    const notes = playedNotes(compilePlayback(lower(source)));
    assert(source.length < 1000 && !/-\/+/.test(source),
        `组外 tempo 不得制造非二进制碎片或缩短 dash：${source}`);
    const last = notes.find(note => note.midi === 67);
    assert(last?.start.equals(1) && last.duration.equals(1),
        `组外普通音符必须保持一拍且不得被 tempo 切点重触发：${source}`);
});

test("和弦的减时与附点写在宿主音符上", () => {
    const source = midiJsonToJpFun(midi([[
        note(0, 360, 60),
        note(0, 360, 64),
    ]]));
    assert(source.includes("{C4/. ^ E4}") && !source.includes("-//"),
        `附点和弦应把减时线与点写在宿主音符上：${source}`);
    const plan = compilePlayback(lower(source));
    const notes = playedNotes(plan);
    assert(plan.diagnostics.length === 0 && notes.length === 2
        && notes.every(item => item.duration.equals(3, 4)),
    `附点和弦应无诊断并保持 3/4 拍：${source}`);

    const sustained = midiJsonToJpFun(midi([[
        note(0, 600, 60),
        note(0, 600, 64),
    ]]));
    const sustainedNotes = playedNotes(compilePlayback(lower(sustained)));
    assert(!/-\/+/.test(sustained) && (sustained.match(/@tie\(/g) ?? []).length === 2,
        `带减时线的和弦延续应改用逐音 tie，不得生成缩短 dash：${sustained}`);
    assert(sustainedNotes.length === 2 && sustainedNotes.every(item => item.duration.equals(5, 4)),
        `tie 改写必须保持和弦 5/4 拍时值：${sustained}`);
});

test("跨小节持续音在每个小节首重写，并用完整 tie 链连接", () => {
    const single = midiJsonToJpFun(midi([[
        note(0, 4320, 60),
    ]], { timeSignatures: [{ ticks: 0, timeSignature: [3, 4] }] }), { barsPerLine: 3 });
    const chord = midiJsonToJpFun(midi([[
        note(0, 2880, 60), note(0, 2880, 64),
    ]], { timeSignatures: [{ ticks: 0, timeSignature: [3, 4] }] }), { barsPerLine: 2 });
    const singleNotes = playedNotes(compilePlayback(lower(single)));
    const chordNotes = playedNotes(compilePlayback(lower(chord)));
    assert(!/\|\s*-/.test(single)
        && /C4@mt\d+ - - \| C4@mt\d+ - - \| C4@mt\d+ - - @tie\(mt\d+, mt\d+, mt\d+\)/.test(single),
    `跨三小节单音必须在每个小节首重写，并在末尾生成一条 tie 链：${single}`);
    assert(!/\|\s*-/.test(chord) && (chord.match(/@tie\([^)]*,[^)]*\)/g) ?? []).length === 2,
        `跨小节和弦必须逐音生成完整 tie 链：${chord}`);
    assert(singleNotes.length === 1 && singleNotes[0].duration.equals(9)
        && chordNotes.length === 2 && chordNotes.every(item => item.duration.equals(6)),
    `小节首重写不得改变单音或和弦的总时值：${single}\n${chord}`);
});

test("不同 MIDI 轨生成 N 声部并保留轨名", () => {
    const source = midiJsonToJpFun(midi(
        [[note(0, 480, 72)], [note(0, 960, 48)]],
        { names: ["主唱", 'Bass "A"'] },
    ), { pitchMode: "absolute" });
    assert(source.includes('N("主唱"):') && source.includes('N("Bass \\"A\\""):'),
        `多轨应生成带名称的 N 声部：${source}`);
    assert(source.includes("H.signature: 1=C4 4/4"),
        `绝对音高模式也应在 head 中显示 1=C：${source}`);
    assert(!source.includes("@voices(") && !source.includes("@voice("), `MIDI 声部应优先使用 N 语法糖：${source}`);
    assert(source.includes("\"主唱\"") && source.includes('"Bass \\"A\\""'), `轨名应正确转义：${source}`);
    const notes = playedNotes(compilePlayback(lower(source)));
    assert(notes.length === 2 && notes.some(item => item.midi === 72) && notes.some(item => item.midi === 48),
        `两个 MIDI 轨都必须保留：${source}`);
});

    test("单个 MIDI 声部省略轨名", () => {
        const source = midiJsonToJpFun(midi([[note(0, 480, 60)]], { names: ["Solo"] }), { barsPerLine: 4 });
        assert(source.includes("\n\nN:") && !source.includes('N("Solo"):'),
        `单个声部应直接使用 N:，不得输出轨名：${source}`);
    });

test("速度和拍号变化在量化时间生效，首版忽略力度", () => {
    const input = midi([[note(0, 1920, 60, 20), note(1920, 1440, 62, 127)]], {
        tempos: [{ ticks: 0, bpm: 100 }, { ticks: 960, bpm: 80 }],
        timeSignatures: [
            { ticks: 0, timeSignature: [4, 4] },
            { ticks: 1920, timeSignature: [3, 4] },
        ],
    });
    const source = midiJsonToJpFun(input, { barsPerLine: 1 });
    const plan = compilePlayback(lower(source));
    assert(plan.diagnostics.length === 0, `变拍转换结果不应产生诊断：${source}`);
    assert(source.includes("^ @tempo(80)") && source.includes("^ @meter(3, 4)")
        && !source.includes("@br()") && source.includes("\n\nN:"),
    `中途状态应附着到音符或 dash，系统间应使用空行：${source}`);
    const velocities = plan.events.filter(event => event.kind === "note-on").map(event => event.velocity);
    assert(velocities.every(value => value === 80), "首版 intensity 不得影响 jpFun 力度");
});

test("全谱速度变化附着到最高 lane", () => {
    const source = midiJsonToJpFun(midi([[
        note(0, 1920, 48),
        note(480, 480, 72),
    ]], { tempos: [{ ticks: 480, bpm: 80 }] }));
    const stack = source.match(/@stack\(\{ ([\s\S]*?) \}, \{ ([\s\S]*?) \}\)/);
    assert(stack && !stack[1].includes("@tempo(80)") && stack[2].includes("@tempo(80)"),
        `全谱速度必须写在最高 lane，不得落在低声部：${source}`);
});

test("MIDI 每个系统重写 N，只有首系统保留轨名", () => {
    const source = midiJsonToJpFun(midi(
        [
            [note(0, 480, 60), note(1920, 480, 62)],
            [note(0, 480, 64), note(1920, 480, 65)],
        ],
        { names: ["A", "B"] },
    ), { barsPerLine: 1 });
    assert((source.match(/^N(?:\(|:)/gm) ?? []).length === 4
        && (source.match(/^N\(/gm) ?? []).length === 2
        && !source.includes("@br()"),
    `两轨两系统应有四条 N、仅首系统两条带名称：${source}`);
    const systems = source.split("\n\n").slice(1);
    assert(systems.length === 2
        && systems[0].includes('N("A"):') && systems[0].includes('N("B"):')
        && (systems[1].match(/^N:/gm) ?? []).length === 2,
    `后续系统只能使用 N:：${source}`);
});

test("MIDI 默认自动换行，barsPerLine 正数可强制覆盖", () => {
    const sparseInput = midi([Array.from({ length: 8 }, (_, index) =>
        note(index * 1920, 1920, 60))]);
    const denseInput = midi([Array.from({ length: 64 }, (_, index) =>
        note(index * 120, 120, 60))]);
    const chordInput = midi([Array.from({ length: 64 }, (_, index) => [
        note(index * 120, 120, 60),
        note(index * 120, 120, 64),
        note(index * 120, 120, 67),
    ]).flat()]);
    const balancedInput = midi([Array.from({ length: 4 }, (_, measure) => [
        ...Array.from({ length: 12 }, (_, index) => note(measure * 1920 + index * 120, 120, 60)),
        note(measure * 1920 + 1440, 480, 60),
    ]).flat()]);
    const automaticZero = midiJsonToJpFun(sparseInput, { barsPerLine: 0 });
    const automaticNegative = midiJsonToJpFun(denseInput, { barsPerLine: -1 });
    const defaulted = midiJsonToJpFun(denseInput);
    const chord = midiJsonToJpFun(chordInput);
    const balanced = midiJsonToJpFun(balancedInput);
    const forced = midiJsonToJpFun(denseInput, { barsPerLine: 2 });
    const systemCount = (source: string) => source.split("\n\n").length - 1;

    assert(systemCount(automaticZero) === 2, `0 应让八个稀疏小节自动排成两个系统：${automaticZero}`);
    assert(automaticZero.split("\n\n").slice(1)
        .every(system => (system.match(/\|/g) ?? []).length === 4),
    `自动换行应将八个等密度小节平衡为 4+4，不得留下短尾行：${automaticZero}`);
    assert(systemCount(automaticNegative) === 2,
        `负数应按自然宽度把四个十六分音符密集小节分成 2+2：${automaticNegative}`);
    assert(defaulted === midiJsonToJpFun(denseInput, { barsPerLine: 0 }),
        "省略 barsPerLine 必须等价于显式 0");
    assert(systemCount(defaulted) === 2, `省略参数应默认按自然宽度自动换行：${defaulted}`);
    const naturalWidths = naturalSystemWidths(defaulted);
    const contentWidth = DEFAULT_PAGE_CONFIG.width
        - DEFAULT_PAGE_CONFIG.marginLeft - DEFAULT_PAGE_CONFIG.marginRight;
    assert(naturalWidths.every(width => width >= contentWidth * 0.85)
        && Math.max(...naturalWidths) - Math.min(...naturalWidths) < 1e-6,
    `离散小节无法撑满时应保持均衡且不得留下极短尾行，实际 ${naturalWidths}：${defaulted}`);
    assert(systemCount(chord) === systemCount(defaulted),
        `同起止和弦只能占一个视觉时间列，不得按成员数增加系统：${chord}`);
    assert(systemCount(balanced) === 2, `四个十三列小节应利用弹性上限全局分成 2+2：${balanced}`);
    assert(systemCount(forced) === 2, `显式 barsPerLine=2 必须固定为两个系统：${forced}`);
});

test("MIDI 固定换行不需要 core 布局能力", () => {
    const input = midi([[note(0, 1920, 60), note(1920, 1920, 62)]]);
    const source = convertMidiJsonToJpFun(input, { barsPerLine: 1 });
    assert(source.split("\n\n").length === 3,
        `无布局能力时仍应按每行一小节生成两个系统：${source}`);
});

test("拍号对齐到最近小节边界并忽略尾音之后的元事件", () => {
    const source = midiJsonToJpFun(midi([[note(0, 3840, 60)]], {
        tempos: [{ ticks: 2, bpm: 90 }, { ticks: 1, bpm: 100 }, { ticks: 9600, bpm: 40 }],
        timeSignatures: [
            { ticks: 960, timeSignature: [3, 4] },
            { ticks: 9600, timeSignature: [6, 8] },
        ],
    }));
    const plan = compilePlayback(lower(source));
    assert(plan.diagnostics.length === 0, `非边界拍号不应制造拍长诊断：${source}`);
    const signatures = plan.events.filter(event => event.kind === "time-signature");
    assert(signatures.length === 2
        && signatures[0].at.equals(0)
        && signatures[1].at.equals(4)
        && signatures[1].numerator === 3 && signatures[1].denominator === 4,
    `半小节处的 3/4 应对齐到最近的 4/4 小节边界：${source}`);
    assert(source.includes("H.tempo: 90") && !source.includes("@tempo(40)") && !source.includes("@meter(6, 8)"),
        `同刻元事件应取最后值，尾音之后的元事件应忽略：${source}`);

    const adjacent = midiJsonToJpFun(midi([[note(0, 331, 60)]], {
        tempos: [{ ticks: 332, bpm: 40 }],
        timeSignatures: [{ ticks: 332, timeSignature: [3, 4] }],
    }));
    assert(!adjacent.includes("@tempo(40)") && !adjacent.includes("@meter(3, 4)"),
        `尾音后 1 tick 的元事件不得因量化提前生效：${adjacent}`);
});

test("所有空白使用可见休止符，绝对与相对音高均可选", () => {
    const input = midi([[note(480, 240, 61)]]);
    const absolute = midiJsonToJpFun(input);
    const relative = midiJsonToJpFun(input, { pitchMode: "relative" });
    assert(absolute === midiJsonToJpFun(input, { pitchMode: "absolute" }),
        "默认调用必须等价于显式 absolute 模式");
    assert(relative.includes("0") && relative.includes("#1"), `相对模式应生成休止和 C 调数字：${relative}`);
    assert(!absolute.includes("@1(C4)") && absolute.includes("C#4"), `绝对模式应生成字母音名：${absolute}`);
    assert(compilePlayback(lower(relative)).diagnostics.length === 0, "休止拆分不得产生增时线诊断");
});

test("跨小节长音保持时值，绝对模式覆盖 MIDI 最低音", () => {
    const longSource = midiJsonToJpFun(midi([[note(0, 2880, 60)]]));
    const longPlan = compilePlayback(lower(longSource));
    const longNotes = playedNotes(longPlan);
    assert(longPlan.diagnostics.length === 0 && longNotes[0].duration.equals(6),
        `跨小节长音应使用增时线保持六拍：${longSource}`);

    const lowSource = midiJsonToJpFun(midi([[note(0, 480, 0)]]), { pitchMode: "absolute" });
    const lowNotes = playedNotes(compilePlayback(lower(lowSource)));
    assert(lowSource.includes("C-1") && lowNotes[0].midi === 0,
        `绝对音高必须覆盖 MIDI 0：${lowSource}`);
});

test("绝对零八度和相对低八度和弦不丢失音高", () => {
    const absolute = midiJsonToJpFun(midi([[
        note(0, 240, 12),
        note(480, 480, 23),
    ]]), { pitchMode: "absolute" });
    const absolutePitches = playedNotes(compilePlayback(lower(absolute))).map(item => item.midi);
    assert(absolute.includes("@note(C, , 0)") && absolutePitches.join() === "12,23",
        `绝对 octave=0 必须显式保留：${absolute}`);

    const chord = midiJsonToJpFun(midi([[
        note(0, 480, 51),
        note(0, 480, 60),
    ]]), { pitchMode: "relative" });
    const chordPitches = playedNotes(compilePlayback(lower(chord))).map(item => item.midi).sort((a, b) => a - b);
    assert(chord.includes("{#2, ^ 1}") && chordPitches.join() === "51,60",
        `低八度逗号在和弦语法糖中必须保持音高：${chord}`);
});

test("MIDI program 按原轨切换且 channel 10 整轨跳过", () => {
    const input = midi([
        [note(0, 480, 60), note(480, 480, 62)],
        [note(0, 480, 36)],
    ], { names: ["Lead", "Drums"] });
    input.tracks[0].instruments = [{ ticks: 0, number: 40 }, { ticks: 480, number: 41 }];
    input.tracks[1].channel = 9;
    input.tracks[1].instruments = [{ ticks: 0, number: 0 }];

    const source = midiJsonToJpFun(input, { barsPerLine: 4 });
    const plan = compilePlayback(lower(source));
    const programs = plan.events.filter(event => event.kind === "program-change");

    assert(source.includes("@program(40)") && source.includes("@program(41)"),
        `普通轨的 program 应写入源码：${source}`);
    assert(!source.includes("Drums") && playedNotes(plan).every(item => item.midi !== 36),
        `channel 10 的鼓轨应整轨跳过：${source}`);
    assert(programs.map(event => `${event.at}:${event.track}:${event.program}`).join(" ")
        === "0:0:40 1:0:41",
    `program-change 应保持原始轨道与时刻：${source}`);

    const overlap = midi([[note(0, 960, 60), note(480, 960, 67)]]);
    overlap.tracks[0].instruments = [{ ticks: 0, number: 40 }, { ticks: 480, number: 41 }];
    const splitEvents = compilePlayback(lower(midiJsonToJpFun(overlap))).events;
    const splitPrograms = splitEvents.filter(event => event.kind === "program-change");
    for (const noteOn of splitEvents.filter(event => event.kind === "note-on")) {
        if (noteOn.at.compare(1) < 0) continue;
        const program = splitPrograms.filter(event =>
            event.track === noteOn.track && event.at.compare(noteOn.at) <= 0).at(-1);
        assert(program?.program === 41,
            "一个 MIDI 轨拆成多个 stack lane 后，每个发声 Track 都应继承中途 program");
    }
});

test("转换不修改输入，标题保留，未支持字段不影响输出", () => {
    const input = midi([[note(0, 480, 60, 12)]]);
    input.header.name = "Title % A";
    input.tracks[0].controlChanges = [{ ticks: 0, controller: 64, value: 127 }];
    const before = JSON.stringify(input);
    const source = midiJsonToJpFun(input);
    assert(JSON.stringify(input) === before, "转换器不得修改调用方的 MIDI JSON");
    assert(source.includes('H.title: @text("Title % A", size=2em, align=center)'),
        `含注释字符的标题应安全写入 head：${source}`);
    const imported = midiJsonToJpFun(input, { title: "Imported File" });
    assert(imported.includes("H.title: Imported File") && !imported.includes("Title % A"),
        `显式文件标题应覆盖 MIDI header 名：${imported}`);
    assert(compilePlayback(lower(source)).diagnostics.length === 0, `带标题源码应能无诊断编译：${source}`);

    const plain = midi([[note(0, 480, 60, 99)]]);
    plain.header.name = input.header.name;
    assert(midiJsonToJpFun(plain) === source,
        "intensity 和 controlChanges 暂不改变转换结果");

    const empty = midi([]);
    empty.header.name = "Empty";
    assert(midiJsonToJpFun(empty).includes("H.title: Empty"), "没有音符时也应保留 MIDI 标题");
});

test("输入校验拒绝无效 PPQ、选项、拍号和音符", () => {
    const valid = midi([[note(0, 480, 60)]]);
    const invalidProgram = midi([[note(0, 480, 60)]]);
    invalidProgram.tracks[0].instruments = [{ ticks: 0, number: 128 }];
    let failures = 0;
    for (const run of [
        () => midiJsonToJpFun({ ...valid, header: { ...valid.header, tick: 0 } }),
        () => midiJsonToJpFun(valid, { alignRate: 1 }),
        () => midiJsonToJpFun(valid, { barsPerLine: 1.5 }),
        () => midiJsonToJpFun(valid, { title: 1 as unknown as string }),
        () => midiJsonToJpFun(valid, { pitchMode: "other" as "relative" }),
        () => midiJsonToJpFun(midi([[note(0, 0, 60)]])),
        () => midiJsonToJpFun(midi([[note(0, 480, 128)]])),
        () => midiJsonToJpFun(invalidProgram),
        () => midiJsonToJpFun(midi([[note(0, 480, 60)]], {
            timeSignatures: [{ ticks: 0, timeSignature: [4, 3] }],
        })),
    ]) {
        try { run(); } catch { failures++; }
    }
    assert(failures === 9, `九种非法输入都应失败，实际失败 ${failures} 种`);
});