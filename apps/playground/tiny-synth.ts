import {
    DEFAULT_BPM,
    DEFAULT_PROGRAM,
    type PlaybackNoteOnEvent,
    type PlaybackPlan,
} from "jpfun";
import { loadClassicScript } from "./platform.js";

const TINY_SYNTH_URL = "https://madderscientist.github.io/noteDigger/lib/tinySynth.js";
const SCHEDULE_INTERVAL = 100;
const SCHEDULE_AHEAD_SECONDS = 1;
const START_LATENCY_SECONDS = 0.02;

interface TinySynthChannel {
    instrument: number;
    out: GainNode;
}

interface TinySynthInstance {
    readonly audioContext: AudioContext;
    readonly channel: TinySynthChannel[];
    addChannel(at?: number, instrument?: number, gain?: number): TinySynthChannel;
    play(options: { id: number; f: number; v: number; t: number; last: number }): unknown;
    stopAll(): void;
}

interface TinySynthConstructor {
    new(context?: AudioContext, loadAll?: boolean): TinySynthInstance;
    readonly instrument: readonly string[];
}

declare const TinySynth: TinySynthConstructor;

export interface PlaybackTrackSettings {
    program: number;
    overrideProgram: boolean;
    volume: number;
    muted: boolean;
    solo: boolean;
}

interface ScheduledNote {
    start: number;
    end: number;
    track: number;
    midi: number;
    velocity: number;
    program: number;
}

interface TinySynthPlayerOptions {
    onStateChange(): void;
    onError(error: unknown): void;
}

function constrain(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function audioContextConstructor() {
    return window.AudioContext
        ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

function notesOf(plan: PlaybackPlan): ScheduledNote[] {
    const active = new Map<number, { event: PlaybackNoteOnEvent; start: number; program: number }>();
    const notes: ScheduledNote[] = [];
    const programs = new Map<number, number>();
    let scoreTime = 0;
    let seconds = 0;
    let bpm = DEFAULT_BPM;
    for (const event of plan.events) {
        const at = event.at.toNumber();
        seconds += (at - scoreTime) * 60 / bpm;
        scoreTime = at;
        if (event.kind === "tempo") {
            bpm = event.bpm;
            continue;
        }
        if (event.kind === "program-change") {
            programs.set(event.track, event.program);
            continue;
        }
        if (event.kind === "note-on") {
            active.set(event.noteId, { event, start: seconds, program: programs.get(event.track) ?? DEFAULT_PROGRAM });
            continue;
        }
        if (event.kind !== "note-off") continue;
        const started = active.get(event.noteId);
        if (!started) continue;
        active.delete(event.noteId);
        notes.push({
            start: started.start,
            end: seconds,
            track: started.event.track,
            midi: started.event.midi,
            velocity: started.event.velocity,
            program: started.program,
        });
    }
    notes.sort((left, right) => left.start - right.start);
    return notes;
}

export async function loadTinySynth(): Promise<readonly string[]> {
    await loadClassicScript(TINY_SYNTH_URL);
    if (typeof TinySynth !== "function" || !Array.isArray(TinySynth.instrument)) {
        throw new Error("tinySynth.js 未提供预期的 TinySynth 类");
    }
    return TinySynth.instrument;
}

export class TinySynthPlayer {
    private notes: ScheduledNote[] = [];
    private durationSeconds = 0;
    private channelCount = 0;
    private settings: readonly PlaybackTrackSettings[] = [];
    private synth: TinySynthInstance | null = null;
    private timer: number | undefined;
    private nextNote = 0;
    private anchorContextTime = 0;
    private anchorPlanTime = 0;
    private pausedAt = 0;
    private rate = 1;
    private transpose = 0;
    private running = false;
    private starting = false;
    private operation = 0;

    constructor(private readonly options: TinySynthPlayerOptions) {}

    get isPlaying() { return this.running; }
    get duration() { return this.durationSeconds; }
    get position() {
        if (!this.running || !this.synth) return this.pausedAt;
        const position = Math.max(0, this.rawPosition());
        return constrain(position, 0, this.duration);
    }

    setPlan(plan: PlaybackPlan, settings: readonly PlaybackTrackSettings[]) {
        this.halt();
        this.pausedAt = 0;
        this.notes = notesOf(plan);
        this.durationSeconds = plan.durationSeconds;
        this.channelCount = plan.tracks.length;
        this.settings = settings;
        this.syncChannels();
        this.options.onStateChange();
    }

    clearPlan() {
        this.halt();
        this.pausedAt = 0;
        this.notes = [];
        this.durationSeconds = 0;
        this.channelCount = 0;
        this.options.onStateChange();
    }

    setRate(value: number) {
        return this.restartPlaying(() => {
            this.rate = constrain(value, 0.25, 4);
        });
    }

    setTranspose(value: number) {
        return this.restartPlaying(() => {
            this.transpose = Math.round(constrain(value, -24, 24));
        });
    }

    async updateTrackSettings(settings: readonly PlaybackTrackSettings[], restart: boolean) {
        if (!restart) {
            this.settings = settings;
            this.syncChannels();
            return;
        }
        await this.restartPlaying(() => {
            this.settings = settings;
            this.syncChannels();
        });
    }

    async play() {
        if (this.duration <= 0 || this.running || this.starting) return;
        const operation = ++this.operation;
        this.starting = true;
        try {
            await this.ensureSynth();
            if (operation !== this.operation || !this.synth) return;
            if (this.pausedAt >= this.duration) this.pausedAt = 0;
            await this.synth.audioContext.resume();
            if (operation !== this.operation) return;
            this.begin(this.pausedAt);
        } catch (error) {
            if (operation === this.operation) {
                this.halt();
                this.options.onError(error);
            }
        } finally {
            if (operation === this.operation) {
                this.starting = false;
            }
        }
    }

    pause() {
        if (!this.running) return;
        this.pausedAt = this.position;
        this.halt();
        this.options.onStateChange();
    }

    stop() {
        this.halt();
        this.pausedAt = 0;
        this.options.onStateChange();
    }

    seek(seconds: number) {
        const wasPlaying = this.running;
        this.halt();
        this.pausedAt = constrain(seconds, 0, this.duration);
        if (wasPlaying) {
            try {
                this.begin(this.pausedAt);
            } catch (error) {
                this.halt();
                this.options.onError(error);
            }
        } else this.options.onStateChange();
    }

    destroy() {
        this.halt();
        this.notes = [];
        this.durationSeconds = 0;
        this.channelCount = 0;
    }

    private async ensureSynth() {
        if (this.synth) return;
        await loadTinySynth();
        const Context = audioContextConstructor();
        if (!Context) throw new Error("当前浏览器不支持 Web Audio");
        this.synth = new TinySynth(new Context());
        this.syncChannels();
    }

    private async restartPlaying(update: () => void) {
        const wasPlaying = this.running;
        const position = this.position;
        if (wasPlaying) this.halt();
        update();
        this.pausedAt = position;
        if (wasPlaying) await this.play();
    }

    private syncChannels() {
        if (!this.synth) return;
        while (this.synth.channel.length < this.channelCount) {
            const index = this.synth.channel.length;
            this.synth.addChannel(index, this.settings[index]?.program ?? DEFAULT_PROGRAM);
        }
        const anySolo = this.settings.some(track => track.solo);
        for (let index = 0; index < this.synth.channel.length; index++) {
            const channel = this.synth.channel[index];
            const setting = this.settings[index];
            if (!setting) {
                channel.out.gain.value = 0;
                continue;
            }
            if (setting.overrideProgram) {
                channel.instrument = Math.round(constrain(setting.program, 0, 127));
            }
            const audible = !setting.muted && (!anySolo || setting.solo);
            channel.out.gain.value = audible ? constrain(setting.volume, 0, 100) / 100 : 0;
        }
    }

    private begin(position: number) {
        if (!this.synth || this.duration <= 0) return;
        window.clearInterval(this.timer);
        this.synth.stopAll();
        this.pausedAt = position;
        this.anchorPlanTime = position;
        this.anchorContextTime = this.synth.audioContext.currentTime + START_LATENCY_SECONDS;
        this.nextNote = this.firstNoteAt(position);
        this.running = true;

        for (let index = 0; index < this.nextNote; index++) {
            const note = this.notes[index];
            if (note.end > position) this.schedule(note, position);
        }
        this.fillSchedule();
        this.timer = window.setInterval(() => this.scheduleTick(), SCHEDULE_INTERVAL);
        this.options.onStateChange();
    }

    private halt() {
        this.operation++;
        this.starting = false;
        window.clearInterval(this.timer);
        this.timer = void 0;
        this.running = false;
        this.synth?.stopAll();
    }

    private scheduleTick() {
        try {
            this.fillSchedule();
        } catch (error) {
            this.halt();
            this.options.onError(error);
        }
    }

    private rawPosition() {
        if (!this.synth) return this.pausedAt;
        return this.anchorPlanTime
            + (this.synth.audioContext.currentTime - this.anchorContextTime) * this.rate;
    }

    private firstNoteAt(position: number) {
        let low = 0;
        let high = this.notes.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (this.notes[middle].start < position) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    private fillSchedule() {
        if (!this.running || !this.synth) return;
        const position = Math.max(0, this.rawPosition());
        if (position >= this.duration) {
            this.halt();
            this.pausedAt = this.duration;
            this.options.onStateChange();
            return;
        }

        const horizon = position + SCHEDULE_AHEAD_SECONDS * this.rate;
        while (this.nextNote < this.notes.length && this.notes[this.nextNote].start < horizon) {
            this.schedule(this.notes[this.nextNote++], position);
        }
    }

    private schedule(note: ScheduledNote, position: number) {
        if (!this.synth || note.end <= position) return;
        this.synth.channel[note.track].instrument = Math.round(constrain(
            this.settings[note.track]?.overrideProgram ? this.settings[note.track].program : note.program,
            0,
            127,
        ));
        const midi = Math.round(constrain(note.midi + this.transpose, 0, 127));
        const start = Math.max(position, note.start);
        const contextTime = Math.max(
            this.synth.audioContext.currentTime + START_LATENCY_SECONDS,
            this.anchorContextTime + (note.start - this.anchorPlanTime) / this.rate,
        );
        this.synth.play({
            id: note.track,
            f: 440 * 2 ** ((midi - 69) / 12),
            v: Math.round(constrain(note.velocity, 0, 127)),
            t: contextTime,
            last: (note.end - start) / this.rate,
        });
    }
}