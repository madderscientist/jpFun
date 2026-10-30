import { test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";

import { Fraction } from "../src/fraction.js";
import { compilePlayback } from "../src/playback/compile.js";
import type { PlaybackEvent } from "../src/playback/types.js";
import {
    performanceTimeToScoreTime,
    performanceTimeToSeconds,
    scoreTimeToSeconds,
    secondsToPerformanceTime,
    secondsToScoreTime,
} from "../src/playback/time.js";
import { assert, expectDiagnostic as expectPlaybackError, nearly, lower, playedNotes } from "./helpers.js";

test("playback 从已固化 lowering 生成音符与速度计划", () => {
    const plan = compilePlayback(lower(`@tempo(90) @1(D4) 1 0 8 9`));
    const notes = playedNotes(plan);

    assert(notes.length === 2, "休止符和占位符不发声，节拍记号应发打击音");
    const note = notes[0];
    assert(note.midi === 62, `D4 调性的简谱 1 应解析为 MIDI 62，实际为 ${note.midi}`);
    assert(note.start.equals(0) && note.duration.equals(1), "无演奏变换时演奏时间应等于乐谱时间");
    assert(note.velocity === 80 && note.track === 0, "首版默认力度与轨道编号必须稳定");
    assert(note.bpm === 90, "音符应记录它所在记谱位置生效的速度");

    const tempos = plan.events.filter(event => event.kind === "tempo");
    assert(tempos.length === 1 && tempos[0].bpm === 90, "起始 tempo 应覆盖默认 120 BPM");
    assert(plan.performanceDuration.equals(4), "静音事件仍应推进整篇时间");
    assert(nearly(plan.durationSeconds, 8 / 3), `90 BPM 下 4 QN 应为 8/3 秒，实际为 ${plan.durationSeconds}`);
    assert(nearly(performanceTimeToSeconds(plan.events, 2), 4 / 3), "正向时间换算应分段积分 tempo");
    assert(nearly(secondsToPerformanceTime(plan.events, 4 / 3), 2), "秒数应可反查演奏时间");
    assert(nearly(scoreTimeToSeconds(plan, 2), 4 / 3), "谱面位置应可换算为秒数，供点击谱面起播");
});

test("9/X 发布固定打击音并自然支持增时线", () => {
    for (const source of ["9- - 1", "X - - 1", "@note(X) - - 1"]) {
        const plan = compilePlayback(lower(source));
        const starts = plan.events.filter(event => event.kind === "note-on");
        const notes = playedNotes(plan);
        assert(starts.length === 2 && starts[0].percussion === true && starts[0].midi === 37,
            `${source} 应以固定打击键 37 起音`);
        assert(!("percussion" in starts[1]) && starts[0].track === starts[1].track,
            "普通音的对象形状与原声部归属应保持不变");
        assert(notes[0].duration.equals(3) && notes[1].start.equals(3),
            "两条增时线应延长 NoteOff，而不增加打击起音或移动后继音");
        assert(plan.diagnostics.length === 0, "打击音应是合法的增时线目标");
    }
    const silence = compilePlayback(lower("0 Z 8"));
    assert(playedNotes(silence).length === 0 && silence.tracks.length === 0,
        "休止符和占位符必须保持静音");
    const repeated = compilePlayback(lower("|: 9 - :|"));
    assert(playedNotes(repeated).length === 2 && repeated.diagnostics.length === 0,
        "每次反复应重新起音，增时线不应串到另一遍");
    const chord = playedNotes(compilePlayback(lower("1^9 -")));
    assert(chord.length === 2 && chord.every(note => note.duration.equals(2)),
        "混合和弦的旋律音和打击音应一起延长");
    const parallel = playedNotes(compilePlayback(lower("@stack({9 -}, {9})")));
    assert(parallel.length === 2 && parallel[0].duration.equals(2) && parallel[1].duration.equals(1),
        "不同声部的打击音不能互相延长");
});

test("tie 只合并同种类的同键号音符", () => {
    for (const source of ["C#2@a 9@b @tie(a,b)", "9@a C#2@b @tie(a,b)"]) {
        const notes = playedNotes(compilePlayback(lower(source)));
        assert(notes.length === 2 && notes.every(note => note.midi === 37 && note.duration.equals(1)),
            "普通音高 37 与打击键 37 不得被合并");
    }
    const tied = playedNotes(compilePlayback(lower("9@a X@b @tie(a,b)")));
    assert(tied.length === 1 && tied[0].duration.equals(2), "相同打击音仍可连音");
});

test("打击音保留力度而不参与音高装饰", () => {
    const accented = compilePlayback(lower("9 ^ $accent"));
    const note = accented.events.find(event => event.kind === "note-on");
    assert(note?.percussion === true && note.velocity === 100, "打击音应接受重音力度");
    for (const symbol of ["tr", "prall", "mordent"]) {
        const plan = compilePlayback(lower(`@1(D4) 9 ^ $${symbol}`));
        const starts = plan.events.filter(event => event.kind === "note-on");
        assert(starts.length === 1 && starts[0].percussion === true && starts[0].midi === 37,
            "调性和音高装饰不能改变打击键或产生派生音");
    }
});

test("拍号按实际播放访问发布且不参与速度积分", () => {
    const plan = compilePlayback(lower(`@tempo(90) @meter(3,4) |: 1 @meter(6,8) 2 :|`));
    const signatures = plan.events.filter(event => event.kind === "time-signature");

    assert(signatures.map(event => `${event.at}:${event.numerator}/${event.denominator}`).join(" ")
        === "0:3/4 1:6/8 3:6/8",
    "反复段内的拍号应在每次实际访问时重新发布，段外拍号只发布一次");
    assert(plan.events.slice(0, 4).map(event => event.kind).join(" ")
        === "tempo time-signature program-change note-on",
    "同刻事件应按 tempo、拍号、program-change、note-off、note-on 的系统顺序输出");
    assert(nearly(plan.durationSeconds, 8 / 3), "拍号事件不能改变 QN 到秒的速度积分");
});

test("音色按音轨固化并在反复后恢复", () => {
    const plan = compilePlayback(lower(`@program(10) |: 1 @program(20) 2 :|`));
    const programs = plan.events.filter(event => event.kind === "program-change");

    assert(programs.map(event => `${event.at}:${event.track}:${event.program}`).join(" ")
        === "0:0:10 1:0:20 2:0:10 3:0:20",
    "反复回到旧记谱位置时，应恢复该音符固化的音色");
    assert(plan.events.slice(0, 3).map(event => event.kind).join(" ")
        === "tempo program-change note-on",
    "同刻 program-change 应先于 note-on");

    const defaultProgram = compilePlayback(lower(`1`)).events
        .find(event => event.kind === "program-change");
    assert(defaultProgram?.program === 0, "未声明音色时应在首音前明确使用 program 0");
    assert(lower(`@program(10) 1`).columns[0][0].box === undefined,
        "program 应进入时间列但不产生可见布局对象");
    for (const source of [`@program(-1)`, `@program(1.5)`, `@program(128)`]) {
        expectPlaybackError(() => lower(source), "E_PROGRAM_INVALID");
    }
});

test("音色按 Track 继承且互不回灌", () => {
    const plan = compilePlayback(lower(`@program(10) @stack({1 @program(20) 2}, {3 4})`));
    const programs = plan.events.filter(event => event.kind === "program-change");

    assert(programs.filter(event => event.track === 0).map(event => event.program).join() === "10,20",
        "分支应继承父轨音色，并允许只修改自身后续音色");
    assert(programs.filter(event => event.track === 1).map(event => event.program).join() === "10",
        "一个分支的 program 不能回灌父轨或泄漏到兄弟轨");
});

test("播放只导出发声 Track 并压成连续编号，NoteOff 先于同刻 NoteOn", () => {
    const lowering = lower(`@stack({0}, {1 2})`);
    const plan = compilePlayback(lowering);
    const notes = playedNotes(plan);
    assert(lowering.tracks.length === 2,
        "lowering 应按 Track 首次承载 Temporal 的顺序收集实际轨道");
    assert(plan.tracks.length === 1 && plan.tracks[0] === lowering.tracks[1]
        && notes.every(note => note.track === 0),
        "只含休止符的视觉 Track 不应占用播放通道，发声音轨应重新压成连续编号");
    const boundary = plan.events.filter(event => event.at.equals(1));
    assert(boundary.length === 2
        && boundary[0].kind === "note-off"
        && boundary[1].kind === "note-on",
    "同刻必须先关闭旧音，再开启新音");
});

test("head 的布局辅助 Track 不进入播放通道", () => {
    const lowering = lower(`H.title: A
H.signature: 1=C 4/4
H.tempo: 85
@br()
1`);
    const plan = compilePlayback(lowering);
    const notes = playedNotes(plan);

    assert(lowering.tracks.length === 4, "head 应保留自己的视觉 Track 拓扑");
    assert(plan.tracks.length === 1 && plan.tracks[0] === lowering.rootTrack
        && notes.length === 1 && notes[0].track === 0,
        "head 的纯布局 Track 不应进入播放通道统计");
});

test("播放 Track 保持 lowering 的稳定顺序，不随首个 NoteOn 改变", () => {
    const lowering = lower(`@stack({0 1}, {3 4})`);
    const plan = compilePlayback(lowering);
    const notes = playedNotes(plan);

    assert(plan.tracks.length === 2
        && plan.tracks[0] === lowering.tracks[0]
        && plan.tracks[1] === lowering.tracks[1],
    "filtered playback tracks must preserve lowering order");
    assert(notes[0].track === 1 && notes.slice(1).some(note => note.track === 0),
        "an earlier NoteOn on the second track must not reorder playback channels");
});

test("up 由复合节点发出折叠成员且不重不漏", () => {
    const notes = playedNotes(compilePlayback(lower(`@up(1, 3) 4`)));
    assert(notes.length === 3, `和弦两个成员加后继音应发出三个音，实际为 ${notes.length}`);
    assert(notes[0].start.equals(0) && notes[1].start.equals(0),
        "up 成员必须共享同一演奏起点");
    assert(notes[2].start.equals(1), "up 的后继音必须从和弦时值之后开始");
    assert(notes[0].midi === 64 && notes[1].midi === 60 && notes[2].midi === 65,
        "up 应按从上到下发出成员，之后继续主时间线");
});

test("增时线延长同轨上一组发声音符", () => {
    const plan = compilePlayback(lower(`1 - - 2`));
    const notes = playedNotes(plan);
    assert(notes.length === 2, "增时线不能产生新的 attack");
    assert(notes[0].duration.equals(3), "两根增时线应把前音延长到三个四分音符");
    assert(notes[1].start.equals(3),
        "增时线不应移动 lowering 已确定的后继起点");
    assert(plan.diagnostics.length === 0, "有相邻目标的增时线不应产生诊断");

    const chord = playedNotes(compilePlayback(lower(`1^3 -`)));
    assert(chord.length === 2 && chord.every(note => note.duration.equals(2)),
        "增时线应延长上一组的全部音符，而不只是其中一个");

    const parallel = playedNotes(compilePlayback(lower(`@stack({1 -}, {3})`)));
    const upper = parallel.find(note => note.midi === 60);
    const lowerNote = parallel.find(note => note.midi === 64);
    assert(upper?.duration.equals(2) && lowerNote?.duration.equals(1),
        "增时线只能延长自身 Track，不能串到同刻结束的另一声部");

    // 折叠体内部更早结束的成员不得把已有的组换掉
    const withGrace = playedNotes(compilePlayback(lower(`{2>1}^3 -`)));
    const top = withGrace.find(note => note.midi === 64);
    assert(top !== undefined && top.duration.equals(2),
        "和弦顶部应与宿主一起被延长，不能被中间的倚音顶掉");

    const trill = playedNotes(compilePlayback(lower(`1^$tr -`)));
    assert(trill.length === 16 && trill.every(note => note.duration.equals(1, 8))
        && trill[15].end.equals(2),
        "增时线应扩展同一个音符的完整时值，颤音必须连续填满两拍");

    const missing = compilePlayback(lower(`- 1`));
    assert(missing.diagnostics.some(item => item.code === "W_PLAYBACK_SUSTAIN_WITHOUT_TARGET"),
        "开头的增时线应报告没有播放目标");
});

test("前后倚音在宿主时值内按发声顺序排程", () => {
    const pre = playedNotes(compilePlayback(lower(`2>1 3`)));
    assert(pre.length === 3, "前倚音、宿主和后继音都应发声");
    assert(pre[0].midi === 62 && pre[0].start.equals(0)
        && pre[0].duration.equals(1, 8), "八分前倚音应从拍点借用 1/8 QN");
    assert(pre[1].midi === 60 && pre[1].start.equals(1, 8)
        && pre[1].duration.equals(7, 8), "前倚音宿主应使用剩余时值");
    assert(pre[2].start.equals(1), "倚音不能移动后继乐谱事件");

    const post = playedNotes(compilePlayback(lower(`1<2`)));
    assert(post[0].midi === 60 && post[0].duration.equals(7, 8),
        "后倚音应先播放缩短后的宿主");
    assert(post[1].midi === 62 && post[1].start.equals(7, 8) && post[1].duration.equals(1, 8),
        "八分后倚音应占宿主末尾的 1/8 QN");

    for (const [source, expected] of [
        ["{3 2}>1", "0:1/8 1/8:1/8 1/4:3/4"],
        ["{@text(A) 2 3/}>1//", "0:1/12 1/12:1/24 1/8:1/8"],
        ["{@text(A)}>1", "0:1"],
        ["1>2>3<4", "0:1/16 1/16:1/16 1/8:3/4 7/8:1/8"],
    ]) {
        const plan = compilePlayback(lower(source));
        deepStrictEqual(plan.diagnostics, [], source);
        deepStrictEqual(playedNotes(plan).map(note => `${note.start}:${note.duration}`).join(" "), expected, source);
    }
});
test("多声部倚音同时起奏，借时按最长分支书写时值的四分之一计算，全部在宿主轨上发声", () => {
    const byMidi = (plan: ReturnType<typeof compilePlayback>) =>
        new Map(playedNotes(plan).map(note => [note.midi, note]));
    const plan = compilePlayback(lower(`{1 & {3 4}}>5`));
    const voices = byMidi(plan);
    const [main, upper, later, host] = [60, 64, 65, 67].map(midi => voices.get(midi)!);
    assert(main.start.equals(0) && upper.start.equals(0) && main.duration.equals(1, 8) && upper.duration.equals(1, 8),
        "simultaneous grace voices must start together on one local time scale");
    assert(later.start.equals(1, 8) && later.duration.equals(1, 8) && host.start.equals(1, 4) && host.duration.equals(3, 4),
        "the steal must quarter the whole block length and preserve the block's proportions");
    assert(plan.tracks.length === 1 && [main, upper, later].every(note => note.track === host.track),
        "every grace voice must play on the host track so exports gain no extra tracks");

    const sustained = byMidi(compilePlayback(lower(`1<{2 & 3} -`)));
    assert(sustained.get(62)!.duration.equals(9, 8) && sustained.get(64)!.duration.equals(9, 8),
        "a following dash must sustain every voice that ends with the post grace");
});

test("tie 只合并同轨同音且连续的单音", () => {
    const tied = playedNotes(compilePlayback(lower(`1@a 1@b 1@c @tie(a,b,c)`)));
    assert(tied.length === 1, "连续同音 tie 链应合并成一个 gesture");
    assert(tied[0].duration.equals(3), "合并后的 gesture 应持续到最后一个端点结束");
    assert(tied[0].sourceSpans.length === 3, "合并后必须保留所有端点的源码范围");

    for (const source of [
        "1@a 2@b @tie(a,b)",
        "1@a 0 1@b @tie(a,b)",
        "@stack({1@a}, {1@b}) @tie(a,b)",
    ]) {
        const notes = playedNotes(compilePlayback(lower(source)));
        assert(notes.length === 2, `${source}: only contiguous same-track unisons may merge`);
    }

    // 反复让同一个端点产生多个 gesture，每一遍各串一条链
    const repeated = playedNotes(compilePlayback(lower(`|: 1@a 1@b :| @tie(a,b)`)));
    assert(repeated.length === 2 && repeated.every(note => note.duration.equals(2)),
        `反复段内的连音线应在每一遍各合并一次，实际 ${repeated.length} 个音`);

    // 已经当过代表的音之后又被吸收，重定向就串成了链，只穿透一层会静默丢音
    const crossed = playedNotes(compilePlayback(lower(`1@a 1@b 1@c 1@d @tie(b,c) @tie(a,b) @tie(c,d)`)));
    assert(crossed.length === 1 && crossed[0].duration.equals(4),
        `交叉声明的 tie 链也应合并成一个四拍 gesture，实际 ${crossed.length} 个音`);
});

test("tie 延续无修饰后继的装饰与断奏，有独立修饰的后继从自身起点生效", () => {
    const trill = playedNotes(compilePlayback(lower(`1 ^ $tr 1 @tie()`)));
    assert(trill.length === 16 && trill.every((note, i) =>
        note.midi === (i % 2 === 0 ? 60 : 62) && note.start.equals(i, 8)
        && note.duration.equals(1, 8) && note.sourceSpans.length === 2), "首音颤音铺满整条连音");

    const midTrill = playedNotes(compilePlayback(lower(`1@a 1@b ^ $tr 1@c @tie(a,b,c)`)));
    assert(midTrill.length === 16 && midTrill[0].start.equals(0) && midTrill[0].end.equals(9, 8)
        && midTrill[0].sourceSpans.length === 3
        && midTrill.slice(1).every((note, i) => note.start.equals(i + 9, 8) && note.duration.equals(1, 8)),
    "中段颤音从中段延续到链尾");

    const prall = playedNotes(compilePlayback(lower(`1 ^ $prall 1 @tie()`)));
    assert(prall.length === 3 && prall.every(note => note.duration.equals(2, 3)) && prall[2].end.equals(2), "波音覆盖连音");
    const tailPrall = playedNotes(compilePlayback(lower(`1 1 ^ $prall @tie()`)));
    assert(tailPrall.length === 3 && tailPrall[0].end.equals(4, 3) && tailPrall[2].end.equals(2), "后段波音合并首音");

    for (const [source, end, spans] of [
        [`1 ^ $staccato 1 @tie()`, [1, 1], 2],
        [`1 1 ^ $staccato @tie()`, [3, 2], 2],
        [`1@a 1@b ^ $staccato 1@c @tie(a,b,c)`, [2, 1], 3],
    ] as const) {
        const notes = playedNotes(compilePlayback(lower(source)));
        assert(notes.length === 1 && notes[0].start.equals(0)
            && notes[0].end.equals(end[0], end[1]) && notes[0].sourceSpans.length === spans, "连音断奏时值");
    }
});

test("tie 对同音和弦成员一对一连接", () => {
    for (const suffix of ["", " @tie(a,b)"]) {
        const notes = playedNotes(compilePlayback(lower(`{1 ^ 1}@a {1 ^ 1}@b @tie(a,b)${suffix}`)));
        assert(notes.length === 2 && notes.every(note => note.duration.equals(2)
            && note.sourceSpans.length === 2), "每个同音成员应连接独立后继，重复声明不重复合并来源");
    }
});

test("重叠 tie 声明复用既有配对，并独立连接剩余和弦成员", () => {
    const body = `{1@a ^ 1@b}@x {1@c ^ 1@d}@y`;
    for (const suffix of [
        `@tie(a,d) @tie(x,y)`,
        `@tie(x,y) @tie(a,d)`,
        `@tie(a,d) @tie(x,y) @tie(a,d) @tie(x,y)`,
    ]) {
        for (const repeated of [false, true]) {
            const plan = compilePlayback(lower(`${repeated ? `|: ${body} :|` : body} ${suffix}`));
            const notes = playedNotes(plan);
            assert(notes.length === (repeated ? 4 : 2) && notes.every(note => note.duration.equals(2)
                && note.sourceSpans.length === 2), "重叠声明应保留一对一连接，不能报错、丢音或重复合并来源");
            assert(plan.diagnostics.length === 0, "合法重叠连线不应产生播放诊断");
        }
    }
});

test("秒数反查谱面位置时钳制到演奏计划边界", () => {
    const plan = compilePlayback(lower(`1 2`));
    assert(nearly(secondsToScoreTime(plan, -1), 0), "负秒数应钳制到谱面开头");
    assert(nearly(secondsToScoreTime(plan, plan.durationSeconds), 2), "计划终点应映射到谱面终点");
    assert(nearly(secondsToScoreTime(plan, plan.durationSeconds + 1), 2),
        "计划结束后的秒数不能继续外推谱面位置");

    const multiTempoEvents: readonly PlaybackEvent[] = [
        { kind: "tempo", at: new Fraction(1), bpm: 90 },
        { kind: "tempo", at: new Fraction(1), bpm: 60 },
        { kind: "tempo", at: new Fraction(3), bpm: 180 },
    ];
    for (const [performance, seconds] of [
        [-1, 0],
        [0, 0],
        [0.5, 0.25],
        [1, 0.5],
        [2, 1.5],
        [3, 2.5],
        [4.5, 3],
    ] as const) {
        assert(nearly(performanceTimeToSeconds(multiTempoEvents, performance), seconds),
            `performance ${performance} 应换算为 ${seconds}s`);
        if (performance >= 0) {
            assert(nearly(secondsToPerformanceTime(multiTempoEvents, seconds), performance),
                `${seconds}s 应反查为 performance ${performance}`);
        }
    }
    assert(nearly(performanceTimeToSeconds([], 2), 1) && nearly(secondsToPerformanceTime([], 1), 2),
        "无 tempo 事件时应按默认 120 BPM 换算");
    assert(Number.isNaN(performanceTimeToSeconds(multiTempoEvents, Number.NaN))
        && Number.isNaN(secondsToPerformanceTime(multiTempoEvents, Number.NaN))
        && Number.isNaN(performanceTimeToScoreTime(plan.scoreMap, Number.NaN)),
    "NaN 输入应保持 NaN，不得越界抛错");

    const repeated = compilePlayback(lower(`1 |: 2 3 :| 4`));
    for (const [performance, score] of [[0.5, 0.5], [1, 1], [2.5, 2.5], [3, 1], [4.5, 2.5], [5.25, 3.25]] as const) {
        assert(nearly(performanceTimeToScoreTime(repeated.scoreMap, performance), score),
            `反复演奏位置 ${performance} 应映射到谱面 ${score}`);
    }
});

test("速度由记谱位置决定，复合节点 origin 支持关系连接，展开步数受预算保护", () => {
    const notes = playedNotes(compilePlayback(lower(`@tempo(180) 1 |: 2 @tempo(60) 3 :| 4`)));
    assert(notes.map(note => note.bpm).join(" ") === "180 180 60 180 60 60",
        "回跳到 |: 后应回到该位置之前的 180，而不是沿用上一遍演到的 60");

    const tiedFold = playedNotes(compilePlayback(lower(`{1 ^ @text(A)}@a 1@b @tie(a,b)`)));
    assert(tiedFold.length === 1 && tiedFold[0].duration.equals(2),
        "标注整个 Fold 时，成员事件应继承复合节点 origin");

    expectPlaybackError(() => compilePlayback(lower(`1`), { maxFlowSteps: 0 }), "E_PLAYBACK_FLOW_LIMIT");
    expectPlaybackError(() => compilePlayback(lower(`|: 1 2 :|`), { maxFlowSteps: 1 }), "E_PLAYBACK_FLOW_LIMIT");
});

test("演奏计划按演奏时间排序", () => {
    // 折叠成员倒序播放、倚音在宿主区间内后铺，生成顺序都不等于发声顺序
    const notes = playedNotes(compilePlayback(lower(`@stack({2>1 3}, {1 1})`)));
    assert(notes.length === 5, `应有五个音，实际 ${notes.length}`);
    for (let i = 1; i < notes.length; i++) {
        assert(notes[i].start.compare(notes[i - 1].start) >= 0,
            `notes 必须按演奏时间不降，第 ${i} 个回退了`);
    }
});
