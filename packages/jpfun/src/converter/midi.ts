/**
 * MIDI JSON -> jpFun 的转换流水线：
 * 1. 校验输入，选择足以表达原时值的二进制精度；
 * 2. 在原始 tick 上识别 3:2 三连音，再把其余音符量化到二进制网格；
 * 3. 合并同起止音为和弦，把重叠内容拆到不同 lane；
 * 4. 生成单行源码，以真实自然排版宽度选择换行点；
 * 5. 重新生成最终源码，并用 tie 表达跨小节或不足一拍的持续音。
 *
 * MIDI 字节解析不属于 core；这里接收的是 midi.js 已解析好的 JSON。
 */
import { ANCHOR_KEY } from "../functions/temporal.js";
import { DEFAULT_PAGE_CONFIG } from "../layout/page.js";
import { compileScore } from "../pipeline.js";
import { identifyTriplets, type TripletMark } from "./midi-triplet.js";
import { attachAbove, quote, renderHead, renderPitch, renderSystems, type PitchMode } from "./source.js";

export interface MidiJsonNote {
    ticks: number;
    durationTicks: number;
    midi: number;
    intensity: number;
}

export interface MidiJsonControlChange {
    ticks: number;
    controller: number;
    value: number;
}

export interface MidiJsonInstrument {
    ticks: number;
    number: number;
}

export interface MidiJsonTrack {
    channel: number;
    name: string;
    controlChanges: readonly MidiJsonControlChange[];
    instruments: readonly MidiJsonInstrument[];
    notes: readonly MidiJsonNote[];
}

export interface MidiJson {
    header: {
        name: string;
        tick: number;
        tempos: readonly { ticks: number; bpm: number }[];
        timeSignatures: readonly { ticks: number; timeSignature: readonly [number, number] }[];
    };
    tracks: readonly MidiJsonTrack[];
}

export interface MidiToJpFunOptions {
    pitchMode?: PitchMode;
    alignRate?: number;
    barsPerLine?: number;
    title?: string;
}

// 同一个音符在各阶段逐步补充信息，不复制或丢弃 intensity 等原始 MIDI 字段。
type SourceNote = MidiJsonNote & { divisions: number; triplet?: TripletMark };
type QuantizedNote = SourceNote & { start: number; end: number };

interface MeterPoint {
    at: number;
    numerator: number;
    denominator: number;
}

interface RawMeterPoint {
    ticks: number;
    numerator: number;
    denominator: number;
}

interface QuantizedChord {
    start: number;
    end: number;
    notes: QuantizedNote[];
    triplet?: TripletMark;
}

/** 已识别的三连音是一个原子时间范围，lane 分配不会把三个槽拆开。 */
interface QuantizedTriplet {
    start: number;
    end: number;
    members: QuantizedChord[];
}

type QuantizedItem = QuantizedChord | QuantizedTriplet;

interface Lane {
    items: QuantizedItem[];
}

interface TrackRegion {
    start: number;
    end: number;
    lanes: Lane[];
}

interface ConvertedTrack {
    source: MidiJsonTrack;
    regions: TrackRegion[];
    programs: ReadonlyMap<number, number>;
}

const DEFAULT_BPM = 120;
const DEFAULT_TIME_SIGNATURE = [4, 4] as const;
const AUTO_LINE_TARGET_RATIO = 1.03;
const AUTO_LINE_LIMIT_RATIO = 1.25;
const AUTO_LINE_UNDERFILL_PENALTY = 4;
const AUTO_LINE_MAX_BARS = 8;
const RELATIVE_NAMES = ["1", "1#", "2", "2#", "3", "4", "4#", "5", "5#", "6", "6#", "7"] as const;
const ABSOLUTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

function expectSafeInteger(value: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new RangeError(`${name} must be an integer in ${min}..${max}`);
    }
}

function expectArray(value: unknown, name: string): asserts value is readonly unknown[] {
    if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
}

function durationDivisions(durationTicks: number, ticksPerQuarter: number, alignRate: number) {
    let divisions = 1;
    while (ticksPerQuarter * alignRate > durationTicks * 2 ** divisions) divisions++;
    return divisions;
}

function coalesceSorted<T extends { at: number }>(items: readonly T[]) {
    const result = new Map<number, T>();
    for (const item of items) result.set(item.at, item);
    return [...result.values()];
}

function heapPush<T>(heap: T[], value: T, compare: (left: T, right: T) => number) {
    let index = heap.length;
    heap.push(value);
    while (index > 0) {
        const parent = (index - 1) >> 1;
        if (compare(heap[parent], value) <= 0) break;
        heap[index] = heap[parent];
        index = parent;
    }
    heap[index] = value;
}

function heapPop<T>(heap: T[], compare: (left: T, right: T) => number) {
    const result = heap[0];
    const value = heap.pop()!;
    if (heap.length === 0) return result;
    let index = 0;
    while (true) {
        const left = index * 2 + 1;
        if (left >= heap.length) break;
        const right = left + 1;
        const child = right < heap.length && compare(heap[right], heap[left]) < 0 ? right : left;
        if (compare(heap[child], value) >= 0) break;
        heap[index] = heap[child];
        index = child;
    }
    heap[index] = value;
    return result;
}

function noteName(midi: number, mode: PitchMode) {
    const pitchClass = midi % 12;
    const octave = Math.floor(midi / 12) - 1;
    const source = mode === "absolute" ? ABSOLUTE_NAMES[pitchClass] : RELATIVE_NAMES[pitchClass];
    return renderPitch({
        name: source[0],
        accidental: source.slice(1),
        octave: mode === "absolute" ? octave : octave - 4,
    }, mode);
}

function meterDuration(point: MeterPoint, scale: number) {
    return point.numerator * 4 * scale / point.denominator;
}

function pointAt<T extends { at: number }>(points: readonly T[], at: number) {
    let left = 0;
    let right = points.length - 1;
    while (left < right) {
        const middle = Math.ceil((left + right) / 2);
        if (points[middle].at <= at) left = middle;
        else right = middle - 1;
    }
    return points[left];
}

function quantizeTime(raw: number, divisions: number, meters: readonly MeterPoint[], scale: number) {
    const meter = pointAt(meters, raw);
    const measureLength = meterDuration(meter, scale);
    const measure = Math.max(0, Math.floor((raw - meter.at) / measureLength));
    const measureStart = meter.at + measure * measureLength;
    const step = scale / 2 ** divisions;
    return measureStart + Math.round((raw - measureStart) / step) * step;
}

/**
 * 把拍号变化吸附到最近的小节边界。
 * 后续量化、三连音 blocker 和小节线都共享这一份结果，避免各阶段边界不一致。
 */
function normalizeMeterTicks(points: readonly RawMeterPoint[], ticksPerQuarter: number) {
    const coalesced = new Map<number, RawMeterPoint>();
    for (const point of points) coalesced.set(point.ticks, point);
    const result: RawMeterPoint[] = [];
    for (const candidate of coalesced.values()) {
        const previous = result.at(-1);
        if (!previous) {
            result.push(candidate);
            continue;
        }
        const measureTicks = previous.numerator * 4 * ticksPerQuarter / previous.denominator;
        const count = Math.max(0, Math.round((candidate.ticks - previous.ticks) / measureTicks));
        const point = { ...candidate, ticks: previous.ticks + count * measureTicks };
        if (point.ticks === previous.ticks) result[result.length - 1] = point;
        else result.push(point);
    }
    return result;
}

/** 返回拍号变化之间所有真正的小节边界，三连音不能跨过这些位置。 */
function measureBoundaries(meters: readonly RawMeterPoint[], rawEnd: number, ticksPerQuarter: number) {
    const result: number[] = [];
    for (let index = 0; index < meters.length; index++) {
        const meter = meters[index];
        const next = meters[index + 1]?.ticks ?? rawEnd;
        const duration = meter.numerator * 4 * ticksPerQuarter / meter.denominator;
        for (let at = meter.ticks + duration; at < next && at < rawEnd; at += duration) result.push(at);
    }
    return result;
}

/** 同起点、同终点的音符组成和弦；不同长度的重叠音仍保持独立。 */
function combineChords(notes: readonly QuantizedNote[]) {
    const groups = new Map<string, QuantizedChord>();
    for (const note of notes) {
        const key = `${note.start}:${note.end}`;
        const item = groups.get(key);
        if (item) {
            item.notes.push(note);
        } else {
            groups.set(key, {
                start: note.start,
                end: note.end,
                notes: [note],
                triplet: note.triplet,
            });
        }
    }
    const result = [...groups.values()];
    for (const item of result) item.notes.sort((left, right) => left.midi - right.midi);
    return result.sort((left, right) => left.start - right.start || left.end - right.end);
}

/** 把同一识别组的三个槽折叠为一个三连音原子，其余和弦原样保留。 */
function groupTriplets(chords: readonly QuantizedChord[]) {
    const groups = new Map<number, QuantizedChord[]>();
    const result: QuantizedItem[] = [];
    for (const chord of chords) {
        if (chord.triplet) {
            const members = groups.get(chord.triplet.group) ?? [];
            members.push(chord);
            groups.set(chord.triplet.group, members);
        } else result.push(chord);
    }
    for (const members of groups.values()) {
        members.sort((left, right) => left.triplet!.slot - right.triplet!.slot);
        result.push({ start: members[0].start, end: members.at(-1)!.end, members });
    }
    return result.sort((left, right) => left.start - right.start || left.end - right.end);
}

/**
 * 贪心分配重叠内容：能接在已有 lane 尾部就复用，否则新建 lane。
 * lane 最后按平均音高从低到高排序，最高 lane 用来承载全谱 tempo/meter 标记。
 */
function splitLanes(items: readonly QuantizedItem[]) {
    const lanes: Lane[] = [];
    const active: { end: number; laneIndex: number }[] = [];
    const available: number[] = [];
    const compareActive = (left: { end: number; laneIndex: number }, right: { end: number; laneIndex: number }) =>
        left.end - right.end || left.laneIndex - right.laneIndex;
    const compareLaneIndex = (left: number, right: number) => left - right;
    for (const item of items) {
        while (active.length > 0 && active[0].end <= item.start) {
            heapPush(available, heapPop(active, compareActive).laneIndex, compareLaneIndex);
        }
        const laneIndex = available.length > 0 ? heapPop(available, compareLaneIndex) : lanes.length;
        const lane = lanes[laneIndex] ?? { items: [] };
        if (laneIndex === lanes.length) lanes.push(lane);
        lane.items.push(item);
        heapPush(active, { end: item.end, laneIndex }, compareActive);
    }
    const averagePitch = (lane: Lane) => {
        let sum = 0;
        let count = 0;
        for (const item of lane.items) {
            const chords = "members" in item ? item.members : [item];
            for (const chord of chords) {
                for (const note of chord.notes) {
                    sum += note.midi;
                    count++;
                }
            }
        }
        return sum / count;
    };
    return lanes.map(lane => ({ lane, averagePitch: averagePitch(lane) }))
        .sort((left, right) => left.averagePitch - right.averagePitch)
        .map(item => item.lane);
}

/** 只把传递重叠的事件放进同一区域；每个区域独立生成局部 @stack，边界不会切断事件 */
function splitRegions(items: readonly QuantizedItem[]) {
    const regions: TrackRegion[] = [];
    let group: QuantizedItem[] = [];
    let end = 0;
    const flush = () => {
        if (group.length === 0) return;
        regions.push({ start: group[0].start, end, lanes: splitLanes(group) });
        group = [];
    };
    for (const item of items) {
        if (group.length > 0 && item.start >= end) flush();
        group.push(item);
        end = Math.max(end, item.end);
    }
    flush();
    return regions;
}

/** 把整数时值分解为 jpFun 的 `/` 与 `.` 后缀；剩余部分会另写为 dash/rest。 */
function rhythmSuffixes(duration: number, scale: number) {
    const result: string[] = [];
    let remaining = duration;
    let first = true;
    while (remaining > 0) {
        const base = 2 ** Math.floor(Math.log2(Math.min(remaining, scale)));
        remaining -= base;
        let dots = 0;
        if (first && remaining < scale) {
            for (let next = base / 2; next >= 1 && remaining >= next; next /= 2) {
                remaining -= next;
                dots++;
            }
        }
        const divisions = Math.log2(scale / base);
        result.push("/".repeat(divisions) + ".".repeat(dots));
        first = false;
    }
    return result;
}

/**
 * 自动换行不猜“几个音符算一行”：先在超宽页面上排出单行自然宽度，
 * 再按小节的实际对象边界做动态规划，使各行接近默认页面内容宽。
 */
function automaticLineBreaks(
    source: string,
    bars: readonly number[],
    scale: number,
) {
    const naturalWidth = Math.max(1_000_000, source.length * 64);
    const naturalSource = `@page(width=${naturalWidth}px, height=0px, top=0px, bottom=0px, left=0px, right=0px)\n${source}`;
    const layout = compileScore(naturalSource).layout;
    const bodyLine = Math.max(...layout.objects.filter(node => !node.T.isZero()).map(node => node.layoutLine));
    const bodyObjects = layout.objects.filter(node => node.layoutLine === bodyLine && node.box.w > 0);
    const measureBounds = bars.map(() => ({ left: Infinity, right: -Infinity }));
    for (const node of bodyObjects) {
        const at = Math.round(node.t.toNumber() * scale);
        let low = 0;
        let high = bars.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            const end = bars[middle];
            if (at < end || (at === end && node.mergeKey === ANCHOR_KEY)) high = middle;
            else low = middle + 1;
        }
        let measure = low;
        if (measure >= bars.length) measure = bars.length - 1;
        const bounds = measureBounds[measure];
        bounds.left = Math.min(bounds.left, node.box.x);
        bounds.right = Math.max(bounds.right, node.box.x + node.box.w);
    }
    const contentWidth = DEFAULT_PAGE_CONFIG.width
        - DEFAULT_PAGE_CONFIG.marginLeft - DEFAULT_PAGE_CONFIG.marginRight;
    const targetWidth = contentWidth * AUTO_LINE_TARGET_RATIO;
    const limitWidth = contentWidth * AUTO_LINE_LIMIT_RATIO;
    const best: { imbalance: number; previous: number }[] = [
        { imbalance: 0, previous: -1 },
    ];
    for (let end = 1; end <= bars.length; end++) {
        let choice: typeof best[number] | undefined;
        for (let start = end - 1; start >= Math.max(0, end - AUTO_LINE_MAX_BARS); start--) {
            let left = Infinity;
            let right = -Infinity;
            for (let measure = start; measure < end; measure++) {
                left = Math.min(left, measureBounds[measure].left);
                right = Math.max(right, measureBounds[measure].right);
            }
            const width = right - left;
            if (width > limitWidth && start < end - 1) continue;
            const before = best[start];
            if (!before) continue;
            const difference = width - targetWidth;
            const candidate = {
                imbalance: before.imbalance + difference ** 2
                    * (width < contentWidth ? AUTO_LINE_UNDERFILL_PENALTY : 1),
                previous: start,
            };
            if (!choice || candidate.imbalance < choice.imbalance) choice = candidate;
        }
        best[end] = choice!;
    }

    const lineBreaks = new Set<number>();
    for (let end = bars.length; best[end].previous > 0; end = best[end].previous) {
        lineBreaks.add(bars[best[end].previous - 1]);
    }
    return lineBreaks;
}

function itemHead(
    item: QuantizedChord,
    pitchMode: PitchMode,
    suffix = "",
    labels?: readonly string[],
) {
    const labelAt = (index: number) => labels ? `@${labels[index]}` : "";
    return item.notes.length === 1
        ? `${noteName(item.notes[0].midi, pitchMode)}${suffix}${labelAt(0)}`
        : `{${item.notes.map((note, index) =>
            `${noteName(note.midi, pitchMode)}${index === 0 ? suffix : ""}${labelAt(index)}`).join(" ^ ")}}`;
}

/**
 * 把一个 lane 沿“音符起止、小节、元事件”切成时间片并输出源码。
 * dash 只允许延续本小节内已经出现的音；跨小节或不足一拍时重写同音，
 * 每个和弦成员分别收集完整标签链，音结束时一次输出 @tie(x, y, ...)。
 */
function renderLane(
    lane: Lane,
    rangeStart: number,
    rangeEnd: number,
    rhythmScale: number,
    timeFactor: number,
    pitchMode: PitchMode,
    bars: ReadonlySet<number>,
    lineBreaks: ReadonlySet<number>,
    adjustments: ReadonlyMap<number, readonly string[]> | undefined,
    programs: ReadonlyMap<number, number> | undefined,
    nextTieLabel: () => string,
) {
    const points = new Set<number>([rangeStart, rangeEnd]);
    for (const item of lane.items) {
        points.add(item.start);
        points.add(item.end);
    }
    for (const at of bars) if (at > rangeStart && at < rangeEnd) points.add(at);
    for (const at of adjustments?.keys() ?? []) {
        if (at >= rangeStart && at < rangeEnd) points.add(at);
    }
    for (const at of programs?.keys() ?? []) {
        if (at >= rangeStart && at < rangeEnd) points.add(at);
    }
    const timeline = [...points].sort((left, right) => left - right);
    const timelineIndex = new Map(timeline.map((at, index) => [at, index]));
    const tieChains = new Map<QuantizedChord, string[][]>();
    const extendTieChains = (chains: string[][]) => chains.map(chain => {
        const label = nextTieLabel();
        chain.push(label);
        return label;
    });
    for (const item of lane.items) {
        if ("members" in item) continue;
        const startIndex = timelineIndex.get(item.start)!;
        for (let index = startIndex; timeline[index] < item.end; index++) {
            const suffixes = rhythmSuffixes((timeline[index + 1] - timeline[index]) / timeFactor, rhythmScale);
            if ((timeline[index] > item.start && bars.has(timeline[index]))
                || suffixes.some((suffix, suffixIndex) =>
                (timeline[index] > item.start || suffixIndex > 0) && suffix.includes("/"))) {
                tieChains.set(item, item.notes.map(() => []));
                break;
            }
        }
    }

    const outputs: string[][] = Array.from({ length: lineBreaks.size + 1 }, () => []);
    let outputIndex = [...lineBreaks].filter(at => at <= rangeStart).length;
    let itemIndex = 0;
    for (let index = 0; index < timeline.length; index++) {
        const at = timeline[index];
        while (itemIndex < lane.items.length && lane.items[itemIndex].end <= at) itemIndex++;

        if (at > rangeStart && at < rangeEnd && bars.has(at)) outputs[outputIndex].push("|");
        if (at > rangeStart && at < rangeEnd && lineBreaks.has(at)) outputIndex++;

        const next = timeline[index + 1];
        if (next === undefined) continue;
        const program = programs?.get(at);
        if (program !== undefined) outputs[outputIndex].push(`@program(${program})`);
        const changes = adjustments?.get(at) ?? [];
        const item = lane.items[itemIndex];
        if (item && item.start <= at && item.end >= next) {
            if ("members" in item && at === item.start) {
                const writtenDuration = (item.members[0].end - item.members[0].start) * 3 / (2 * timeFactor);
                const suffix = rhythmSuffixes(writtenDuration, rhythmScale).join("");
                const content = item.members.map(member => itemHead(member, pitchMode, suffix)).join(" ");
                outputs[outputIndex].push(attachAbove(`@tuplet({${content}}, 2)`, changes));
                index = timelineIndex.get(item.end)! - 1;
                continue;
            }
            if ("members" in item) throw new Error("MIDI triplet rendering must start at its first slot");
            const suffixes = rhythmSuffixes((next - at) / timeFactor, rhythmScale);
            for (let suffixIndex = 0; suffixIndex < suffixes.length; suffixIndex++) {
                const suffix = suffixes[suffixIndex];
                const continuation = at > item.start || suffixIndex > 0;
                let token: string;
                const chains = tieChains.get(item);
                if (!continuation) {
                    if (chains) {
                        token = itemHead(item, pitchMode, suffix, extendTieChains(chains));
                    } else {
                        token = itemHead(item, pitchMode, suffix);
                    }
                } else if ((suffixIndex === 0 && bars.has(at)) || suffix.includes("/")) {
                    token = itemHead(item, pitchMode, suffix, extendTieChains(chains!));
                } else {
                    token = `-${suffix}`;
                }
                if (suffixIndex === 0) token = attachAbove(token, changes);
                outputs[outputIndex].push(token);
                if (chains && next === item.end && suffixIndex === suffixes.length - 1) {
                    outputs[outputIndex].push(...chains.map(labels => `@tie(${labels.join(", ")})`));
                }
            }
        } else {
            outputs[outputIndex].push(...rhythmSuffixes((next - at) / timeFactor, rhythmScale)
                .map((suffix, index) => index === 0 ? attachAbove(`0${suffix}`, changes) : `0${suffix}`));
        }
    }
    return outputs.map(output => output.join(" "));
}

function renderTrack(
    track: ConvertedTrack,
    scoreEnd: number,
    bars: ReadonlySet<number>,
    lineBreaks: ReadonlySet<number>,
    render: (region: TrackRegion, lane: Lane) => string[],
    showName: boolean,
) {
    const lineCount = lineBreaks.size + 1;
    const outputs: string[][] = Array.from({ length: lineCount }, () => []);
    const segments: TrackRegion[] = [];
    let cursor = 0;
    for (const region of track.regions) {
        if (cursor < region.start) segments.push({ start: cursor, end: region.start, lanes: [{ items: [] }] });
        segments.push(region);
        cursor = region.end;
    }
    if (cursor < scoreEnd) segments.push({ start: cursor, end: scoreEnd, lanes: [{ items: [] }] });
    for (const region of segments) {
        if (region.start > 0 && bars.has(region.start)) {
            const lineIndex = [...lineBreaks].filter(at => at < region.start).length;
            outputs[lineIndex].push("|");
        }
        const lanes = region.lanes.map(lane => render(region, lane));
        for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
            if (!lanes.some(lines => lines[lineIndex])) continue;
            const content = lanes.length === 1
                ? lanes[0][lineIndex]
                : `@stack(${lanes.map(lines => `{ ${lines[lineIndex]} }`).join(", ")})`;
            outputs[lineIndex].push(content);
        }
    }
    if (bars.has(scoreEnd)) outputs[lineCount - 1].push("|");
    return outputs.map((output, lineIndex) => {
        const name = showName && lineIndex === 0 && track.source.name ? `(${quote(track.source.name)})` : "";
        return `N${name}: { ${output.join(" ")} }`;
    });
}

/**
 * 公开转换入口。options 只控制表示方式；量化后的 track/note 仍保留原始字段，
 * 方便后续加入力度、乐器和踏板时直接扩展现有时间线。
 */
export function midiJsonToJpFun(input: MidiJson, options: MidiToJpFunOptions = {}) {
    if (!input || typeof input !== "object" || !input.header || typeof input.header !== "object") {
        throw new TypeError("MIDI JSON must contain a header");
    }
    expectArray(input.tracks, "tracks");
    expectArray(input.header.tempos, "header.tempos");
    expectArray(input.header.timeSignatures, "header.timeSignatures");
    if (typeof input.header.name !== "string") throw new TypeError("header.name must be a string");

    const ticksPerQuarter = input.header.tick;
    expectSafeInteger(ticksPerQuarter, "header.tick", 1, 0x7fff);
    const alignRate = options.alignRate ?? 4;
    expectSafeInteger(alignRate, "alignRate", 2, 16);
    const barsPerLine = options.barsPerLine ?? 0;
    if (!Number.isSafeInteger(barsPerLine)) throw new RangeError("barsPerLine must be an integer");
    const pitchMode = options.pitchMode ?? "absolute";
    if (pitchMode !== "relative" && pitchMode !== "absolute") {
        throw new TypeError("pitchMode must be relative or absolute");
    }
    const title = options.title ?? input.header.name;
    if (typeof title !== "string") throw new TypeError("title must be a string");

    // 第一阶段：校验 note，并从最短时值求出全曲需要的二进制精度
    const sourceTracks: { source: MidiJsonTrack; notes: SourceNote[]; programs: MidiJsonInstrument[] }[] = [];
    let rawNoteEnd = 0;
    let globalDivisions = 1;
    for (const [trackIndex, track] of input.tracks.entries()) {
        if (!track || typeof track !== "object" || typeof track.name !== "string") {
            throw new TypeError(`tracks[${trackIndex}] must contain a string name`);
        }
        expectSafeInteger(track.channel, `tracks[${trackIndex}].channel`, 0, 15);
        if (track.channel === 9) continue;
        expectArray(track.notes, `tracks[${trackIndex}].notes`);
        expectArray(track.instruments, `tracks[${trackIndex}].instruments`);
        const programs = track.instruments.map((item, index) => {
            expectSafeInteger(item.ticks, `tracks[${trackIndex}].instruments[${index}].ticks`);
            expectSafeInteger(item.number, `tracks[${trackIndex}].instruments[${index}].number`, 0, 127);
            return { ...item };
        });
        const notes = track.notes.map((note, index) => {
            expectSafeInteger(note.ticks, `tracks[${trackIndex}].notes[${index}].ticks`);
            expectSafeInteger(note.durationTicks, `tracks[${trackIndex}].notes[${index}].durationTicks`, 1);
            expectSafeInteger(note.midi, `tracks[${trackIndex}].notes[${index}].midi`, 0, 127);
            rawNoteEnd = Math.max(rawNoteEnd, note.ticks + note.durationTicks);
            const divisions = durationDivisions(note.durationTicks, ticksPerQuarter, alignRate);
            globalDivisions = Math.max(globalDivisions, divisions);
            return { ...note, divisions };
        });
        if (notes.length > 0) sourceTracks.push({ source: track, notes, programs });
    }

    // 第二阶段：在原始 tick 域规范化全谱拍号和速度
    const rawMeters = normalizeMeterTicks([
        { ticks: 0, timeSignature: DEFAULT_TIME_SIGNATURE },
        ...input.header.timeSignatures,
    ].filter(item => item.ticks === 0 || item.ticks < rawNoteEnd).map((item, index) => {
        expectSafeInteger(item.ticks, `header.timeSignatures[${index}].ticks`);
        const [numerator, denominator] = item.timeSignature;
        expectSafeInteger(numerator, `header.timeSignatures[${index}].numerator`, 1, 0xff);
        expectSafeInteger(denominator, `header.timeSignatures[${index}].denominator`, 1, 0x8000);
        const denominatorPower = Math.log2(denominator);
        if (!Number.isInteger(denominatorPower)) throw new RangeError("MIDI time-signature denominator must be a power of two");
        globalDivisions = Math.max(globalDivisions, denominatorPower - 2);
        return { ticks: item.ticks, numerator, denominator };
    }).sort((left, right) => left.ticks - right.ticks), ticksPerQuarter);

    const rawTempos = [
        { ticks: 0, bpm: DEFAULT_BPM },
        ...input.header.tempos.map((item, index) => {
            expectSafeInteger(item.ticks, `header.tempos[${index}].ticks`);
            if (!Number.isFinite(item.bpm) || item.bpm <= 0) {
                throw new RangeError(`header.tempos[${index}].bpm must be positive and finite`);
            }
            return item;
        }),
    ].filter(item => item.ticks === 0 || item.ticks < rawNoteEnd)
        .sort((left, right) => left.ticks - right.ticks);

    // 第三阶段：先识别三连音。命中时把内部时间轴乘 3，使三分槽也能用整数表示
    const rhythmScale = 2 ** globalDivisions;
    const timeFactor = identifyTriplets(
        sourceTracks,
        ticksPerQuarter,
        [
            ...rawMeters.slice(1).map(item => item.ticks),
            ...rawTempos.slice(1).map(item => item.ticks),
            ...sourceTracks.flatMap(track => track.programs.map(item => item.ticks)),
            ...measureBoundaries(rawMeters, rawNoteEnd, ticksPerQuarter),
        ],
    ) ? 3 : 1;
    const scale = rhythmScale * timeFactor;
    const rawUnits = (ticks: number) => {
        if (!Number.isSafeInteger(ticks * scale)) throw new RangeError("MIDI timeline is too large to quantize exactly");
        return ticks * scale / ticksPerQuarter;
    };
    const binaryUnitAt = (ticks: number) => {
        if (!Number.isSafeInteger(ticks * rhythmScale)) throw new RangeError("MIDI timeline is too large to quantize exactly");
        return Math.round(ticks * rhythmScale / ticksPerQuarter) * timeFactor;
    };
    const meters = rawMeters.map(item => ({
        at: binaryUnitAt(item.ticks),
        numerator: item.numerator,
        denominator: item.denominator,
    }));

    // 第四阶段：量化音符；同一原始 tick 共用最高精度，防止和弦成员起点错开
    const convertedTracks: ConvertedTrack[] = [];
    const startDivisions = new Map<number, number>();
    for (const track of sourceTracks) {
        for (const note of track.notes) {
            startDivisions.set(note.ticks, Math.max(startDivisions.get(note.ticks) ?? 1, note.divisions));
        }
    }
    let lastNoteEnd = 0;
    for (const track of sourceTracks) {
        const notes = track.notes.map(note => {
            const tripletUnit = note.triplet
                ? Math.round(rawUnits(note.triplet.spanTicks) / 3)
                : 0;
            const start = note.triplet
                ? Math.round(rawUnits(note.triplet.startTicks)) + note.triplet.slot * tripletUnit
                : quantizeTime(rawUnits(note.ticks), startDivisions.get(note.ticks)!, meters, scale);
            let end = note.triplet
                ? start + tripletUnit
                : quantizeTime(rawUnits(note.ticks + note.durationTicks), note.divisions, meters, scale);
            const step = scale / 2 ** note.divisions;
            if (end <= start) end = start + step;
            lastNoteEnd = Math.max(lastNoteEnd, end);
            return { ...note, start, end };
        });
        const programs = coalesceSorted(track.programs
            .filter(item => item.ticks === 0 || item.ticks < rawNoteEnd)
            .map(item => ({ at: binaryUnitAt(item.ticks), program: item.number })));
        convertedTracks.push({
            source: track.source,
            regions: splitRegions(groupTriplets(combineChords(notes))),
            programs: new Map(programs.map(item => [item.at, item.program])),
        });
    }

    const activeMeter = pointAt(meters, lastNoteEnd);
    const finalMeasureLength = meterDuration(activeMeter, scale);
    const scoreEnd = lastNoteEnd === 0
        ? 0
        : activeMeter.at + Math.ceil((lastNoteEnd - activeMeter.at) / finalMeasureLength) * finalMeasureLength;

    const tempoPoints = coalesceSorted(rawTempos.map(item => ({
        at: binaryUnitAt(item.ticks),
        bpm: item.bpm,
    }))).filter(item => item.at === 0 || item.at < lastNoteEnd);
    const relevantMeters = meters.filter(item => item.at === 0 || item.at < lastNoteEnd);

    // 第五阶段：建立最终小节线和正文中的 tempo/meter 调整。
    const bars = new Set<number>();
    for (let index = 0; index < relevantMeters.length; index++) {
        const meter = relevantMeters[index];
        const next = relevantMeters[index + 1]?.at ?? scoreEnd;
        if (meter.at > 0) bars.add(meter.at);
        const duration = meterDuration(meter, scale);
        for (let at = meter.at + duration; at <= next && at <= scoreEnd; at += duration) bars.add(at);
    }
    if (scoreEnd > 0) bars.add(scoreEnd);
    const orderedBars = [...bars].sort((left, right) => left - right);
    const scoreAdjustments = new Map<number, string[]>();
    const addAdjustment = (at: number, source: string) => {
        const sources = scoreAdjustments.get(at) ?? [];
        sources.push(source);
        scoreAdjustments.set(at, sources);
    };
    for (const meter of relevantMeters.slice(1)) {
        addAdjustment(meter.at, `@meter(${meter.numerator}, ${meter.denominator})`);
    }
    for (const tempo of tempoPoints.slice(1)) addAdjustment(tempo.at, `@tempo(${tempo.bpm})`);
    const initialMeter = relevantMeters[0];
    const head = renderHead({
        title,
        key: "C4",
        meter: [initialMeter.numerator, initialMeter.denominator],
        tempo: tempoPoints[0].bpm,
    });
    if (convertedTracks.length === 0) return head;

    // 第六阶段：先生成单行候选做自然宽度测量，再用选出的断点生成最终源码
    const renderScore = (lineBreaks: ReadonlySet<number>) => {
        let tieIndex = 0;
        const tracks = convertedTracks.map((track, trackIndex) => renderTrack(track, scoreEnd, bars, lineBreaks, (region, lane) =>
            renderLane(
                lane,
                region.start,
                region.end,
                rhythmScale,
                timeFactor,
                pitchMode,
                bars,
                lineBreaks,
                trackIndex === 0 && lane === region.lanes.at(-1) ? scoreAdjustments : undefined,
                track.programs,
                () => `mt${tieIndex++}`,
            ), convertedTracks.length > 1));
        return `${head}\n\n${renderSystems(tracks)}`;
    };
    const lineBreaks = barsPerLine <= 0
        ? automaticLineBreaks(renderScore(new Set()), orderedBars, scale)
        : new Set(orderedBars.filter((at, index) =>
            (index + 1) % barsPerLine === 0 && at < scoreEnd));
    return renderScore(lineBreaks);
}