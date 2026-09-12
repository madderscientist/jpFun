import { ErrorDiagnostic, WarningDiagnostic, type Diagnostic } from "../diagnostic.js";
import { Fraction } from "../fraction.js";
import type { LoweringResult } from "../lowering/types.js";
import { DEFAULT_BPM, type TemporalNodeBase } from "../functions/temporal.js";
import type { SourceSpan } from "../parser/types.js";
import type {
    PlaybackDraftEvent,
    PlaybackDraftNoteOffEvent,
    PlaybackDraftNoteOnEvent,
} from "./event.js";
import { comparePlaybackDraftEvents, finalizePlaybackEvents } from "./event.js";
import { performanceTimeToSeconds } from "./time.js";
import type {
    PlaybackControl,
    PlaybackCursor, PlaybackFlow,
    PlaybackFlowHook,
    PlaybackHook,
    PlaybackHookContext,
    PlaybackNote,
    PlaybackOrigin,
    PlaybackPlan,
    PlaybackRelationContext,
    PlaybackScorePoint,
    PlaybackSpan,
    PlaybackSpanInput,
    PlaybackSystemSnapshot,
    PlaybackSystemState,
    PlaybackTransform,
    PlaybackTransformContext,
} from "./types.js";
import { isPlaybackRelation } from "./types.js";

/**
 * 按控制流声明展开出实际访问的列顺序
 *
 * 核心只维护游标、到达次数和标记表，跳转规则全部由函数在自己的 `playbackFlow` 里写：
 * 反复线找最近的段起点标记，房子按段起点被访问过几次决定本遍演不演。
 * 本阶段只产生列索引；游标计数和标记索引每次编译重新建立，不会回写 lowering。
 */
function linearizeColumns(lowering: LoweringResult, diagnostics: Diagnostic[], maxFlowSteps: number) {
    const columns = lowering.columns;
    const columnOf = new Map<TemporalNodeBase, number>();
    // 先建立时间流内的 TemporalNode 的列索引
    for (let index = 0; index < columns.length; index++) {
        for (const node of columns[index]) columnOf.set(node, index);
    }
    // 折叠成员不单独占列，沿 foldedInto 找到最近的已入列宿主
    // 标记和关系端点都使用这个映射，保持控制流与实际时间列一致
    const resolveColumn = (node: TemporalNodeBase) => {
        for (let at: TemporalNodeBase | undefined = node; at; at = at.foldedInto) {
            const index = columnOf.get(at);
            if (index !== void 0) return index;
        } return void 0;
    };

    // 收集流的控制信息，并直接按生效列建立索引
    const marked = new Map<string, number[]>(); // 用于查询最近的标签的列
    const hooksByColumn = new Map<number, { hook: PlaybackFlowHook; sourceSpan: SourceSpan }[]>();
    /** 校验控制流声明的范围，并将它登记到每个有效列 */
    const addHook = (owner: Partial<PlaybackFlow>, sourceSpan: SourceSpan) => {
        const hook = owner.playbackFlow?.(resolveColumn);
        if (!hook) return;
        const [from, to] = hook.range ?? [0, columns.length - 1];
        if (hook.range && (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)
            || from < 0 || to < from || to >= columns.length)) {
            throw new ErrorDiagnostic(
                "E_PLAYBACK_FLOW_RANGE",
                `播放控制流范围 [${from}, ${to}] 超出时间列边界`,
                sourceSpan,
            );
        }
        const registered = { hook, sourceSpan };
        // 预先按范围分发，执行时只检查当前列相关的声明。
        for (let at = from; at <= to; at++) {
            const list = hooksByColumn.get(at);
            if (list) list.push(registered);
            else hooksByColumn.set(at, [registered]);
        }
    };
    // astToTemporal 保留了折叠成员，内部节点发布的控制流和标记也必须参与编译
    for (const nodes of lowering.astToTemporal.values()) {
        for (const node of nodes) {
            addHook(node as TemporalNodeBase & Partial<PlaybackFlow>, node.ast.sourceSpan);
            const marks = node.playbackMarks?.();
            if (!marks) continue;
            const at = resolveColumn(node);
            if (at === void 0) continue;
            for (const mark of marks) {
                const list = marked.get(mark);
                if (list) list.push(at);
                else marked.set(mark, [at]);
            }
        }
    }
    // 附件通过同一个能力接口声明控制流，核心无需判断具体附件种类
    for (const attach of lowering.attachments) {
        addHook(attach as Partial<PlaybackFlow>, attach.sourceSpan ?? { start: 0, end: 0 });
    }
    // 如果没有任何控制流声明，直接按列顺序播放
    if (hooksByColumn.size === 0) return columns.map((_, index) => index);

    // 标记按记谱列排序，正向和反向查询都能找到指定方向上最近的一项
    for (const list of marked.values()) list.sort((a, b) => a - b);
    const visits = new Array<number>(columns.length).fill(0);
    let index = 0;
    const cursor: PlaybackCursor = {
        get column() { return index; },
        visits: column => visits[column] ?? 0,
        /** 查找严格位于 from 之前或之后的标记，排除起始列自身 */
        seek(mark, from, direction) {
            const list = marked.get(mark);
            if (!list) return undefined;
            if (direction > 0) return list.find(column => column > from);
            for (let i = list.length - 1; i >= 0; i--) if (list[i] < from) return list[i];
            return undefined;
        },
    };

    const order: number[] = []; // 记录最终的播放顺序
    let steps = 0;  // 防死循环
    // 先记录到达，再决定本列去留；跳过的列也算一次到达，但不会发布声音
    while (index < columns.length) {
        if (++steps > maxFlowSteps) {
            throw new ErrorDiagnostic(
                "E_PLAYBACK_FLOW_LIMIT",
                `播放控制流访问超过 ${maxFlowSteps} 步；可通过 maxFlowSteps 提高展开预算`,
                columns[index][0].ast.sourceSpan,
            );
        }
        visits[index]++;
        let jumpTo: number | undefined;
        // 同列多个跳转请求取最早目标；停止请求立即结束整个计划
        for (const registered of hooksByColumn.get(index) ?? []) {
            const hook = registered.hook;
            const action = hook.run(cursor);
            if (!action) continue;
            // stop 提前结束时，后面的列不算“任何一遍都不会演奏”
            if (action.kind === "stop") return order;
            if (!Number.isSafeInteger(action.column)
                || action.column < 0 || action.column > columns.length) {
                throw new ErrorDiagnostic(
                    "E_PLAYBACK_FLOW_JUMP",
                    `播放控制流跳转目标 ${action.column} 超出时间列边界`,
                    registered.sourceSpan,
                );
            }
            // 取最小的跳转目标到最前面
            jumpTo = Math.min(jumpTo ?? Infinity, action.column);
        }
        if (jumpTo !== undefined) index = jumpTo;
        else {  // 没有 hook 走这个分支
            order.push(index);
            index++;
        }
    }
    // 正常走到文末才报告从未演奏的列；连续缺失区间只报第一列
    const played = new Set(order);
    let previousMissing = false;
    for (let index = 0; index < columns.length; index++) {
        const missing = !played.has(index);
        if (missing && !previousMissing) {
            diagnostics.push(new WarningDiagnostic(
                "W_PLAYBACK_COLUMN_NEVER_PLAYED",
                "这里在任何一遍里都不会演奏",
                columns[index][0].ast.sourceSpan,
            ));
        }
        previousMissing = missing;
    }
    return order;
}

/**
 * 把 lowering 的时间流编译成完整的演奏计划
 *
 * 控制流展开 -> 音段结构 -> 连接及效果范围 -> 最终系统状态 -> 声音展开 -> 点事件
 * 结构处理不读取最终状态，声音展开不改变结构边界；每个声明只执行一次
 */
export function compilePlayback(
    lowering: LoweringResult,
    options?: { maxFlowSteps?: number },
): PlaybackPlan {
    const maxFlowSteps = options?.maxFlowSteps ?? 1 << 16;
    if (!Number.isSafeInteger(maxFlowSteps) || maxFlowSteps <= 0) {
        throw new ErrorDiagnostic(
            "E_PLAYBACK_FLOW_LIMIT",
            "maxFlowSteps 必须是正安全整数",
            lowering.columns[0]?.[0]?.ast.sourceSpan ?? { start: 0, end: 0 },
        );
    }

    const diagnostics: Diagnostic[] = [];
    const events: PlaybackDraftEvent[] = [];
    // notes 是 spans 中有声对象的引用视图，结构修改只需维护同一份边界
    const spans: PlaybackSpan[] = [];
    const notes: PlaybackNote[] = [];
    const transforms = new Map<PlaybackNote, readonly PlaybackTransform[]>();
    const activePrograms = new Map<TemporalNodeBase["track"], number>();
    let nextEventOrder = 0;
    let nextNoteId = 0;

    interface BpmScale {
        key: object;
        factor: Fraction;
        followConnections: boolean;
        origins: PlaybackOrigin[];
        /** 区间内的归一化起点；外层结构缩放时与区间一起移动 */
        startRatio?: Fraction;
    }
    type StateChange = { at: Fraction; origins: PlaybackOrigin[] } & (
        | { kind: "initial" }
        | { kind: "control"; apply: PlaybackControl }
        | { kind: "scale"; scale: BpmScale; delta: 1 | -1 }
    );
    const changes: StateChange[] = [{ kind: "initial", at: new Fraction(), origins: [] }];
    const factors = new Map<object, Fraction>();
    const spanScales = new Map<PlaybackSpan, readonly BpmScale[]>();
    const structureContext: PlaybackHookContext = { spans, notes, diagnostics };
    /** 固化控制的演奏时刻和来源，回调留到最终状态扫描时统一执行 */
    const scheduleControl = (at: Fraction, origins: PlaybackOrigin[], apply: PlaybackControl) => {
        if (!Number.isFinite(at.toNumber()) || at.compare(0) < 0) {
            throw new ErrorDiagnostic("E_PLAYBACK_CONTROL_TIME", "系统控制时刻必须是非负有限值",
                origins.at(-1)!.node.ast.sourceSpan);
        }
        changes.push({ kind: "control", at: at.clone(), origins, apply });
    };

    /** 为一次节点访问建立独立来源身份，收集区间、控制和各阶段的处理声明 */
    function play(
        node: TemporalNodeBase,
        activeTransforms: PlaybackTransform[],
        activeScales: BpmScale[],
        start: Fraction,
        duration: Fraction,
        ancestors: PlaybackOrigin[] = [],
    ) {
        const lineage: PlaybackOrigin[] = [...ancestors, { node }];
        // 当前目标使用进入时的效果快照；子节点序列使用副本，内部新增效果不会回灌外层
        const childTransforms = [...activeTransforms];
        const inheritedTransforms = [...activeTransforms];
        const childScales = [...activeScales];
        const inheritedScales = [...activeScales];
        const deferred: PlaybackHook[] = [];

        /** 复制可变的时间和源码位置，避免结构修改影响输入或另一遍访问 */
        function publishSpan<Input extends PlaybackSpanInput>(input: Input) {
            const span = {
                ...input,
                start: input.start.clone(),
                end: input.end.clone(),
                track: node.track,
                origins: lineage,
                sourceSpans: [{ ...node.ast.sourceSpan }],
            };
            spans.push(span);
            if (inheritedScales.length) spanScales.set(span, inheritedScales);
            return span;
        }

        // 每次访问都恢复记谱位置固化的基础状态，回跳不继承上一遍结束时的状态
        const program = node.playbackState?.program;
        if (program !== undefined && activePrograms.get(node.track) !== program) {
            activePrograms.set(node.track, program);
            events.push({ kind: "program-change", at: start.clone(), order: nextEventOrder++,
                origins: lineage, track: node.track, program });
        }
        const bpm = node.playbackState?.bpm;
        if (bpm !== undefined) scheduleControl(start, lineage, state => { state.bpm = bpm; });

        node.emitPlayback?.({
            start,
            end: start.clone().add(duration),
            track: node.track,
            span(input) { publishSpan(input); },
            /** 有声目标沿用已发布的区间对象，只额外登记声音变换 */
            note(input) {
                const note = publishSpan(input);
                notes.push(note);
                if (inheritedTransforms.length) transforms.set(note, inheritedTransforms);
            },
            /** 延长原区间，并把当前访问携带的效果定位到新增部分 */
            extend(span) {
                if (!spans.includes(span) || !span.end.equals(start) || duration.compare(0) <= 0) {
                    throw new ErrorDiagnostic("E_PLAYBACK_EXTEND_RANGE", "扩展必须接续当前计划内的区间且时值为正",
                        node.ast.sourceSpan);
                }
                const previousDuration = span.end.clone().sub(span.start);
                const extendedDuration = previousDuration.clone().add(duration);
                // 比例以总时长为分母；延长后重新标定，保持既有效果的实际起点不动
                const scales = (spanScales.get(span) ?? []).map(scale => scale.startRatio
                    ? { ...scale, startRatio: scale.startRatio.clone().mul(previousDuration).div(extendedDuration) }
                    : scale);
                // 新效果从旧终点开始；保存比例后，后续整体结构缩放仍能同步移动它的起点
                for (const scale of inheritedScales) {
                    scales.push({ ...scale, startRatio: previousDuration.clone().div(extendedDuration) });
                }
                if (scales.length) spanScales.set(span, scales);
                span.end.add(duration);
            },
            emit: event => events.push({ ...event, at: event.at.clone(),
                order: nextEventOrder++, origins: lineage }),
            control: (at, apply) => scheduleControl(at, lineage, apply),
            /** 只登记效果身份和比例，范围等结构与连接确定后再计算 */
            scaleFollowingBpm(key, numerator, denominator = 1, options) {
                if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
                    || numerator <= 0 || denominator <= 0) {
                    throw new ErrorDiagnostic("E_PLAYBACK_BPM_SCALE", "速度比例必须是正有理数",
                        node.ast.sourceSpan);
                }
                const factor = new Fraction(numerator, denominator);
                const previous = factors.get(key);
                if (previous && !previous.equals(factor)) {
                    throw new ErrorDiagnostic("E_PLAYBACK_BPM_SCALE", "同一速度效果 key 必须使用固定比例",
                        node.ast.sourceSpan);
                }
                factors.set(key, factor);
                activeScales.push({ key, factor, followConnections: options?.followConnections ?? false,
                    origins: lineage });
            },
            affectFollowing: transform => activeTransforms.push(transform),
            defer: hook => deferred.push(hook),
            play: (child, childStart, childDuration) => play(child, childTransforms, childScales,
                childStart ?? start, childDuration ?? duration, lineage),
        });
        // 当前节点发布完成就执行结构处理，因此 hook 只能看到当前位置此前的目标
        for (const hook of deferred) hook(structureContext);
    }

    const order = linearizeColumns(lowering, diagnostics, maxFlowSteps);

    const firstScore = lowering.columns[order[0]]?.[0]?.t.clone() ?? new Fraction();
    const scoreMap: PlaybackScorePoint[] = [{
        performance: new Fraction(),    // 演奏时间0
        score: firstScore               // 记谱时间0
    }];
    const shift = new Fraction().sub(firstScore);   // performance = score + shift
    // 先按实际走过的列累计；结构处理若把音段推得更远，收尾时还会扩展
    const performanceEnd = new Fraction();
    for (let step = 0; step < order.length; step++) {
        const index = order[step];
        // 同列各顶层访问共享演奏坐标，但分别建立自己的效果作用域
        for (const node of lowering.columns[index]) {
            play(node, [], [], node.t.clone().add(shift), node.T.clone());
        }
        const boundary = lowering.columns[index + 1]?.[0]?.t ?? lowering.duration;  // 当前列的控制终点
        performanceEnd.copyFrom(boundary).add(shift);
        const next = order[step + 1];
        if (next === undefined || next === index + 1) continue;
        // 离开记谱顺序时 performance 不跳，只改变接下来所对应的 score 坐标
        const resume = lowering.columns[next][0]?.t.clone() ?? new Fraction();
        shift.add(boundary).sub(resume);
        const point = { performance: performanceEnd.clone(), score: resume };
        const previous = scoreMap[scoreMap.length - 1];
        // 同一个演奏时刻指向后面最近的谱面时刻
        if (previous.performance.equals(point.performance)) scoreMap[scoreMap.length - 1] = point;
        else scoreMap.push(point);
    }

    // 所有结构处理已完成；先校验最终边界，再冻结它们供连接和声音阶段共享
    for (const span of spans) {
        if (!Number.isFinite(span.start.toNumber()) || !Number.isFinite(span.end.toNumber())
            || span.start.compare(0) < 0 || span.end.compare(span.start) <= 0) {
            throw new ErrorDiagnostic("E_PLAYBACK_NOTE_RANGE", "音段必须具有非负起点和正时值",
                span.sourceSpans[0]);
        }
        if (span.end.compare(performanceEnd) > 0) performanceEnd.copyFrom(span.end);
        // Fraction 和来源对象也可被原地修改，单独冻结外层 span 不足以保护共享数据
        Object.freeze(span.start);
        Object.freeze(span.end);
        for (const origin of span.origins) Object.freeze(origin);
        for (const sourceSpan of span.sourceSpans) Object.freeze(sourceSpan);
        Object.freeze(span.origins);
        Object.freeze(span.sourceSpans);
        Object.freeze(span);
    }

    const noteSet = new Set(notes);
    const connections = new Map<PlaybackNote, PlaybackNote>();
    const predecessors = new Map<PlaybackNote, PlaybackNote>();
    const relationContext: PlaybackRelationContext = {
        notes,
        diagnostics,
        /** 只建立一进一出的逻辑连接，保留两个音段各自的边界和修饰 */
        connect(from, to) {
            if (!noteSet.has(from) || !noteSet.has(to) || !from.end.equals(to.start)) {
                throw new ErrorDiagnostic("E_PLAYBACK_CONNECTION", "音段连接必须属于当前计划且时间相接",
                    from.sourceSpans[0]);
            }
            if ((connections.has(from) && connections.get(from) !== to)
                || (predecessors.has(to) && predecessors.get(to) !== from)) return false;
            connections.set(from, to);
            predecessors.set(to, from);
            return true;
        },
    };
    // 关系按最终结构匹配逻辑音段，此时还没有装饰音的实际 NoteOn/NoteOff
    for (const attachment of lowering.attachments) {
        if (isPlaybackRelation(attachment)) attachment.applyPlayback(relationContext);
    }

    const reverseNotes = [...notes].sort((left, right) => right.start.compare(left.start));
    const connectedEnds = new Map<PlaybackSpan, Fraction>();
    // 连接严格向未来推进；逆序处理保证后继的链尾已知，一次算出所有逻辑终点
    for (const note of reverseNotes) {
        const next = connections.get(note);
        const end = next ? connectedEnds.get(next)! : note.end;
        connectedEnds.set(note, end);
    }
    // 将有声、无声区间上的效果转换为进入和退出边界，交给同一条全局状态时间线
    for (const span of spans) {
        const end = connectedEnds.get(span) ?? span.end;
        // 连接只可能延续效果终点；每个效果仍从自己在原区间内的位置开始
        for (const scale of spanScales.get(span) ?? []) {
            const start = scale.startRatio
                ? span.start.clone().add(span.end.clone().sub(span.start).mul(scale.startRatio))
                : span.start;
            changes.push(
                { kind: "scale", at: start, origins: scale.origins, scale, delta: 1 },
                { kind: "scale", at: scale.followConnections ? end : span.end,
                    origins: scale.origins, scale, delta: -1 },
            );
        }
    }

    const system: PlaybackSystemState = {
        bpm: DEFAULT_BPM,
        bpmScale: new Fraction(1),
    };
    const activeCounts = new Map<object, number>();
    const activeScale = new Fraction(1);
    const statePoints: { at: Fraction; state: PlaybackSystemSnapshot }[] = [];
    changes.sort((left, right) => left.at.compare(right.at));
    let changeIndex = 0;
    let emittedBpm: number | undefined;
    // 结构与连接全部确定后，只扫描一次状态；后续声音变换统一读取这份最终结果
    while (changeIndex < changes.length) {
        const at = changes[changeIndex].at;
        const origins = new Set<PlaybackOrigin>();
        // 同刻控制和效果边界全部应用后才生成快照，避免输出由扫描顺序造成的瞬时速度
        while (changeIndex < changes.length && changes[changeIndex].at.equals(at)) {
            const change = changes[changeIndex++];
            for (const origin of change.origins) origins.add(origin);
            if (change.kind === "control") change.apply(system);
            else if (change.kind === "scale") {
                const { key, factor } = change.scale;
                // 同 key 的重叠只累计层数，只有进入或离开整个覆盖范围时才乘除比例
                const before = activeCounts.get(key) ?? 0;
                const after = before + change.delta;
                activeCounts.set(key, after);
                if (before === 0 && after > 0) activeScale.mul(factor);
                else if (before > 0 && after === 0) activeScale.div(factor);
            }
        }
        const bpmScale = system.bpmScale.clone().mul(activeScale);
        const snapshot: PlaybackSystemSnapshot = {
            bpm: system.bpm,
            bpmScale,
            effectiveBpm: system.bpm * bpmScale.toNumber(),
        };
        if (!Number.isFinite(snapshot.effectiveBpm) || snapshot.effectiveBpm <= 0) {
            throw new ErrorDiagnostic("E_PLAYBACK_BPM", "系统控制产生了无效速度",
                [...origins].at(-1)?.node.ast.sourceSpan ?? { start: 0, end: 0 });
        }
        const previous = statePoints.at(-1)?.state;
        if (!previous || previous.bpm !== snapshot.bpm || !previous.bpmScale.equals(bpmScale)) {
            statePoints.push({ at: at.clone(), state: snapshot });
        }
        if (emittedBpm !== snapshot.effectiveBpm) {
            emittedBpm = snapshot.effectiveBpm;
            events.push({
                kind: "tempo",
                at: at.clone(),
                bpm: snapshot.effectiveBpm,
                order: nextEventOrder++,
                origins: [...origins],
            });
        }
    }

    const transformContext: PlaybackTransformContext = {
        diagnostics,
        /** 查询不晚于指定演奏时刻的最后一份最终状态，并隔离可变的比例对象 */
        stateAt(time) {
            let left = 0;
            let right = statePoints.length;
            // 二分定位右侧边界；减一后就是该时刻已经生效的快照
            while (left < right) {
                const middle = (left + right) >>> 1;
                if (statePoints[middle].at.compare(time) <= 0) left = middle + 1;
                else right = middle;
            }
            const snapshot = statePoints[Math.max(0, left - 1)].state;
            return { ...snapshot, bpmScale: snapshot.bpmScale.clone() };
        },
    };

    const realized = new Map<PlaybackNote, {
        on: PlaybackDraftNoteOnEvent;
        off: PlaybackDraftNoteOffEvent;
    }[]>();
    // 每个逻辑音段独立展开声音，连接不会让后一段继承前一段的装饰
    for (const note of notes) {
        let owned: PlaybackNote[] = [{ ...note, start: note.start.clone(), end: note.end.clone() }];
        // 变换按登记顺序消费上一项的结果，每项对这个逻辑音段只执行一次
        for (const transform of transforms.get(note) ?? []) {
            owned = transform(transformContext, owned) ?? owned;
        }
        let first: Fraction | undefined;
        let last: Fraction | undefined;
        // 各子音必须留在原区间内；同时收集整体边界，防止声音阶段改写已确定的结构范围
        for (const sound of owned) {
            if (!Number.isFinite(sound.start.toNumber()) || !Number.isFinite(sound.end.toNumber())
                || sound.start.compare(note.start) < 0 || sound.end.compare(note.end) > 0
                || sound.end.compare(sound.start) <= 0) {
                throw new ErrorDiagnostic("E_PLAYBACK_TRANSFORM_RANGE", "声音展开必须位于原音段区间内且时值为正",
                    note.sourceSpans[0]);
            }
            if (!first || sound.start.compare(first) < 0) first = sound.start;
            if (!last || sound.end.compare(last) > 0) last = sound.end;
        }
        if (!first?.equals(note.start) || !last?.equals(note.end)) {
            throw new ErrorDiagnostic("E_PLAYBACK_TRANSFORM_RANGE", "声音展开必须保持原音段的起止边界",
                note.sourceSpans[0]);
        }
        // 现在才分配实际音符身份；变换专用字段不再进入点事件，配对留给边界合并使用
        realized.set(note, owned.map(sound => {
            const { start, end, track, midi, velocity, percussion, origins, sourceSpans } = sound;
            const noteId = nextNoteId++;
            const on: PlaybackDraftNoteOnEvent = {
                kind: "note-on", at: start.clone(), noteId, order: nextEventOrder++,
                track, midi, velocity, percussion,
                origins: [...origins], sourceSpans: sourceSpans.map(span => ({ ...span })),
            };
            const off: PlaybackDraftNoteOffEvent = {
                kind: "note-off", at: end.clone(), noteId, order: nextEventOrder++, origins: [...origins],
            };
            events.push(on, off);
            return { on, off };
        }));
    }

    const removed = new Set<PlaybackDraftEvent>();
    const joinedSources = new Map<PlaybackDraftNoteOnEvent, PlaybackDraftNoteOnEvent>();
    // 后继先完成合并，前驱便可直接接到它更新后的终点；仅合并连接处实际同音的事件
    for (const note of reverseNotes) {
        const next = connections.get(note);
        if (!next) continue;
        // 只有到达原音段末端的子音可以跨边界连接，中间子音保留自己的起止
        for (const tail of realized.get(note)!) {
            if (!tail.off.at.equals(note.end)) continue;
            const head = realized.get(next)!.find(pair => !removed.has(pair.on)
                && pair.on.at.equals(next.start) && pair.on.track === tail.on.track
                && pair.on.midi === tail.on.midi && pair.on.percussion === tail.on.percussion);
            if (!head) continue;
            tail.off.at.copyFrom(head.off.at);
            joinedSources.set(tail.on, head.on);
            removed.add(head.on);
            removed.add(head.off);
        }
    }

    // 中间节点只保留来源引用；最终给存活链头汇总一次，避免沿长链反复复制来源后缀
    for (const on of joinedSources.keys()) {
        if (removed.has(on)) continue;
        for (let next = joinedSources.get(on); next; next = joinedSources.get(next)) {
            on.sourceSpans.push(...next.sourceSpans);
        }
    }

    // 稳定排序后，由统一出口检查配对、压实轨道编号并剥离编译期字段
    const finalEvents = events.filter(event => !removed.has(event)).sort(comparePlaybackDraftEvents);
    const output = finalizePlaybackEvents(finalEvents, lowering.tracks);
    const eventEnd = finalEvents.at(-1)?.at;
    if (eventEnd && eventEnd.compare(performanceEnd) > 0) performanceEnd.copyFrom(eventEnd);
    // 秒数是最终 Tempo 事件对 performance QN 的积分，绝不反向改写事件时间
    return {
        events: output.events,
        scoreMap,
        tracks: output.tracks,
        performanceDuration: performanceEnd,
        durationSeconds: performanceTimeToSeconds(output.events, performanceEnd.toNumber()),
        diagnostics,
    };
}