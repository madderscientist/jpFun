import { scoreTimeToSeconds, secondsToScoreTime, type PlaybackPlan } from "jpfun";
import { createMidiBlob } from "./midi-export.js";
import { requiredElement } from "./platform.js";
import {
    loadTinySynth,
    TinySynthPlayer,
    type PlaybackTrackSettings,
} from "./tiny-synth.js";

interface PlaybackControllerOptions {
    requestPlan(): boolean | Promise<boolean>;
    showDiagnostics(): void;
    getFileName(): string;
    onScorePosition(scoreTime: number | null): void;
}

type PlaybackStatus = "idle" | "loading" | "ready" | "warning" | "error";
const CURSOR_UPDATE_INTERVAL = 80;

export interface PlaybackController {
    readonly active: boolean;
    readonly hasPlan: boolean;
    setActive(active: boolean): void;
    setPlan(plan: PlaybackPlan): void;
    setCompileError(message: string, hasDiagnostic: boolean): void;
    setScoreError(message: string): void;
    seekScoreTime(scoreTime: number): void;
    downloadMidi(): Promise<void>;
    invalidate(): void;
    destroy(): void;
}

function constrain(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function formatTime(value: number) {
    const seconds = Math.max(0, Math.floor(value));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function messageOf(error: unknown) {
    if (error instanceof Error) return error.message;
    return String(error);
}

function midiName(fileName: string) {
    const base = fileName.replace(/\.[^.]*$/, "") || "score";
    return `${base}.mid`;
}

export function createPlaybackController(options: PlaybackControllerOptions): PlaybackController {
    const status = requiredElement<HTMLButtonElement>("#playbackStatus");
    const currentTime = requiredElement<HTMLElement>("#playbackCurrentTime");
    const totalTime = requiredElement<HTMLElement>("#playbackTotalTime");
    const restartButton = requiredElement<HTMLButtonElement>("#playbackRestart");
    const toggleButton = requiredElement<HTMLButtonElement>("#playbackToggle");
    const stopButton = requiredElement<HTMLButtonElement>("#playbackStop");
    const progress = requiredElement<HTMLInputElement>("#playbackProgress");
    const rateInput = requiredElement<HTMLInputElement>("#playbackRate");
    const rateOutput = requiredElement<HTMLOutputElement>("#playbackRateValue");
    const transposeInput = requiredElement<HTMLInputElement>("#playbackTranspose");
    const mixerSection = requiredElement<HTMLElement>("#mixerSection");
    const mixerSummary = requiredElement<HTMLElement>("#mixerSummary");
    const mixerTracks = requiredElement<HTMLElement>("#mixerTracks");

    let isActive = false;
    let plan: PlaybackPlan | null = null;
    let settings: PlaybackTrackSettings[] = [];
    let instruments: readonly string[] = ["Acoustic Grand Piano"];
    let frame: number | undefined;
    let cursorUpdatedAt = -Infinity;
    let statusHasDiagnostics = false;
    let showProgress = false;
    let audioAvailable: boolean | null = null;
    let audioError = "";

    const player = new TinySynthPlayer({
        onStateChange: renderTransport,
        onError(error) {
            audioAvailable = false;
            audioError = `播放失败：${messageOf(error)}`;
            showProgress = false;
            setStatus("error", audioError);
            renderTransport();
        },
    });

    function setStatus(
        state: PlaybackStatus,
        text: string,
        hasDiagnostics = false,
    ) {
        statusHasDiagnostics = hasDiagnostics;
        status.dataset.state = state;
        status.textContent = text;
        status.title = hasDiagnostics ? "查看诊断" : text;
        status.disabled = !hasDiagnostics;
    }

    function showPlanStatus(readyText = "演奏计划已就绪") {
        if (!plan || audioAvailable === false) return;
        setStatus(plan.diagnostics.length > 0 ? "warning" : "ready",
            plan.diagnostics.length > 0 ? `播放警告 ${plan.diagnostics.length} 条` : readyText,
            plan.diagnostics.length > 0);
    }

    function renderClock(updateCursor = true) {
        const position = player.position;
        const text = formatTime(position);
        if (currentTime.textContent !== text) currentTime.textContent = text;
        if (!progress.matches(":active")) progress.value = String(position);
        if (updateCursor) {
            cursorUpdatedAt = performance.now();
            options.onScorePosition(showProgress && plan ? secondsToScoreTime(plan, position) : null);
        }
    }

    function renderTransport() {
        window.cancelAnimationFrame(frame ?? 0);
        frame = void 0;
        const available = plan !== null && audioAvailable === true;
        restartButton.disabled = !available;
        toggleButton.disabled = !available;
        stopButton.disabled = !available;
        progress.disabled = !available;
        rateInput.disabled = !available;
        transposeInput.disabled = !available;
        toggleButton.textContent = player.isPlaying ? "Ⅱ" : "▶";
        toggleButton.title = player.isPlaying ? "暂停" : "播放";
        toggleButton.setAttribute("aria-label", toggleButton.title);
        totalTime.textContent = formatTime(player.duration);
        progress.max = String(player.duration || 0);
        if (!player.isPlaying && player.duration > 0 && player.position >= player.duration) {
            showProgress = false;
        }
        renderClock();

        if (player.isPlaying) {
            const update = (time: number) => {
                renderClock(time - cursorUpdatedAt >= CURSOR_UPDATE_INTERVAL);
                if (player.isPlaying) frame = window.requestAnimationFrame(update);
            };
            frame = window.requestAnimationFrame(update);
        }
    }

    function renderMixer() {
        mixerSection.hidden = !plan;
        mixerSummary.textContent = `${plan?.tracks.length ?? 0} 声部`;
        mixerTracks.replaceChildren();
        if (!plan) return;

        for (let index = 0; index < plan.tracks.length; index++) {
            const setting = settings[index];
            const strip = document.createElement("div");
            strip.className = "voice-strip";

            const title = document.createElement("div");
            title.className = "voice-title";
            const strong = document.createElement("strong");
            strong.textContent = `声部 ${index + 1}`;
            const instrumentName = document.createElement("span");
            instrumentName.textContent = setting.overrideProgram
                ? instruments[setting.program] ?? `音色 ${setting.program + 1}`
                : "按谱面";
            title.append(strong, instrumentName);

            const actions = document.createElement("div");
            actions.className = "voice-actions";
            const mute = document.createElement("button");
            mute.type = "button";
            mute.textContent = "M";
            mute.title = `静音声部 ${index + 1}`;
            mute.setAttribute("aria-pressed", String(setting.muted));
            mute.addEventListener("click", () => {
                setting.muted = !setting.muted;
                mute.setAttribute("aria-pressed", String(setting.muted));
                void player.updateTrackSettings(settings, false);
            });
            const solo = document.createElement("button");
            solo.type = "button";
            solo.textContent = "S";
            solo.title = `独奏声部 ${index + 1}`;
            solo.setAttribute("aria-pressed", String(setting.solo));
            solo.addEventListener("click", () => {
                setting.solo = !setting.solo;
                solo.setAttribute("aria-pressed", String(setting.solo));
                void player.updateTrackSettings(settings, false);
            });
            actions.append(mute, solo);

            const volumeLabel = document.createElement("label");
            volumeLabel.className = "range-label full";
            volumeLabel.append("音量");
            const volume = document.createElement("input");
            volume.type = "range";
            volume.min = "0";
            volume.max = "100";
            volume.value = String(setting.volume);
            volume.setAttribute("aria-label", `声部 ${index + 1} 音量`);
            const output = document.createElement("output");
            output.value = String(setting.volume);
            volume.addEventListener("input", () => {
                setting.volume = volume.valueAsNumber;
                output.value = volume.value;
                void player.updateTrackSettings(settings, false);
            });
            volumeLabel.append(volume, output);

            const instrumentLabel = document.createElement("label");
            instrumentLabel.className = "field-label";
            instrumentLabel.append("乐器");
            const instrument = document.createElement("select");
            instrument.setAttribute("aria-label", `声部 ${index + 1} 乐器`);
            const scoreProgram = document.createElement("option");
            scoreProgram.value = "";
            scoreProgram.textContent = "按谱面";
            instrument.append(scoreProgram);
            for (const [program, name] of instruments.entries()) {
                const item = document.createElement("option");
                item.value = String(program);
                item.textContent = `${program + 1}. ${name}`;
                instrument.append(item);
            }
            instrument.value = setting.overrideProgram ? String(setting.program) : "";
            instrument.addEventListener("change", () => {
                setting.overrideProgram = instrument.value !== "";
                if (setting.overrideProgram) setting.program = Number(instrument.value);
                instrumentName.textContent = setting.overrideProgram ? instruments[setting.program] : "按谱面";
                void player.updateTrackSettings(settings, true);
            });
            instrumentLabel.append(instrument);

            strip.append(title, actions, volumeLabel, instrumentLabel);
            mixerTracks.append(strip);
        }
    }

    async function activate() {
        audioAvailable = null;
        audioError = "";
        setStatus("loading", "正在准备播放");
        renderTransport();
        if (!await options.requestPlan()) return;
        try {
            instruments = await loadTinySynth();
            audioAvailable = true;
            renderMixer();
            renderTransport();
            showPlanStatus();
        } catch (error) {
            audioAvailable = false;
            audioError = `音源加载失败：${messageOf(error)}`;
            showProgress = false;
            setStatus("error", audioError);
            renderTransport();
        }
    }

    restartButton.addEventListener("click", () => {
        showProgress = true;
        void player.seek(0);
    });
    toggleButton.addEventListener("click", () => {
        if (player.isPlaying) player.pause();
        else {
            showProgress = true;
            void player.play();
        }
    });
    stopButton.addEventListener("click", () => {
        showProgress = false;
        player.stop();
    });
    progress.addEventListener("input", () => {
        currentTime.textContent = formatTime(progress.valueAsNumber);
    });
    progress.addEventListener("change", () => {
        showProgress = true;
        void player.seek(progress.valueAsNumber);
    });
    rateInput.addEventListener("input", () => {
        const value = constrain(rateInput.valueAsNumber || 1, 0.25, 4);
        rateOutput.value = `${value.toFixed(2)}×`;
    });
    rateInput.addEventListener("change", () => {
        const value = constrain(rateInput.valueAsNumber || 1, 0.25, 4);
        void player.setRate(value);
    });
    transposeInput.addEventListener("change", () => {
        const value = Math.round(constrain(transposeInput.valueAsNumber || 0, -24, 24));
        transposeInput.value = String(value);
        void player.setTranspose(value);
    });
    status.addEventListener("click", () => {
        if (statusHasDiagnostics) options.showDiagnostics();
    });
    async function downloadMidi() {
        if (!plan && !await options.requestPlan()) {
            throw new Error("当前没有可导出的演奏计划");
        }
        if (!plan) throw new Error("当前没有可导出的演奏计划");
        try {
            const fileName = midiName(options.getFileName());
            const blob = await createMidiBlob(plan, settings);
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = fileName;
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 0);
            if (audioAvailable !== false) showPlanStatus("MIDI 已生成");
        } catch (error) {
            setStatus("error", `MIDI 导出失败：${messageOf(error)}`);
            throw error;
        }
    }

    renderTransport();
    renderMixer();

    return {
        get active() { return isActive; },
        get hasPlan() { return plan !== null; },
        setActive(active) {
            if (isActive === active) return;
            isActive = active;
            if (active) void activate();
        },
        setPlan(nextPlan) {
            showProgress = false;
            plan = nextPlan;
            settings = Array.from({ length: plan.tracks.length }, () => ({
                program: 0,
                overrideProgram: false,
                volume: 100,
                muted: false,
                solo: false,
            }));
            player.setPlan(plan, settings);
            if (audioAvailable === true) renderMixer();
            if (audioAvailable === true) showPlanStatus();
            else if (audioAvailable === false) setStatus("error", audioError);
        },
        setCompileError(message, hasDiagnostic) {
            showProgress = false;
            plan = null;
            player.clearPlan();
            renderMixer();
            setStatus("error", message, hasDiagnostic);
        },
        setScoreError(message) {
            showProgress = false;
            plan = null;
            player.clearPlan();
            renderMixer();
            setStatus("error", message);
        },
        seekScoreTime(scoreTime) {
            if (!plan) return;
            showProgress = true;
            void player.seek(scoreTimeToSeconds(plan, scoreTime));
        },
        downloadMidi,
        invalidate() {
            if (!plan && status.dataset.state === "idle") return;
            showProgress = false;
            plan = null;
            player.clearPlan();
            renderMixer();
            setStatus("idle", "等待最新谱面排版");
        },
        destroy() {
            window.cancelAnimationFrame(frame ?? 0);
            options.onScorePosition(null);
            player.destroy();
        },
    };
}