import { Diagnostic, ErrorDiagnostic } from "../../diagnostic.js";

export interface ParsedNoteName {
    name: string;
    next: number;
    acc: string | null;
    octave: number | null;
    absOctave: boolean;
}

function isLetterNote(ch: string): boolean {
    return (ch >= "A" && ch <= "G") || ch === "X" || ch === "Z";
}

function isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9";
}

function isAccidentalChar(ch: string): boolean {
    return ch === "#" || ch === "b" || ch === "n";
}

function readAccidental(str: string, pos: number, end: number): number {
    while (pos < end && isAccidentalChar(str[pos])) pos++;
    return pos;
}

/** 后置升降号不能紧接数字音名（例如 `C4#1` 或 `1#2` 中的 `#1`/`#2` 属于下一个音符） */
function readTrailingAccidental(str: string, pos: number, end: number): string | null {
    const accEnd = readAccidental(str, pos, end);
    return accEnd > pos && !isDigit(str[accEnd] ?? "") ? str.slice(pos, accEnd) : null;
}

function readAbsOctave(str: string, pos: number, end: number): number {
    if (pos < end && (str[pos] === "+" || str[pos] === "-")) pos++;
    const digitStart = pos;
    while (pos < end && isDigit(str[pos])) pos++;
    return pos > digitStart ? pos : -1;
}

function finishRelative(str: string, pos: number, end: number, name: string, acc: string | null): ParsedNoteName {
    let octave = 0;
    let next = pos;
    while (next < end && (str[next] === "," || str[next] === "'")) {
        octave += str[next++] === "'" ? 1 : -1;
    }
    return { name, next, acc, octave: next > pos ? octave : null, absOctave: false };
}

/**
 * 解析音符名称，支持三种语法分支：
 * 1. 字母音名：`[A-GXZ]` + (`[绝对八度][后置升降号]` | `[升降号][绝对八度]`)
 * 2. 数字音名：`[0-9]` + `[后置升降号]` + `[相对八度 ,']`
 * 3. 前置升降号数字音名：`[#bn]+` + `[0-9]` + `[相对八度 ,']`
 */
export function parseNoteName(str: string, start?: number, end?: number, diagnose?: true): ParsedNoteName | Diagnostic;
export function parseNoteName(str: string, start: number, end: number, diagnose: false): ParsedNoteName | null;
export function parseNoteName(
    str: string,
    start: number = 0,
    end: number = str.length,
    diagnose: boolean = true,
): ParsedNoteName | Diagnostic | null {
    if (end - start === 0) {
        return diagnose ? new ErrorDiagnostic(
            "E_WRONG_NOTE_NAME",
            '函数 @note 的参数 [0]:"name" 不能为空',
            { start, end },
        ) : null;
    }

    const ch = str[start];
    // 分支 1：字母音名（使用绝对八度）
    if (isLetterNote(ch)) {
        let pos = start + 1;
        let acc: string | null = null;
        let octave: number | null = null;
        const octEnd = readAbsOctave(str, pos, end);
        if (octEnd > 0) {
            octave = parseInt(str.slice(pos, octEnd), 10);
            pos = octEnd;
            acc = readTrailingAccidental(str, pos, end);
            if (acc) pos += acc.length;
        } else {
            const accEnd = readAccidental(str, pos, end);
            if (accEnd > pos) {
                acc = str.slice(pos, accEnd);
                const oct2 = readAbsOctave(str, accEnd, end);
                if (oct2 > 0) {
                    octave = parseInt(str.slice(accEnd, oct2), 10);
                    pos = oct2;
                } else pos = accEnd;
            }
        }
        return { name: ch, next: pos, acc, octave, absOctave: true };
    }

    // 分支 2：数字音名（使用相对八度）
    if (isDigit(ch)) {
        const acc = readTrailingAccidental(str, start + 1, end);
        return finishRelative(str, start + 1 + (acc ? acc.length : 0), end, ch, acc);
    }

    // 分支 3：前置升降号 + 数字音名
    if (isAccidentalChar(ch)) {
        const accEnd = readAccidental(str, start, end);
        if (accEnd >= end) {
            return diagnose ? new ErrorDiagnostic(
                "E_WRONG_NOTE_NAME",
                '函数 @note 的参数 [0]:"name" 格式错误: 在升降号开头时，应该接数字音名，但输入已结束',
                { start, end },
            ) : null;
        }
        const noteCh = str[accEnd];
        if (!isDigit(noteCh)) {
            return diagnose ? new ErrorDiagnostic(
                "E_WRONG_NOTE_NAME",
                '函数 @note 的参数 [0]:"name" 格式错误: 在升降号开头时，应该接数字音名，但发现字符 "{ch}"',
                { start: accEnd, end: accEnd + 1 },
                { ch: noteCh },
            ) : null;
        }
        return finishRelative(str, accEnd + 1, end, noteCh, str.slice(start, accEnd));
    }

    return diagnose ? new ErrorDiagnostic(
        "E_WRONG_NOTE_NAME",
        '函数 @note 的参数 [0]:"name" 格式错误: 首字符 "{ch}" 不合法，期望 A-G (a-g)、0-9、X 或 Z 开头，或在开头直接使用升降号(#/b/n)',
        { start, end: start + 1 },
        { ch },
    ) : null;
}