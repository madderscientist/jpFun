import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScore, compilePlayback } from "../../../packages/jpfun/src/index.ts";
import { loadTinySynth, TinySynthPlayer } from "../tiny-synth.ts";
import { createMidiBlob } from "../midi-export.ts";

class MidiEventStub {
    constructor(event) { Object.assign(this, event); }
    static tempo(ticks, bpm) { return { ticks, code: 0xff51, value: [bpm] }; }
    static time_signature(ticks, numerator, denominator) {
        return { ticks, code: 0xff58, value: [numerator, denominator] };
    }
}

class MidiTrackStub {
    static exported = [];
    static number_hex(value, length) {
        return Array.from({ length }, (_, index) => (value >>> ((length - index - 1) * 8)) & 255);
    }
    constructor(name, events = []) {
        this.name = name;
        this.events = [...events];
    }
    addEvent(event) { this.events.push(event); }
    export(channelId) {
        MidiTrackStub.exported.push({ channelId, name: this.name, events: this.events });
        return [77, 84, 114, 107, 0, 0, 0, 4, 0, 255, 47, 0];
    }
}

globalThis.mtrk = MidiTrackStub;
globalThis.midiEvent = MidiEventStub;
globalThis.midi = class {};

class AudioContextStub {
    currentTime = 0;
    async resume() {}
}

class TinySynthStub {
    static instrument = Array.from({ length: 128 }, (_, index) => `Instrument ${index}`);
    static wave = Array.from({ length: 128 }, () => []);
    static instances = [];
    channel = [];
    calls = [];
    stops = 0;

    constructor(context) {
        this.audioContext = context;
        TinySynthStub.instances.push(this);
    }

    addChannel(at, instrument, gain = 1) {
        const channel = { instrument, out: { gain: { value: gain } } };
        this.channel.splice(at, 0, channel);
        return channel;
    }

    play(options) {
        this.calls.push({ ...options, instrument: this.channel[options.id].instrument });
    }

    stopAll() { this.stops++; }
}

globalThis.TinySynth = TinySynthStub;
globalThis.window = {
    AudioContext: AudioContextStub,
    setInterval: () => 1,
    clearInterval() {},
};
globalThis.document = {
    createElement: () => new EventTarget(),
    head: { append: script => queueMicrotask(() => script.dispatchEvent(new Event("load"))) },
};

function planOf(source) {
    return compilePlayback(compileScore(source).lowering);
}

function settingsFor(plan) {
    return plan.tracks.map(() => ({ program: 0, overrideProgram: false, volume: 100, muted: false, solo: false }));
}

function playerFor(context, plan, settings = settingsFor(plan)) {
    const player = new TinySynthPlayer({ onStateChange() {}, onError: error => { throw error; } });
    context.after(() => player.destroy());
    player.setPlan(plan, settings);
    return player;
}

test("percussion timbre registration is idempotent and hidden from the program menu", async () => {
    const instruments = await loadTinySynth();
    const wave = TinySynthStub.wave[128];
    await loadTinySynth();
    assert.equal(instruments.length, 128);
    assert.equal(TinySynthStub.instrument.length, 129);
    assert.equal(TinySynthStub.wave[128], wave);
    assert.equal(wave[0].t, 0);
    assert.equal(wave[0].s, 0);
    assert.ok(wave[0].d < 0.01);
});

test("mixed notes reuse one channel while percussion ignores program and transpose", async context => {
    const plan = planOf("@program(24) 1 9 - 2");
    const settings = settingsFor(plan);
    const player = playerFor(context, plan, settings);
    await player.setRate(4);
    await player.setTranspose(12);
    await player.play();
    const synth = TinySynthStub.instances.at(-1);
    assert.deepEqual(synth.calls.map(call => call.instrument), [24, 128, 24]);
    assert.deepEqual(synth.calls.map(call => call.id), [0, 0, 0]);
    assert.equal(synth.calls[0].f, 440 * 2 ** ((72 - 69) / 12));
    assert.equal(synth.calls[1].f, 440 * 2 ** ((37 - 69) / 12));
    assert.equal(synth.calls[1].last, 0.025);
    settings[0].program = 11;
    settings[0].overrideProgram = true;
    await player.updateTrackSettings(settings, true);
    assert.deepEqual(synth.calls.slice(-3).map(call => call.instrument), [11, 128, 11]);
    const stops = synth.stops;
    player.pause();
    assert.equal(synth.stops, stops + 1);
    assert.equal(player.isPlaying, false);
});

test("percussion keeps independent source-track mixer gains", async context => {
    const plan = planOf("@stack({9 -}, {9 -})");
    const settings = settingsFor(plan);
    const player = playerFor(context, plan, settings);
    await player.play();
    const synth = TinySynthStub.instances.at(-1);
    assert.deepEqual(synth.calls.map(call => call.id), [0, 1]);
    settings[0].muted = true;
    settings[1].volume = 40;
    await player.updateTrackSettings(settings, false);
    assert.deepEqual(synth.channel.map(channel => channel.out.gain.value), [0, 0.4]);
    settings[0].muted = false;
    settings[0].solo = true;
    await player.updateTrackSettings(settings, false);
    assert.deepEqual(synth.channel.map(channel => channel.out.gain.value), [1, 0]);
});

test("seeking or resuming inside a percussion sustain does not retrigger the attack", async context => {
    const player = playerFor(context, planOf("9 - - 1"));
    await player.setRate(4);
    player.seek(0.75);
    await player.play();
    const synth = TinySynthStub.instances.at(-1);
    assert.deepEqual(synth.calls.map(call => call.instrument), [0]);
    player.pause();
    await player.play();
    assert.deepEqual(synth.calls.map(call => call.instrument), [0, 0]);
    player.seek(0);
    assert.deepEqual(synth.calls.slice(-2).map(call => call.instrument), [128, 0]);
});

async function exportedTracks(plan, settings = settingsFor(plan)) {
    MidiTrackStub.exported.length = 0;
    const blob = await createMidiBlob(plan, settings);
    assert.equal(blob.type, "audio/midi");
    return [...MidiTrackStub.exported];
}

test("MIDI routes both drum edges to channel 10 without changing source tracks", async () => {
    const plan = planOf("@program(24) 1 9 - 2");
    const before = JSON.stringify(plan.events);
    const settings = settingsFor(plan);
    settings[0].volume = 50;
    const tracks = await exportedTracks(plan, settings);
    assert.equal(plan.tracks.length, 1);
    assert.equal(JSON.stringify(plan.events), before);
    assert.deepEqual(tracks.map(track => track.channelId), [0, 0, 9]);
    const drum = tracks.at(-1);
    assert.deepEqual(drum.events, [
        { ticks: 0, code: 0xb, value: [7, 127] },
        { ticks: 480, code: 0x9, value: [37, 40] },
        { ticks: 1440, code: 0x9, value: [37, 0] },
    ]);
    assert.equal(tracks[1].events.filter(event => event.code === 0x9).length, 4);
    assert.ok(tracks[1].events.some(event => event.code === 0xc && event.value[0] === 24));
    assert.ok(tracks[0].events.some(event => event.code === 0xff01 && event.ticks === 1920));
});

test("MIDI omits empty melodic and silent drum tracks and does not bake in mute/solo", async () => {
    const plan = planOf("9 -");
    const settings = settingsFor(plan);
    settings[0].muted = true;
    settings[0].overrideProgram = true;
    settings[0].program = 42;
    const audible = await exportedTracks(plan, settings);
    assert.deepEqual(audible.map(track => track.channelId), [0, 9]);
    assert.ok(audible[1].events.every(event => event.code !== 0xc));
    settings[0].volume = 0;
    assert.equal((await exportedTracks(plan, settings)).length, 1);
    settings[0].volume = 0.01;
    const quiet = (await exportedTracks(plan, settings))[1].events.filter(event => event.code === 0x9);
    assert.deepEqual(quiet.map(event => event.value[1]), [1, 0]);
    assert.equal((await exportedTracks(planOf("0 8"))).length, 1);
    assert.deepEqual((await exportedTracks(planOf("1"))).map(track => track.channelId), [0, 0]);
});

test("MIDI shares one drum track but scales each source track independently", async () => {
    const plan = planOf("@stack({9 -}, {9 -})");
    const settings = settingsFor(plan);
    settings[0].volume = 25;
    settings[1].volume = 75;
    const tracks = await exportedTracks(plan, settings);
    assert.equal(tracks.length, 2);
    const starts = tracks[1].events.filter(event => event.code === 0x9 && event.value[1] > 0);
    assert.deepEqual(starts.map(event => event.value[1]), [20, 60]);
    assert.equal(tracks[1].events.filter(event => event.code === 0xb).length, 1);
});

test("MIDI reserves channel 10 in every port, not just the first", async () => {
    const plan = planOf(`@stack(${Array.from({ length: 31 }, () => "{1}").join(",")})`);
    const tracks = (await exportedTracks(plan)).slice(1);
    assert.equal(tracks.length, 31);
    assert.ok(tracks.every(track => track.channelId % 16 !== 9));
    assert.deepEqual([tracks[8], tracks[9], tracks[15], tracks[24], tracks[30]].map(track => track.channelId),
        [8, 10, 16, 26, 32]);
});

test("stop, clearPlan and destroy all stop pre-scheduled percussion", async context => {
    const plan = planOf("9 9 9");
    const player = playerFor(context, plan);
    for (const action of ["stop", "clearPlan", "destroy"]) {
        player.setPlan(plan, settingsFor(plan));
        await player.play();
        const synth = TinySynthStub.instances.at(-1);
        const stops = synth.stops;
        player[action]();
        assert.equal(synth.stops, stops + 1);
        assert.equal(player.isPlaying, false);
    }
});

test("overlapping percussion retains each note's own end on the shared MIDI channel", async () => {
    const tracks = await exportedTracks(planOf("@stack({9 - -}, {0 9})"));
    assert.equal(tracks.length, 2);
    assert.equal(tracks[1].channelId, 9);
    const notes = tracks[1].events.filter(event => event.code === 0x9);
    assert.deepEqual(notes.map(event => [event.ticks, event.value[1]]),
        [[0, 80], [480, 80], [960, 0], [1440, 0]]);
});