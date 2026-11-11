import { ErrorDiagnostic } from "../../diagnostic.js";
import type { ASTNodeBase } from "../ASTtypes.js";
import type { SourceSpan } from "../../parser/types.js";
import { preprocessSource } from "../../parser/preprocess.js";
import { callArgName, readCall } from "../../parser/parse-utils/call-utils.js";
import type { CallInfo } from "../../parser/grammarType.js";
import { findClosingQuote, quote } from "../../parser/parse-utils/string-utils.js";
import {
    FLAT_NOTE_NAMES,
    NOTE_LETTERS,
    NoteNameMap,
    SHARP_NOTE_NAMES,
    normalizeAccidentalOffset,
    offsetToAccidental,
    resolveLetterNameToJianpu,
    tonality2Midi,
    wrapPitchClass,
} from "../../parser/parse-utils/note-utils.js";
import { parseNoteName } from "./noteName.js";

export type NoteTransform = "to-absolute" | "to-relative" | "semitone-up" | "semitone-down";
export interface SourceEdit { span: SourceSpan; text: string }

interface NoteSource {
    ast: ASTNodeBase & { name: string; acc: string; octave: number; hasDefaultAcc: boolean; jeOctaveOffset: number };
    resolvedMidi: number | null;
    keySignature: string;
}

function fail(span: SourceSpan): never {
    throw new ErrorDiagnostic("E_NOTE_TRANSFORM", "无法安全改写此音符的音高", span);
}

/** 音高计算只读固化事实；互转保留调内级数，半音操作采用最少升降号的拼写 */
function targetPitch(note: NoteSource, operation: NoteTransform) {
    const absolute = operation === "to-absolute"
        || operation !== "to-relative" && NOTE_LETTERS.includes(note.ast.name);
    const midi = note.resolvedMidi! + (operation === "semitone-up" ? 1 : operation === "semitone-down" ? -1 : 0);
    const tonic = tonality2Midi(note.keySignature)!;
    if (![midi, tonic, note.ast.octave, note.ast.jeOctaveOffset].every(Number.isSafeInteger)) fail(note.ast.sourceSpan);
    const spelling = operation === "semitone-down" ? FLAT_NOTE_NAMES : SHARP_NOTE_NAMES;
    let name: string, acc: string, octave: number;
    if (operation === "to-absolute") {
        const base = NOTE_LETTERS.indexOf(note.keySignature[0]);
        const degree = Number(note.ast.name) - 1;
        name = NOTE_LETTERS[(base + degree) % 7];
        const tonicAcc = normalizeAccidentalOffset(tonic - NoteNameMap[NOTE_LETTERS[base]]);
        octave = Math.floor((tonic - tonicAcc) / 12) - 1 + Math.floor((base + degree) / 7)
            + note.ast.octave + note.ast.jeOctaveOffset;
        acc = offsetToAccidental(midi - ((octave + 1) * 12 + NoteNameMap[name]));
    } else if (operation === "to-relative") {
        const ast = note.ast;
        const relative = resolveLetterNameToJianpu(ast.name, ast.acc, ast.octave + ast.jeOctaveOffset, note.keySignature);
        if (!relative) fail(ast.sourceSpan);
        ({ renderName: name, renderAcc: acc, renderOctave: octave } = relative);
    } else {
        const value = absolute ? midi : midi - tonic;
        const pitch = spelling[wrapPitchClass(value)];
        name = absolute ? pitch[0] : String(NOTE_LETTERS.indexOf(pitch[0]) + 1);
        acc = pitch.slice(1);
        octave = Math.floor(value / 12) - (absolute ? 1 : 0);
    }
    return { name, acc, octave: octave - note.ast.jeOctaveOffset, absolute };
}

/**
 * 仅在函数参数的顶层保护低八度逗号；已有大括号内的简写无需再包装。
 * 沿 AST 父链定位最近一层显式函数调用 `@call(...)` 及目标音符所属实参，
 * 统计实参起点到音符前的 `{}` 深度（跳过双引号字符串字面量）。
 */
export function needsBraces(masked: string, ast: ASTNodeBase): boolean {
    for (let parent = ast.parent; parent; parent = parent.parent) {
        const call = readCall(masked, parent.sourceSpan.start, parent.sourceSpan.end);
        const arg = call?.args.find(item => item.valueSpan.start <= ast.sourceSpan.start
            && item.valueSpan.end >= ast.sourceSpan.end);
        if (!arg) continue;
        let depth = 0;
        for (let position = arg.valueSpan.start; position < ast.sourceSpan.start; position++) {
            if (masked[position] === '"') {
                const close = findClosingQuote(masked, position, arg.valueSpan.end);
                if (close >= 0) position = close;
            } else if (masked[position] === "{") depth++;
            else if (masked[position] === "}") depth--;
        }
        return depth === 0;
    }
    return false;
}

export interface NotePitch { name: string; acc: string; octave: number; absolute: boolean }

/** 音高简写文本；省略的部分由显式实参提供 */
function pitchToken({ name, acc, octave, absolute }: NotePitch, withAcc = true, withOctave = true): string {
    const accText = withAcc ? acc : "";
    const octaveText = !withOctave ? "" : absolute ? String(octave) : octave < 0 ? ",".repeat(-octave) : "'".repeat(octave);
    return absolute ? name + accText + octaveText : accText + name + octaveText;
}

/** 只记录与原文不同的改写；被掩码的片段（如注释）无法安全改写 */
function pushEdit(edits: SourceEdit[], source: string, masked: string, span: SourceSpan, text: string) {
    const original = source.slice(span.start, span.end);
    if (original === text) return;
    if (original !== masked.slice(span.start, span.end)) fail(span);
    edits.push({ span, text });
}

/** 改写显式 `@note(...)` 的音高：已有实参只改值，缺失的追加为命名参数；存在默认 acc 时显式写出 acc 以覆盖它 */
export function rewriteNoteCall(source: string, masked: string, call: CallInfo, pitch: NotePitch, hasDefaultAcc: boolean, edits: SourceEdit[] = []): SourceEdit[] {
    const slots = new Map<string | number, SourceSpan>();
    call.args.forEach((arg, index) => {
        if (arg.valueSpan.start < arg.valueSpan.end) slots.set(callArgName(masked, arg) ?? index, arg.valueSpan);
    });
    const nameSlot = slots.get("name") ?? slots.get(0);
    const accSlot = slots.get("acc") ?? slots.get(1);
    const octaveSlot = slots.get("octave") ?? slots.get(2);
    const additions: string[] = [];
    const valueText = (value: string, slot?: SourceSpan) =>
        !value || value.includes(",") || slot && source[slot.start] === '"' ? quote(value) : value;
    const name = pitchToken(pitch, !accSlot && !hasDefaultAcc, !octaveSlot);
    if (nameSlot) pushEdit(edits, source, masked, nameSlot, valueText(name, nameSlot));
    else additions.push(`name=${valueText(name)}`);
    if (accSlot) pushEdit(edits, source, masked, accSlot, valueText(pitch.acc, accSlot));
    else if (hasDefaultAcc) additions.push(`acc=${quote(pitch.acc)}`);
    if (octaveSlot) pushEdit(edits, source, masked, octaveSlot, String(pitch.octave));
    if (additions.length) {
        const at = call.closeParenSpan!.start;
        const prefix = masked.slice(call.openParenSpan.end, at).trimEnd();
        pushEdit(edits, source, masked, { start: at, end: at }, (prefix ? prefix.endsWith(",") ? " " : ", " : "") + additions.join(", "));
    }
    return edits;
}

/** edits 始终引用原文；参数只改值，默认参数只在当前调用覆盖，避免影响其他音符 */
export function rewriteNotes(source: string, notes: readonly NoteSource[], operation: NoteTransform, ranges?: readonly SourceSpan[]): SourceEdit[] {
    const { maskedSource: masked } = preprocessSource(source);
    const edits: SourceEdit[] = [];
    const tokens: SourceEdit[] = [];
    for (const note of notes) {
        const { ast } = note;
        const span = ast.sourceSpan;
        const call = readCall(masked, span.start, span.end);
        const explicit = call?.span.end === span.end && call.closeParenSpan;
        const already = operation === "to-absolute" && NOTE_LETTERS.includes(ast.name)
            || operation === "to-relative" && /^[1-7]$/.test(ast.name);
        if (!explicit) tokens.push({ span, text: source.slice(span.start, span.end) });
        if (ranges && !ranges.some(range => range.start <= span.start && range.end >= span.end)) continue;
        if (note.resolvedMidi === null || already) continue;
        const pitch = targetPitch(note, operation);
        if (explicit) {
            rewriteNoteCall(source, masked, call, pitch, ast.hasDefaultAcc, edits);
            continue;
        }
        let text = pitchToken(pitch);
        if (text.includes(",") && needsBraces(masked, ast)) text = `{${text}}`;
        tokens[tokens.length - 1].text = text;
    }
    // 相邻原子改写后仍须是两个音符，例如 C4D4 -> C4 2，不能合并成 C42。
    tokens.sort((left, right) => left.span.start - right.span.start);
    for (let index = 0; index < tokens.length - 1; index++) {
        const left = tokens[index], right = tokens[index + 1];
        if (left.span.end !== right.span.start || left.text.endsWith("}")) continue;
        const merged = left.text + right.text;
        const parsed = parseNoteName(merged, 0, merged.length, false);
        if (!parsed || parsed.next !== left.text.length) {
            if (left.text !== source.slice(left.span.start, left.span.end)) left.text += " ";
            else right.text = " " + right.text;
        }
    }
    for (const token of tokens) pushEdit(edits, source, masked, token.span, token.text);
    edits.sort((left, right) => left.span.start - right.span.start);
    for (let index = 1; index < edits.length; index++) {
        if (edits[index - 1].span.end > edits[index].span.start) fail(edits[index].span);
    }
    return edits;
}