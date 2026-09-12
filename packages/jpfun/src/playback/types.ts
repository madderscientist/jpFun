import type { Diagnostic } from "../diagnostic.js";
import type { Fraction } from "../fraction.js";
import type { LoweringAttachment } from "../lowering/types.js";
import type { TemporalNodeBase } from "../functions/temporal.js";
import type { Track } from "../lowering/track.js";
import type { SourceSpan } from "../parser/types.js";
import type {
    PlaybackEvent,
    PlaybackEventInput,
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
 * 不要用任意键索引，否则具体 MIDI 状态会失去类型约束
 */
export interface PlaybackState {
    readonly bpm?: number;
    readonly velocity?: number;
    readonly program?: number;
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

/** 一个完整时间区间；时间位于演奏 QN 轴 */
export interface PlaybackSpanInput {
    start: Fraction;
    end: Fraction;
}

/**
 * 编译期区间；有声与无声目标共享结构边界及来源
 * 结构阶段允许修改 start/end，完成后核心会冻结区间、时间对象和来源元数据
 */
export interface PlaybackSpan extends PlaybackSpanInput {
    readonly track: Track;
    readonly origins: readonly PlaybackOrigin[];
    readonly sourceSpans: readonly Readonly<SourceSpan>[];
}

/** 一个完整音段的发声声明 */
export interface PlaybackNoteInput extends PlaybackSpanInput {
    midi: number;
    velocity: number;
    percussion?: true;
    transpose?: (steps: number) => number;
}

/** 编译期音段；对象身份与来源在连接及声音展开期间保持独立 */
export interface PlaybackNote extends PlaybackNoteInput, PlaybackSpan {}

/** 当前节点发布完成后，修改此前音段的结构；此时尚未生成系统状态 */
export type PlaybackHook = (context: PlaybackHookContext) => void;
/** 在最终状态下展开一个音段；结果须保持原音段的起止边界 */
export type PlaybackTransform = (
    context: PlaybackTransformContext,
    notes: PlaybackNote[],
) => PlaybackNote[] | void;

/** 结构阶段的已发布前缀；集合只读，其中区间的边界仍可调整 */
export interface PlaybackHookContext {
    /** 此前发布的全部时间区间；包括无声目标，有声音段与 notes 共享对象 */
    readonly spans: readonly PlaybackSpan[];
    /** 按发布顺序排列，仅包含当前位置此前已发布的有声音段 */
    readonly notes: readonly PlaybackNote[];
    readonly diagnostics: Diagnostic[];
}

/** 声音阶段只查询最终状态，接口不提供全局区间的写入口 */
export interface PlaybackTransformContext {
    readonly diagnostics: Diagnostic[];
    /** 查询最终系统状态；返回值与内部时间线隔离 */
    stateAt(time: Fraction): PlaybackSystemSnapshot;
}

/** 连接阶段使用冻结后的完整音段集合，匹配规则由关系声明者负责 */
export interface PlaybackRelationContext {
    /** 全部结构已确定的音段；连接保留各音段的区间和修饰 */
    readonly notes: readonly Readonly<PlaybackNote>[];
    readonly diagnostics: Diagnostic[];
    /**
     * 尝试连接当前计划内的相接音段；外来对象或不相接的边界会抛出诊断
     * 每段最多一个前驱和后继；既有配对冲突返回 false，重复声明同一连接返回 true
     */
    connect(from: Readonly<PlaybackNote>, to: Readonly<PlaybackNote>): boolean;
}

/** 具体 Temporal 发布音段、系统事件、结构处理与声音展开声明 */
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
    /** 发布无声区间，参与结构及速度效果处理，不生成音符事件 */
    span(span: PlaybackSpanInput): void;
    /** 发布完整音段；core 自动补轨道和来源，最终统一分配 NoteOn/NoteOff 身份 */
    note(note: PlaybackNoteInput): void;
    /**
     * 用当前相接区间延长已有区间，继承的速度效果从新增部分开始
     * 保留原区间的对象身份和声音变换，不创建新的结构目标
     */
    extend(span: PlaybackSpan): void;
    /** 发布系统事件；core 自动补来源和稳定次序 */
    emit(event: PlaybackEventInput): void;
    /** 在指定时刻登记系统状态修改；同刻控制全部执行后才生成最终状态事件 */
    control(at: Fraction, apply: PlaybackControl): void;
    /**
     * 缩放后续有声及无声区间的 BPM；同 key 对应固定比例，重叠或相邻范围按并集生效
     * 默认只覆盖各区间自身；followConnections 可延续到逻辑连接链尾，效果起点保持不变
     */
    scaleFollowingBpm(key: object, numerator: number, denominator?: number,
        options?: { followConnections?: boolean }): void;
    /** 对同一 play frame 的后续音段登记声音展开，内部新增修饰不泄漏到外层 */
    affectFollowing(transform: PlaybackTransform): void;
    /** 当前节点发布完成后，在当前位置处理此前已发布的音段 */
    defer(hook: PlaybackHook): void;
    /** 递归发布折叠的子节点；未指定区间时继承当前 start 和 duration */
    play(child: TemporalNodeBase, start?: Fraction, duration?: Fraction): void;
}

/** 结构 hook 完成后，attachment 声明音段之间的连接 */
export interface PlaybackRelation extends LoweringAttachment {
    applyPlayback(context: PlaybackRelationContext): void;
}
/** 按能力识别播放关系，避免核心依赖具体附件类 */
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
 * 跨音段关系也需要完整的演奏位置。无限反复属于播放器的循环控制，
 * 应表示为有限计划加循环点，不是无限序列。
 */
export interface PlaybackPlan {
    /** 按演奏时间升序；同刻依次为 tempo、time-signature、program-change、note-off、note-on */
    readonly events: readonly PlaybackEvent[];
    readonly scoreMap: readonly PlaybackScorePoint[];
    /** 最终至少含一个 NoteOn 的原始 Track；事件 track 是此数组的索引 */
    readonly tracks: readonly Track[];
    readonly performanceDuration: Fraction;
    readonly durationSeconds: number;
    readonly diagnostics: readonly Diagnostic[];
}