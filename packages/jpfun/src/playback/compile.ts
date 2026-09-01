import { ErrorDiagnostic, WarningDiagnostic, type Diagnostic } from "../diagnostic.js";
import { Fraction } from "../fraction.js";
import type { LoweringResult, TemporalNodeBase } from "../lowering/types.js";
import { DEFAULT_BPM } from "../lowering/types.js";
import type { SourceSpan } from "../parser/types.js";
import type { PlaybackDraftEvent } from "./event.js";
import { comparePlaybackDraftEvents, finalizePlaybackEvents } from "./event.js";
import { performanceTimeToSeconds } from "./time.js";
import type {
    PlaybackControl,
    PlaybackCursor, PlaybackFlow,
    PlaybackFlowHook,
    PlaybackHook,
    PlaybackHookContext,
    PlaybackOrigin,
    PlaybackPlan,
    PlaybackScorePoint,
    PlaybackSystemSnapshot,
    PlaybackSystemState,
    PlaybackTransform
} from "./types.js";
import { isPlaybackRelation } from "./types.js";

/**
 * 按控制流声明展开出实际访问的列顺序
 *
 * 核心只维护游标、到达次数和标记表，跳转规则全部由函数在自己的 `playbackFlow` 里写：
 * 反复线找最近的段起点标记，房子按段起点被访问过几次决定本遍演不演。
 */
function linearizeColumns(lowering: LoweringResult, diagnostics: Diagnostic[], maxFlowSteps: number) {
    const columns = lowering.columns;
    const columnOf = new Map<TemporalNodeBase, number>();
    // 先建立时间流内的 TemporalNode 的列索引
    for (let index = 0; index < columns.length; index++) {
        for (const node of columns[index]) columnOf.set(node, index);
    }
    // 再建立折叠元素的列索引，用此函数实现
    const resolveColumn = (node: TemporalNodeBase) => {
        for (let at: TemporalNodeBase | undefined = node; at; at = at.foldedInto) {
            const index = columnOf.get(at);
            if (index !== void 0) return index;
        } return void 0;
    };

    // 收集流的控制信息，并直接按生效列建立索引
    const marked = new Map<string, number[]>(); // 用于查询最近的标签的列
    const hooksByColumn = new Map<number, { hook: PlaybackFlowHook; sourceSpan: SourceSpan }[]>();
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
        for (let at = from; at <= to; at++) {
            const list = hooksByColumn.get(at);
            if (list) list.push(registered);
            else hooksByColumn.set(at, [registered]);
        }
    };
    // 走 astToTemporal 而不是 columns，折叠成员才不会被漏掉
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
    for (const attach of lowering.attachments) {
        addHook(attach as Partial<PlaybackFlow>, attach.sourceSpan ?? { start: 0, end: 0 });
    }
    // 如果没有任何控制流声明，直接按列顺序播放
    if (hooksByColumn.size === 0) return columns.map((_, index) => index);

    for (const list of marked.values()) list.sort((a, b) => a - b);
    const visits = new Array<number>(columns.length).fill(0);
    let index = 0;
    const cursor: PlaybackCursor = {
        get column() { return index; },
        visits: column => visits[column] ?? 0,
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
 * 函数通过以下入口参与 playback（按作用顺序）：
 * - [hook] Temporal.playbackMarks / PlaybackFlow.playbackFlow：生成事件前先展开控制流；反复线贴起点标记并回跳，volta 按遍数跳过列
 * - [state] Temporal.playbackState：每次实际访问节点时，把 lowering 已固化的 BPM 登记到演奏轴；note、tempo 和正时值 dash 都用它恢复记谱位置的速度
 * - [hook] Temporal.emitPlayback：按展开后的列序逐次调用；note 登记 NoteOn/NoteOff，up/grace 通过 emitter.play 递归登记折叠成员
 * - [API] PlaybackEmitter.control：emit 时只登记控制；所有节点访问完成后按演奏时刻执行，同刻合并后生成 Tempo；fermata 用它修改 bpmScale
 * - [API] PlaybackEmitter.affectFollowing：把 transform 加入当前 play frame；后续目标音完整登记 NoteOn/NoteOff 后，将冻结的 transform 紧接着写入顺序流；accent、tr、波音使用它
 * - [API] PlaybackEmitter.defer：把 hook 写在当前节点之后；状态扫描完成后重放顺序流，走到该位置才执行，可见完整 Tempo 和此前音符；dash 用它延长前一组 NoteOff
 * - [hook] PlaybackRelation.applyPlayback：顺序流重放完并首次排序后执行，可观察和改写完整事件计划；tie 用它合并相距很远的端点
 * - comparePlaybackDraftEvents / finalizePlaybackEvents：最后稳定排序，再校验 NoteOn/NoteOff 配对并剥离 origins、order 等编译期字段
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
    const events: PlaybackDraftEvent[] = []; // 状态扫描先写 Tempo，顺序流再追加音符
    const sequence: (PlaybackDraftEvent | PlaybackHook)[] = [];
    // 同刻稳定次序与 NoteOn/NoteOff 配对各用独立的单调序号
    let nextEventOrder = 0;
    let nextId = 0;
    const nextNoteId = () => nextId++;

    // 控制事件不直接进入最终计划；origins 让生成的 Tempo 能追溯到声明节点
    const controls: { at: Fraction; origins: PlaybackOrigin[]; apply: PlaybackControl }[] = [];
    const scheduleControl = (
        at: Fraction,
        origins: PlaybackOrigin[],
        apply: PlaybackControl,
    ) => controls.push({
        at: at.clone(), // 调用者通常会继续原地修改 Fraction，因此所有持久时间都必须自己持有实例
        origins, apply
    });

    /**
     * 记录一次 Temporal 访问的全部事件和后处理声明
     *
     * activeTransforms 就是当前 play frame：同级兄弟共享同一数组，所以前面的
     * accent/tr 能影响后面的音符；childTransforms 是进入复合子节点前的副本，
     * 子 frame 能继承外层修饰，却不会把内部新增的修饰泄漏回外层。
     *
     * ancestors 是复合节点 lineage。叶节点发出的事件同时属于自身与所有外层复合体，
     * 因此标注整个 Fold 的 tie 也能找到成员实际发出的 NoteOn/NoteOff。
     */
    function play(
        node: TemporalNodeBase,     // 本次访问并发布播放声明的节点
        activeTransforms: PlaybackTransform[],  // 当前 play frame 中已生效的局部变换
        start: Fraction,    // 本次访问在演奏 QN 轴上的起点
        duration: Fraction, // 分配给本节点及默认子节点的演奏时值
        ancestors: PlaybackOrigin[] = [],   // 外层复合节点的来源链
    ) {
        // 同一个 Temporal 在反复中会走到这里多次；每次创建独立 origin 对象区分访问实例
        const origin: PlaybackOrigin = { node };
        const lineage = [...ancestors, origin]; // 来源链

        // 每个实际访问到的 Temporal 把自己的记谱状态同步到演奏轴
        // 目前是无条件覆盖
        if (node.playbackState) {
            const { bpm } = node.playbackState;
            scheduleControl(start, lineage, state => {
                if (bpm) state.bpm = bpm;
            });
        }

        // 进入时已有的部分作用于本节点；同一副本也作为子 frame，内部新增变换不泄漏到外层
        const inheritedCount = activeTransforms.length;
        const childTransforms = [...activeTransforms];
        const directEvents: PlaybackDraftEvent[] = [];
        let localDeferred: PlaybackHook[] | undefined;
        // 复合父节点不能重复执行叶节点的变换，因此只记录本次是否直接发布 NoteOn
        let directNoteOnEmitted = false;
        node.emitPlayback?.({
            start,
            end: start.clone().add(duration),
            track: node.track,
            nextNoteId,
            emit(event) {
                const draft = {
                    ...event,
                    at: event.at.clone(),
                    order: nextEventOrder++,
                    origins: [...lineage],
                };
                if (draft.kind === "note-on") {
                    directNoteOnEmitted = true;
                    // NoteOn 承载音高、力度、Track 与来源；NoteOff 只靠 noteId 与它配对
                    const output: PlaybackDraftEvent = {
                        ...draft,
                        track: node.track,
                        sourceSpans: [{ ...node.ast.sourceSpan }],
                    };
                    directEvents.push(output);
                    sequence.push(output);
                } else {
                    directEvents.push(draft);
                    sequence.push(draft);
                }
            },
            control: (at, apply) => scheduleControl(at, lineage, apply),
            // 注册到调用者的 frame，故意在 emitPlayback 返回后继续影响后续兄弟
            affectFollowing: transform => activeTransforms.push(transform),
            // 当前节点的局部变换执行后，再在本节点位置处理前序事件
            defer: hook => (localDeferred ??= []).push(hook),
            play: (child, childStart, childDuration) =>
                play(child, childTransforms, childStart ?? start, childDuration ?? duration, lineage),
        });

        if (inheritedCount > 0 && directNoteOnEmitted) {
            sequence.push(context => {
                let owned = directEvents;
                for (let i = 0; i < inheritedCount; i++) {
                    const ownedLength = owned.length;
                    const replacement = childTransforms[i](context, owned);
                    if (!replacement) continue;
                    context.events.splice(context.events.length - ownedLength, ownedLength, ...replacement);
                    owned = replacement;
                }
            });
        }
        if (localDeferred) sequence.push(...localDeferred);
    }

    /**
     * 阶段1：把控制流列序列投影到一条连续的演奏 QN 轴，并收集所有声明
     * 得到 scoreMap、controls 和待重放的音符/局部处理顺序
     */
    const order = linearizeColumns(lowering, diagnostics, maxFlowSteps);

    const firstScore = lowering.columns[order[0]]?.[0]?.t.clone() ?? new Fraction();
    const scoreMap: PlaybackScorePoint[] = [{
        performance: new Fraction(),    // 演奏时间0
        score: firstScore               // 记谱时间0
    }];
    const shift = new Fraction().sub(firstScore);   // performance = score + shift
    // 先按实际走过的列累计；dash 等 hook 若把 NoteOff 推得更远，收尾时还会再次扩展
    const performanceEnd = new Fraction();
    for (let step = 0; step < order.length; step++) {
        const index = order[step];
        for (const node of lowering.columns[index]) {
            play(node, [], node.t.clone().add(shift), node.T.clone());
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

    /**
     * 阶段2：依演奏时间执行控制函数，把 controls 物化成可查询快照与最终 Tempo
     * 消费 controls
     * 得到 statePoints 和 Tempo events
     */
    const system: PlaybackSystemState = {
        bpm: DEFAULT_BPM,
        bpmScale: new Fraction(1),  // 给延长音等变速记号使用
    };
    const statePoints: { at: Fraction; state: PlaybackSystemSnapshot }[] = [];
    // 最终只在 effective BPM 真正变化时发 Tempo，基础 BPM 与倍率的抵消不会产生冗余事件
    let emittedBpm: number | undefined;
    const snapshotState = (): PlaybackSystemSnapshot => ({
        bpm: system.bpm,
        bpmScale: system.bpmScale.clone(),
        effectiveBpm: system.bpm * system.bpmScale.toNumber(),
    });
    // 要求 at 和 origins 可以被安全引用
    const pushStatePoint = (at: Fraction, origins: PlaybackOrigin[]) => {
        const snapshot = snapshotState();
        if (!Number.isFinite(snapshot.effectiveBpm) || snapshot.effectiveBpm <= 0) {
            throw new Error("Playback controls produced an invalid BPM");
        }
        const previous = statePoints[statePoints.length - 1];
        if (previous
            && previous.state.bpm === snapshot.bpm
            && previous.state.bpmScale.equals(snapshot.bpmScale)) return;
        statePoints.push({ at, state: snapshot });
        // bpm 变动，发出等效 tempo 事件
        if (emittedBpm !== snapshot.effectiveBpm) {
            emittedBpm = snapshot.effectiveBpm;
            events.push({
                kind: "tempo",
                at: at.clone(), // events会暴露给hook，因此必须复制
                bpm: snapshot.effectiveBpm,
                order: nextEventOrder++,
                origins,
            });
        }
    };

    controls.sort((left, right) => left.at.compare(right.at));
    let controlIndex = 0;
    // 即使谱面没有显式 tempo/control，计划也需要从 0 开始的默认状态和 Tempo
    if (controls[0]?.at.compare(0) !== 0) pushStatePoint(new Fraction(), []);
    while (controlIndex < controls.length) {
        const at = controls[controlIndex].at.clone();
        const origins: PlaybackOrigin[] = [];
        // 先依稳定声明顺序执行同刻全部修改，再输出该时刻最终可观察状态
        while (controlIndex < controls.length && at.equals(controls[controlIndex].at)) {
            const control = controls[controlIndex++];
            control.apply(system);
            for (const origin of control.origins) if (!origins.includes(origin)) origins.push(origin);
        }
        pushStatePoint(at, origins);
    }

    // hook 可以增删事件或移动时间；relation 开始前和最终输出前各整理一次。
    // HookContext 是具体函数唯一看到的全局面：可信 hook 可直接改事件，
    // 但来源查询和状态查询由 core 统一实现，避免每个符号重复解释 occurrence/control。
    const context: PlaybackHookContext = {
        events,
        diagnostics,
        nextNoteId,
        stateAt: (time: Fraction) => {  // 二分查找 找到不晚于目标时刻的最后一份系统快照
            let left = 0;
            let right = statePoints.length;
            while (left < right) {
                const middle = (left + right) >>> 1;
                if (statePoints[middle].at.compare(time) <= 0) left = middle + 1;
                else right = middle;
            }
            return statePoints[left - 1]?.state ?? snapshotState();
        },
    };

    /**
     * 阶段三：按生成顺序发布音符并执行局部处理
     * Tempo 已完整生成，音符只暴露此前前缀
     */ 
    for (const item of sequence) {
        if (typeof item === "function") item(context);
        else events.push(item);
    }
    /**
     * 阶段四：跨节点关系最后执行；tie 此时看到的是局部变换和 dash 都完成后的真实边界
     */
    events.sort(comparePlaybackDraftEvents);
    for (const attachment of lowering.attachments) {
        if (isPlaybackRelation(attachment)) {
            attachment.applyPlayback(context);
        }
    }

    // 收敛前按最终事件位置稳定排序
    events.sort(comparePlaybackDraftEvents);
    const output = finalizePlaybackEvents(events, lowering.tracks);
    // 正常列序给出基础终点；已排序的末事件包含局部 hook 延长出的最远 NoteOff。
    const eventEnd = events.at(-1)?.at;
    if (eventEnd && eventEnd.compare(performanceEnd) > 0) performanceEnd.copyFrom(eventEnd);
    // 秒数是最终 Tempo 事件对 performance QN 的积分，绝不反向改写事件时间。
    return {
        events: output.events,
        scoreMap,
        tracks: output.tracks,
        performanceDuration: performanceEnd,
        durationSeconds: performanceTimeToSeconds(output.events, performanceEnd.toNumber()),
        diagnostics,
    };
}