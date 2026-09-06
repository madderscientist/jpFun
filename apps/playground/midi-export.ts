import { DEFAULT_BPM, DEFAULT_PROGRAM, type PlaybackPlan } from "jpfun";
import { loadMidiApi, type MidiEventLike } from "./midi-api.js";
import type { PlaybackTrackSettings } from "./tiny-synth.js";

const PPQ = 480;
const DEFAULT_TIME_SIGNATURE = [4, 4] as const;

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
        } else if (event.kind === "program-change"
            && (!Number.isSafeInteger(event.program) || event.program < 0 || event.program > 127)) {
            throw new Error(`MIDI program 必须在 0..127，无法导出 ${event.program}`);
        }
    }
    return { hasInitialTempo, hasInitialTimeSignature };
}

export async function createMidiBlob(
    plan: PlaybackPlan,
    settings: readonly PlaybackTrackSettings[],
): Promise<Blob> {
    const initial = validatePlan(plan);
    const { mtrk, midiEvent } = await loadMidiApi();

    const conductorEvents: MidiEventLike[] = [];
    if (!initial.hasInitialTempo) {
        conductorEvents.push(midiEvent.tempo(0, DEFAULT_BPM));
    }
    if (!initial.hasInitialTimeSignature) {
        conductorEvents.push(midiEvent.time_signature(0, ...DEFAULT_TIME_SIGNATURE));
    }
    const percussionIds = new Set<number>();
    const programTracks = new Set<number>();
    const tracks = new Array<InstanceType<typeof mtrk> | undefined>(plan.tracks.length);
    for (const event of plan.events) {
        if (event.kind === "program-change") programTracks.add(event.track);
        else if (event.kind === "note-on") {
            if (event.percussion) percussionIds.add(event.noteId);
            else tracks[event.track] ??= new mtrk(`声部 ${event.track + 1}`);
        }
    }
    let percussionTrack: InstanceType<typeof mtrk> | undefined;

    for (let index = 0; index < plan.tracks.length; index++) {
        const track = tracks[index];
        if (!track) continue;
        const setting = settings[index] ?? { program: DEFAULT_PROGRAM, overrideProgram: false, volume: 100 };
        if (setting.overrideProgram || !programTracks.has(index)) {
            track.addEvent({
                ticks: 0,
                code: 0xc,
                value: [Math.round(constrain(setting.program, 0, 127))],
            });
        }
        track.addEvent({
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
        } else if (event.kind === "program-change") {
            if (!settings[event.track]?.overrideProgram) tracks[event.track]?.addEvent({
                ticks,
                code: 0xc,
                value: [event.program],
            });
        } else {
            let track = tracks[event.track];
            let velocity = event.kind === "note-on" ? Math.round(constrain(event.velocity, 0, 127)) : 0;
            if (percussionIds.has(event.noteId)) {
                const volume = constrain(settings[event.track]?.volume ?? 100, 0, 100) / 100;
                if (volume === 0) continue;
                if (!percussionTrack) {
                    percussionTrack = new mtrk("打击乐");
                    percussionTrack.addEvent({ ticks: 0, code: 0xb, value: [7, 127] });
                }
                track = percussionTrack;
                if (event.kind === "note-on") velocity = constrain(Math.round(event.velocity * volume), 1, 127);
            }
            track!.addEvent({
                ticks,
                code: 0x9,
                value: [Math.round(constrain(event.midi, 0, 127)), velocity],
            });
        }
    }
    conductorEvents.push(new midiEvent({
        ticks: tickOf(plan.performanceDuration),
        code: 0xff01,
        value: [],
    }));

    const trackData = [new mtrk("", conductorEvents).export(0)];
    for (const [index, track] of tracks.entries()) {
        const slot = index % 15;
        const channelId = Math.floor(index / 15) * 16 + slot + (slot >= 9 ? 1 : 0);
        if (track) trackData.push(track.export(channelId));
    }
    if (percussionTrack) trackData.push(percussionTrack.export(9));
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