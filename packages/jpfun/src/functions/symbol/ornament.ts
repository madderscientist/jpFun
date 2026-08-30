import type {
    PlaybackDraftEvent,
    PlaybackDraftNoteOffEvent,
    PlaybackDraftNoteOnEvent,
} from "../../playback/event.js";
import type { PlaybackTransform } from "../../playback/types.js";

/** 每个四分音符的名义子音数 */
const NOMINAL_RATE = 8;
/** 密度只在极端速度下偏离名义值：区间内 bpm 会在算式里精确抵消 */
const MIN_BPM = 60;
const MAX_BPM = 480;
/** 一个装饰音能展开的子音上限；防的是 `@tempo(0.01)` 这类手滑 */
const MAX_SUBNOTES = 256;

interface OrnamentPattern {
    /** 调内音级偏移序列，0 表示本音 */
    readonly body: readonly number[];
    /** 主体是否重复到填满宿主时值 */
    readonly repeat?: boolean;
}

/**
 * 把一个音按固定音级模式展开成装饰音序列
 *
 * 密度按发声时的速度决定而不是固定的记谱时值：固定 1/8 四分音符在慢速下
 * 每秒只有两三次，听起来根本不是颤音。默认速度下仍然恰好是 1/8 四分音符。
 */
export function ornament(pattern: OrnamentPattern): PlaybackTransform {
    return (context, origin) => {
        const owned = context.eventsOf(origin);
        const noteOffs = new Map<number, PlaybackDraftNoteOffEvent>();
        for (const event of owned) {
            if (event.kind === "note-off") noteOffs.set(event.noteId, event);
        }
        const removed = new Set<PlaybackDraftEvent>();
        const added: PlaybackDraftEvent[] = [];
        for (const note of owned) {
            if (note.kind !== "note-on" || !note.transpose) continue;
            const off = noteOffs.get(note.noteId);
            if (!off) continue;
            const duration = off.at.clone().sub(note.at);
            const bpm = context.stateAt(note.at).effectiveBpm;
            const steps = pattern.repeat ? repeatToFill(pattern.body, duration.toNumber(), bpm) : pattern.body;
            const step = duration.div(steps.length);
            removed.add(note);
            removed.add(off);
            for (let index = 0; index < steps.length; index++) {
                const offset = steps[index];
                const noteId = context.nextNoteId();
                const at = note.at.clone().add(step.clone().mul(index));
                const order = note.order + index / steps.length;
                const on: PlaybackDraftNoteOnEvent = {
                    ...note,
                    at,
                    noteId,
                    order,
                    // 本音保留主体的临时升降号，只有偏移音才走调内换算
                    midi: offset === 0 ? note.midi : note.transpose(offset),
                    // 后续 ornament 要从这个派生音继续移调，不能仍以最初的宿主为基准
                    transpose: delta => note.transpose!(offset + delta),
                    origins: [...note.origins],
                    sourceSpans: note.sourceSpans.map(span => ({ ...span })),
                };
                added.push(on, {
                    ...off,
                    at: at.clone().add(step),
                    noteId,
                    order,
                    origins: [...off.origins],
                });
            }
        }
        context.events.splice(0, context.events.length,
            ...context.events.filter(event => !removed.has(event)), ...added);
    };
}

function repeatToFill(body: readonly number[], duration: number, bpm: number): number[] {
    // 名义密度与速度无关（秒数里的 bpm 与频率里的 bpm 恰好抵消），只在 bpm 越界时按比例修正
    const ratio = Math.min(MAX_BPM, Math.max(MIN_BPM, bpm)) / bpm;
    const limit = Math.floor(MAX_SUBNOTES / body.length);
    const cycles = Math.min(limit, Math.max(1, Math.round(duration * NOMINAL_RATE * ratio / body.length)));
    const result: number[] = [];
    for (let i = 0; i < cycles; i++) result.push(...body);
    return result;
}
