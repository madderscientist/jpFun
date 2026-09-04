/**
 * MIDI 3:2 三连音识别器
 *
 * 本模块只在原始 tick 时间线上标记三连音，不负责二进制量化或 jpFun 输出。
 * 调用方随后把三个槽折叠成一个 QuantizedTriplet，并输出 @tuplet(..., 2)。
 */
export interface TripletMark {
    group: number;
    slot: number;
    startTicks: number;
    spanTicks: number;
}

interface TripletNote {
    ticks: number;
    durationTicks: number;
    triplet?: TripletMark;
}

function lowerBound<T>(items: readonly T[], target: number, valueOf: (item: T) => number) {
    let left = 0;
    let right = items.length;
    while (left < right) {
        const middle = Math.floor((left + right) / 2);
        if (valueOf(items[middle]) < target) left = middle + 1;
        else right = middle;
    }
    return left;
}

/**
 * 标记四分、八分和十六分的 3:2 三连音。
 *
 * 每个候选必须同时满足：三个槽都有音符、起点和时值都接近三分网格、
 * 三分网格明显优于四等分网格，并且整组不跨小节、拍号或速度变化。
 * 和弦按一个槽评分，不会因为某个槽音符更多而改变判断。
 *
 * 返回 true 表示至少命中一组；命中的 note 会原地写入 triplet 标记。
 */
export function identifyTriplets<T extends TripletNote>(
    tracks: readonly { notes: T[] }[],
    ticksPerQuarter: number,
    blockers: readonly number[],
) {
    // 人工演奏容差随 PPQ 缩放，但不会超过单个三连槽宽的 1/8。
    const performanceTolerance = Math.max(1, Math.round(ticksPerQuarter / 48));
    const candidates: { notes: T[][]; start: number; span: number; advantage: number }[] = [];
    const orderedBlockers = [...blockers].sort((left, right) => left - right);
    for (const track of tracks) {
        const notes = [...track.notes].sort((left, right) => left.ticks - right.ticks);
        for (const span of [ticksPerQuarter / 2, ticksPerQuarter, ticksPerQuarter * 2]) {
            const unit = span / 3;
            const tolerance = Math.min(performanceTolerance, unit / 8);
            const startStep = span / 2;
            const starts = new Set(notes.map(note => Math.round(note.ticks / startStep) * startStep)
                .filter((start, index) => Math.abs(notes[index].ticks - start) <= tolerance));
            for (const start of starts) {
                const end = start + span;
                let blockerIndex = lowerBound(orderedBlockers, start, value => value);
                while (orderedBlockers[blockerIndex] === start) blockerIndex++;
                if (orderedBlockers[blockerIndex] < end) continue;
                const slots = [0, 1, 2].map(slot => {
                    const target = start + slot * unit;
                    const from = lowerBound(notes, target - tolerance, note => note.ticks);
                    const to = lowerBound(notes, target + tolerance + 1, note => note.ticks);
                    return notes.slice(from, to).filter(note =>
                        Math.abs(note.ticks - target) <= tolerance
                        && Math.abs(note.durationTicks - unit) <= tolerance);
                });
                if (slots.some(slot => slot.length === 0)) continue;
                const onsets = slots.map(slot => slot.reduce((sum, note) => sum + note.ticks, 0) / slot.length);
                const tripletError = onsets.reduce((sum, onset, slot) =>
                    sum + Math.abs(onset - (start + slot * unit)), 0) / 3;
                const binaryStep = span / 4;
                const binaryError = onsets.reduce((sum, onset) =>
                    sum + Math.abs(onset - (start + Math.round((onset - start) / binaryStep) * binaryStep)), 0) / 3;
                if (binaryError - tripletError >= tolerance) {
                    candidates.push({ notes: slots, start, span, advantage: binaryError - tripletError });
                }
            }
        }
    }
    // 重叠候选先采用相对普通网格优势更大的那一组，每个 note 最多归属一组。
    candidates.sort((left, right) => right.advantage - left.advantage);
    let group = 0;
    for (const candidate of candidates) {
        if (candidate.notes.some(slot => slot.some(note => note.triplet))) continue;
        for (let slot = 0; slot < 3; slot++) {
            for (const note of candidate.notes[slot]) {
                note.triplet = { group, slot, startTicks: candidate.start, spanTicks: candidate.span };
            }
        }
        group++;
    }
    return group > 0;
}
