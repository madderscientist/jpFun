import type { PlaybackNote, PlaybackTransform } from "../../playback/types.js";

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
 * 按调内音级模式拆分传入音段，使用结构完成后的范围和最终播放速度
 *
 * 重复式模式按速度计算次数，固定模式在整段时值内均分。
 * 派生音段继承轨道和来源，仍只声明音段，不直接发布 NoteOn/NoteOff。
 */
export function ornament(pattern: OrnamentPattern): PlaybackTransform {
    return (context, owned) => {
        const result: PlaybackNote[] = [];
        // 前一项声音变换可能已产生多个音段，因此逐段处理，不能假定只剩一个宿主音。
        for (const note of owned) {
            // 缺少调内移调能力的目标原样保留，例如固定打击音。
            if (!note.transpose) {
                result.push(note);
                continue;
            }
            const duration = note.end.clone().sub(note.start);
            // 此处读取最终速度，结构延长和其他声部的速度效果都已计入。
            const bpm = context.stateAt(note.start).effectiveBpm;
            const steps = pattern.repeat ? repeatToFill(pattern.body, duration.toNumber(), bpm) : pattern.body;
            const step = duration.div(steps.length);
            // 用 Fraction 等分最终区间，保证首尾边界准确且不会积累浮点时间误差。
            for (let index = 0; index < steps.length; index++) {
                const offset = steps[index];
                const start = note.start.clone().add(step.clone().mul(index));
                result.push({
                    ...note,
                    start,
                    end: start.clone().add(step),
                    // 本音保留主体的临时升降号，只有偏移音才走调内换算
                    midi: offset === 0 ? note.midi : note.transpose(offset),
                    // 后续 ornament 要从这个派生音继续移调，不能仍以最初的宿主为基准
                    transpose: delta => note.transpose!(offset + delta),
                });
            }
        }
        return result;
    };
}

/** 按最终速度计算完整音型的重复次数，并限制总子音数 */
function repeatToFill(body: readonly number[], duration: number, bpm: number): number[] {
    // 名义密度与速度无关（秒数里的 bpm 与频率里的 bpm 恰好抵消），只在 bpm 越界时按比例修正
    const ratio = Math.min(MAX_BPM, Math.max(MIN_BPM, bpm)) / bpm;
    // 预算按完整音型计算，避免在达到子音上限时留下半个音型。
    const limit = Math.floor(MAX_SUBNOTES / body.length);
    const cycles = Math.min(limit, Math.max(1, Math.round(duration * NOMINAL_RATE * ratio / body.length)));
    const result: number[] = [];
    // 先得到完整音级序列，调用方再按实际子音总数统一分配宿主时值。
    for (let i = 0; i < cycles; i++) result.push(...body);
    return result;
}
