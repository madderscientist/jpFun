import { test } from "node:test";

import { ErrorDiagnostic } from "../src/diagnostic.js";
import type { LoweringAttachment } from "../src/lowering/types.js";
import { compilePlayback } from "../src/playback/compile.js";
import type { PlaybackEmitter, PlaybackFlow, PlaybackRelation, PlaybackSpan, PlaybackTransform } from "../src/playback/types.js";
import {
    performanceTimeToSeconds,
    scoreTimeToSeconds,
    secondsToPerformanceTime,
    secondsToScoreTime,
} from "../src/playback/time.js";
import { assert, nearly, lower, playedNotes } from "./helpers.js";

function expectPlaybackError(run: () => unknown, code: string) {
    let thrown: unknown;
    try { run(); } catch (error) { thrown = error; }
    assert(thrown instanceof ErrorDiagnostic, `Expected ${code}, got ${String(thrown)}`);
    assert(thrown.code === code, `Expected ${code}, got ${thrown.code}`);
    return thrown;
}

function lowerWithModifier(source: string, emitPlayback: (emitter: PlaybackEmitter) => void, column = 0) {
    const lowering = lower(source);
    const chord = lowering.columns[column][0] as typeof lowering.columns[0][0] & {
        members: { emitPlayback?: (emitter: PlaybackEmitter) => void }[];
    };
    chord.members[1].emitPlayback = emitPlayback;
    return lowering;
}

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
        let thrown: unknown;
        try { lower(source); } catch (error) { thrown = error; }
        assert(thrown instanceof ErrorDiagnostic && thrown.code === "E_PROGRAM_INVALID",
            `${source} 应拒绝 0..127 之外的 program`);
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
        "和弦顶部应与宿主一起被延长，不能被中间的倪音顶掉");

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
        && pre[0].duration.equals(1, 2), "前倚音应占宿主开头的一半");
    assert(pre[1].midi === 60 && pre[1].start.equals(1, 2)
        && pre[1].duration.equals(1, 2), "前倚音宿主应使用剩余时值");
    assert(pre[2].start.equals(1), "倚音不能移动后继乐谱事件");

    const post = playedNotes(compilePlayback(lower(`1<2`)));
    assert(post[0].midi === 60 && post[0].duration.equals(1, 2),
        "后倚音应先播放缩短后的宿主");
    assert(post[1].midi === 62 && post[1].start.equals(1, 2),
        "后倚音应占宿主末尾");

    const capped = playedNotes(compilePlayback(lower(`{3 2}>1`)));
    assert(capped[0].duration.equals(3, 8)
        && capped[1].duration.equals(3, 8)
        && capped[2].duration.equals(1, 4),
        "多倚音总借时必须封顶为宿主的四分之三并保持比例");
});

test("tie 只合并同轨同音且连续的单音", () => {
    const tied = playedNotes(compilePlayback(lower(`1@a 1@b 1@c @tie(a,b,c)`)));
    assert(tied.length === 1, "连续同音 tie 链应合并成一个 gesture");
    assert(tied[0].duration.equals(3), "合并后的 gesture 应持续到最后一个端点结束");
    assert(tied[0].sourceSpans.length === 3, "合并后必须保留所有端点的源码范围");

    const differentPitch = playedNotes(compilePlayback(lower(`1@a 2@b @tie(a,b)`)));
    assert(differentPitch.length === 2, "异音 tie 只保留视觉关系，不能合并 attack");

    const discontinuous = playedNotes(compilePlayback(lower(`1@a 0 1@b @tie(a,b)`)));
    assert(discontinuous.length === 2, "中间有时间空隙的 tie 不能合并");

    const crossTrack = playedNotes(compilePlayback(lower(`@stack({1@a}, {1@b}) @tie(a,b)`)));
    assert(crossTrack.length === 2, "跨轨 tie 不能合并为一个 MIDI gesture");

    // 反复让同一个端点产生多个 gesture，每一遍各串一条链
    const repeated = playedNotes(compilePlayback(lower(`|: 1@a 1@b :| @tie(a,b)`)));
    assert(repeated.length === 2 && repeated.every(note => note.duration.equals(2)),
        `反复段内的连音线应在每一遍各合并一次，实际 ${repeated.length} 个音`);

    // 已经当过代表的音之后又被吸收，重定向就串成了链，只穿透一层会静默丢音
    const crossed = playedNotes(compilePlayback(lower(`1@a 1@b 1@c 1@d @tie(b,c) @tie(a,b) @tie(c,d)`)));
    assert(crossed.length === 1 && crossed[0].duration.equals(4),
        `交叉声明的 tie 链也应合并成一个四拍 gesture，实际 ${crossed.length} 个音`);
});

test("tie 保留各音段的装饰，仅合并连接处的实际同音", () => {
    const trill = playedNotes(compilePlayback(lower(`1 ^ $tr 1 @tie()`)));
    assert(trill.length === 9 && trill.slice(0, 8).every(note => note.duration.equals(1, 8)),
        "第一音段应保持一拍颤音");
    assert(trill[8].midi === 60 && trill[8].start.equals(1) && trill[8].end.equals(2),
        "第二音段应是普通持续音，不继承颤音");

    const prall = playedNotes(compilePlayback(lower(`1 ^ $prall 1 @tie()`)));
    assert(prall.length === 3 && prall[2].start.equals(2, 3) && prall[2].end.equals(2),
        "波音的最后子音与后一音段同音时，应自然合并释放边界");
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

test("通用连接保留既有配对，同时拒绝外来或不相接的音段", () => {
    const lowering = lower(`{1 ^ 1} {1 ^ 1}`);
    const relation: PlaybackRelation = {
        sourceSpan: { start: 0, end: 1 },
        applyPlayback(context) {
            const heads = context.notes.filter(note => note.start.equals(0));
            const tails = context.notes.filter(note => note.start.equals(1));
            assert(context.connect(heads[0], tails[1]), "首次连接应成功");
            assert(context.connect(heads[0], tails[1]), "相同连接重复声明应成功");
            assert(!context.connect(heads[0], tails[0]) && !context.connect(heads[1], tails[1]),
                "占用前驱或后继的候选应返回 false，不修改既有配对");
            assert(context.connect(heads[1], tails[0]), "剩余成员仍应可以连接");
            expectPlaybackError(() => context.connect({ ...heads[0] }, tails[1]), "E_PLAYBACK_CONNECTION");
            expectPlaybackError(() => context.connect(heads[0], heads[1]), "E_PLAYBACK_CONNECTION");
        },
    };
    lowering.attachments.push(relation);
    const notes = playedNotes(compilePlayback(lowering));
    assert(notes.length === 2 && notes.every(note => note.duration.equals(2)),
        "拒绝冲突或无效候选不应破坏已建立的连接");
});

test("长连接链一次性保留全部来源且不改变来源次序", () => {
    const count = 256;
    const labels = Array.from({ length: count }, (_, index) => `note${index}`);
    const source = `${labels.map(label => `1@${label}`).join(" ")} @tie(${labels.join(",")})`;
    const notes = playedNotes(compilePlayback(lower(source)));
    assert(notes.length === 1 && notes[0].duration.equals(count)
        && notes[0].sourceSpans.length === count, "长连接链应收敛为一个音符并保留全部原音段");
    assert(notes[0].sourceSpans.every((span, index, spans) => index === 0 || span.start > spans[index - 1].start),
        "来源顺序应保持原演奏顺序");
});

test("控制事件修改系统状态并自动产生 tempo", () => {
    const lowering = lower(`1 2`);
    const first = lowering.columns[0][0];
    const emit = first.emitPlayback!.bind(first);
    first.emitPlayback = emitter => {
        emit(emitter);
        emitter.control(emitter.start, state => state.bpmScale.div(2));
        emitter.control(emitter.end, state => state.bpmScale.mul(2));
    };

    const plan = compilePlayback(lowering);
    const tempos = plan.events.filter(event => event.kind === "tempo");
    assert(tempos.map(event => `${event.at}:${event.bpm}`).join(" ") === "0:60 1:120",
        "控制事件应通过系统状态自动生成最终 tempo");
    assert(lowering.duration.equals(2) && plan.performanceDuration.equals(2)
        && nearly(plan.durationSeconds, 1.5), "速度控制只改变秒数，不修改 QN 时间轴");
    assert(nearly(secondsToScoreTime(plan, 0.75), 0.75), "速度变化不应冻结谱面进度");
});

test("通用速度效果按 key 合并，并显式决定是否沿连接延续", () => {
    const key = {};
    for (const source of [`1 ^ $accent`, `0 ^ $accent`]) {
        for (const shared of [true, false]) {
            const lowering = lowerWithModifier(source, emitter => {
                emitter.scaleFollowingBpm(key, 1, 2);
                emitter.scaleFollowingBpm(shared ? key : {}, 1, 2);
            });
            const tempos = compilePlayback(lowering).events.filter(event => event.kind === "tempo");
            assert(tempos.map(event => `${event.at}:${event.bpm}`).join(" ") === `0:${shared ? 60 : 30} 1:120`,
                "有声与无声目标均应对同 key 去重，并将不同 key 的比例相乘");
        }
    }
    for (const followConnections of [false, true]) {
        const lowering = lowerWithModifier(`1 ^ $accent 1 @tie()`, emitter => {
            emitter.scaleFollowingBpm(key, 1, 2, { followConnections });
        });
        const tempos = compilePlayback(lowering).events.filter(event => event.kind === "tempo");
        assert(tempos.map(event => `${event.at}:${event.bpm}`).join(" ")
            === `0:60 ${followConnections ? 2 : 1}:120`, "效果范围由声明者选择，连接不隐式传播效果");
    }
});

test("通用区间扩展保持对象身份，并从新增部分继承效果", () => {
    for (const followConnections of [false, true]) {
        const lowering = lowerWithModifier(`1@a - ^ $accent - 1@b @tie(a,b)`, emitter => {
            emitter.scaleFollowingBpm({}, 1, 2, { followConnections });
        }, 1);
        const plan = compilePlayback(lowering);
        assert(plan.events.filter(event => event.kind === "tempo")
            .map(event => `${event.at}:${event.bpm}`).join(" ") === `0:120 1:60 ${followConnections ? 4 : 3}:120`,
        "新增部分的效果保持自身起点，并按声明决定是否沿连接延续");
        assert(playedNotes(plan).length === 1 && playedNotes(plan)[0].end.equals(4),
            "区间扩展不能拆分原音段或阻断后续逻辑连接");
    }
    for (const source of [`1 -`, `0 -`]) {
        const lowering = lower(source);
        lowering.columns[1][0].emitPlayback = emitter => emitter.defer(context => {
            const target = context.spans[0];
            expectPlaybackError(() => emitter.extend({ ...target }), "E_PLAYBACK_EXTEND_RANGE");
            emitter.extend(target);
            expectPlaybackError(() => emitter.extend(target), "E_PLAYBACK_EXTEND_RANGE");
            assert(context.spans.length === 1 && context.spans[0] === target && target.end.equals(2),
                "扩展只修改原对象，不创建新的结构目标；重复扩展同一访问应被拒绝");
        });
        assert(JSON.stringify(compilePlayback(lowering).events) === JSON.stringify(compilePlayback(lowering).events),
            "扩展处理的状态不能泄漏到下一次编译");
    }
});

test("通用速度效果拒绝无效比例与同 key 冲突，并保留源码位置", () => {
    const source = `1 ^ $accent`;
    for (const [numerator, denominator] of [[0, 1], [1, 0], [1.5, 2], [Infinity, 1]]) {
        const lowering = lowerWithModifier(source, emitter => emitter.scaleFollowingBpm({}, numerator, denominator));
        const error = expectPlaybackError(() => compilePlayback(lowering), "E_PLAYBACK_BPM_SCALE");
        assert(error.span.start === source.indexOf("$accent"), "非法比例应定位到效果声明");
    }
    const key = {};
    const conflicting = lowerWithModifier(source, emitter => {
        emitter.scaleFollowingBpm(key, 1, 2);
        emitter.scaleFollowingBpm(key, 1, 3);
    });
    expectPlaybackError(() => compilePlayback(conflicting), "E_PLAYBACK_BPM_SCALE");
});

test("结构阶段缩短音段后，速度范围采用实际终点", () => {
    const lowering = lower(`1 ^ $fermata 2`);
    const first = lowering.columns[0][0];
    const emit = first.emitPlayback!.bind(first);
    first.emitPlayback = emitter => {
        emit(emitter);
        emitter.defer(context => context.notes[0].end.set(1, 2));
    };
    const plan = compilePlayback(lowering);
    assert(playedNotes(plan)[0].end.equals(1, 2), "结构 hook 应能缩短音段");
    assert(plan.events.filter(event => event.kind === "tempo")
        .map(event => `${event.at}:${event.bpm}`).join(" ") === "0:60 1/2:120",
    "效果应在缩短后的终点结束");
});

test("无声区间支持结构修改及重复编译，但不执行声音展开", () => {
    for (const [numerator, denominator] of [[1, 2], [2, 1]]) {
        let soundCalls = 0;
        const captured: PlaybackSpan[] = [];
        const lowering = lowerWithModifier(`0 ^ $accent`, emitter => {
            emitter.scaleFollowingBpm({}, 1, 2);
            emitter.affectFollowing(() => { soundCalls++; });
        });
        const first = lowering.columns[0][0];
        const emit = first.emitPlayback!.bind(first);
        first.emitPlayback = emitter => {
            emit(emitter);
            emitter.defer(context => {
                assert(context.notes.length === 0 && context.spans.length === 1,
                    "无声目标应只有区间，没有有声音段");
                context.spans[0].end.set(numerator, denominator);
                captured.push(context.spans[0]);
            });
        };
        for (const plan of [compilePlayback(lowering), compilePlayback(lowering)]) {
            assert(plan.events.filter(event => event.kind === "tempo")
                .map(event => `${event.at}:${event.bpm}`).join(" ") === `0:60 ${numerator === 1 ? "1/2" : "2"}:120`,
            "无声效果应采用修改后的终点，重复编译结果相同");
            assert(plan.performanceDuration.equals(numerator === 1 ? 1 : 2)
                && nearly(plan.durationSeconds, numerator === 1 ? 0.75 : 2),
            "延长无声区间也应扩展总时值，缩短则保留乐谱原有总时值");
            assert(playedNotes(plan).length === 0 && plan.tracks.length === 0,
                "无声区间不能生成音符或发声音轨");
        }
        assert(soundCalls === 0 && captured[0] !== captured[1], "无声区间不执行声音展开，编译间不共享区间身份");
        assert(captured.every(span => Object.isFrozen(span) && Object.isFrozen(span.end)
            && Object.isFrozen(span.sourceSpans[0])), "无声区间同样应在结构完成后冻结边界和来源");
    }
});

test("结构、控制与声音回调每次编译只执行一次，最终状态和来源隔离", () => {
    const calls = { structure: 0, control: 0, sound: 0 };
    const lowering = lowerWithModifier(`1 ^ $accent - 2`, emitter => {
        emitter.control(emitter.start, state => {
            calls.control++;
            state.bpmScale.div(2);
        });
        emitter.defer(context => {
            calls.structure++;
            assert(!("stateAt" in context), "结构阶段不应暴露最终状态查询");
        });
        emitter.affectFollowing((context, notes) => {
            calls.sound++;
            const snapshot = context.stateAt(notes[0].start);
            assert(snapshot.effectiveBpm === 60 && notes[0].end.equals(2),
                "声音展开应看到完整时值及最终速度");
            snapshot.bpmScale.mul(10);
            assert(context.stateAt(notes[0].start).bpmScale.equals(1, 2),
                "修改返回的 Fraction 不得影响内部状态时间线");
            assert(Object.isFrozen(notes[0].sourceSpans[0]) && Object.isFrozen(notes[0].origins),
                "声音展开共享的来源元数据必须冻结");
            Object.defineProperty(notes[0], "transpose", {
                enumerable: true,
                get() { throw new Error("声音展开结束后不应读取 transpose"); },
            });
        });
    });
    const first = compilePlayback(lowering);
    const second = compilePlayback(lowering);
    assert(calls.structure === 2 && calls.control === 2 && calls.sound === 2,
        "重编译只能各执行一次声明，不能重放控制或声音回调");
    assert(JSON.stringify(first.events) === JSON.stringify(second.events), "重复编译应得到相同事件");
});

test("点事件保留音符来源校验", () => {
    const lowering = lowerWithModifier(`1 ^ $accent`, emitter => {
        emitter.affectFollowing((_context, notes) => notes.map(note => ({ ...note, origins: [] })));
    });
    let thrown: unknown;
    try { compilePlayback(lowering); } catch (error) { thrown = error; }
    assert(thrown instanceof Error && /^Note \d+ has no origin$/.test(thrown.message),
        `缺少来源的音符必须被拒绝，实际为 ${String(thrown)}`);
});

test("声音展开拒绝越界、缩短、移动外边界与空结果", () => {
    const transforms: PlaybackTransform[] = [
        (_context, notes) => { notes[0].end.add(1); },
        (_context, notes) => { notes[0].end.div(2); },
        (_context, notes) => { notes[0].start.add(1, 4); },
        () => [],
    ];
    for (const transform of transforms) {
        const lowering = lowerWithModifier(`1 ^ $accent`, emitter => emitter.affectFollowing(transform));
        expectPlaybackError(() => compilePlayback(lowering), "E_PLAYBACK_TRANSFORM_RANGE");
    }
});

test("秒数反查谱面位置时钳制到演奏计划边界", () => {
    const plan = compilePlayback(lower(`1 2`));
    assert(nearly(secondsToScoreTime(plan, -1), 0), "负秒数应钳制到谱面开头");
    assert(nearly(secondsToScoreTime(plan, plan.durationSeconds), 2), "计划终点应映射到谱面终点");
    assert(nearly(secondsToScoreTime(plan, plan.durationSeconds + 1), 2),
        "计划结束后的秒数不能继续外推谱面位置");
});

test("defer 只能看到当前位置此前发布的音段", () => {
    const lowering = lower(`1 2`);
    const node = lowering.columns[0][0];
    const emit = node.emitPlayback!.bind(node);
    let visibleNotes = 0;
    node.emitPlayback = emitter => {
        emit(emitter);
        emitter.defer(context => {
            visibleNotes = context.notes.length;
        });
    };

    compilePlayback(lowering);
    assert(visibleNotes === 1, "defer 只能观察当前位置此前发布的音段，不能看见未来音段");
});

test("局部事件变换不能跨顶层 play frame 泄漏", () => {
    const lowering = lower(`1 2`);
    const first = lowering.columns[0][0];
    const emit = first.emitPlayback!.bind(first);
    first.emitPlayback = emitter => {
        emit(emitter);
        emitter.affectFollowing((_context, notes) => {
            for (const note of notes) {
                note.velocity = 10;
            }
        });
    };
    const notes = playedNotes(compilePlayback(lowering));
    assert(notes[0].velocity === 80 && notes[1].velocity === 80,
        "顶层事件各自开始一个新的 play 序列，effect 不能跨列泄漏");
});

test("声音变换替换自己的音段列表", () => {
    const lowering = lowerWithModifier(`1 ^ $accent`, emitter => emitter.affectFollowing((_context, notes) => {
        const replacement = [...notes];
        notes.length = 0;
        return replacement;
    }));

    const notes = playedNotes(compilePlayback(lowering));
    assert(notes.length === 1 && notes[0].midi === 60,
        "transform 改变输入数组长度后仍只能替换目标音段");
});

test("速度由记谱位置决定，而不是上一次实际演到的速度", () => {
    const notes = playedNotes(compilePlayback(lower(`@tempo(180) 1 |: 2 @tempo(60) 3 :| 4`)));
    assert(notes.map(note => note.bpm).join(" ") === "180 180 60 180 60 60",
        "回跳到 |: 后应回到该位置之前的 180，而不是沿用上一遍演到的 60");

    const jumpToDash = lower(`@tempo(180) 1 @tempo(60) -`);
    jumpToDash.attachments.push({
        playbackFlow: () => ({
            range: [0, 0],
            run: () => ({ kind: "jump", column: jumpToDash.columns.length - 1 }),
        }),
    } as LoweringAttachment & PlaybackFlow);
    const dashPlan = compilePlayback(jumpToDash);
    const dashTempos = dashPlan.events.filter(event => event.kind === "tempo");
    assert(dashTempos.length === 1 && dashTempos[0].bpm === 60,
        "控制流直接落到 dash 时，应恢复 dash 在记谱位置固化的速度");
    assert(nearly(dashPlan.durationSeconds, 1), "60 BPM 下一个四分音符长的 dash 应持续一秒");
});

test("复合节点的整体 origin 是关系端点", () => {
    const notes = playedNotes(compilePlayback(lower(`{1 ^ @text(A)}@a 1@b @tie(a,b)`)));
    assert(notes.length === 1 && notes[0].duration.equals(2),
        "标注整个 Fold 时，成员事件应继承复合节点 origin");
});

test("控制流声明可以跳过或提前结束", () => {
    const lowering = lower(`1 2 3`);
    const flow: LoweringAttachment & PlaybackFlow = {
        playbackFlow: () => ({
            run(cursor) {
                if (cursor.column === 1) return { kind: "jump", column: 2 };
                if (cursor.column === 2) return { kind: "stop" };
            },
        }),
    };
    lowering.attachments.push(flow);

    const plan = compilePlayback(lowering);
    const notes = playedNotes(plan);
    assert(notes.map(note => `${note.midi}@${note.start}`).join(" ") === "60@0",
        "被跳过的列与 stop 所在列都不应发声");
    assert(plan.performanceDuration.equals(1), "提前结束时演奏总长应止于最后演奏的列");
    assert(nearly(scoreTimeToSeconds(plan, 2), plan.durationSeconds),
        "stop 后没有下一可达位置，谱面定位应钳到计划终点");

    const competing = lower(`1 2 3 4`);
    for (const column of [3, 2]) {
        competing.attachments.push({
            playbackFlow: () => ({
                run: cursor => cursor.column === 1 ? { kind: "jump", column } : undefined,
            }),
        } as LoweringAttachment & PlaybackFlow);
    }
    const jumped = playedNotes(compilePlayback(competing));
    assert(jumped.map(note => note.midi).join(" ") === "60 64 65",
        "同一列的多个 jump 应采用最小目标列");

    const startsWithJump = lower(`1 2 3`);
    startsWithJump.attachments.push({
        playbackFlow: () => ({
            range: [0, 0],
            run: () => ({ kind: "jump", column: 2 }),
        }),
    } as LoweringAttachment & PlaybackFlow);
    const skippedHead = compilePlayback(startsWithJump);
    const skippedNotes = playedNotes(skippedHead);
    assert(skippedNotes.length === 1 && skippedNotes[0].start.equals(0)
        && skippedHead.performanceDuration.equals(1)
        && skippedHead.scoreMap[0].score.equals(2),
    "开头被跳过时，首个实际列应从 performance 0 开始并映射到真实 score");
});

test("控制流 hook 只在声明的列范围内运行", () => {
    const lowering = lower(`1 2 3 4`);
    let temporalCalls = 0;
    let rangeCalls = 0;
    let globalCalls = 0;

    const temporal = lowering.columns[0][0] as typeof lowering.columns[0][0] & Partial<PlaybackFlow>;
    temporal.playbackFlow = columnOf => ({
        range: [columnOf(temporal)!, columnOf(temporal)!],
        run: () => { temporalCalls++; },
    });
    lowering.attachments.push({
        playbackFlow: columnOf => ({
            range: [columnOf(lowering.columns[1][0])!, columnOf(lowering.columns[2][0])!],
            run: () => { rangeCalls++; },
        }),
    } as LoweringAttachment & PlaybackFlow);
    lowering.attachments.push({
        playbackFlow: () => ({ run: () => { globalCalls++; } }),
    } as LoweringAttachment & PlaybackFlow);

    compilePlayback(lowering);
    assert(temporalCalls === 1, `Temporal hook 应只运行于自身列，实际 ${temporalCalls} 次`);
    assert(rangeCalls === 2, `区间 hook 应在声明的每列运行，实际 ${rangeCalls} 次`);
    assert(globalCalls === 4, `未声明区间的 attachment hook 应运行于每列，实际 ${globalCalls} 次`);
});

test("控制流拒绝非法范围、跳转和展开预算", () => {
    const invalidRange = lower(`1 2`);
    invalidRange.attachments.push({
        sourceSpan: { start: 1, end: 2 },
        playbackFlow: () => ({ range: [-1, 0], run: () => undefined }),
    } as LoweringAttachment & PlaybackFlow);
    const rangeError = expectPlaybackError(
        () => compilePlayback(invalidRange),
        "E_PLAYBACK_FLOW_RANGE",
    );
    assert(rangeError.span.start === 1 && rangeError.span.end === 2,
        "非法 range 应定位到声明它的 attachment");

    const invalidJump = lower(`1 2`);
    invalidJump.attachments.push({
        sourceSpan: { start: 2, end: 3 },
        playbackFlow: () => ({ range: [0, 0], run: () => ({ kind: "jump", column: -1 }) }),
    } as LoweringAttachment & PlaybackFlow);
    const jumpError = expectPlaybackError(
        () => compilePlayback(invalidJump),
        "E_PLAYBACK_FLOW_JUMP",
    );
    assert(jumpError.span.start === 2 && jumpError.span.end === 3,
        "非法 jump 应定位到声明它的 attachment");

    expectPlaybackError(
        () => compilePlayback(lower(`1`), { maxFlowSteps: 0 }),
        "E_PLAYBACK_FLOW_LIMIT",
    );
    expectPlaybackError(
        () => compilePlayback(lower(`|: 1 2 :|`), { maxFlowSteps: 1 }),
        "E_PLAYBACK_FLOW_LIMIT",
    );
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
