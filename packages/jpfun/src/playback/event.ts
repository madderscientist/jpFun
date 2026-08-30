import type { Fraction } from "../fraction.js";
import type { Track } from "../lowering/track.js";
import type { TemporalNodeBase } from "../lowering/types.js";
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

export interface PlaybackNoteOnEvent {
    readonly kind: "note-on";
    readonly at: Fraction;
    readonly noteId: PlaybackNoteId;
    readonly track: number;
    readonly midi: number;
    readonly velocity: number;
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
    | PlaybackNoteOnEvent
    | PlaybackNoteOffEvent;


/** 一次 `play(node)` 访问；对象身份区分同一节点在反复中的不同访问 */
export interface PlaybackOrigin {
    readonly node: TemporalNodeBase;
}

interface PlaybackDraftEventBase {
    at: Fraction;
    order: number;
    origins: PlaybackOrigin[];
}

/** 编译期事件；函数 hook 可直接增删改，最终输出前会剥掉内部字段 */
export interface PlaybackDraftNoteOnEvent extends PlaybackDraftEventBase {
    kind: "note-on";
    noteId: PlaybackNoteId;
    track: Track;
    midi: number;
    velocity: number;
    transpose?: (steps: number) => number;
    sourceSpans: SourceSpan[];
}

export interface PlaybackDraftNoteOffEvent extends PlaybackDraftEventBase {
    kind: "note-off";
    noteId: PlaybackNoteId;
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

export type PlaybackDraftEvent =
    | PlaybackDraftNoteOnEvent
    | PlaybackDraftNoteOffEvent
    | PlaybackDraftTempoEvent
    | PlaybackDraftTimeSignatureEvent;

export type PlaybackEventInput =
    | {
        kind: "note-on";
        at: Fraction;
        noteId: PlaybackNoteId;
        midi: number;
        velocity: number;
        transpose?: (steps: number) => number;
    }
    | {
        kind: "note-off";
        at: Fraction;
        noteId: PlaybackNoteId;
    }
    | {
        kind: "time-signature";
        at: Fraction;
        numerator: number;
        denominator: number;
    };

const EVENT_PRIORITY = {
    tempo: 0,
    "time-signature": 1,
    "note-off": 2,
    "note-on": 3,
} satisfies Record<PlaybackDraftEvent["kind"], number>;

export function comparePlaybackDraftEvents(left: PlaybackDraftEvent, right: PlaybackDraftEvent) {
    const byTime = left.at.compare(right.at);
    return byTime || EVENT_PRIORITY[left.kind] - EVENT_PRIORITY[right.kind] || left.order - right.order;
}

/** 校验配对、压实发声 Track 编号并剥掉编译期字段，得到稳定、可序列化的公开事件 */
export function finalizePlaybackEvents(
    events: readonly PlaybackDraftEvent[],
    trackOrder: readonly Track[],
): { events: PlaybackEvent[]; tracks: Track[] } {
    const noteOns = new Map<PlaybackNoteId, PlaybackDraftNoteOnEvent>();
    const noteOffs = new Map<PlaybackNoteId, PlaybackDraftNoteOffEvent>();
    for (const event of events) {
        if (event.kind === "note-on") {
            if (noteOns.has(event.noteId)) throw new Error(`Duplicate NoteOn ${event.noteId}`);
            noteOns.set(event.noteId, event);
        } else if (event.kind === "note-off") {
            if (noteOffs.has(event.noteId)) throw new Error(`Duplicate NoteOff ${event.noteId}`);
            noteOffs.set(event.noteId, event);
        }
    }
    for (const [noteId, on] of noteOns) {
        const off = noteOffs.get(noteId);
        if (!off) throw new Error(`Note ${noteId} has no NoteOff`);
        if (off.at.compare(on.at) <= 0) throw new Error(`Note ${noteId} has a non-positive duration`);
        if (on.origins.length === 0 || off.origins.length === 0) throw new Error(`Note ${noteId} has no origin`);
    }
    for (const noteId of noteOffs.keys()) {
        if (!noteOns.has(noteId)) throw new Error(`NoteOff ${noteId} has no NoteOn`);
    }
    const audible = new Set<Track>();
    for (const on of noteOns.values()) audible.add(on.track);
    // 保留 lowering 的稳定轨道顺序，只过滤 head 等纯布局 Track。
    const trackIds = new Map<Track, number>();
    for (const track of trackOrder) {
        if (audible.has(track)) trackIds.set(track, trackIds.size);
    }
    // 可信扩展若替换成 lowering 之外的 Track，仍按首次 NoteOn 顺序追加。
    for (const track of audible) {
        if (!trackIds.has(track)) trackIds.set(track, trackIds.size);
    }

    const output: PlaybackEvent[] = events.map(event => {
        if (event.kind === "tempo") return { kind: "tempo", at: event.at, bpm: event.bpm };
        if (event.kind === "time-signature") {
            return {
                kind: "time-signature",
                at: event.at,
                numerator: event.numerator,
                denominator: event.denominator,
            };
        }
        const on = event.kind === "note-on" ? event : noteOns.get(event.noteId)!;
        const track = trackIds.get(on.track)!;
        if (event.kind === "note-on") {
            return {
                kind: "note-on",
                at: event.at,
                noteId: event.noteId,
                track,
                midi: event.midi,
                velocity: event.velocity,
                sourceSpans: event.sourceSpans,
            };
        }
        return {
            kind: "note-off",
            at: event.at,
            noteId: event.noteId,
            track,
            midi: on.midi,
        };
    });
    return { events: output, tracks: [...trackIds.keys()] };
}