import type { Fraction } from "../fraction.js";
import type { Track } from "../lowering/track.js";
import type { TemporalNodeBase } from "../functions/temporal.js";
import type { SourceSpan } from "../parser/types.js";

export type PlaybackNoteId = number;

/** 最终可直接交给 MIDI 适配器的系统事件 */
export interface PlaybackTempoEvent {
    readonly kind: "tempo";
    readonly at: Fraction;
    readonly bpm: number;
}

export interface PlaybackTimeSignatureEvent {
    readonly kind: "time-signature";
    readonly at: Fraction;
    readonly numerator: number;
    readonly denominator: number;
}

export interface PlaybackProgramChangeEvent {
    readonly kind: "program-change";
    readonly at: Fraction;
    readonly track: number;
    readonly program: number;
}

export interface PlaybackNoteOnEvent {
    readonly kind: "note-on";
    readonly at: Fraction;
    readonly noteId: PlaybackNoteId;
    readonly track: number;
    readonly midi: number;
    readonly velocity: number;
    readonly percussion?: true;
    readonly sourceSpans: readonly SourceSpan[];
}

export interface PlaybackNoteOffEvent {
    readonly kind: "note-off";
    readonly at: Fraction;
    readonly noteId: PlaybackNoteId;
    readonly track: number;
    readonly midi: number;
}

export type PlaybackEvent =
    | PlaybackTempoEvent
    | PlaybackTimeSignatureEvent
    | PlaybackProgramChangeEvent
    | PlaybackNoteOnEvent
    | PlaybackNoteOffEvent;


/** 一次 `play(node)` 访问；对象身份区分同一节点在反复中的不同访问 */
export interface PlaybackOrigin {
    readonly node: TemporalNodeBase;
}

interface PlaybackDraftEventBase {
    at: Fraction;
    order: number;
}

/** 声音展开后生成的点事件；最终输出前压实轨道编号并剥离编译期字段 */
export interface PlaybackDraftNoteOnEvent extends PlaybackDraftEventBase {
    kind: "note-on";
    noteId: PlaybackNoteId;
    track: Track;
    midi: number;
    velocity: number;
    percussion?: true;
    sourceSpans: SourceSpan[];
}

export interface PlaybackDraftNoteOffEvent extends PlaybackDraftEventBase {
    kind: "note-off";
    noteId: PlaybackNoteId;
    track: Track;
    midi: number;
}

export interface PlaybackDraftTempoEvent extends PlaybackDraftEventBase {
    kind: "tempo";
    bpm: number;
}

export interface PlaybackDraftTimeSignatureEvent extends PlaybackDraftEventBase {
    kind: "time-signature";
    numerator: number;
    denominator: number;
}

export interface PlaybackDraftProgramChangeEvent extends PlaybackDraftEventBase {
    kind: "program-change";
    track: Track;
    program: number;
}

export type PlaybackDraftEvent =
    | PlaybackDraftNoteOnEvent
    | PlaybackDraftNoteOffEvent
    | PlaybackDraftTempoEvent
    | PlaybackDraftTimeSignatureEvent
    | PlaybackDraftProgramChangeEvent;

export interface PlaybackEventInput {
    kind: "time-signature";
    at: Fraction;
    numerator: number;
    denominator: number;
}

const EVENT_PRIORITY = {
    tempo: 0,
    "time-signature": 1,
    "program-change": 2,
    "note-off": 3,
    "note-on": 4,
} satisfies Record<PlaybackDraftEvent["kind"], number>;

/** 同刻先处理系统状态，再关音和开音；相同类别保持原发布次序 */
export function comparePlaybackDraftEvents(left: PlaybackDraftEvent, right: PlaybackDraftEvent) {
    const byTime = left.at.compare(right.at);
    return byTime || EVENT_PRIORITY[left.kind] - EVENT_PRIORITY[right.kind] || left.order - right.order;
}

/**
 * 压实发声 Track 编号并剥掉编译期字段，得到稳定、可序列化的公开事件
 * 输入已经稳定排序；这里保留次序，将编译期的 Track 对象转换为公开通道编号
 */
export function finalizePlaybackEvents(
    events: readonly PlaybackDraftEvent[],
    trackOrder: readonly Track[],
    audible: ReadonlySet<Track>,
): { events: PlaybackEvent[]; tracks: Track[] } {
    // 保留 lowering 的稳定轨道顺序，只过滤未实际发声的轨道
    const trackIds = new Map<Track, number>();
    for (const track of trackOrder) {
        if (audible.has(track)) trackIds.set(track, trackIds.size);
    }
    // 可信扩展若替换成 lowering 之外的 Track，仍按首次 NoteOn 顺序追加
    for (const track of audible) {
        if (!trackIds.has(track)) trackIds.set(track, trackIds.size);
    }

    const output: PlaybackEvent[] = [];
    // 维持输入的稳定顺序，并显式挑选公开字段，防止内部身份和变换数据泄漏到输出
    for (const event of events) {
        if (event.kind === "tempo") {
            output.push({ kind: "tempo", at: event.at, bpm: event.bpm });
            continue;
        }
        if (event.kind === "time-signature") {
            output.push({
                kind: "time-signature",
                at: event.at,
                numerator: event.numerator,
                denominator: event.denominator,
            });
            continue;
        }
        const track = trackIds.get(event.track);
        if (track === undefined) continue;
        if (event.kind === "program-change") {
            output.push({
                kind: "program-change",
                at: event.at,
                track,
                program: event.program,
            });
            continue;
        }
        if (event.kind === "note-on") {
            output.push({
                kind: "note-on",
                at: event.at,
                noteId: event.noteId,
                track,
                midi: event.midi,
                velocity: event.velocity,
                ...(event.percussion ? { percussion: true as const } : {}),
                sourceSpans: event.sourceSpans,
            });
            continue;
        }
        output.push({
            kind: "note-off",
            at: event.at,
            noteId: event.noteId,
            track,
            midi: event.midi,
        });
    }
    return { events: output, tracks: [...trackIds.keys()] };
}