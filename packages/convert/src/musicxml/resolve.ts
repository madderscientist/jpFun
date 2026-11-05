import { quote } from "../source.js";
import { reportDiagnostic } from "./features.js";
import type {
    MusicXmlDiagnostic, MusicXmlDirectionPoint as DirectionPoint,
    MusicXmlEndingPoint as EndingPoint, MusicXmlEndingSpan as EndingSpan,
    MusicXmlEvent as MusicEvent, MusicXmlLane as Lane,
    MusicXmlWedgePoint as WedgePoint, MusicXmlWedgeSpan as WedgeSpan,
} from "./model.js";

function eventEnd(event: MusicEvent) {
    return event.start.clone().add(event.duration);
}

/** 省略 voice 才广播到同 staff；显式目标缺失时不得改写其他声部 */
export function matchingLanes(lanes: readonly Lane[], { partId, staff, voice }: DirectionPoint["location"]) {
    return lanes.filter(lane => lane.partId === partId && lane.staff === staff && (!voice || lane.voice === voice));
}

/** 所有 part 扫描结束后配对关系；此阶段只处理语义点，不读取 DOM 或推进游标 */
export function resolveRelations(wedgePoints: WedgePoint[], endingPoints: EndingPoint[], diagnostics: MusicXmlDiagnostic[]) {
    const wedges: WedgeSpan[] = [];
    const activeWedges = new Map<string, WedgePoint>();
    for (const point of wedgePoints.sort((left, right) => left.at.compare(right.at))) {
        const { partId, staff, voice = "" } = point.location;
        const key = `${partId}\0${staff}\0${voice}\0${point.number}`;
        if (point.type === "stop") {
            const from = activeWedges.get(key);
            if (from) wedges.push({ from, end: point.at });
            else reportDiagnostic(diagnostics, "wedgeStart", point.location);
            activeWedges.delete(key);
        } else {
            const previous = activeWedges.get(key);
            if (previous) reportDiagnostic(diagnostics, "wedgeReplaced", previous.location);
            activeWedges.set(key, point);
        }
    }
    for (const point of activeWedges.values()) reportDiagnostic(diagnostics, "wedgeStop", point.location);

    const endings: EndingSpan[] = [];
    let activeEnding: EndingPoint | undefined;
    for (const point of endingPoints.sort((left, right) => left.at.compare(right.at))) {
        if (point.type === "start") {
            if (activeEnding) reportDiagnostic(diagnostics, "endingReplaced", activeEnding.location);
            activeEnding = point;
        } else if (activeEnding) {
            endings.push({ from: activeEnding, end: point.at });
            activeEnding = undefined;
        } else reportDiagnostic(diagnostics, "endingStart", point.location);
    }
    if (activeEnding) reportDiagnostic(diagnostics, "endingStop", activeEnding.location);
    return { wedges, endings };
}

/** 为无起音的有效房子补休止端点；锚点不得覆盖已有长音，并延续解析阶段的事件次序 */
function anchorEndings(lanes: Lane[], endings: readonly EndingSpan[], directions: readonly DirectionPoint[], order: number, partNames: ReadonlyMap<string, string>) {
    const topLane = lanes[0];
    if (!topLane) return;
    for (const ending of endings) {
        if (ending.from.at.compare(ending.end) >= 0) continue;
        const direction = directions.find(item => item.at.compare(ending.from.at) >= 0 && item.at.compare(ending.end) < 0);
        const hostPartId = direction?.location.partId ?? topLane.partId;
        const hostStaff = direction?.location.staff ?? topLane.staff;
        const hostLanes = lanes.filter(lane => lane.partId === hostPartId && lane.staff === hostStaff);
        if (hostLanes.some(lane => lane.events.some(event =>
            event.start.compare(ending.from.at) >= 0 && event.start.compare(ending.end) < 0))) continue;

        let hostLane = hostLanes.find(lane => !lane.events.some(event =>
            event.start.compare(ending.end) < 0 && eventEnd(event).compare(ending.from.at) > 0));
        if (!hostLane) {
            const voices = hostLanes.map(lane => Number(lane.voice)).filter(Number.isFinite);
            hostLane = {
                partId: hostPartId,
                partName: partNames.get(hostPartId) ?? hostPartId,
                staff: hostStaff,
                voice: String(Math.max(0, ...voices) + 1),
                events: [],
            };
            lanes.push(hostLane);
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

/** 无 voice 的力度作用于同 staff 的全部 lane；文字只附着一次，允许使用刚补出的房子锚点 */
function attachDirections(lanes: Lane[], directions: readonly DirectionPoint[], diagnostics: MusicXmlDiagnostic[]) {
    for (const direction of directions) {
        const targets = matchingLanes(lanes, direction.location);
        if (direction.dynamic && targets.length === 0) {
            reportDiagnostic(diagnostics, "dynamicHost", { ...direction.location, element: "dynamics" }, direction.dynamic);
        }
        if (direction.dynamic) {
            const dynamic = {
                at: direction.at,
                name: direction.dynamic,
                placement: direction.placement,
                location: { ...direction.location, element: "dynamics" },
            };
            for (const lane of targets) (lane.dynamics ??= []).push(dynamic);
        }
        if (direction.texts.length === 0) continue;
        let target: MusicEvent | undefined;
        findTarget: for (const lane of targets) for (const event of lane.events) {
            const position = event.start.compare(direction.at);
            if (position < 0 && eventEnd(event).compare(direction.at) > 0) {
                target = event;
                break findTarget;
            }
            if (!target || target.start.compare(direction.at) < 0 || position >= 0
                && (event.start.compare(target.start) < 0 || event.start.equals(target.start) && event.order < target.order)) target = event;
        }
        for (const annotation of direction.texts) {
            if (target) target.annotations.push({ ...annotation, placement: direction.placement });
            else reportDiagnostic(diagnostics, "textHost",
                { ...direction.location, element: annotation.boxed ? "rehearsal" : "words" }, quote(annotation.text));
        }
    }
}

/** 附着完成后拆分重叠事件；所有派生 lane 继承原有的声部身份及精确力度控制点 */
function splitOverlappingLanes(lanes: readonly Lane[]) {
    return lanes.flatMap(lane => {
        const parallel: Lane[] = [];
        for (const event of [...lane.events].sort((left, right) => left.start.compare(right.start) || left.order - right.order)) {
            const target = parallel.find(candidate => eventEnd(candidate.events.at(-1)!).compare(event.start) <= 0);
            if (target) target.events.push(event);
            else parallel.push({ ...lane, events: [event] });
        }
        return parallel.length ? parallel : [lane];
    });
}

/** 锚点先于附着，附着先于拆声部，避免重复文字或遗漏派生声部的力度 */
export function resolveVoices(lanes: Lane[], endings: readonly EndingSpan[], directions: readonly DirectionPoint[], nextOrder: number, partNames: ReadonlyMap<string, string>, diagnostics: MusicXmlDiagnostic[]) {
    anchorEndings(lanes, endings, directions, nextOrder, partNames);
    attachDirections(lanes, directions, diagnostics);
    return splitOverlappingLanes(lanes);
}