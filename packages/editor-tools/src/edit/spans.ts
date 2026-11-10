/**
 * 源码区间代数与词法边界原语
 *
 * 负责处理 SourceEdit[] 文本补丁合成、跨补丁区间重映射，以及 jpFun 语法特有的词法边界保护
 *（如裸 `H.xxx:` 行尾换行、函数实参内低八度逗号 `{1,}` 保护、顶层双回车 `\n\n` 换行判定等）。
 */
import {
    analyzeScoreSyntax,
    findClosingQuote,
    skipSpaces,
    skipSpacesBack,
    type Rect,
    type SourceEdit,
    type SourceSpan,
} from "jpfun";
import type { NoteEditTarget, DashEditTarget, RhythmSpec } from "./types.js";

/** 按逆序偏移将一组不重叠的 SourceEdit 补丁合成为新源码文本 */
export function applySourceEditsToText(source: string, edits: readonly SourceEdit[]): string {
    const indexed = edits.map((edit, idx) => ({ edit, idx }));
    indexed.sort((a, b) => b.edit.span.start - a.edit.span.start || b.edit.span.end - a.edit.span.end || b.idx - a.idx);
    let result = source;
    for (const { edit } of indexed) {
        result = result.slice(0, edit.span.start) + edit.text + result.slice(edit.span.end);
    }
    return result;
}

/** 将一个原有的 SourceSpan 映射为应用补丁数组后的新源码区间；与区间相交的补丁，其替换文本并入新区间 */
export function mapSpanThroughEdits(span: SourceSpan, edits: readonly SourceEdit[]): SourceSpan {
    const sorted = [...edits].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
    let start = span.start, end = span.end, delta = 0;
    for (const { span: e, text } of sorted) {
        const change = text.length - (e.end - e.start);
        if (e.end <= span.start) {
            start += change;
            end += change;
        } else if (e.start <= span.start && e.end >= span.end) {
            start = e.start + delta;
            end = start + text.length;
        } else if (e.start < span.end) {
            if (e.start < span.start) start = e.start + delta;
            end = e.end > span.end ? e.start + delta + text.length : end + change;
        }
        delta += change;
    }
    return { start, end: Math.max(start, end) };
}

/** 计算多个矩形区域的最小外接包围盒 */
export function unionRects(rects: readonly Rect[]): Rect {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const r of rects) {
        left = Math.min(left, r.x);
        top = Math.min(top, r.y);
        right = Math.max(right, r.x + r.w);
        bottom = Math.max(bottom, r.y + r.h);
    }
    return left < Infinity ? { x: left, y: top, w: right - left, h: bottom - top } : { x: 0, y: 0, w: 0, h: 0 };
}

/**
 * 在指定偏移插入源码片段时，自动按上下文补齐前后分隔空白：
 * - 若插入点位于裸 `H.title: ...` 等头部糖行末尾，必须先补 `\n` 避免新音符被吞入标题文本
 * - 返回完整插入串及核心片段在新文档中的起止偏移 `[innerStart, innerEnd]`
 */
export function wrapInsertionText(source: string, pos: number, text: string): { fullText: string; innerStart: number; innerEnd: number } {
    const onBareHeaderLine = pos > 0 && /(?:^|\r?\n)\s*H\.[a-z]+:[^\r\n]*$/.test(source.slice(0, pos));
    const lead = onBareHeaderLine ? "\n" : (pos > 0 && !/[\s({[]/.test(source[pos - 1]) ? " " : "");
    const trail = pos < source.length && !/[\s)}\],]/.test(source[pos]) ? " " : "";
    return {
        fullText: `${lead}${text}${trail}`,
        innerStart: pos + lead.length,
        innerEnd: pos + lead.length + text.length,
    };
}

/** 删除指定区间时一并吞掉紧邻的一侧水平空白，防止多次删除后残留连续空格 */
export function deleteRangeCleanly(source: string, span: SourceSpan): SourceSpan {
    const end = skipSpaces(source, span.end, source.length);
    return { start: end === span.end ? skipSpacesBack(source, span.start - 1) + 1 : span.start, end };
}

/** 将音高、升降号与八度格式化为简谱语法糖词元（如 `#1'`、`5,`） */
export function formatPitchToken(pitch: string, acc: string, octave: number): string {
    if (pitch === "-" || pitch === "0" || pitch === "8" || pitch === "9") return pitch;
    const octText = octave < 0 ? ",".repeat(-octave) : "'".repeat(octave);
    return `${acc}${pitch}${octText}`;
}

/** 将音高与时值（减时线 `/`、附点 `.`）及可选 `@label` 拼接为完整音符语法糖 */
export function formatNoteWithRhythm(pitch: string, acc: string, octave: number, rhythm: RhythmSpec, label?: string): string {
    const base = formatPitchToken(pitch, acc, octave);
    const divPart = "/".repeat(Math.max(0, Math.trunc(rhythm.div)));
    const dotPart = ".".repeat(Math.max(0, Math.trunc(rhythm.dot)));
    return `${base}${divPart}${dotPart}${label ? `@${label}` : ""}`;
}

/** 重写音符或延长线的 `stemSpan`（保留内部原有的 `@label` 绑定） */
export function formatStemSlice(source: string, member: NoteEditTarget | DashEditTarget, rhythm: RhythmSpec): string {
    const baseSpan = member.kind === "note" ? member.noteSpan : { start: member.stemSpan.start, end: member.stemSpan.start + 1 };
    const baseText = member.kind === "note" ? source.slice(baseSpan.start, baseSpan.end) : "-";
    const hasInternalLabel = Boolean(member.label
        && member.stemSpan.end >= (baseSpan.end + member.label.length + 1)
        && source.slice(member.stemSpan.start, member.stemSpan.end).includes(`@${member.label}`));
    return `${baseText}${"/".repeat(rhythm.div)}${".".repeat(rhythm.dot)}${hasInternalLabel && member.label ? `@${member.label}` : ""}`;
}

/**
 * 判定指定位置是否可以使用顶层双回车 `\n\n` 换行语法糖：
 * `BrFunction.deSugarAtom` 仅在括号深度为 0 且不处于 `N:` / `L:` 声部行内时才将 `\n\n` 解析为换行。
 */
export function isTopLevelLineBreakAllowed(masked: string, pos: number): boolean {
    let depth = 0;
    for (let i = 0; i < pos; i++) {
        const ch = masked[i];
        if (ch === '"') {
            i = findClosingQuote(masked, i, pos);
            if (i < 0) break;
        } else if (ch === "{" || ch === "(") depth++;
        else if (ch === "}" || ch === ")") depth = Math.max(0, depth - 1);
    }
    if (depth > 0) return false;
    const lineStart = masked.lastIndexOf("\n", pos - 1) + 1;
    return !/^\s*[NL](?:\([^)]*\))?:/.test(masked.slice(lineStart, pos));
}

/** 扫描源码中已存在的 `@label`，按前缀（如 `t1`, `t2`）分配不冲突的新标签名 */
export function allocateLabels(source: string, prefix: string, count: number): string[] {
    const existing = new Set<string>();
    for (const token of analyzeScoreSyntax(source).syntax.tokens) {
        if (token.kind === "label") {
            const raw = source.slice(token.span.start, token.span.end);
            existing.add(raw.startsWith("@") ? raw.slice(1) : raw);
        }
    }
    const result: string[] = [];
    for (let num = 1; result.length < count; num++) {
        const candidate = `${prefix}${num}`;
        if (!existing.has(candidate)) {
            existing.add(candidate);
            result.push(candidate);
        }
    }
    return result;
}
