import { DEFAULT_BPM } from "../functions/temporal.js";
import type { PlaybackEvent, PlaybackPlan, PlaybackScorePoint } from "./types.js";

/** 演奏时间（QN）按分段速度积分为秒 */
export function performanceTimeToSeconds(events: readonly PlaybackEvent[], performanceTime: number): number {
    const target = Math.max(0, performanceTime);
    let seconds = 0;
    let position = 0;
    let bpm = DEFAULT_BPM;

    for (const event of events) {
        if (event.kind !== "tempo") continue;
        const next = event.at.toNumber();
        if (next > target) break;
        if (next > position) seconds += (next - position) * 60 / bpm;
        position = next;
        bpm = event.bpm;
    }
    return seconds + (target - position) * 60 / bpm;
}

export function secondsToPerformanceTime(events: readonly PlaybackEvent[], seconds: number): number {
    let remaining = Math.max(0, seconds);
    let position = 0;
    let bpm = DEFAULT_BPM;

    for (const event of events) {
        if (event.kind !== "tempo") continue;
        const next = event.at.toNumber();
        const segmentSeconds = (next - position) * 60 / bpm;
        if (remaining < segmentSeconds) return position + remaining * bpm / 60;
        remaining -= segmentSeconds;
        position = next;
        bpm = event.bpm;
    }
    return position + remaining * bpm / 60;
}

/** 演奏进度换算为谱面进度 */
export function performanceTimeToScoreTime(scoreMap: readonly PlaybackScorePoint[], performanceTime: number): number {
    const target = Math.max(0, performanceTime);
    let result = target;
    for (const point of scoreMap) {
        const performance = point.performance.toNumber();
        if (performance > target) break;
        result = point.score.toNumber() + target - performance;
    }
    return result;
}

/**
 * 谱面位置换算为演奏时间，供“点击谱面从这里播放”使用
 *
 * 反复让同一个谱面位置对应多段演奏时间，这里取最早的一遍。
 */
export function scoreTimeToPerformanceTime(scoreMap: readonly PlaybackScorePoint[], scoreTime: number): number {
    const target = Math.max(0, scoreTime);
    let nextReachable: PlaybackScorePoint | undefined;
    for (let i = 0; i < scoreMap.length; i++) {
        const point = scoreMap[i];
        const score = point.score.toNumber();
        if (score > target) {
            if (!nextReachable || score < nextReachable.score.toNumber()) nextReachable = point;
            continue;
        }
        const next = scoreMap[i + 1];
        const span = next ? next.performance.toNumber() - point.performance.toNumber() : Infinity;
        if (target - score >= span) continue;
        return point.performance.toNumber() + (target - score);
    }
    return nextReachable?.performance.toNumber() ?? target;
}

export function secondsToScoreTime(plan: PlaybackPlan, seconds: number): number {
    const performance = Math.min(
        secondsToPerformanceTime(plan.events, seconds),
        plan.performanceDuration.toNumber(),
    );
    return performanceTimeToScoreTime(plan.scoreMap, performance);
}

export function scoreTimeToSeconds(plan: PlaybackPlan, scoreTime: number): number {
    const performance = Math.min(
        scoreTimeToPerformanceTime(plan.scoreMap, scoreTime),
        plan.performanceDuration.toNumber(),
    );
    return performanceTimeToSeconds(plan.events, performance);
}