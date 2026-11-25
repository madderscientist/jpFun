import { deepStrictEqual, ok } from "node:assert/strict";
import {
    RecordingPainter,
    compilePlayback,
    compileScore,
    paintLayout,
    type DocumentLayoutResult,
    type PlaybackNoteOffEvent,
    type PlaybackNoteOnEvent,
    type PlaybackPlan,
} from "jpfun";

export { ok as assert } from "node:assert/strict";

export function nearly(left: number, right: number) {
    return Math.abs(left - right) < 1e-6;
}

export function compileValid(source: string) {
    const result = compileScore(source);
    deepStrictEqual(result.diagnostics, [], source);
    return result;
}

export function lower(source: string) {
    return compileScore(source).lowering;
}

export function playedNotes(plan: PlaybackPlan) {
    const noteOffs = new Map<number, PlaybackNoteOffEvent>();
    for (const event of plan.events) {
        if (event.kind === "note-off") noteOffs.set(event.noteId, event);
    }
    return plan.events.filter((event): event is PlaybackNoteOnEvent => event.kind === "note-on").map(note => {
        const off = noteOffs.get(note.noteId);
        ok(off, `Missing NoteOff for ${note.noteId}`);
        let bpm = 120;
        for (const event of plan.events) {
            if (event.at.compare(note.at) > 0) break;
            if (event.kind === "tempo") bpm = event.bpm;
        }
        return { ...note, start: note.at, end: off.at, duration: off.at.clone().sub(note.at), bpm };
    });
}

/** 断言每个 note-on 所在 Track 的当前 program 在 changeAt 前后分别为 before/after，返回 note-on 数量。 */
export function assertProgramsAt(source: string, changeAt: number, before: number, after: number) {
    const programs = new Map<number, number>();
    let count = 0;
    for (const event of compilePlayback(lower(source)).events) {
        if (event.kind === "program-change") programs.set(event.track, event.program);
        if (event.kind === "note-on") {
            count++;
            ok(programs.get(event.track) === (event.at.compare(changeAt) < 0 ? before : after), source);
        }
    }
    return count;
}

export function recordCommands(layout: DocumentLayoutResult) {
    const recording = new RecordingPainter();
    paintLayout(layout, recording);
    return recording.commands;
}