import {
    child, children, descendant, descendants, nameOf, number, text,
    type MusicXmlElement,
} from "./dom.js";
import type { MusicXmlArpeggio, MusicXmlDiagnostic, MusicXmlDirectionPoint, MusicXmlEvent, MusicXmlPitch, ParsedMusicXmlScore } from "./model.js";
import { NoteNameMap, SHARP_NOTE_NAMES } from "../../parser/parse-utils/note-utils.js";

/** 统一两种 MusicXML 根结构中的小节内容与外层小节容器 */
export interface MusicXmlMeasureSource {
    body: MusicXmlElement;
    container: MusicXmlElement;
}

const DYNAMIC_NAMES = new Set(["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"]);
const MAX_ENDING_PASS = 256;

const DIAGNOSTICS = {
    percussion: ["PERCUSSION_SKIPPED", "MIDI channel 10 percussion note was omitted."],
    displayPitch: ["APPROXIMATED", "Unpitched note was converted to a melodic note using its display pitch."],
    afterGrace: ["APPROXIMATED", "After-grace note has no preceding event and was treated as a before-grace note."],
    wedge: ["APPROXIMATED", "Wedge was mapped to note onsets with a fixed velocity change of {value}."],
    unsupported: ["UNSUPPORTED_ELEMENT", "MusicXML <{value}> was omitted."],
    gracePitch: ["UNATTACHED_CONTENT", "Grace note without a pitch was omitted."],
    graceHost: ["UNATTACHED_CONTENT", "Before-grace note has no following event and was omitted."],
    dynamicHost: ["UNATTACHED_CONTENT", "Dynamic {value} has no target voice and was omitted."],
    directionOutput: ["UNATTACHED_CONTENT", "Direction mark has no generated output position and was omitted."],
    tempoReplaced: ["UNATTACHED_CONTENT", "Tempo {value} was replaced by a different tempo at the same time and was omitted."],
    arpeggioOutput: ["UNSUPPORTED_ELEMENT", "Arpeggiate mark requires at least two pitches in one event and was omitted."],
    textHost: ["UNATTACHED_CONTENT", "Text {value} has no target event and was omitted."],
    wedgeStart: ["UNRESOLVED_RELATION", "Wedge stop has no matching start and was omitted."],
    wedgeReplaced: ["UNRESOLVED_RELATION", "Wedge start was replaced before a matching stop and was omitted."],
    wedgeStop: ["UNRESOLVED_RELATION", "Wedge start has no matching stop and was omitted."],
    wedgeVoice: ["UNRESOLVED_RELATION", "Wedge has no target voice and was omitted."],
    wedgeEndpoints: ["UNRESOLVED_RELATION", "Wedge has no two distinct note onsets to use as endpoints and was omitted."],
    endingStart: ["UNRESOLVED_RELATION", "Ending stop has no matching start and was omitted."],
    endingReplaced: ["UNRESOLVED_RELATION", "Ending start was replaced before a matching stop and was omitted."],
    endingStop: ["UNRESOLVED_RELATION", "Ending start has no matching stop and was omitted."],
    endingEndpoints: ["UNRESOLVED_RELATION", "Ending has no event endpoints in its interval and was omitted."],
    tieStart: ["UNRESOLVED_RELATION", "Tie stop has no matching start and was omitted."],
    tieStop: ["UNRESOLVED_RELATION", "Tie start has no matching stop in any ending branch and was omitted."],
} as const;

export function reportDiagnostic(
    diagnostics: MusicXmlDiagnostic[], issue: keyof typeof DIAGNOSTICS,
    location: MusicXmlDiagnostic["location"], value: string | number = "",
) {
    const [kind, message] = DIAGNOSTICS[issue];
    diagnostics.push({ code: `W_MUSICXML_${kind}`, severity: "warning",
        message: message.replace("{value}", () => String(value)), location });
}

/** 查询不改变覆盖状态；解析结果写入语义模型后显式确认，未确认项按 XML 顺序报告 */
export class MusicXmlReader {
    private readonly accepted: MusicXmlElement[] = [];
    constructor(private readonly roots: readonly MusicXmlElement[]) {}

    read(name: string, deep = false, parent?: MusicXmlElement) {
        for (const root of parent ? [parent] : this.roots) {
            const element = deep ? descendant(root, name) : child(root, name);
            if (element) return element;
        }
        return undefined;
    }

    readAll(name: string, deep = false) {
        return this.roots.flatMap(root => deep ? descendants(root, name) : children(root, name));
    }

    accept(element: MusicXmlElement | undefined) {
        if (element) this.accepted.push(element);
    }

    report(diagnostics: MusicXmlDiagnostic[], location: MusicXmlDiagnostic["location"], parent?: MusicXmlElement) {
        for (const root of parent ? [parent] : this.roots) for (const element of children(root)) {
            if (this.accepted.includes(element)) continue;
            const name = nameOf(element);
            reportDiagnostic(diagnostics, "unsupported", { ...location, element: name }, name);
        }
    }
}

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

/** 校验 MIDI 乐器字段，并将一基 program 转为内部零基编号 */
export function readInstrument(midi: MusicXmlElement) {
    const instrument: { channel?: number; program?: number } = {};
    if (child(midi, "midi-channel")) {
        instrument.channel = number(midi, "midi-channel");
        if (!Number.isSafeInteger(instrument.channel) || instrument.channel < 1 || instrument.channel > 16) {
            throw new RangeError("MusicXML midi-channel must be an integer in 1..16");
        }
    }
    if (child(midi, "midi-program")) {
        instrument.program = number(midi, "midi-program") - 1;
        if (!Number.isSafeInteger(instrument.program) || instrument.program < 0 || instrument.program > 127) {
            throw new RangeError("MusicXML midi-program must be an integer in 1..128");
        }
    }
    return instrument;
}

/** 文档元数据不参与时间推进；仅完整的页面声明覆盖默认页面 */
export function scoreMetadata(root: MusicXmlElement): Pick<ParsedMusicXmlScore, "title" | "subtitle" | "creator" | "page"> {
    const credits = children(root, "credit");
    const credit = (type: string) => {
        const item = credits.find(value => text(value, "credit-type") === type);
        return item ? text(item, "credit-words") : "";
    };
    const workTitle = text(child(root, "work"), "work-title");
    const title = text(root, "movement-title")
        || (workTitle !== "Untitled Score" && workTitle !== "未命名乐谱" ? workTitle : "")
        || credit("title");
    const subtitle = credit("subtitle");
    const creator = credit("composer") || (() => {
        const identification = child(root, "identification");
        const creators = identification ? children(identification, "creator") : [];
        return text(creators.find(item => item.getAttribute("type") === "composer") ?? creators[0]);
    })();
    let page: ParsedMusicXmlScore["page"];
    const defaults = child(root, "defaults");
    const scaling = defaults && child(defaults, "scaling");
    const pageLayout = defaults && child(defaults, "page-layout");
    if (scaling && pageLayout && child(pageLayout, "page-width") && child(pageLayout, "page-height")) {
        const pixelsPerTenth = number(scaling, "millimeters") / number(scaling, "tenths") * 96 / 25.4;
        const marginList = children(pageLayout, "page-margins");
        const margins = marginList.find(item => item.getAttribute("type") === "odd") ?? marginList[0];
        if (Number.isFinite(pixelsPerTenth) && pixelsPerTenth > 0) {
            page = {
                width: number(pageLayout, "page-width") * pixelsPerTenth,
                height: number(pageLayout, "page-height") * pixelsPerTenth,
                top: margins ? number(margins, "top-margin", 48 / pixelsPerTenth) * pixelsPerTenth : 48,
                bottom: margins ? number(margins, "bottom-margin", 48 / pixelsPerTenth) * pixelsPerTenth : 48,
                left: margins ? number(margins, "left-margin", 40 / pixelsPerTenth) * pixelsPerTenth : 40,
                right: margins ? number(margins, "right-margin", 40 / pixelsPerTenth) * pixelsPerTenth : 40,
            };
        }
    }
    return { title, subtitle, creator, page };
}

/** 解析书面音高及该和弦成员自己的 tie 起止标记 */
export function parsePitch(note: MusicXmlElement, location: MusicXmlPitch["location"], notations?: MusicXmlReader): MusicXmlPitch | null {
    const tied = notations?.readAll("tied");
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
    const ties = children(note, "tie");
    for (const tie of ties) tieTypes.add(tie.getAttribute("type") ?? "");
    if (tied) for (const tie of tied) {
        const type = tie.getAttribute("type") ?? "";
        tieTypes.add(type);
        if (type === "start" || type === "stop" || type === "continue") notations?.accept(tie);
    }
    return {
        location: { ...location, element: ties.length ? "tie" : tied?.length ? "tied" : nameOf(note) },
        step,
        alter,
        octave,
        tieStart: tieTypes.has("start") || tieTypes.has("continue"),
        tieStop: tieTypes.has("stop") || tieTypes.has("continue"),
    };
}

export function transposePitch(pitch: MusicXmlPitch, chromatic: number, diatonic: number | undefined, octaves: number) {
    const midi = (pitch.octave + 1) * 12 + NoteNameMap[pitch.step] + pitch.alter + chromatic + octaves * 12;
    if (diatonic === undefined) {
        const spelling = SHARP_NOTE_NAMES[((midi % 12) + 12) % 12];
        pitch.step = spelling[0];
        pitch.alter = spelling.length - 1;
        pitch.octave = Math.floor(midi / 12) - 1;
    } else {
        const letters = "CDEFGAB";
        const degree = pitch.octave * 7 + letters.indexOf(pitch.step) + diatonic + octaves * 7;
        pitch.step = letters[((degree % 7) + 7) % 7];
        pitch.octave = Math.floor(degree / 7);
        pitch.alter = midi - (pitch.octave + 1) * 12 - NoteNameMap[pitch.step];
    }
}

/** 将支持的 fermata articulation 和 ornament 转成 jpFun 修饰符 */
export function noteModifiers(notations: MusicXmlReader | undefined, diagnostics: MusicXmlDiagnostic[], location: MusicXmlDiagnostic["location"]) {
    const result: MusicXmlEvent["modifiers"] = [];
    if (!notations) return result;
    const fermata = notations.read("fermata");
    if (fermata) {
        result.push({ name: "fermata", placement: placementOf(fermata, fermata.getAttribute("type") === "inverted" ? "below" : "above") });
        notations.accept(fermata);
    }
    const articulations = notations.read("articulations");
    if (articulations) {
        const accent = notations.read("accent", false, articulations);
        if (accent) {
            result.push({ name: "accent", placement: placementOf(accent, "above") });
            notations.accept(accent);
        }
        notations.report(diagnostics, location, articulations);
        notations.accept(articulations);
    }
    const ornaments = notations.read("ornaments");
    if (ornaments) {
        const names = [
            ["trill-mark", "tr"],
            ["mordent", "mordent"],
            ["inverted-mordent", "prall"],
        ] as const;
        for (const [tag, name] of names) {
            const ornament = notations.read(tag, false, ornaments);
            if (ornament) {
                result.push({ name, placement: placementOf(ornament, "above") });
                notations.accept(ornament);
            }
        }
        notations.report(diagnostics, location, ornaments);
        notations.accept(ornaments);
    }
    return result;
}

/** 无箭头不覆盖显式方向，两个相反的显式方向不能属于同一和弦。 */
export function mergeArpeggio(current?: MusicXmlArpeggio, next?: MusicXmlArpeggio) {
    if (!next || next.direction === "none") return current ?? next;
    if (current && current.direction !== "none" && current.direction !== next.direction) {
        throw new RangeError("Conflicting MusicXML arpeggiate directions in one chord");
    }
    return next;
}

/** 读取和弦成员上的琶音方向；none 表示无箭头但仍按自下而上演奏。 */
export function noteArpeggio(notations: MusicXmlReader | undefined, location: MusicXmlPitch["location"]): MusicXmlArpeggio | undefined {
    if (!notations) return undefined;
    let result: MusicXmlArpeggio | undefined;
    for (const arpeggiate of notations.readAll("arpeggiate")) {
        const value = arpeggiate.getAttribute("direction") || "none";
        if (value !== "none" && value !== "up" && value !== "down") {
            throw new RangeError(`Unsupported MusicXML arpeggiate direction: ${value}`);
        }
        result = mergeArpeggio(result, { direction: value, location: { ...location, element: "arpeggiate" } });
        notations.accept(arpeggiate);
    }
    return result;
}

/** 解析 tuplet 的实际音数与正常音数，并保留显式组边界 */
export function timeModification(note: MusicXmlElement, tuplets: readonly MusicXmlElement[] | undefined) {
    const modification = child(note, "time-modification");
    if (!modification) return undefined;
    const actual = number(modification, "actual-notes");
    const normal = number(modification, "normal-notes");
    if (!Number.isSafeInteger(actual) || actual < 2 || !Number.isSafeInteger(normal) || normal <= 0) {
        throw new RangeError("MusicXML time-modification requires positive integer actual-notes and normal-notes");
    }
    return {
        actual,
        normal,
        start: tuplets?.some(item => item.getAttribute("type") === "start") ?? false,
        stop: tuplets?.some(item => item.getAttribute("type") === "stop") ?? false,
    };
}

/** 和弦成员可重复声明同一边界；仅确认最终事件确实持有的节奏标记 */
export function acceptTuplets(notations: MusicXmlReader | undefined, tuplets: readonly MusicXmlElement[] | undefined, rhythm: MusicXmlEvent["timeModification"]) {
    if (!notations || !tuplets || !rhythm) return;
    for (const tuplet of tuplets) {
        const type = tuplet.getAttribute("type");
        if ((type === "start" || type === "stop") && rhythm[type]) notations.accept(tuplet);
    }
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

/** 返回 dynamics 中首个受支持的力度记号 */
export function directionDynamic(dynamics: MusicXmlElement | undefined, diagnostics: MusicXmlDiagnostic[], location: MusicXmlDiagnostic["location"]) {
    if (!dynamics) return undefined;
    let dynamic: string | undefined;
    for (const element of children(dynamics)) {
        const name = nameOf(element);
        if (!dynamic && DYNAMIC_NAMES.has(name)) dynamic = name;
        else reportDiagnostic(diagnostics, "unsupported", { ...location, element: name }, name);
    }
    return dynamic;
}

/** 收集排练标记与普通文字，排练标记保留方框语义；空白文字视为空内容 */
export function directionTexts(direction: MusicXmlReader) {
    const result: MusicXmlDirectionPoint["texts"] = [];
    for (const name of ["rehearsal", "words"]) {
        for (const node of direction.readAll(name, true)) {
            const value = node.textContent?.trim();
            if (value) result.push({ text: value, boxed: name === "rehearsal" });
            direction.accept(node);
        }
    }
    return result;
}

/** 将 metronome 的拍单位和附点折算成四分音符 BPM */
export function metronomeBpm(metronome: MusicXmlElement | undefined) {
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