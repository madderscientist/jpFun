import type { Diagnostic } from "../diagnostic.js";
import type { Fraction } from "../fraction.js";
import type { LoweringAttachment, TemporalNodeBase } from "../lowering/types.js";
import type { Track } from "../lowering/track.js";
import type {
    PlaybackDraftEvent,
    PlaybackEvent,
    PlaybackEventInput,
    PlaybackNoteId,
    PlaybackOrigin,
} from "./event.js";

export type * from "./event.js";

/**
 * 播放列游标
 *
 * 控制流只能通过它查询已经发生的事实，因此自身不保存状态，同一份 lowering 结果重复编译结果一致
 */
export interface PlaybackCursor {
    /** 正在决定去留的列 */
    readonly column: number;
    /** 该列到目前为止被到达的次数，含本次；被跳过的到达也算 */
    visits(column: number): number;
    /** 从 from 出发沿 direction 找最近一个带该标记的列，不含 from 自身 */
    seek(mark: string, from: number, direction: -1 | 1): number | undefined;
}

/**
 * 对游标的一次干预
 * - jump: 当前列不演奏，直接跳到目标列
 * - stop: 在当前列之前结束
 */
export type PlaybackFlowAction =
    | { kind: "jump"; column: number }
    | { kind: "stop" };

/** 把事件映射到它在播放时间流中的列；折叠成员会映射到宿主 */
export type PlaybackColumnOf = (node: TemporalNodeBase) => number | undefined;

/** 控制流在编译开始时生成的执行声明；range 是运行的升序闭区间，缺省表示每列都运行 */
export interface PlaybackFlowHook {
    readonly range?: readonly [number, number];
    run(cursor: PlaybackCursor): PlaybackFlowAction | undefined;
}

/** 参与播放顺序决策的能力 */
export interface PlaybackFlow {
    /** 根据本轮列索引声明生效范围和运行逻辑 */
    playbackFlow(columnOf: PlaybackColumnOf): PlaybackFlowHook | undefined;
}


/**
 * 记谱位置固化到 Temporal 上的基础状态
 *
 * 将来支持音色时，在这里增加具名的 `program?: number`，并同步扩展系统状态和最终 ProgramChange 事件
 * 不要用任意键索引，否则具体 MIDI 状态会失去类型约束
 */
export interface PlaybackState {
    readonly bpm?: number;
    readonly velocity?: number;
}

/** 按线性化时间扫描的可变系统状态 */
export interface PlaybackSystemState {
    bpm: number;
    bpmScale: Fraction;
}
export interface PlaybackSystemSnapshot {
    readonly bpm: number;
    readonly bpmScale: Fraction;
    readonly effectiveBpm: number;
}

/** 在指定演奏时刻修改系统状态；所有同刻控制执行完后，core 据最终状态生成 Tempo 等事件 */
export type PlaybackControl = (state: PlaybackSystemState) => void;
/** 当前节点的局部变换完成后，检查或改写此前已发布的事件，例如 dash 延后前音的 NoteOff */
export type PlaybackHook = (context: PlaybackHookContext) => void;
/** 修饰同一 play frame 中排在声明者之后的一次具体访问，例如 accent、tr 和 mordent */
export type PlaybackTransform = (
    context: PlaybackHookContext,
    events: PlaybackDraftEvent[],
) => PlaybackDraftEvent[] | void;

export interface PlaybackHookContext {
    /** 完整 Tempo 表，以及当前位置此前已经发布的音符事件；relation 阶段包含完整计划 */
    readonly events: PlaybackDraftEvent[];
    readonly diagnostics: Diagnostic[];
    nextNoteId(): PlaybackNoteId;
    stateAt(time: Fraction): PlaybackSystemSnapshot;
}


/** 具体 Temporal 只发布系统原语、系统控制和延迟事件变换 */
export interface PlaybackEmitter {
    /** 当前访问在演奏 QN 轴上的起点 */
    readonly start: Fraction;
    /**
     * 当前访问在演奏 QN 轴上的终点
     * 和 t+T 不一定相等，例如 up 中的折叠节点
     */
    readonly end: Fraction;
    /** 当前节点所属的原始 Track；最终输出时转换为 PlaybackPlan.tracks 的索引 */
    readonly track: Track;
    /** 为一对新的 NoteOn/NoteOff 分配共享身份 */
    nextNoteId(): PlaybackNoteId;
    /** 发布一个系统定义的原始播放事件；core 自动补来源、轨道和稳定次序 */
    emit(event: PlaybackEventInput): void;
    /** 在指定时刻登记系统状态修改；同刻控制全部执行后才生成最终状态事件 */
    control(at: Fraction, apply: PlaybackControl): void;
    /** 修饰同一 play frame 中排在当前节点之后的音符访问 */
    affectFollowing(transform: PlaybackTransform): void;
    /** 当前节点的局部变换完成后，在当前位置处理此前已发布的事件 */
    defer(hook: PlaybackHook): void;
    /** 递归发布折叠的子节点；未指定区间时继承当前 start 和 duration */
    play(child: TemporalNodeBase, start?: Fraction, duration?: Fraction): void;
}

/** 所有节点 hook 完成后，attachment 可以处理跨节点关系 */
export interface PlaybackRelation extends LoweringAttachment {
    applyPlayback(context: PlaybackHookContext): void;
}
export function isPlaybackRelation(attachment: LoweringAttachment): attachment is PlaybackRelation {
    return typeof (attachment as Partial<PlaybackRelation>).applyPlayback === "function";
}

/** 控制流展开后的演奏位置到记谱位置映射 */
export interface PlaybackScorePoint {
    /** 控制流展开后的连续演奏位置；反复继续前进，跳转处也不回退，单位 QN */
    readonly performance: Fraction;
    /** 与该演奏位置对应的原始谱面位置；反复时会回退，跳过房子时会前跳，单位 QN */
    readonly score: Fraction;
}

/**
 * 完整且可查询的演奏计划
 *
 * 刻意不做成 generator：随机定位、总时长和 MIDI 导出都需要完整计划，
 * 而 tie 这类关系对象要同时改写相距很远的两个端点。无限反复属于播放器的循环控制，
 * 应表示为有限计划加循环点，不是无限序列。
 */
export interface PlaybackPlan {
    /** 按演奏时间升序；同刻依次为 tempo、time-signature、note-off、note-on */
    readonly events: readonly PlaybackEvent[];
    readonly scoreMap: readonly PlaybackScorePoint[];
    /** 最终至少含一个 NoteOn 的原始 Track；事件 track 是此数组的索引 */
    readonly tracks: readonly Track[];
    readonly performanceDuration: Fraction;
    readonly durationSeconds: number;
    readonly diagnostics: readonly Diagnostic[];
}