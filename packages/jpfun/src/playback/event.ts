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

export type PlaybackEvent = PlaybackTempoEvent | PlaybackNoteOnEvent | PlaybackNoteOffEvent;


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

export type PlaybackDraftEvent =
    | PlaybackDraftNoteOnEvent
    | PlaybackDraftNoteOffEvent
    | PlaybackDraftTempoEvent;

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
    };

const EVENT_PRIORITY = {
    tempo: 0,
    "note-off": 1,
    "note-on": 2,
} satisfies Record<PlaybackDraftEvent["kind"], number>;

export function comparePlaybackDraftEvents(left: PlaybackDraftEvent, right: PlaybackDraftEvent) {
    const byTime = left.at.compare(right.at);
    return byTime || EVENT_PRIORITY[left.kind] - EVENT_PRIORITY[right.kind] || left.order - right.order;
}

/** 校验 NoteOn/NoteOff 配对并剥掉编译期字段，得到稳定、可序列化的公开事件 */
export function finalizePlaybackEvents(events: readonly PlaybackDraftEvent[]): PlaybackEvent[] {
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

    return events.map(event => {
        if (event.kind === "tempo") return { kind: "tempo", at: event.at, bpm: event.bpm };
        const on = event.kind === "note-on" ? event : noteOns.get(event.noteId)!;
        const track = on.track.id;
        if (track === undefined) throw new Error("Playback event uses an unknown Track");
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
}