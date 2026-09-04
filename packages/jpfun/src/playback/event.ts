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
    "program-change": 2,
    "note-off": 3,
    "note-on": 4,
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

    const output: PlaybackEvent[] = [];
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
        if (event.kind === "program-change") {
            const track = trackIds.get(event.track);
            if (track !== undefined) output.push({
                kind: "program-change",
                at: event.at,
                track,
                program: event.program,
            });
            continue;
        }
        const on = event.kind === "note-on" ? event : noteOns.get(event.noteId)!;
        const track = trackIds.get(on.track)!;
        if (event.kind === "note-on") {
            output.push({
                kind: "note-on",
                at: event.at,
                noteId: event.noteId,
                track,
                midi: event.midi,
                velocity: event.velocity,
                sourceSpans: event.sourceSpans,
            });
            continue;
        }
        output.push({
            kind: "note-off",
            at: event.at,
            noteId: event.noteId,
            track,
            midi: on.midi,
        });
    }
    return { events: output, tracks: [...trackIds.keys()] };
}