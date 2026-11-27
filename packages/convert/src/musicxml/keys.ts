/**
 * 全谱实音调号的合成：MusicXML 每个声部、每行谱表各有调号，jpFun 全谱只有一个当前调号
 */
import type { Fraction } from "jpfun";
import { latestAt, reportDiagnostic, type readTransposition } from "./features.js";
import type { MusicXmlDiagnostic, MusicXmlKeyPoint as KeyPoint } from "./model.js";

type MeasureLocation = { partId: string; measureIndex: number; measureNumber?: string };
type KeyLocation = MusicXmlDiagnostic["location"] & { partId: string };
type KeyDeclaration = KeyPoint & { hidden: boolean; location: KeyLocation };
type LocatedTransposition = ReturnType<typeof readTransposition> & { location: KeyLocation };

/** 单个声部收集到的选调信息 */
export interface PartKeys {
    /** 出现过音符或带编号 key 的谱表 */
    staves: Set<string>;
    /** 最终保留了 pitch 编码的普通音符或已附着倚音的谱表 */
    pitchedStaves: Set<string>;
    /** 各时间线按乐谱时间稳定排序；同刻最后一项生效 */
    staffCounts: { at: Fraction; count: number }[];
    measures: { at: Fraction; location: MeasureLocation }[];
    transpositions: LocatedTransposition[];
    declarations: KeyDeclaration[];
}

/** 未编号的声明作用于全部谱表；filter 保留同刻的 XML 顺序 */
export function forStaff<T extends { location: KeyLocation }>(points: readonly T[], staff: string) {
    return points.filter(item => !item.location.staff || item.location.staff === staff);
}

/** 等音调号在五度圈上相距 12 步，取离零最近的拼写 */
function nearestFifths(fifths: number) {
    return fifths - 12 * Math.round(fifths / 12);
}

function transposeFifths(written: number, change?: LocatedTransposition) {
    if (!change) return written;
    const { chromatic, diatonic } = change;
    // diatonic 指定字母拼写；缺省时只知道音高，取最近的等音位移
    const shift = diatonic === undefined ? nearestFifths(7 * (chromatic % 12)) : 7 * chromatic - 12 * diatonic;
    const concert = written + shift;
    return Math.abs(concert) <= 7 ? concert : nearestFifths(concert);
}

/**
 * 每个声部的每行谱表各自持有当前调号，未编号的 key 作用于该声部全部谱表。
 * 在每个调号、移调或谱表数变化点重新选出生效调号：当时存在、可见且有音高的谱表优先，其次按谱面顺序；
 * 隐藏调号和无音高谱表只在没有其他候选时生效，也不报告冲突。
 */
export function resolveConcertKeys(parts: readonly PartKeys[], diagnostics: MusicXmlDiagnostic[]) {
    const slots = parts.flatMap(part => {
        const staves = [...part.staves].sort((left, right) => Number(left) - Number(right));
        return staves.map(staff => ({
            part, staff, multiStaff: staves.length > 1,
            declarations: forStaff(part.declarations, staff),
            transpositions: forStaff(part.transpositions, staff),
            previousFifths: undefined as number | undefined,
            conflicting: false,
        }));
    });
    type Candidate = { slot: typeof slots[number]; written: KeyDeclaration; fifths: number; changedAt?: KeyLocation };
    const times = new Map<string, Fraction>();
    for (const part of parts) {
        for (const { at } of [...part.declarations, ...part.staffCounts, ...part.transpositions]) times.set(at.toString(), at);
    }

    const keys: KeyPoint[] = [];
    for (const at of [...times.values()].sort((left, right) => left.compare(right))) {
        const primary: Candidate[] = [];
        let fallback: Candidate | undefined;
        let present = false;
        for (const slot of slots) {
            if (Number(slot.staff) > (latestAt(slot.part.staffCounts, at)?.count ?? 1)) {
                slot.previousFifths = undefined;
                slot.conflicting = false;
                continue;
            }
            present = true;
            const written = latestAt(slot.declarations, at);
            if (!written) continue;
            const change = latestAt(slot.transpositions, at);
            const fifths = transposeFifths(written.fifths, change);
            const moved = slot.previousFifths !== undefined && (fifths - slot.previousFifths) % 12 !== 0;
            const changedAt = written.at.equals(at) ? written.location : moved ? change?.location : undefined;
            slot.previousFifths = fifths;
            const candidate = { slot, written, fifths, changedAt };
            if (!written.hidden && slot.part.pitchedStaves.has(slot.staff)) primary.push(candidate);
            else {
                fallback ??= candidate;
                slot.conflicting = false;
            }
        }

        // 已生效的调号随谱表消失且剩余谱表都没有调号时回到默认 C 大调；
        // 输出按实际拼写判重，显式的等音换调号（如 F# 改记为 Gb）也要保留
        const last = keys.at(-1);
        const winner = primary[0] ?? fallback;
        if (!winner && !(present && last)) continue;
        const fifths = winner?.fifths ?? 0;
        const mode = winner?.written.mode ?? "major";
        if (!last || last.fifths !== fifths || last.mode !== mode) keys.push({ at, fifths, mode });
        if (primary.length < 2) {
            if (winner) winner.slot.conflicting = false;
            continue;
        }

        // 冲突在首次出现或谱表重新声明时报告一次；共用同一个 key 的谱表合并为一条
        const reports = new Map<KeyDeclaration, { location: KeyLocation; staff?: string }>();
        for (const candidate of primary) {
            const { slot, written, changedAt } = candidate;
            const conflicting = written.mode !== mode || (candidate.fifths - fifths) % 12 !== 0;
            if (conflicting && (changedAt || !slot.conflicting)) {
                const report = reports.get(written);
                // 多行谱表共用同一个声明时，退回声明本身的谱表号
                if (report) report.staff = report.location.staff;
                else {
                    const location = changedAt ?? { ...latestAt(slot.part.measures, at)!.location, element: "key", staff: written.location.staff };
                    reports.set(written, { location, staff: slot.multiStaff ? slot.staff : location.staff });
                }
            }
            slot.conflicting = conflicting;
        }
        const { partId } = primary[0].written.location;
        const source = primary[0].slot.multiStaff ? `${partId} staff ${primary[0].slot.staff}` : partId;
        for (const { location, staff } of reports.values()) {
            reportDiagnostic(diagnostics, "keyConflict", { ...location, staff }, source);
        }
    }
    return keys;
}
