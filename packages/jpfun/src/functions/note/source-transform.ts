import { Diagnostic, ErrorDiagnostic } from "../../diagnostic.js";
import type { ASTNodeBase } from "../ASTtypes.js";
import type { SourceSpan } from "../../parser/types.js";
import { preprocessSource } from "../../parser/preprocess.js";
import { readCall } from "../../parser/parse-utils/call-utils.js";
import { findClosingQuote, quote } from "../../parser/parse-utils/string-utils.js";
import { NoteNameMap, SHARP_NOTE_NAMES, FLAT_NOTE_NAMES, resolveLetterNameToJianpu, tonality2Midi } from "../../parser/parse-utils/note-utils.js";
import { parseNoteName } from "./noteNameFSM.js";

export type NoteTransform = "to-absolute" | "to-relative" | "semitone-up" | "semitone-down";
export interface SourceEdit { span: SourceSpan; text: string }

interface NoteSource {
    ast: ASTNodeBase & { name: string; acc: string; octave: number; hasDefaultAcc: boolean; jeOctaveOffset: number };
    resolvedMidi: number | null;
    keySignature: string;
}

const LETTERS = "CDEFGAB";
const mod = (value: number, base: number) => ((value % base) + base) % base;
const accidental = (offset: number) => offset < 0 ? "b".repeat(-offset) : "#".repeat(offset);

function fail(span: SourceSpan): never {
    throw new ErrorDiagnostic("E_NOTE_TRANSFORM", "无法安全改写此音符的音高", span);
}

/** 音高计算只读固化事实；互转保留调内级数，半音操作采用最少升降号的拼写 */
function targetPitch(note: NoteSource, operation: NoteTransform) {
    const absolute = operation === "to-absolute"
        || operation !== "to-relative" && LETTERS.includes(note.ast.name);
    const midi = note.resolvedMidi! + (operation === "semitone-up" ? 1 : operation === "semitone-down" ? -1 : 0);
    const tonic = tonality2Midi(note.keySignature, 4);
    if (![midi, tonic, note.ast.octave, note.ast.jeOctaveOffset].every(Number.isSafeInteger)) fail(note.ast.sourceSpan);
    const spelling = operation === "semitone-down" ? FLAT_NOTE_NAMES : SHARP_NOTE_NAMES;
    let name: string, acc: string, octave: number;
    if (operation === "to-absolute") {
        const tonicLetter = LETTERS.indexOf(note.keySignature[0]);
        const base = tonicLetter < 0 ? LETTERS.indexOf(SHARP_NOTE_NAMES[mod(tonic, 12)][0]) : tonicLetter;
        const degree = Number(note.ast.name) - 1;
        name = LETTERS[(base + degree) % 7];
        const tonicAcc = mod(tonic - NoteNameMap[LETTERS[base]] + 6, 12) - 6;
        octave = Math.floor((tonic - tonicAcc) / 12) - 1 + Math.floor((base + degree) / 7)
            + note.ast.octave + note.ast.jeOctaveOffset;
        acc = accidental(midi - ((octave + 1) * 12 + NoteNameMap[name]));
    } else if (operation === "to-relative") {
        const ast = note.ast;
        const key = LETTERS.includes(note.keySignature[0]) ? note.keySignature
            : SHARP_NOTE_NAMES[mod(tonic, 12)] + (Math.floor(tonic / 12) - 1);
        const relative = resolveLetterNameToJianpu(ast.name, ast.acc, ast.octave + ast.jeOctaveOffset, key);
        if (!relative) fail(ast.sourceSpan);
        ({ renderName: name, renderAcc: acc, renderOctave: octave } = relative);
    } else {
        const value = absolute ? midi : midi - tonic;
        const pitch = spelling[mod(value, 12)];
        name = absolute ? pitch[0] : String(LETTERS.indexOf(pitch[0]) + 1);
        acc = pitch.slice(1);
        octave = Math.floor(value / 12) - (absolute ? 1 : 0);
    }
    return { name, acc, octave: octave - note.ast.jeOctaveOffset, absolute };
}

/** 仅在函数参数的顶层保护低八度逗号；已有大括号内的简写无需再包装 */
function needsBraces(masked: string, ast: ASTNodeBase) {
    for (let parent = ast.parent; parent; parent = parent.parent) {
        const call = readCall(masked, parent.sourceSpan.start, parent.sourceSpan.end);
        if (!call) continue;
        const arg = call.args.find(item => item.valueSpan.start <= ast.sourceSpan.start
            && item.valueSpan.end >= ast.sourceSpan.end);
        if (!arg) continue;
        let depth = 0;
        for (let position = arg.valueSpan.start; position < ast.sourceSpan.start; position++) {
            if (masked[position] === '"') position = findClosingQuote(masked, position, arg.valueSpan.end);
            else if (masked[position] === "{") depth++;
            else if (masked[position] === "}") depth--;
        }
        return depth === 0;
    }
    return false;
}

/** edits 始终引用原文；参数只改值，默认参数只在当前调用覆盖，避免影响其他音符 */
export function rewriteNotes(source: string, notes: readonly NoteSource[], operation: NoteTransform, ranges?: readonly SourceSpan[]): SourceEdit[] {
    const { maskedSource: masked } = preprocessSource(source);
    const edits: SourceEdit[] = [];
    const tokens: SourceEdit[] = [];
    function replace(span: SourceSpan, text: string) {
        if (source.slice(span.start, span.end) === text) return;
        if (source.slice(span.start, span.end) !== masked.slice(span.start, span.end)) fail(span);
        edits.push({ span, text });
    }
    for (const note of notes) {
        const { ast } = note;
        const span = ast.sourceSpan;
        const call = readCall(masked, span.start, span.end);
        const explicit = call?.span.end === span.end && call.closeParenSpan;
        const already = operation === "to-absolute" && LETTERS.includes(ast.name)
            || operation === "to-relative" && /^[1-7]$/.test(ast.name);
        if (!explicit) tokens.push({ span, text: source.slice(span.start, span.end) });
        if (ranges && !ranges.some(range => range.start <= span.start && range.end >= span.end)) continue;
        if (note.resolvedMidi === null || already) continue;
        const pitch = targetPitch(note, operation);
        const octaveText = pitch.absolute ? String(pitch.octave)
            : pitch.octave < 0 ? ",".repeat(-pitch.octave) : "'".repeat(pitch.octave);
        const nameText = (acc: string, octave: string) => pitch.absolute
            ? pitch.name + acc + octave : acc + pitch.name + octave;
        if (!explicit) {
            let text = nameText(pitch.acc, octaveText);
            if (text.includes(",") && needsBraces(masked, ast)) text = `{${text}}`;
            tokens[tokens.length - 1].text = text;
            continue;
        }
        const slots = new Map<string | number, SourceSpan>();
        call.args.forEach((arg, index) => {
            if (arg.valueSpan.start === arg.valueSpan.end) return;
            slots.set(arg.nameSpan ? masked.slice(arg.nameSpan.start, arg.nameSpan.end).toLowerCase() : index, arg.valueSpan);
        });
        const nameSlot = slots.get("name") ?? slots.get(0);
        const accSlot = slots.get("acc") ?? slots.get(1);
        const octaveSlot = slots.get("octave") ?? slots.get(2);
        const additions: string[] = [];
        function write(slot: SourceSpan | undefined, name: string, value: string) {
            const text = !value || value.includes(",")
                || slot && source[slot.start] === '"' ? quote(value) : value;
            if (slot) replace(slot, text);
            else additions.push(`${name}=${text}`);
        }
        write(nameSlot, "name", nameText(accSlot ? "" : pitch.acc, octaveSlot ? "" : octaveText));
        if (accSlot) write(accSlot, "acc", pitch.acc);
        else if (ast.hasDefaultAcc) additions.push('acc=""');
        if (octaveSlot) replace(octaveSlot, String(pitch.octave));
        if (additions.length) {
            const at = call.closeParenSpan!.start;
            const prefix = masked.slice(call.openParenSpan.end, at).trimEnd();
            replace({ start: at, end: at }, (prefix ? prefix.endsWith(",") ? " " : ", " : "") + additions.join(", "));
        }
    }
    // 相邻原子改写后仍须是两个音符，例如 C4D4 -> C4 2，不能合并成 C42。
    tokens.sort((left, right) => left.span.start - right.span.start);
    for (let index = 0; index < tokens.length - 1; index++) {
        const left = tokens[index], right = tokens[index + 1];
        if (left.span.end !== right.span.start || left.text.endsWith("}")) continue;
        const parsed = parseNoteName(left.text + right.text);
        if (parsed instanceof Diagnostic || parsed.next !== left.text.length) {
            if (left.text !== source.slice(left.span.start, left.span.end)) left.text += " ";
            else right.text = " " + right.text;
        }
    }
    for (const token of tokens) replace(token.span, token.text);
    edits.sort((left, right) => left.span.start - right.span.start);
    for (let index = 1; index < edits.length; index++) {
        if (edits[index - 1].span.end > edits[index].span.start) fail(edits[index].span);
    }
    return edits;
}