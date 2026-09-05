/**
 * MusicXML -> jpFun 的转换流水线：
 * 1. 接收调用方解析好的 XML 根元素，并把 partwise/timewise 统一成“每个 part 的小节序列”；
 * 2. 按 part + staff + voice 建立 lane，使用 Fraction 保存精确时间；
 * 3. 收集拍号、调号、速度、反复、歌词、力度和连音等语义；
 * 4. 把普通事件和 tuplet 变成连续 RenderBlock，并为跨事件关系分配标签；
 * 5. 按统一时间线生成 N:/L: 系统和文档末尾关系。
 *
 * XML 文本解析和 .mxl 解压都属于应用边界，core 不依赖具体 XML parser
 */
import { Fraction } from "../../fraction.js";
import { NoteNameMap } from "../../parser/parse-utils/note-utils.js";
import {
    child, children, descendant, nameOf, number, text,
    type MusicXmlElement,
} from "./dom.js";
import {
    directionDynamic, directionTexts, endingPasses, metronomeBpm,
    mergeArpeggio, noteArpeggio, noteLyrics, noteModifiers, parsePitch,
    parseTimeSignature, partMeasures, timeModification,
} from "./features.js";
import type {
    MusicXmlDirectionPoint as DirectionPoint,
    MusicXmlEndingPoint as EndingPoint,
    MusicXmlEndingSpan as EndingSpan,
    MusicXmlKeyPoint as KeyPoint,
    MusicXmlLane as Lane,
    MusicXmlMeterPoint as MeterPoint,
    MusicXmlEvent as MusicEvent,
    ParsedMusicXmlScore as ParsedScore,
    MusicXmlPitch as Pitch,
    MusicXmlWedgePoint as WedgePoint,
    MusicXmlWedgeSpan as WedgeSpan,
} from "./model.js";
import { attachAbove, quote, renderHead, renderPitch, renderSystems, type PitchMode } from "../source.js";

export type { MusicXmlElement, MusicXmlNode } from "./dom.js";

export interface MusicXmlToJpFunOptions {
    pitchMode?: PitchMode;
    barsPerLine?: number;
}

/**
 * 渲染时间线上的连续区间。
 * 普通块引用 event；tuplet 块提前生成完整 source，避免外层时间线切开其内部比例。
 */
interface RenderBlock {
    start: Fraction;
    end: Fraction;
    event?: MusicEvent;
    source?: string;
    lyricEvents?: { event: MusicEvent; slotCount: number }[];
}

interface RenderMetadata {
    labels: Map<Pitch | MusicEvent, string>;
    afterSources: Map<MusicEvent, string[]>;
}

const MAJOR_KEYS = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const MINOR_KEYS = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#"];
// name = token[0] acc = token.slice(1)
const RELATIVE_NAMES = ["1", "1#", "2", "2#", "3", "4", "4#", "5", "5#", "6", "6#", "7"] as const;

function add(left: Fraction, right: Fraction) {
    return left.clone().add(right);
}

function keyOf(value: Fraction) {
    return value.toString();
}

function fractionFromKey(value: string) {
    const [numerator, denominator = "1"] = value.split("/");
    return new Fraction(Number(numerator), Number(denominator));
}

function lowerBoundAt<T>(items: readonly T[], at: Fraction, getAt: (item: T) => Fraction) {
    let low = 0;
    let high = items.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (getAt(items[middle]).compare(at) < 0) low = middle + 1;
        else high = middle;
    }
    return low;
}

function insideSpan<T extends { start: Fraction; end: Fraction }>(spans: readonly T[], at: Fraction) {
    const span = spans[lowerBoundAt(spans, at, item => item.start) - 1];
    return !!span && span.end.compare(at) > 0;
}

function lyricToken(value: string) {
    const continuation = value.endsWith("-");
    const body = continuation ? value.slice(0, -1) : value;
    const escaped = body.replace(/[\\{}@-]/g, "\\$&") + (continuation ? "-" : "");
    // 花括号让会被歌词词法拆分的一个 XML lyric 仍只占一个歌词槽。
    const hasNonAscii = [...body].some(char => char.codePointAt(0)! > 0x7f);
    return /\s/.test(body) || (hasNonAscii && ([...body].length > 1 || body.length > 1 || continuation))
        ? `{${escaped}}`
        : escaped;
}

function setBar(bars: Map<string, string>, at: Fraction, token: string) {
    const key = keyOf(at);
    const current = bars.get(key);
    if (!current || current === "|") {
        bars.set(key, token);
        return;
    }
    if (current === "|:" && token.startsWith(":|")) {
        bars.set(key, token === ":|" ? ":|:" : `${token} |:`);
    } else if (token === "|:" && current.includes(":|")) {
        bars.set(key, current === ":|" ? ":|:" : `${current} |:`);
    } else if (token === "||" && !current.includes("|:") && !current.includes(":|")) {
        bars.set(key, token);
    }
}

/**
 * 把 DOM 转成 ParsedScore
 * 每个 part 独立推进游标，第一 part 的小节长度作为多 part 对齐基准
 * backup/forward 只移动当前小节游标，不直接产生可见音符
 */
function parseScore(root: MusicXmlElement): ParsedScore {
    const partNames = new Map<string, string>();
    type Instrument = { channel?: number; program?: number };
    const instrumentsByPart = new Map<string, { fallback?: Instrument; byId: Map<string, Instrument> }>();
    const partList = child(root, "part-list");
    if (partList) {
        // 乐器定义按 part 和 instrument id 建索引，note 只保留最终 program
        for (const scorePart of children(partList, "score-part")) {
            const partId = scorePart.getAttribute("id") ?? "";
            partNames.set(partId, text(scorePart, "part-name"));
            const byId = new Map<string, Instrument>();
            let fallback: Instrument | undefined;
            // 一个 part 可声明多个 instrument，首个定义同时作为无 id note 的回退
            for (const midi of children(scorePart, "midi-instrument")) {
                const channelSource = text(midi, "midi-channel");
                const programSource = text(midi, "midi-program");
                const channel = channelSource === "" ? undefined : Number(channelSource);
                const program = programSource === "" ? undefined : Number(programSource) - 1;
                if (channel !== undefined && (!Number.isSafeInteger(channel) || channel < 1 || channel > 16)) {
                    throw new RangeError("MusicXML midi-channel must be an integer in 1..16");
                }
                if (program !== undefined && (!Number.isSafeInteger(program) || program < 0 || program > 127)) {
                    throw new RangeError("MusicXML midi-program must be an integer in 1..128");
                }
                const instrument = { channel, program };
                fallback ??= instrument;
                byId.set(midi.getAttribute("id") ?? "", instrument);
            }
            instrumentsByPart.set(partId, { fallback, byId });
        }
    }
    // 标题作者等文档级元数据不进入时间线
    const credits = children(root, "credit");
    const credit = (type: string) => {
        const item = credits.find(value => text(value, "credit-type") === type);
        return item ? text(item, "credit-words") : "";
    };
    const workTitle = text(child(root, "work"), "work-title");
    // 优先采用语义明确的标题字段，并过滤 MuseScore 的默认占位标题
    const title = text(root, "movement-title")
        || (workTitle !== "Untitled Score" && workTitle !== "未命名乐谱" ? workTitle : "")
        || credit("title");
    const subtitle = credit("subtitle");
    const creator = credit("composer") || (() => {
        const identification = child(root, "identification");
        const creators = identification ? children(identification, "creator") : [];
        return text(creators.find(item => item.getAttribute("type") === "composer") ?? creators[0]);
    })();
    // 页面配置只有在 scaling 和完整尺寸同时存在时才接管 jpFun 默认值
    let page: ParsedScore["page"];
    const defaults = child(root, "defaults");
    const scaling = defaults && child(defaults, "scaling");
    const pageLayout = defaults && child(defaults, "page-layout");
    if (scaling && pageLayout && child(pageLayout, "page-width") && child(pageLayout, "page-height")) {
        // MusicXML 的 tenths 经毫米标尺换算成 CSS 像素
        const millimeters = number(scaling, "millimeters");
        const tenths = number(scaling, "tenths");
        const pixelsPerTenth = millimeters / tenths * 96 / 25.4;
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

    // 先收集按时间定位的原始语义；关系端点在所有 part 解析完后统一配对
    const lanes = new Map<string, Lane>();
    const meters = new Map<string, MeterPoint>();
    const keys = new Map<string, KeyPoint>();
    const tempos = new Map<string, { at: Fraction; bpm: number }>();
    const directions: DirectionPoint[] = [];
    const wedgePoints: WedgePoint[] = [];
    const endingPoints = new Map<string, EndingPoint>();
    const bars = new Map<string, string>();
    const measureBoundaries = new Set<string>();
    const lineBreaks = new Set<string>();
    let scoreEnd = new Fraction();
    let order = 0;

    // 主时间解析：逐 part、逐小节扫描 attributes/direction/note/barline
    const measuresByPart = partMeasures(root);
    const partOrder = new Map([...measuresByPart.keys()].map((id, index) => [id, index]));
    // 第一 part 决定全谱小节边界，其他 part 必须落在同一时间框架内
    const controlPartId = measuresByPart.keys().next().value as string | undefined;
    const controlMeasureLengths: Fraction[] = [];
    // 每个 part 独立解析，最终事件统一落到从乐谱开头计算的绝对时间
    for (const [partId, measures] of measuresByPart) {
        const partInstruments = instrumentsByPart.get(partId);
        let divisions = 1;
        let partTime = new Fraction();
        let activeMeter = { numerator: 4, denominator: 4 };
        const lastEvent = new Map<string, MusicEvent>();
        const pendingGraces = new Map<string, Pitch[][]>();

        // 小节游标从零开始，partTime 保存当前小节在全谱中的绝对起点
        for (let measureIndex = 0; measureIndex < measures.length; measureIndex++) {
            const { body: measure, container: measureContainer } = measures[measureIndex];
            let cursor = new Fraction();
            let measureEnd = new Fraction();
            if (measureContainer.getAttribute("implicit") !== "yes" && measureIndex > 0) {
                setBar(bars, partTime, "|");
                if (partId === controlPartId) measureBoundaries.add(keyOf(partTime));
            }
            const print = child(measure, "print") ?? (measureContainer === measure ? undefined : child(measureContainer, "print"));
            if (print?.getAttribute("new-system") === "yes" || print?.getAttribute("new-page") === "yes") {
                if (!partTime.isZero()) lineBreaks.add(keyOf(partTime));
            }
            const measureItems = children(measure);

            // 小节线的样式、反复和房子共享同一个绝对时间点
            const recordBarline = (barline: MusicXmlElement, at: Fraction) => {
                const repeatElement = child(barline, "repeat");
                const repeat = repeatElement?.getAttribute("direction");
                if (repeat === "forward") setBar(bars, at, "|:");
                else if (repeat === "backward") {
                    const timesValue = repeatElement?.getAttribute("times");
                    const times = timesValue ? Number(timesValue) : 2;
                    if (!Number.isSafeInteger(times) || times < 2) throw new RangeError("MusicXML repeat times must be an integer of at least 2");
                    setBar(bars, at, new Array(times - 1).fill(":|").join(" "));
                } else if (text(barline, "bar-style") === "light-heavy") setBar(bars, at, "||");
                const ending = child(barline, "ending");
                const endingType = ending?.getAttribute("type");
                if (ending && (endingType === "start" || endingType === "stop" || endingType === "discontinue")) {
                    const passes = endingPasses(ending.getAttribute("number") ?? "");
                    if (passes.length > 0) endingPoints.set(`${keyOf(at)}\0${endingType}\0${passes.join(",")}`, {
                        at: at.clone(),
                        type: endingType,
                        passes,
                    });
                }
            };

            // 必须按 XML 原始顺序扫描，backup forward 和 chord 都依赖当前游标或前一事件
            for (const item of measureItems) {
                const tag = nameOf(item);
                // attributes 从当前位置起更新 divisions 拍号和调号
                if (tag === "attributes") {
                    const at = add(partTime, cursor);
                    if (child(item, "divisions")) divisions = number(item, "divisions");
                    if (!Number.isSafeInteger(divisions) || divisions <= 0) throw new RangeError("MusicXML divisions must be a positive integer");
                    const time = child(item, "time");
                    if (time) {
                        const { numerator, denominator } = parseTimeSignature(time);
                        activeMeter = { numerator, denominator };
                        meters.set(keyOf(at), { at, numerator, denominator });
                    }
                    const key = child(item, "key");
                    if (key) {
                        const fifths = number(key, "fifths", 0);
                        if (!Number.isSafeInteger(fifths)) throw new RangeError("MusicXML fifths must be an integer");
                        keys.set(keyOf(at), {
                            at,
                            fifths,
                            mode: text(key, "mode") || "major",
                        });
                    }
                    continue;
                }
                // backup 和 forward 只重定位当前小节游标，用于交错 voice
                if (tag === "backup" || tag === "forward") {
                    const duration = new Fraction(number(item, "duration"), divisions);
                    if (tag === "backup") cursor.sub(duration);
                    else cursor.add(duration);
                    if (cursor.compare(0) < 0) throw new RangeError("MusicXML backup moves before the measure start");
                    measureEnd = measureEnd.compare(cursor) < 0 ? cursor.clone() : measureEnd;
                    continue;
                }
                // direction 收集精确时间上的速度、力度、文字和楔形线端点
                if (tag === "direction") {
                    const offset = new Fraction(number(item, "offset", 0), divisions);
                    const at = add(add(partTime, cursor), offset);
                    const sound = child(item, "sound");
                    const tempo = sound?.getAttribute("tempo");
                    const bpm = tempo !== null && tempo !== undefined && tempo !== "" ? Number(tempo) : metronomeBpm(item);
                    if (bpm !== undefined) {
                        if (!Number.isFinite(bpm) || bpm <= 0) throw new RangeError("MusicXML tempo must be positive and finite");
                        tempos.set(keyOf(at), { at, bpm });
                    }
                    const dynamic = directionDynamic(item);
                    const texts = directionTexts(item);
                    if (dynamic || texts.length > 0) directions.push({
                        at,
                        partId,
                        staff: text(item, "staff") || "1",
                        voice: text(item, "voice") || "",
                        placement: item.getAttribute("placement") === "below" ? "below" : "above",
                        dynamic,
                        texts,
                    });
                    const wedge = descendant(item, "wedge");
                    const wedgeType = wedge?.getAttribute("type");
                    if (wedgeType === "crescendo" || wedgeType === "diminuendo" || wedgeType === "stop") {
                        wedgePoints.push({
                            at,
                            partId,
                            staff: text(item, "staff") || "1",
                            voice: text(item, "voice") || "",
                            number: wedge?.getAttribute("number") || "1",
                            type: wedgeType,
                        });
                    }
                    continue;
                }
                // measure 直属 sound 也可能携带速度，不要求包在 direction 中
                const tempo = tag === "sound" ? item.getAttribute("tempo") : null;
                if (tempo !== null && tempo !== "") {
                    const bpm = Number(tempo);
                    if (!Number.isFinite(bpm) || bpm <= 0) throw new RangeError("MusicXML tempo must be positive and finite");
                    const at = add(partTime, cursor);
                    tempos.set(keyOf(at), { at, bpm });
                    continue;
                }
                if (tag === "barline" && item.getAttribute("location") === "middle") {
                    recordBarline(item, add(partTime, cursor));
                    continue;
                }
                if (tag !== "note") continue;

                // note 先确定 lane 与 instrument，再区分打击乐、倚音、和弦成员和普通起音
                const voice = text(item, "voice") || "1";
                const staff = text(item, "staff") || "1";
                const laneKey = `${partId}\0${staff}\0${voice}`;
                const instrumentId = child(item, "instrument")?.getAttribute("id") ?? "";
                const instrument = instrumentId
                    ? partInstruments?.byId.get(instrumentId)
                    : partInstruments?.fallback;
                const pitch = parsePitch(item);
                const rest = child(item, "rest") !== undefined;
                if (!pitch && !rest) {
                    throw new TypeError("MusicXML note must contain pitch, unpitched, or rest");
                }
                const chord = child(item, "chord") !== undefined;
                const grace = child(item, "grace");
                // 打击乐尚未建模，但普通音符仍须推进游标以保持后续事件位置
                if (instrument?.channel === 10) {
                    if (grace) continue;
                    const duration = new Fraction(number(item, "duration"), divisions);
                    if (duration.compare(0) <= 0) throw new RangeError("MusicXML non-grace notes require a positive duration");
                    if (!chord) cursor.add(duration);
                    if (measureEnd.compare(cursor) < 0) measureEnd = cursor.clone();
                    continue;
                }
                // lane 在首次遇到可保留事件时创建，纯打击乐轨不会留下空 lane
                let lane = lanes.get(laneKey);
                if (!lane) {
                    lane = {
                        partId,
                        partName: partNames.get(partId) ?? partId,
                        staff,
                        voice,
                        events: [],
                    };
                    lanes.set(laneKey, lane);
                }
                const previousEvent = lastEvent.get(laneKey);
                if (grace) {
                    if (!pitch) continue;
                    // 后倚音挂到前一事件，前倚音暂存到下一次真实起音
                    const stealTimePrevious = grace.getAttribute("steal-time-previous");
                    if (stealTimePrevious !== null && stealTimePrevious !== "" && previousEvent) {
                        const groups = previousEvent.postGraces;
                        if (chord && groups.length > 0) groups.at(-1)!.push(pitch);
                        else groups.push([pitch]);
                    } else {
                        const groups = pendingGraces.get(laneKey) ?? [];
                        if (chord && groups.length > 0) groups.at(-1)!.push(pitch);
                        else groups.push([pitch]);
                        pendingGraces.set(laneKey, groups);
                    }
                    continue;
                }

                const duration = new Fraction(number(item, "duration"), divisions);
                if (duration.compare(0) <= 0) throw new RangeError("MusicXML non-grace notes require a positive duration");
                const start = chord ? previousEvent?.start.clone() ?? add(partTime, cursor) : add(partTime, cursor);
                let event = chord ? previousEvent : undefined;
                const lyrics = noteLyrics(item);
                const modifiers = noteModifiers(item);
                const arpeggio = noteArpeggio(item);
                // chord 成员只有起点和时值都一致时才合并到前一事件
                if (!event || !event.start.equals(start) || !event.duration.equals(duration) || event.rest) {
                    event = {
                        start,
                        duration,
                        pitches: [],
                        rest,
                        order: order++,
                        modifiers,
                        annotations: [],
                        preGraces: pendingGraces.get(laneKey) ?? [],
                        postGraces: [],
                        lyrics,
                        arpeggio,
                        program: instrument?.program,
                        timeModification: timeModification(item),
                    };
                    pendingGraces.delete(laneKey);
                    lane.events.push(event);
                    lastEvent.set(laneKey, event);
                } else {
                    event.program ??= instrument?.program;
                    event.arpeggio = mergeArpeggio(event.arpeggio, arpeggio);
                    for (const modifier of modifiers) {
                        if (!event.modifiers.some(item => item.name === modifier.name && item.placement === modifier.placement)) {
                            event.modifiers.push(modifier);
                        }
                    }
                }
                if (pitch) event.pitches.push(pitch);
                for (const [verse, words] of lyrics) {
                    if (words && !event.lyrics.has(verse)) event.lyrics.set(verse, words);
                }
                if (!chord) cursor.add(duration);
                const relativeEnd = add(start, duration).sub(partTime);
                if (measureEnd.compare(relativeEnd) < 0) measureEnd = relativeEnd;
            }

            // 扫描完成后才能确定弱起长度和多 voice 的最远结束位置
            const expected = new Fraction(activeMeter.numerator * 4, activeMeter.denominator);
            // 弱起小节采用实际长度，普通小节至少占满当前拍号长度
            const implicit = measureContainer.getAttribute("implicit") === "yes" || (measureIndex === 0 && measureEnd.compare(expected) < 0);
            const ownLength = implicit ? measureEnd : measureEnd.compare(expected) > 0 ? measureEnd : expected;
            let length = ownLength;
            if (partId === controlPartId) controlMeasureLengths[measureIndex] = ownLength.clone();
            else if (controlMeasureLengths[measureIndex]) {
                length = controlMeasureLengths[measureIndex].clone();
                if (measureEnd.compare(length) > 0) {
                    throw new RangeError(`MusicXML part ${partId} exceeds the controlling measure duration`);
                }
            }
            // 左右小节线依赖最终小节长度，中间小节线已在顺序扫描时处理
            const measureFinish = add(partTime, length);
            for (const barline of measureItems.filter(item => nameOf(item) === "barline")) {
                const location = barline.getAttribute("location");
                if (location === "middle") continue;
                recordBarline(barline, location === "left" ? partTime : measureFinish);
            }
            partTime.add(length);
            if (scoreEnd.compare(partTime) < 0) scoreEnd = partTime.clone();
        }
        setBar(bars, partTime, "||");
    }

    const laneList = [...lanes.values()];
    // 将 start/stop 形式的范围标记配对，渲染阶段只消费完整区间
    const wedges: WedgeSpan[] = [];
    const activeWedges = new Map<string, WedgePoint>();
    // wedge 按 part staff voice 和 number 配对，允许多个楔形线并行存在
    for (const point of wedgePoints.sort((left, right) => left.at.compare(right.at))) {
        const key = `${point.partId}\0${point.staff}\0${point.voice}\0${point.number}`;
        if (point.type === "stop") {
            const from = activeWedges.get(key);
            if (from) wedges.push({ from, end: point.at });
            activeWedges.delete(key);
        } else activeWedges.set(key, point);
    }

    const endings: EndingSpan[] = [];
    let activeEnding: EndingPoint | undefined;
    // ending 沿全谱时间顺序配对，起点持有适用遍数
    for (const point of [...endingPoints.values()].sort((left, right) => left.at.compare(right.at))) {
        if (point.type === "start") activeEnding = point;
        else if (activeEnding) {
            endings.push({ from: activeEnding, end: point.at });
            activeEnding = undefined;
        }
    }
    // 只有房子没有音符时也要保留一条 lane 承载生成的端点
    if (endings.length > 0 && laneList.length === 0 && controlPartId !== undefined) {
        laneList.push({
            partId: controlPartId,
            partName: partNames.get(controlPartId) ?? controlPartId,
            staff: "1",
            voice: "1",
            events: [],
        });
    }
    const topLane = laneList[0];
    // 为没有真实起音的房子补休止端点，保证 volta 始终能绑定可见事件
    if (topLane) for (const ending of endings) {
        if (ending.from.at.compare(ending.end) >= 0) continue;
        const direction = directions.find(item => item.at.compare(ending.from.at) >= 0
            && item.at.compare(ending.end) < 0);
        const hostPartId = direction?.partId ?? topLane.partId;
        const hostStaff = direction?.staff ?? topLane.staff;
        const hostLanes = laneList.filter(lane => lane.partId === hostPartId && lane.staff === hostStaff);
        const hasEndpoint = hostLanes.some(lane => lane.events.some(event =>
            event.start.compare(ending.from.at) >= 0 && event.start.compare(ending.end) < 0));
        if (!hasEndpoint) {
            // 空房子需要一个不可冲突的休止事件作为 volta 标签端点
            let hostLane = hostLanes.find(lane => !lane.events.some(event =>
            event.start.compare(ending.end) < 0
                && add(event.start, event.duration).compare(ending.from.at) > 0));
            if (!hostLane) {
                const voices = hostLanes.map(lane => Number(lane.voice)).filter(Number.isFinite);
                hostLane = {
                    partId: hostPartId,
                    partName: partNames.get(hostPartId) ?? hostPartId,
                    staff: hostStaff,
                    voice: String(Math.max(0, ...voices) + 1),
                    events: [],
                };
                laneList.push(hostLane);
            }
            hostLane.events.push({
                start: ending.from.at.clone(),
                duration: ending.end.clone().sub(ending.from.at),
                pitches: [],
                rest: true,
                order: order++,
                modifiers: [],
                annotations: [],
                preGraces: [],
                postGraces: [],
                lyrics: new Map(),
            });
            hostLane.events.sort((left, right) => left.start.compare(right.start) || left.order - right.order);
        }
    }

    // direction 没有明确 voice 时作用于同 staff 的所有 lane；文字只显示一次
    for (const direction of directions) {
        const candidates = laneList.filter(lane =>
            lane.partId === direction.partId && lane.staff === direction.staff
            && (!direction.voice || lane.voice === direction.voice));
        const targets = candidates.length > 0
            ? candidates
            : laneList.filter(item => item.partId === direction.partId).slice(0, 1);
        for (const lane of targets) {
            const contained = lane.events.find(item => item.start.compare(direction.at) <= 0
                && add(item.start, item.duration).compare(direction.at) > 0);
            let event = contained ?? lane.events.find(item => item.start.compare(direction.at) >= 0);
            if (!event) event = lane.events.at(-1);
            if (event && direction.dynamic) event.modifiers.push({ name: direction.dynamic, placement: direction.placement });
        }
        if (direction.texts.length > 0) {
            const events = targets.flatMap(lane => lane.events);
            const textTarget = events.find(event => event.start.compare(direction.at) < 0
                && add(event.start, event.duration).compare(direction.at) > 0)
                ?? events.filter(event => event.start.compare(direction.at) >= 0)
                    .sort((left, right) => left.start.compare(right.start) || left.order - right.order)[0]
                ?? events.at(-1);
            textTarget?.annotations.push(...direction.texts.map(text => ({
                ...text,
                placement: direction.placement,
            })));
        }
    }
    // 输出顺序保持原 part 次序，再按 staff 和 voice 排列
    return {
        title,
        subtitle,
        creator,
        page,
        lanes: laneList.sort((left, right) =>
            partOrder.get(left.partId)! - partOrder.get(right.partId)!
            || Number(left.staff) - Number(right.staff)
            || Number(left.voice) - Number(right.voice)),
        meters: [...meters.values()].sort((left, right) => left.at.compare(right.at)),
        keys: [...keys.values()].sort((left, right) => left.at.compare(right.at)),
        tempos: [...tempos.values()].sort((left, right) => left.at.compare(right.at)),
        wedges,
        endings,
        bars,
        measureBoundaries,
        lineBreaks,
        end: scoreEnd,
    };
}

/** 将 MusicXML 的 fifths + mode 转成 jpFun 可表示的主音拼写 */
function tonicName(key: KeyPoint) {
    if (!Number.isSafeInteger(key.fifths) || key.fifths < -7 || key.fifths > 7) {
        throw new RangeError("jpFun supports MusicXML key signatures from -7 to 7 fifths");
    }
    const mode = key.mode.toLowerCase();
    if (mode === "minor" || mode === "aeolian") return MINOR_KEYS[key.fifths + 7];
    if (mode === "major" || mode === "ionian") return MAJOR_KEYS[key.fifths + 7];
    const modalDegree: Record<string, [number, number]> = {
        dorian: [1, 2], phrygian: [2, 4], lydian: [3, 5], mixolydian: [4, 7], locrian: [6, 11],
    };
    const shift = modalDegree[mode];
    if (!shift) throw new RangeError(`Unsupported MusicXML mode ${key.mode}`);
    const major = MAJOR_KEYS[key.fifths + 7];
    const letters = "CDEFGAB";
    const letter = letters[(letters.indexOf(major[0]) + shift[0]) % letters.length];
    const majorPitch = NoteNameMap[major[0]] + (major[1] === "#" ? 1 : major[1] === "b" ? -1 : 0);
    const targetPitch = ((majorPitch + shift[1]) % 12 + 12) % 12;
    const alteration = ((targetPitch - NoteNameMap[letter] + 18) % 12) - 6;
    if (alteration < -1 || alteration > 1) throw new RangeError(`MusicXML mode ${key.mode} requires an unsupported tonic spelling`);
    return letter + (alteration === 1 ? "#" : alteration === -1 ? "b" : "");
}

function pointAt<T extends { at: Fraction }>(points: readonly T[], at: Fraction) {
    const index = lowerBoundAt(points, at, point => point.at);
    return index < points.length && points[index].at.equals(at)
        ? points[index]
        : points[Math.max(0, index - 1)];
}

/** 生成单个音高；octave=0 等有歧义的情况回退到显式 note */
function pitchSource(
    pitch: Pitch,
    mode: PitchMode,
    key: KeyPoint,
    metadata: RenderMetadata,
    suffix = "",
) {
    let name: string;
    let accidental: string;
    let octave: number;
    if (mode === "absolute") {
        name = pitch.step;
        accidental = pitch.alter > 0 ? "#".repeat(pitch.alter) : "b".repeat(-pitch.alter);
        octave = pitch.octave;
    } else {
        const midi = (pitch.octave + 1) * 12 + NoteNameMap[pitch.step] + pitch.alter;
        const tonic = tonicName(key);
        const tonicAlter = tonic[1] === "#" ? 1 : tonic[1] === "b" ? -1 : 0;
        const difference = midi - 60 - NoteNameMap[tonic[0]] - tonicAlter;
        const pitchClass = ((difference % 12) + 12) % 12;
        name = RELATIVE_NAMES[pitchClass][0];
        accidental = RELATIVE_NAMES[pitchClass].slice(1);
        octave = Math.floor(difference / 12);
    }
    const label = metadata.labels.get(pitch);
    return renderPitch({ name, accidental, octave }, mode, suffix) + (label ? `@${label}` : "");
}

/** 把和弦、倚音、力度和文字组合成一个 jpFun 原子表达式 */
function eventSource(
    event: MusicEvent,
    mode: PitchMode,
    key: KeyPoint,
    metadata: RenderMetadata,
    suffix = "",
) {
    let source: string;
    if (event.rest || event.pitches.length === 0) source = `0${suffix}`;
    else if (event.pitches.length === 1) source = pitchSource(event.pitches[0], mode, key, metadata, suffix);
    else source = `{${event.pitches.map((pitch, index) => pitchSource(pitch, mode, key, metadata, index === 0 ? suffix : "")).join(" ^ ")}}`;

    if (event.arpeggio && event.pitches.length >= 2) {
        source = event.arpeggio === "none"
            ? `@arp(${source})`
            : `@arp(${source}, direction=${event.arpeggio})`;
    }

    const graceSource = (groups: Pitch[][]) => groups.map(group => group.length === 1
            ? pitchSource(group[0], mode, key, metadata)
            : `{${group.map(pitch => pitchSource(pitch, mode, key, metadata)).join(" ^ ")}}`);
    if (event.preGraces.length > 0) source = `{{${graceSource(event.preGraces).join(" ")}} > ${source}}`;
    if (event.postGraces.length > 0) source = `{${source} < {${graceSource(event.postGraces).join(" ")}}}`;
    for (const modifier of event.modifiers) {
        source = `{${source} ${modifier.placement === "below" ? "_" : "^"} $${modifier.name}}`;
    }
    for (const annotation of event.annotations) {
        const text = quote(annotation.text);
        source = `{${source} ${annotation.placement === "below" ? "_" : "^"} ${annotation.boxed ? `@box(${text})` : text}}`;
    }
    const label = metadata.labels.get(event);
    if (label && event.pitches.length !== 1) source += `@${label}`;
    return source;
}

function powerOfTwo(value: number) {
    return value > 0 && Number.isInteger(Math.log2(value));
}

function addDivisions(source: string, power: number) {
    const divisions = "/".repeat(power);
    // 标签必须留在减时线之后，否则词法层会把斜线吞进标签名
    const label = source.match(/@mx\d+$/)?.[0];
    return label ? source.slice(0, -label.length) + divisions + label : source + divisions;
}

function durationParts(duration: Fraction) {
    const result: { fractionPower: number; dots: number }[] = [];
    let numerator = duration.numerator;
    // 从最大二进制块向下拆分，首块尽量吸收连续小块形成附点
    for (let bit = Math.floor(Math.log2(numerator)); bit >= 0; bit--) {
        const value = 2 ** bit;
        if (numerator < value) continue;
        numerator -= value;
        const fractionPower = Math.log2(duration.denominator) - bit;
        let dots = 0;
        if (result.length === 0 && fractionPower >= 0) {
            for (let nextBit = bit - 1; nextBit >= 0 && numerator >= 2 ** nextBit; nextBit--) {
                numerator -= 2 ** nextBit;
                dots++;
            }
        }
        result.push({ fractionPower, dots });
    }
    return result;
}

/**
 * 把精确 Fraction 时值写成 `/`、`.` 和 continuation 序列。
 * 非二进制分母必须已由外层 tuplet 块吸收，否则无法无损表示。
 */
function durationSource(head: string | ((suffix: string) => string), continuation: string, duration: Fraction) {
    if (!powerOfTwo(duration.denominator)) {
        throw new RangeError(`MusicXML duration ${duration} requires a tuplet that jpFun cannot infer`);
    }
    const result: string[] = [];
    for (const [index, { fractionPower, dots }] of durationParts(duration).entries()) {
        const first = index === 0;
        const suffix = `${"/".repeat(Math.max(0, fractionPower))}${".".repeat(dots)}`;
        const renderedWithSuffix = first && typeof head === "function";
        let source: string;
        if (renderedWithSuffix) source = head(suffix);
        else source = first ? head as string : continuation;
        if (!renderedWithSuffix && fractionPower > 0) source = addDivisions(source, fractionPower);
        if (!renderedWithSuffix && dots > 0) source += ".".repeat(dots);
        else if (fractionPower < 0) {
            const count = 2 ** -fractionPower;
            result.push(source, ...new Array(count - 1).fill(continuation));
            continue;
        }
        result.push(source);
    }
    return result.join(" ");
}

function restSlotCount(duration: Fraction) {
    if (!powerOfTwo(duration.denominator)) return 0;
    return durationParts(duration).reduce((count, part) =>
        count + (part.fractionPower < 0 ? 2 ** -part.fractionPower : 1), 0);
}

/**
 * 将 lane 事件变成不可再切分的 RenderBlock。
 * 普通事件一对一成块；连续 time-modification 事件先恢复书面时值，
 * 再整体输出 @tuplet，保留跨小节组内的小节线。
 */
function renderBlocks(
    lane: Lane,
    pitchMode: PitchMode,
    score: ParsedScore,
    keys: readonly KeyPoint[],
    adjustments: ReadonlyMap<string, { at: Fraction; sources: readonly string[] }> | undefined,
    programs: ReadonlyMap<string, number>,
    metadata: RenderMetadata,
) {
    const blocks: RenderBlock[] = [];
    const adjustmentPoints = [...adjustments?.values() ?? []]
        .sort((left, right) => left.at.compare(right.at));
    for (let index = 0; index < lane.events.length;) {
        const event = lane.events[index];
        const modification = event.timeModification;
        if (!modification) {
            blocks.push({ start: event.start, end: add(event.start, event.duration), event });
            index++;
            continue;
        }

        const group: MusicEvent[] = [event];
        const marked = modification.start;
        while (++index < lane.events.length) {
            const previous = group.at(-1)!;
            if (previous.timeModification?.stop) break;
            const next = lane.events[index];
            const nextModification = next.timeModification;
            if (!nextModification
                || nextModification.actual !== modification.actual
                || nextModification.normal !== modification.normal
                || !add(previous.start, previous.duration).equals(next.start)
                || (!marked && group.length >= modification.actual)) break;
            group.push(next);
        }
        if (group.length < 2) throw new RangeError("MusicXML tuplet group must contain at least two consecutive events");

        // 状态变化把成员切成更小片段，片段时值再从实际比例还原为书面比例
        const slices = group.map(item => {
            const end = add(item.start, item.duration);
            let from = lowerBoundAt(adjustmentPoints, item.start, point => point.at);
            if (adjustmentPoints[from]?.at.equals(item.start)) from++;
            const to = lowerBoundAt(adjustmentPoints, end, point => point.at);
            const points = [
                item.start,
                ...adjustmentPoints.slice(from, to).map(point => point.at),
                end,
            ];
            return points.slice(0, -1).map((at, index) => ({
                at,
                duration: points[index + 1].clone().sub(at)
                    .mul(modification.actual, modification.normal),
            }));
        });
        const writtenDurations = slices.flatMap(item => item.map(slice => slice.duration));
        // 最短书面时值作为一个单位，由总单位数推导 jpFun 的 normal 参数
        const shortest = writtenDurations.reduce((left, right) => left.compare(right) <= 0 ? left : right);
        const writtenTotal = writtenDurations.reduce((sum, value) => sum.add(value), new Fraction());
        const actualUnits = writtenTotal.div(shortest);
        const normalUnits = actualUnits.clone().mul(modification.normal, modification.actual);
        if (actualUnits.denominator !== 1 || normalUnits.denominator !== 1) {
            throw new RangeError("MusicXML tuplet ratio cannot be represented by jpFun");
        }
        const lyricEvents: { event: MusicEvent; slotCount: number }[] = [];
        const tokens = group.map((item, groupIndex) => {
            const key = pointAt(keys, item.start);
            const prefix: string[] = [];
            const program = programs.get(keyOf(item.start));
            if (program !== undefined) prefix.push(`@program(${program})`);
            if (groupIndex > 0) {
                const bar = score.bars.get(keyOf(item.start));
                if (bar) prefix.push(bar);
            }
            const continuation = item.rest ? "0" : "-";
            let slotCount = item.rest ? 0 : 1;
            for (const [pointIndex, { at, duration }] of slices[groupIndex].entries()) {
                const changes = adjustments?.get(keyOf(at))?.sources ?? [];
                const head = pointIndex === 0 || changes.length > 0
                    ? (suffix: string) => attachAbove(
                        pointIndex === 0 ? eventSource(item, pitchMode, key, metadata, suffix) : `${continuation}${suffix}`,
                        changes,
                    )
                    : continuation;
                prefix.push(durationSource(head, continuation, duration));
                if (item.rest) slotCount += restSlotCount(duration);
            }
            lyricEvents.push({ event: item, slotCount });
            prefix.push(...metadata.afterSources.get(item) ?? []);
            return prefix.join(" ");
        });
        const end = add(group.at(-1)!.start, group.at(-1)!.duration);
        blocks.push({
            start: group[0].start,
            end,
            source: `@tuplet({${tokens.join(" ")}}, ${normalUnits.numerator})`,
            lyricEvents,
        });
    }
    return blocks;
}

/**
 * 为 tie、wedge 和 ending 找到实际音符端点，并生成稳定标签。
 * tie 紧跟它的 stop 事件；dyn/volta 是完整区间关系，放在文档末尾。
 */
function labelRelations(score: ParsedScore) {
    let labelIndex = 0;
    const relations: string[] = [];
    const metadata: RenderMetadata = {
        labels: new Map(),
        afterSources: new Map(),
    };
    const pitchLabel = (pitch: Pitch) => {
        const label = metadata.labels.get(pitch) ?? `mx${labelIndex++}`;
        metadata.labels.set(pitch, label);
        return label;
    };
    const active = new Map<string, Pitch>();
    const endingActive = new Map<EndingSpan, Map<string, Pitch>>();
    const endings = [...score.endings].sort((left, right) => left.from.at.compare(right.from.at));
    // 房子内维护独立 tie 状态，避免某一遍的端点污染房子外的主时间流
    const containingEnding = (at: Fraction) => {
        const index = lowerBoundAt(endings, at, item => item.from.at);
        const candidate = endings[index]?.from.at.equals(at) ? endings[index] : endings[index - 1];
        return candidate && at.compare(candidate.end) < 0 ? candidate : undefined;
    };
    for (const lane of score.lanes) {
        for (const event of lane.events) {
            const ending = containingEnding(event.start);
            const localActive = ending
                ? endingActive.get(ending) ?? new Map<string, Pitch>()
                : active;
            if (ending) endingActive.set(ending, localActive);
            const orderedPitches = [
                ...event.preGraces.flat(),
                ...event.pitches,
                ...event.postGraces.flat(),
            ];
            for (const pitch of orderedPitches) {
                const key = `${lane.partId}\0${lane.staff}\0${lane.voice}\0${pitch.step}\0${pitch.alter}\0${pitch.octave}`;
                const previous = localActive.get(key) ?? (ending ? active.get(key) : undefined);
                if (pitch.tieStop && previous) {
                    const after = metadata.afterSources.get(event) ?? [];
                    after.push(`@tie(${pitchLabel(previous)}, ${pitchLabel(pitch)})`);
                    metadata.afterSources.set(event, after);
                }
                if (pitch.tieStart) localActive.set(key, pitch);
                else if (pitch.tieStop) localActive.delete(key);
            }
        }
    }
    const eventLabel = (event: MusicEvent) => {
        if (event.pitches.length === 1) return pitchLabel(event.pitches[0]);
        const label = metadata.labels.get(event) ?? `mx${labelIndex++}`;
        metadata.labels.set(event, label);
        return label;
    };
    for (const wedge of score.wedges) {
        // 连续楔形区间落到实际起音端点后再输出离散的 dyn 关系
        const lanes = score.lanes.filter(item => item.partId === wedge.from.partId && item.staff === wedge.from.staff
            && (!wedge.from.voice || item.voice === wedge.from.voice));
        const targets = lanes.length > 0 ? lanes : score.lanes.filter(item => item.partId === wedge.from.partId).slice(0, 1);
        for (const lane of targets) {
            const sounding = lane.events.filter(event => !event.rest && event.pitches.length > 0);
            const from = sounding.find(event => event.start.compare(wedge.from.at) <= 0
                && add(event.start, event.duration).compare(wedge.from.at) > 0)
                ?? sounding.find(event => event.start.compare(wedge.from.at) >= 0);
            let to: MusicEvent | undefined;
            for (const event of sounding) {
                if (event.start.compare(wedge.end) >= 0) break;
                to = event;
            }
            if (!from || !to || from.start.compare(to.start) >= 0) continue;
            const delta = wedge.from.type === "crescendo" ? 24 : -24;
            relations.push(`@dyn(${eventLabel(from)}, ${eventLabel(to)}, ${delta})`);
        }
    }
    const events = score.lanes.flatMap(lane => lane.events)
        .sort((left, right) => left.start.compare(right.start) || left.order - right.order);
    for (const ending of endings) {
        const fromIndex = lowerBoundAt(events, ending.from.at, event => event.start);
        const toIndex = lowerBoundAt(events, ending.end, event => event.start);
        if (fromIndex >= toIndex) continue;
        const from = events[fromIndex];
        const to = events[toIndex - 1];
        relations.push(`@volta(${eventLabel(from)}, ${eventLabel(to)}, ${ending.from.passes.join(", ")})`);
    }
    return { relations, metadata };
}

/** 将完整 ParsedScore 序列化为 jpFun 源码 */
function renderScore(score: ParsedScore, options: MusicXmlToJpFunOptions) {
    const pitchMode = options.pitchMode ?? "absolute";
    if (pitchMode !== "relative" && pitchMode !== "absolute") throw new TypeError("pitchMode must be relative or absolute");
    const barsPerLine = options.barsPerLine ?? 4;
    if (!Number.isSafeInteger(barsPerLine) || barsPerLine <= 0) throw new RangeError("barsPerLine must be a positive integer");

    // 缺失的零时刻状态由 jpFun 默认值补齐，保证 head 始终完整
    const meters = score.meters.length === 0 || !score.meters[0].at.isZero()
        ? [{ at: new Fraction(), numerator: 4, denominator: 4 }, ...score.meters]
        : score.meters;
    const keys = score.keys.length === 0 || !score.keys[0].at.isZero()
        ? [{ at: new Fraction(), fifths: 0, mode: "major" }, ...score.keys]
        : score.keys;
    const tempos = score.tempos.length === 0 || !score.tempos[0].at.isZero()
        ? [{ at: new Fraction(), bpm: 120 }, ...score.tempos]
        : score.tempos;

    // 初始状态进入 head；中途状态作为精确时间点只写在最上方 lane
    const scoreAdjustments = new Map<string, { at: Fraction; sources: string[] }>();
    const addAdjustment = (at: Fraction, source: string) => {
        const key = keyOf(at);
        const point = scoreAdjustments.get(key) ?? { at, sources: [] };
        point.sources.push(source);
        scoreAdjustments.set(key, point);
    };
    for (const item of keys.slice(1)) addAdjustment(item.at, `@1(${tonicName(item)}4)`);
    for (const item of meters.slice(1)) addAdjustment(item.at, `@meter(${item.numerator}, ${item.denominator})`);
    for (const item of tempos.slice(1)) addAdjustment(item.at, `@tempo(${item.bpm})`);
    // 每条 lane 只记录 program 真正变化的起点
    const programsByLane = score.lanes.map(lane => {
        const programs = new Map<string, number>();
        let active: number | undefined;
        for (const event of lane.events) {
            if (event.program !== undefined && event.program !== active) {
                active = event.program;
                programs.set(keyOf(event.start), active);
            }
        }
        return programs;
    });

    // 关系先分配标签，随后 eventSource 才能把标签写进正确音符
    const { relations, metadata } = labelRelations(score);
    const barTimes = [...score.bars.keys()].map(fractionFromKey)
        .sort((left, right) => left.compare(right));
    const measureBars = [...score.measureBoundaries].map(fractionFromKey)
        .sort((left, right) => left.compare(right));
    if (score.lineBreaks.size === 0) {
        let barsOnLine = 0;
        for (const at of measureBars) {
            if (++barsOnLine === barsPerLine) {
                score.lineBreaks.add(keyOf(at));
                barsOnLine = 0;
            }
        }
    }

    const initialKey = keys[0];
    const initialMeter = meters[0];
    const initialTempo = tempos[0];
    const page = score.page
        ? `@page(width=${score.page.width}px, height=${score.page.height}px, top=${score.page.top}px, bottom=${score.page.bottom}px, left=${score.page.left}px, right=${score.page.right}px)\n`
        : "";

    // 明确的 MusicXML 换行优先；若会切开 tuplet，则丢弃该断点以保持时值组完整
    const blocksByLane = score.lanes.map((lane, index) => renderBlocks(
        lane,
        pitchMode,
        score,
        keys,
        index === 0 ? scoreAdjustments : undefined,
        programsByLane[index],
        metadata,
    ));
    const tupletSpans = blocksByLane.flatMap(blocks => blocks
        .filter(block => block.source)
        .map(block => ({ start: block.start, end: block.end })))
        .sort((left, right) => left.start.compare(right.start) || left.end.compare(right.end));
    const mergedTupletSpans: { start: Fraction; end: Fraction }[] = [];
    for (const span of tupletSpans) {
        const previous = mergedTupletSpans.at(-1);
        if (previous && span.start.compare(previous.end) < 0) {
            if (span.end.compare(previous.end) > 0) previous.end = span.end;
        } else mergedTupletSpans.push(span);
    }
    const lineBreaks = new Map([...score.lineBreaks]
        .map(value => [value, fractionFromKey(value)] as const)
        .filter(([, at]) => !insideSpan(mergedTupletSpans, at)));

    // 每条 lane 独立沿同一组时间点输出；最后再按系统转置成完整 N: 组
    const voices = score.lanes.map((lane, laneIndex) => {
        const verses = new Set<string>();
        for (const event of lane.events) for (const verse of event.lyrics.keys()) verses.add(verse);
        const orderedVerses = [...verses].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
        const outputs: string[][] = [[]];
        const lyricTokens = [new Map(orderedVerses.map(verse => [verse, [] as string[]]))];
        // 歌词槽与可见 note/rest 槽同步推进；缺词位置显式写 @ 占位
        const addLyricSlots = (event: MusicEvent | undefined, count: number) => {
            for (const verse of orderedVerses) {
                const tokens = lyricTokens.at(-1)!.get(verse)!;
                for (let index = 0; index < count; index++) {
                    const value = index === 0 && event ? event.lyrics.get(verse) : undefined;
                    tokens.push(value ? lyricToken(value) : "@");
                }
            }
        };
        const blocks = blocksByLane[laneIndex];
        const tupletBlocks = blocks.filter(block => block.source);
        // 所有事件边界与控制点汇成一条时间线，每个相邻点只输出一个连续片段
        const points = new Map<string, Fraction>();
        points.set("0", new Fraction());
        points.set(keyOf(score.end), score.end);
        for (const block of blocks) {
            points.set(keyOf(block.start), block.start);
            points.set(keyOf(block.end), block.end);
        }
        for (const at of barTimes) if (!insideSpan(tupletBlocks, at)) points.set(keyOf(at), at);
        for (const [value, at] of lineBreaks) points.set(value, at);
        if (laneIndex === 0) {
            for (const [value, point] of scoreAdjustments) {
                if (!insideSpan(tupletBlocks, point.at)) points.set(value, point.at);
            }
        }
        const timeline = [...points.values()].sort((left, right) => left.compare(right));
        let blockIndex = 0;
        for (let index = 0; index < timeline.length; index++) {
            const at = timeline[index];
            while (blockIndex < blocks.length && blocks[blockIndex].end.compare(at) <= 0) {
                blockIndex++;
            }
            const bar = score.bars.get(keyOf(at));
            if (bar && (!at.isZero() || bar !== "|")) outputs.at(-1)!.push(bar);
            if (lineBreaks.has(keyOf(at))) {
                outputs.push([]);
                lyricTokens.push(new Map(orderedVerses.map(verse => [verse, [] as string[]])));
            }
            const next = timeline[index + 1];
            if (!next) continue;
            const duration = next.clone().sub(at);
            if (duration.isZero()) continue;
            const changes = laneIndex === 0 ? scoreAdjustments.get(keyOf(at))?.sources ?? [] : [];
            const block = blocks[blockIndex];
            if (block?.source) {
                if (!block.start.equals(at) || !block.end.equals(next)) {
                    throw new RangeError("MusicXML tuplet cannot cross a barline or state change");
                }
                outputs.at(-1)!.push(block.source);
                for (const item of block.lyricEvents ?? []) {
                    addLyricSlots(item.event, item.slotCount);
                }
                continue;
            }
            const program = programsByLane[laneIndex].get(keyOf(at));
            if (program !== undefined) outputs.at(-1)!.push(`@program(${program})`);
            const event = block?.event;
            if (event && block.start.compare(at) <= 0 && block.end.compare(next) >= 0) {
                const start = event.start.equals(at);
                const key = pointAt(keys, event.start);
                const continuation = event.rest ? "0" : "-";
                // 中途状态挂到 continuation，起音片段则重新生成完整事件源码
                const head = start || changes.length > 0
                    ? (suffix: string) => attachAbove(
                        start ? eventSource(event, pitchMode, key, metadata, suffix) : `${continuation}${suffix}`,
                        changes,
                    )
                    : continuation;
                outputs.at(-1)!.push(durationSource(head, continuation, duration));
                if (start) outputs.at(-1)!.push(...metadata.afterSources.get(event) ?? []);
                if (event.rest) addLyricSlots(start ? event : undefined, restSlotCount(duration));
                else if (start) addLyricSlots(event, 1);
            } else {
                const head = changes.length > 0
                    ? (suffix: string) => attachAbove(`0${suffix}`, changes)
                    : "0";
                outputs.at(-1)!.push(durationSource(head, "0", duration));
                addLyricSlots(undefined, restSlotCount(duration));
            }
        }
        const partName = lane.partName && (!score.lanes[laneIndex - 1] || score.lanes[laneIndex - 1].partId !== lane.partId)
            ? lane.partName
            : "";
        return outputs.map((output, lineIndex) => {
            const lyrics = orderedVerses.map(verse => quote(lyricTokens[lineIndex].get(verse)!.join(" ")));
            const lyricLines = lyrics.map(lyric => `L: ${lyric}`).join("\n");
            const name = lineIndex === 0 && partName ? `(${quote(partName)})` : "";
            return `N${name}: { ${output.join(" ")} }${lyricLines ? `\n${lyricLines}` : ""}`;
        });
    });

    const head = renderHead({
        title: score.title,
        subtitle: score.subtitle,
        author: score.creator,
        key: `${tonicName(initialKey)}4`,
        meter: [initialMeter.numerator, initialMeter.denominator],
        tempo: initialTempo.bpm,
    });
    const body = renderSystems(voices);
    return `${page}${head}\n\n${body}${relations.length > 0 ? `\n${relations.join(" ")}` : ""}`;
}

/** 将解析好的 MusicXML 根元素同步转换为可重新解析的 jpFun 源码 */
export function musicXmlToJpFun(root: MusicXmlElement, options: MusicXmlToJpFunOptions = {}) {
    if (!root || root.nodeType !== 1) throw new TypeError("MusicXML root must be an element");
    return renderScore(parseScore(root), options);
}