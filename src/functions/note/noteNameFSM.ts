import { Diagnostic, ErrorDiagnostic } from "../../parser/diagnostic.js";

const LETTER_NOTE_START_RE = /^[A-G]/;
const NUM_NOTE_START_RE = /^[0-9]/;
const SHARP_RE = /^[#bn]+/;
const ABS_OCTAVE_RE = /^[+-]?\d+/;
const RELATIVE_OCTAVE_RE = /^[,']+/;

export function parseNoteName(str: string, start: number = 0, end: number = str.length): {
    name: string;
    next: number;
    acc: string | null;
    octave: number | null;
    absOctave: boolean;
} | Diagnostic {
    if ((end - start) === 0) return new ErrorDiagnostic(
        "E_WRONG_NOTE_NAME",
        `函数 @note 的参数 [0]:"name" 不能为空`,
        { start, end }
    );
    // 用状态机解决 详细信息查看FSM.drawio
    let state: number = 0;
    let name: string | null = null, acc: string | null = null, octave: number | null = null, absOctave: boolean = false;
    let match: any;
    for (let pos = start; pos < end; pos++) {
        const ch = str[pos];
        switch (state) {
            case 0:
                if (LETTER_NOTE_START_RE.test(ch)) {
                    name = ch;
                    absOctave = true;
                    state = 1;
                } else if (NUM_NOTE_START_RE.test(ch)) {
                    name = ch;
                    absOctave = false;
                    state = 4;
                } else {
                    const match = str.slice(pos, end).match(SHARP_RE);
                    if (match) {
                        acc = match[0];
                        pos += acc.length - 1;
                        absOctave = false;
                        state = 7;
                    } else return new ErrorDiagnostic(
                        "E_WRONG_NOTE_NAME",
                        `函数 @note 的参数 [0]:"name" 格式错误: 首字符 "${ch}" 不合法，期望 A-G (a-g) 或 0-9 开头，或在开头直接使用升降号(#/b/n)`,
                        { start: pos, end: pos + 1 }
                    );
                } break;
            case 1:
                const subs = str.slice(pos, end);
                match = subs.match(ABS_OCTAVE_RE);
                if (match) {
                    octave = parseInt(match[0], 10);
                    pos += match[0].length - 1;
                    state = 2;
                    break;
                }
                match = subs.match(SHARP_RE);
                if (match) {
                    acc = match[0] as string;
                    pos += acc.length - 1;
                    state = 3;
                    break;
                }
                return {
                    name: name!,
                    next: pos,
                    acc: null,
                    octave: null,
                    absOctave,
                };
            case 2:
                match = str.slice(pos, end).match(SHARP_RE);
                if (match) {
                    acc = match[0] as string;
                    return {
                        name: name!,
                        next: pos + acc.length,
                        acc,
                        octave,
                        absOctave,
                    };
                } return {
                    name: name!,
                    next: pos,
                    acc: null,
                    octave: octave!,
                    absOctave,
                };
            case 3:
                match = str.slice(pos, end).match(ABS_OCTAVE_RE);
                if (match) {
                    octave = parseInt(match[0], 10);
                    return {
                        name: name!,
                        next: pos + match[0].length,
                        acc,
                        octave,
                        absOctave,
                    };
                } return {
                    name: name!,
                    next: pos,
                    acc: acc!,
                    octave: null,
                    absOctave,
                };
            case 4:
                match = str.slice(pos, end).match(RELATIVE_OCTAVE_RE);
                if (match) {
                    const octave_str = match[0];
                    octave = relativeOctaveFromString(octave_str);
                    pos += octave_str.length - 1;
                    state = 5;
                    break;
                }
                match = str.slice(pos, end).match(SHARP_RE);
                if (match) {
                    acc = match[0] as string;
                    pos += acc.length - 1;
                    state = 6;
                    break;
                } return {
                    name: name!,
                    next: pos,
                    acc: null,
                    octave: octave!,
                    absOctave,
                };
            case 5:
                match = str.slice(pos, end).match(SHARP_RE);
                if (match) {
                    acc = match[0] as string;
                    return {
                        name: name!,
                        next: pos + acc.length,
                        acc,
                        octave: octave!,
                        absOctave,
                    };
                } return {
                    name: name!,
                    next: pos,
                    acc: null,
                    octave: octave!,
                    absOctave,
                };
            case 6:
                match = str.slice(pos, end).match(RELATIVE_OCTAVE_RE);
                if (match) {
                    const octave_str = match[0];
                    octave = relativeOctaveFromString(octave_str);
                    return {
                        name: name!,
                        next: pos + octave_str.length,
                        acc: acc!,
                        octave: octave!,
                        absOctave,
                    };
                } return {
                    name: name!,
                    next: pos,
                    acc: acc!,
                    octave: octave!,
                    absOctave,
                };
            case 7:
                if (NUM_NOTE_START_RE.test(ch)) {
                    name = ch;
                    state = 6;
                    break;
                } else return new ErrorDiagnostic(
                    "E_WRONG_NOTE_NAME",
                    `函数 @note 的参数 [0]:"name" 格式错误: 在升降号开头时，应该接数字音名，但发现字符 "${ch}"`,
                    { start: pos, end: pos + 1 }
                );
            default:
                return Diagnostic.error.Bug(
                    "音符名称解析状态机进入了未定义的状态",
                    { start: pos, end },
                );
        }
    }
    return {
        name: name!,
        next: end,
        acc,
        octave,
        absOctave
    };
}

function relativeOctaveFromString(octaveStr: string): number {
    let octave = 0;
    for (let i = 0; i < octaveStr.length; i++) {
        if (octaveStr[i] === ',') octave--;
        else if (octaveStr[i] === "'") octave++;
    } return octave;
}