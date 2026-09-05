import {
    child, children, descendant, descendants, nameOf, number, text,
    type MusicXmlElement,
} from "./dom.js";
import type { MusicXmlEvent, MusicXmlPitch } from "./model.js";

/** 统一两种 MusicXML 根结构中的小节内容与外层小节容器 */
export interface MusicXmlMeasureSource {
    body: MusicXmlElement;
    container: MusicXmlElement;
}

const DYNAMIC_NAMES = new Set(["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"]);
const MAX_ENDING_PASS = 256;

/** 读取上下方位置，非法或缺失值回落到调用方默认值 */
function placementOf(element: MusicXmlElement, fallback: "above" | "below") {
    const placement = element.getAttribute("placement");
    return placement === "above" || placement === "below" ? placement : fallback;
}

/** 将 score-partwise 和 score-timewise 统一为每个 part 的小节序列 */
export function partMeasures(root: MusicXmlElement) {
    const result = new Map<string, MusicXmlMeasureSource[]>();
    const rootName = nameOf(root);
    if (rootName === "score-partwise") {
        for (const part of children(root, "part")) result.set(
            part.getAttribute("id") ?? "",
            children(part, "measure").map(measure => ({ body: measure, container: measure })),
        );
        return result;
    }
    if (rootName === "score-timewise") {
        for (const measure of children(root, "measure")) {
            for (const part of children(measure, "part")) {
                const id = part.getAttribute("id") ?? "";
                const list = result.get(id) ?? [];
                list.push({ body: part, container: measure });
                result.set(id, list);
            }
        } return result;
    }
    throw new TypeError(`Unsupported MusicXML root <${rootName}>`);
}

/** 解析书面音高及该和弦成员自己的 tie 起止标记 */
export function parsePitch(note: MusicXmlElement) {
    const pitched = child(note, "pitch");
    const pitch = pitched ?? child(note, "unpitched");
    if (!pitch) return null;
    const step = text(pitch, pitched ? "step" : "display-step").toUpperCase();
    const alter = pitched ? number(pitch, "alter", 0) : 0;
    const octave = number(pitch, pitched ? "octave" : "display-octave");
    if (!/^[A-G]$/.test(step) || !Number.isInteger(alter) || !Number.isInteger(octave)) {
        throw new RangeError("jpFun requires MusicXML pitches with integer step alterations and octaves");
    }
    const tieTypes = new Set<string>();
    for (const tie of children(note, "tie")) tieTypes.add(tie.getAttribute("type") ?? "");
    const notations = child(note, "notations");
    if (notations) for (const tied of children(notations, "tied")) tieTypes.add(tied.getAttribute("type") ?? "");
    return {
        step,
        alter,
        octave,
        tieStart: tieTypes.has("start") || tieTypes.has("continue"),
        tieStop: tieTypes.has("stop") || tieTypes.has("continue"),
    } satisfies MusicXmlPitch;
}

/** 将支持的 fermata articulation 和 ornament 转成 jpFun 修饰符 */
export function noteModifiers(note: MusicXmlElement) {
    const result: MusicXmlEvent["modifiers"] = [];
    const notations = child(note, "notations");
    if (!notations) return result;
    const fermata = child(notations, "fermata");
    if (fermata) result.push({
        name: "fermata",
        placement: placementOf(fermata, fermata.getAttribute("type") === "inverted" ? "below" : "above"),
    });
    const articulations = child(notations, "articulations");
    const accent = articulations && child(articulations, "accent");
    if (accent) result.push({ name: "accent", placement: placementOf(accent, "above") });
    const ornaments = child(notations, "ornaments");
    if (ornaments) {
        const names = [
            ["trill-mark", "tr"],
            ["mordent", "mordent"],
            ["inverted-mordent", "prall"],
        ] as const;
        for (const [tag, name] of names) {
            const ornament = child(ornaments, tag);
            if (ornament) result.push({ name, placement: placementOf(ornament, "above") });
        }
    }
    return result;
}

/** 解析 tuplet 的实际音数与正常音数，并保留显式组边界 */
export function timeModification(note: MusicXmlElement) {
    const modification = child(note, "time-modification");
    if (!modification) return undefined;
    const actual = number(modification, "actual-notes");
    const normal = number(modification, "normal-notes");
    if (!Number.isSafeInteger(actual) || actual < 2 || !Number.isSafeInteger(normal) || normal <= 0) {
        throw new RangeError("MusicXML time-modification requires positive integer actual-notes and normal-notes");
    }
    const notations = child(note, "notations");
    const tuplets = notations ? children(notations, "tuplet") : [];
    return {
        actual,
        normal,
        start: tuplets.some(item => item.getAttribute("type") === "start"),
        stop: tuplets.some(item => item.getAttribute("type") === "stop"),
    };
}

/** 按 verse 收集歌词并用尾部连字符保留音节延续 */
export function noteLyrics(note: MusicXmlElement) {
    const result = new Map<string, string>();
    for (const lyric of children(note, "lyric")) {
        const verse = lyric.getAttribute("number") || lyric.getAttribute("name") || "1";
        const words = children(lyric)
            .filter(item => ["text", "elision"].includes(nameOf(item)))
            .map(item => nameOf(item) === "elision" ? "~" : text(item))
            .join("");
        const syllabic = text(lyric, "syllabic");
        result.set(verse, words && (syllabic === "begin" || syllabic === "middle") ? `${words}-` : words);
    }
    return result;
}

/** 返回 direction 中首个受支持的力度记号 */
export function directionDynamic(direction: MusicXmlElement) {
    const dynamics = descendant(direction, "dynamics");
    if (!dynamics) return undefined;
    return children(dynamics).map(nameOf).find(name => DYNAMIC_NAMES.has(name));
}

/** 收集排练标记与普通文字，排练标记保留方框语义 */
export function directionTexts(direction: MusicXmlElement) {
    const result: { text: string; boxed: boolean }[] = [];
    for (const name of ["rehearsal", "words"]) {
        for (const node of descendants(direction, name)) {
            const value = node.textContent?.trim();
            if (value) result.push({ text: value, boxed: name === "rehearsal" });
        }
    }
    return result;
}

/** 将 metronome 的拍单位和附点折算成四分音符 BPM */
export function metronomeBpm(direction: MusicXmlElement) {
    const metronome = descendant(direction, "metronome");
    if (!metronome) return undefined;
    const perMinute = Number(text(metronome, "per-minute"));
    const unit = text(metronome, "beat-unit");
    const quarterLengths: Record<string, number> = {
        maxima: 32, long: 16, breve: 8, whole: 4, half: 2, quarter: 1,
        eighth: 0.5, "16th": 0.25, "32nd": 0.125, "64th": 0.0625,
        "128th": 0.03125, "256th": 0.015625, "512th": 0.0078125, "1024th": 0.00390625,
    };
    let length = quarterLengths[unit];
    if (!Number.isFinite(perMinute) || length === undefined) return undefined;
    let addition = length / 2;
    for (const _dot of children(metronome, "beat-unit-dot")) {
        length += addition;
        addition /= 2;
    }
    return perMinute * length;
}

/** 将单一或复合拍号归一成一个等值分数 */
export function parseTimeSignature(time: MusicXmlElement) {
    const pairs: { beats: number; beatType: number }[] = [];
    let beats: number | undefined;
    // beats 与紧随其后的 beat-type 组成一组，多个组表示复合拍号
    for (const item of children(time)) {
        const tag = nameOf(item);
        if (tag === "beats") {
            beats = text(item).split("+").reduce((sum, value) => sum + Number(value), 0);
        } else if (tag === "beat-type" && beats !== undefined) {
            pairs.push({ beats, beatType: Number(text(item)) });
            beats = undefined;
        }
    }
    if (pairs.length === 0 || pairs.some(pair => !Number.isSafeInteger(pair.beats) || pair.beats <= 0
        || !Number.isSafeInteger(pair.beatType) || pair.beatType <= 0)) {
        throw new RangeError("MusicXML time signature must contain positive integer beats/beat-type pairs");
    }
    const gcd = (left: number, right: number): number => right === 0 ? left : gcd(right, left % right);
    const denominator = pairs.reduce((result, pair) => result / gcd(result, pair.beatType) * pair.beatType, 1);
    const numerator = pairs.reduce((sum, pair) => sum + pair.beats * denominator / pair.beatType, 0);
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
        throw new RangeError("MusicXML time signature exceeds the supported integer range");
    }
    return { numerator, denominator };
}

/** 展开逗号分隔的遍数与闭区间范围，并返回升序去重结果 */
export function endingPasses(value: string) {
    const result = new Set<number>();
    for (const part of value.split(/\s*,\s*/)) {
        const match = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!match) throw new RangeError("MusicXML ending number must contain positive integers or ascending ranges");
        const from = Number(match[1]);
        const to = Number(match[2] ?? match[1]);
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)
            || from < 1 || to < from || to > MAX_ENDING_PASS) {
            throw new RangeError(`MusicXML ending passes must be ascending integers in 1..${MAX_ENDING_PASS}`);
        }
        for (let pass = from; pass <= to; pass++) result.add(pass);
    }
    return [...result].sort((left, right) => left - right);
}