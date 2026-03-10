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
};

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