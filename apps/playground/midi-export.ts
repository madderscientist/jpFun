import { DEFAULT_BPM, type PlaybackPlan } from "jpfun";
import { loadClassicScript } from "./platform.js";
import type { PlaybackTrackSettings } from "./tiny-synth.js";

const MIDI_URL = "https://madderscientist.github.io/noteDigger/lib/midi.js";
const PPQ = 480;
const DEFAULT_TIME_SIGNATURE = [4, 4] as const;

interface MidiEventLike {
    ticks: number;
    code: number;
    value: number[];
}

interface MidiTrack {
    addEvent(event: MidiEventLike | readonly MidiEventLike[]): unknown;
    export(trackId: number): number[];
}

interface MidiTrackConstructor {
    new(name?: string, events?: MidiEventLike[]): MidiTrack;
    number_hex(value: number, length?: number): number[];
}

interface MidiEventConstructor {
    new(...args: unknown[]): MidiEventLike;
    tempo(at: number, bpm: number): MidiEventLike;
    time_signature(at: number, numerator: number, denominator: number): MidiEventLike;
}

declare const mtrk: MidiTrackConstructor;
declare const midiEvent: MidiEventConstructor;

function constrain(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function tickOf(value: { toNumber(): number }) {
    return value.toNumber() * PPQ;
}

function validatePlan(plan: PlaybackPlan) {
    let hasInitialTempo = false;
    let hasInitialTimeSignature = false;
    for (const event of plan.events) {
        if (event.kind === "tempo") {
            if (event.at.isZero()) hasInitialTempo = true;
            const microseconds = Math.round(60_000_000 / event.bpm);
            if (!Number.isSafeInteger(microseconds) || microseconds < 1 || microseconds > 0xff_ff_ff) {
                throw new Error(`MIDI 无法表示速度 ${event.bpm} BPM`);
            }
        } else if (event.kind === "time-signature") {
            if (event.at.isZero()) hasInitialTimeSignature = true;
            if (!Number.isSafeInteger(event.numerator)
                || event.numerator < 1 || event.numerator > 0xff) {
                throw new Error(`MIDI 拍号分子必须在 1..255，无法导出 ${event.numerator}/${event.denominator}`);
            }
            if (!Number.isSafeInteger(event.denominator)
                || event.denominator <= 0
                || !Number.isInteger(Math.log2(event.denominator))) {
                throw new Error(`MIDI 拍号分母必须是 2 的幂，无法导出 ${event.numerator}/${event.denominator}`);
            }
        }
    }
    return { hasInitialTempo, hasInitialTimeSignature };
}

export async function createMidiBlob(
    plan: PlaybackPlan,
    settings: readonly PlaybackTrackSettings[],
): Promise<Blob> {
    const initial = validatePlan(plan);
    await loadClassicScript(MIDI_URL);
    if (typeof mtrk !== "function" || typeof midiEvent !== "function") {
        throw new Error("midi.js 未提供预期的导出类");
    }

    const conductorEvents: MidiEventLike[] = [];
    if (!initial.hasInitialTempo) {
        conductorEvents.push(midiEvent.tempo(0, DEFAULT_BPM));
    }
    if (!initial.hasInitialTimeSignature) {
        conductorEvents.push(midiEvent.time_signature(0, ...DEFAULT_TIME_SIGNATURE));
    }
    const tracks = Array.from({ length: plan.tracks.length }, (_, index) => new mtrk(`声部 ${index + 1}`));

    for (let index = 0; index < plan.tracks.length; index++) {
        const setting = settings[index] ?? { program: 0, volume: 100 };
        tracks[index].addEvent({
            ticks: 0,
            code: 0xc,
            value: [Math.round(constrain(setting.program, 0, 127))],
        });
        tracks[index].addEvent({
            ticks: 0,
            code: 0xb,
            value: [7, Math.round(constrain(setting.volume, 0, 100) * 127 / 100)],
        });
    }

    for (const event of plan.events) {
        const ticks = tickOf(event.at);
        if (event.kind === "tempo") {
            conductorEvents.push(midiEvent.tempo(ticks, event.bpm));
        } else if (event.kind === "time-signature") {
            conductorEvents.push(midiEvent.time_signature(
                ticks,
                event.numerator,
                event.denominator,
            ));
        } else {
            tracks[event.track].addEvent({
                ticks,
                code: 0x9,
                value: [
                    Math.round(constrain(event.midi, 0, 127)),
                    event.kind === "note-on" ? Math.round(constrain(event.velocity, 0, 127)) : 0,
                ],
            });
        }
    }
    conductorEvents.push(new midiEvent({
        ticks: tickOf(plan.performanceDuration),
        code: 0xff01,
        value: [],
    }));

    const trackData = [new mtrk("", conductorEvents).export(0)];
    for (const [index, track] of tracks.entries()) trackData.push(track.export(index));
    const header = [
        77, 84, 104, 100, 0, 0, 0, 6, 0, 1,
        ...mtrk.number_hex(trackData.length, 2),
        ...mtrk.number_hex(PPQ, 2),
    ];
    const bytes = new Uint8Array(header.length + trackData.reduce((sum, track) => sum + track.length, 0));
    bytes.set(header);
    let offset = header.length;
    for (const track of trackData) {
        bytes.set(track, offset);
        offset += track.length;
    }
    return new Blob([bytes.buffer], { type: "audio/midi" });
}