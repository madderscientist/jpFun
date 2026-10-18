import { DEFAULT_BPM } from "../functions/temporal.js";
import type { PlaybackEvent, PlaybackPlan, PlaybackScorePoint } from "./types.js";

interface TempoSegment {
    performance: number;
    seconds: number;
    bpm: number;
}

const tempoSegmentsCache = new WeakMap<readonly PlaybackEvent[], readonly TempoSegment[]>();

/** 提取并缓存分段速度积分表，使帧级时间换算无需重复扫描全部音符事件 */
function tempoSegmentsOf(events: readonly PlaybackEvent[]): readonly TempoSegment[] {
    let segments = tempoSegmentsCache.get(events);
    if (segments) return segments;

    const built: TempoSegment[] = [{ performance: 0, seconds: 0, bpm: DEFAULT_BPM }];
    let seconds = 0;
    let position = 0;
    let bpm = DEFAULT_BPM;

    for (const event of events) {
        if (event.kind !== "tempo") continue;
        const next = event.at.toNumber();
        if (next > position) {
            seconds += (next - position) * 60 / bpm;
            position = next;
        }
        bpm = event.bpm;
        const last = built[built.length - 1];
        if (last.performance === position) last.bpm = bpm;
        else built.push({ performance: position, seconds, bpm });
    }
    tempoSegmentsCache.set(events, built);
    return built;
}

function stepAt<T>(items: readonly T[], target: number, valueOf: (item: T) => number): T {
    let low = 0;
    let high = items.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (valueOf(items[middle]) <= target) low = middle + 1;
        else high = middle;
    }
    return items[Math.max(0, low - 1)];
}

/** 演奏时间（QN）按分段速度积分为秒 */
export function performanceTimeToSeconds(events: readonly PlaybackEvent[], performanceTime: number): number {
    const target = Math.max(0, performanceTime);
    const segment = stepAt(tempoSegmentsOf(events), target, item => item.performance);
    return segment.seconds + (target - segment.performance) * 60 / segment.bpm;
}

export function secondsToPerformanceTime(events: readonly PlaybackEvent[], seconds: number): number {
    const target = Math.max(0, seconds);
    const segment = stepAt(tempoSegmentsOf(events), target, item => item.seconds);
    return segment.performance + (target - segment.seconds) * segment.bpm / 60;
}

/** 演奏进度换算为谱面进度 */
export function performanceTimeToScoreTime(scoreMap: readonly PlaybackScorePoint[], performanceTime: number): number {
    const target = Math.max(0, performanceTime);
    const point = stepAt(scoreMap, target, item => item.performance.toNumber());
    return point && point.performance.toNumber() <= target
        ? point.score.toNumber() + target - point.performance.toNumber()
        : target;
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