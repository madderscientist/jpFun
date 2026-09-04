import type { MidiJson } from "jpfun";
import { loadClassicScript } from "./platform.js";

const MIDI_URL = "https://madderscientist.github.io/noteDigger/lib/midi.js";

export interface MidiEventLike {
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

interface MidiFileConstructor {
    new(...args: unknown[]): unknown;
    import(data: Uint8Array): { JSON(): MidiJson } | null;
}

declare const mtrk: MidiTrackConstructor;
declare const midiEvent: MidiEventConstructor;
declare const midi: MidiFileConstructor;

export async function loadMidiApi() {
    await loadClassicScript(MIDI_URL);
    if (typeof mtrk !== "function" || typeof midiEvent !== "function" || typeof midi !== "function") {
        throw new Error("midi.js 未提供预期的 API");
    }
    return { mtrk, midiEvent, midi };
}