import { test } from "node:test";

import { ErrorDiagnostic } from "../src/diagnostic.js";
import type { LoweringAttachment } from "../src/lowering/types.js";
import { compilePlayback } from "../src/playback/compile.js";
import type { PlaybackEmitter, PlaybackFlow } from "../src/playback/types.js";
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

test("playback 从已固化 lowering 生成音符与速度计划", () => {
    const plan = compilePlayback(lower(`@tempo(90) @1(D4) 1 0 8 9`));
    const notes = playedNotes(plan);

    assert(notes.length === 1, "休止符、占位符和节拍记号不能发出 MIDI 音符");
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

test("拍号按实际播放访问发布且不参与速度积分", () => {
    const plan = compilePlayback(lower(`@tempo(90) @meter(3,4) |: 1 @meter(6,8) 2 :|`));
    const signatures = plan.events.filter(event => event.kind === "time-signature");

    assert(signatures.map(event => `${event.at}:${event.numerator}/${event.denominator}`).join(" ")
        === "0:3/4 1:6/8 3:6/8",
    "反复段内的拍号应在每次实际访问时重新发布，段外拍号只发布一次");
    assert(plan.events.slice(0, 3).map(event => event.kind).join(" ")
        === "tempo time-signature note-on",
    "同刻事件应按 tempo、拍号、note-off、note-on 的系统顺序输出");
    assert(nearly(plan.durationSeconds, 8 / 3), "拍号事件不能改变 QN 到秒的速度积分");
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

    // 装饰音展开出的中间子音不在事件末尾结束，不得整批延长
    const trill = playedNotes(compilePlayback(lower(`1^$tr -`)));
    const longer = trill.filter(note => !note.duration.equals(1, 8));
    assert(longer.length === 1 && longer[0].duration.equals(9, 8),
        `只有颤音的最后一个子音应被延长，实际有 ${longer.length} 个`);

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

test("秒数反查谱面位置时钳制到演奏计划边界", () => {
    const plan = compilePlayback(lower(`1 2`));
    assert(nearly(secondsToScoreTime(plan, -1), 0), "负秒数应钳制到谱面开头");
    assert(nearly(secondsToScoreTime(plan, plan.durationSeconds), 2), "计划终点应映射到谱面终点");
    assert(nearly(secondsToScoreTime(plan, plan.durationSeconds + 1), 2),
        "计划结束后的秒数不能继续外推谱面位置");
});

test("defer 只能看到当前位置此前发布的事件", () => {
    const lowering = lower(`1 2`);
    const node = lowering.columns[0][0];
    const emit = node.emitPlayback!.bind(node);
    let visibleNoteOns = 0;
    node.emitPlayback = emitter => {
        emit(emitter);
        emitter.defer(context => {
            visibleNoteOns = context.events.filter(event => event.kind === "note-on").length;
        });
    };

    compilePlayback(lowering);
    assert(visibleNoteOns === 1, "defer 只能观察当前位置此前发布的音符，不能看见未来事件");
});

test("局部事件变换不能跨顶层 play frame 泄漏", () => {
    const lowering = lower(`1 2`);
    const first = lowering.columns[0][0];
    const emit = first.emitPlayback!.bind(first);
    first.emitPlayback = emitter => {
        emit(emitter);
        emitter.affectFollowing((_context, events) => {
            for (const event of events) {
                if (event.kind === "note-on") event.velocity = 10;
            }
        });
    };
    const notes = playedNotes(compilePlayback(lowering));
    assert(notes[0].velocity === 80 && notes[1].velocity === 80,
        "顶层事件各自开始一个新的 play 序列，effect 不能跨列泄漏");
});

test("局部事件变换按调用前的尾段长度替换", () => {
    const lowering = lower(`1 ^ $accent`);
    const chord = lowering.columns[0][0] as typeof lowering.columns[0][0] & {
        members: { emitPlayback?: (emitter: PlaybackEmitter) => void }[];
    };
    chord.members[1].emitPlayback = emitter => emitter.affectFollowing((_context, events) => {
        const replacement = [...events];
        events.length = 0;
        return replacement;
    });

    const notes = playedNotes(compilePlayback(lowering));
    assert(notes.length === 1 && notes[0].midi === 60,
        "transform 改变输入数组长度后仍只能替换目标访问产生的事件");
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
