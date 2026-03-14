import { Diagnostic } from "../diagnostic";

export const NoteNameMap: Record<string, number> = {
    "C": 0,
    "C#": 1, "Db": 1,
    "D": 2,
    "D#": 3, "Eb": 3,
    "E": 4,
    "F": 5,
    "F#": 6, "Gb": 6,
    "G": 7,
    "G#": 8, "Ab": 8,
    "A": 9,
    "A#": 10, "Bb": 10,
    "B": 11,

    "1": 0,
    "2": 2,
    "3": 4,
    "4": 5,
    "5": 7,
    "6": 9,
    "7": 11
} as const;

const LETTER_ORDER = ["C", "D", "E", "F", "G", "A", "B"] as const;
const MAJOR_SCALE_OFFSETS = [0, 2, 4, 5, 7, 9, 11] as const;

export interface RelativeJianpuPitch {
    renderName: string;
    renderAcc: string;
    renderOctave: number;
}

// 输入 C4 D#3 B3b G, A 等音符字符串，输出 MIDI 数值
// 要求非常严格：必须 [大写字母][升降号#bn只能一个][绝对八度]
export function tonality2Midi(tonality: string, defaultOctave: number): number {
    // 解析音名
    const note = tonality[0];
    let acc = "";
    let i = 1;
    // 解析升降号
    if (i < tonality.length && (tonality[i] === '#' || tonality[i] === 'b' || tonality[i] === 'n')) {
        acc = tonality[i];
        i++;
    }
    // 组合音名和升降号
    let noteValue = NoteNameMap[note + acc];
    if (noteValue === undefined) throw Diagnostic.error.InvalidTonality(tonality, { start: 0, end: i });
    // 解析八度
    if (i < tonality.length) {
        defaultOctave = parseInt(tonality.slice(i), 10);
        if (isNaN(defaultOctave)) throw Diagnostic.error.InvalidTonality(tonality, { start: i, end: tonality.length });
    }
    return (defaultOctave + 1) * 12 + noteValue;
}

// ignoreNatural: 是否忽略还原号对升降号的重置作用。默认为true，即默认自然音符不重置acc
// initOffset: 该小节累加的升降号偏移量 仅在ignoreNatural=false时有意义
export function acc2Offset(acc: string, ignoreNatural: boolean = true, initOffset: number = 0): number {
    for (const ch of acc) {
        if (ch === "#") initOffset++;
        else if (ch === "b") initOffset--;
        else if (ch === "n" && !ignoreNatural) initOffset = 0;
    } return initOffset;
}

export function resolveNoteMidi(name: string, acc: string, octave: number, keySignature: string): number | null {
    const noteValue = NoteNameMap[name];
    if (noteValue === undefined) return null;
    const offset = acc2Offset(acc);
    if (name >= "1" && name <= "7") {
        return tonality2Midi(keySignature, 4) + noteValue + offset + octave * 12;
    }
    return (octave + 1) * 12 + noteValue + offset;
}

function wrapPitchClass(value: number): number {
    return ((value % 12) + 12) % 12;
}

function normalizeAccidentalOffset(value: number): number {
    const wrapped = wrapPitchClass(value);
    return wrapped > 6 ? wrapped - 12 : wrapped;
}

function offsetToAccidental(offset: number): string {
    if (offset === 0) return "";
    if (offset > 0) return "#".repeat(offset);
    return "b".repeat(-offset);
}

// 把绝对字母音高转换成“相对当前调性的简谱显示信息”。
// 这里保留字母拼写带来的调内级数信息，因此像 key=D 时的 C 会被解释成 b7，而不是 #6。
export function resolveLetterNameToJianpu(name: string, acc: string, octave: number, keySignature: string): RelativeJianpuPitch | null {
    const tonicLetter = keySignature[0];
    const tonicMidi = tonality2Midi(keySignature, 4);
    const tonicPitchClass = wrapPitchClass(tonicMidi);
    const notePitchClass = wrapPitchClass(resolveNoteMidi(name, acc, octave, keySignature) ?? NaN);

    const tonicIndex = LETTER_ORDER.indexOf(tonicLetter as typeof LETTER_ORDER[number]);
    const noteIndex = LETTER_ORDER.indexOf(name as typeof LETTER_ORDER[number]);
    if (tonicIndex < 0 || noteIndex < 0 || Number.isNaN(notePitchClass)) {
        return null;
    }

    const degreeIndex = (noteIndex - tonicIndex + LETTER_ORDER.length) % LETTER_ORDER.length;
    const expectedPitchClass = wrapPitchClass(tonicPitchClass + MAJOR_SCALE_OFFSETS[degreeIndex]);
    const accidentalOffset = normalizeAccidentalOffset(notePitchClass - expectedPitchClass);
    const actualMidi = resolveNoteMidi(name, acc, octave, keySignature);
    if (actualMidi === null) {
        return null;
    }

    const octaveOffset = (actualMidi - tonicMidi - MAJOR_SCALE_OFFSETS[degreeIndex] - accidentalOffset) / 12;
    return {
        renderName: String(degreeIndex + 1),
        renderAcc: offsetToAccidental(accidentalOffset),
        renderOctave: octaveOffset,
    };
}