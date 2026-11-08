/**
 * 源码无损改写引擎（AST / SourceSpan Round-Trip Rewriting）
 *
 * 将用户的单步交互动作（`ScoreEditAction`）或多音关系命令（`RelationCommandSpec`）
 * 转换为最小化的 `SourceEdit[]` 补丁，最大程度保留用户原有的语法糖风格与无关源码排版。
 */
import {
    ASTBraceNode,
    ASTFunctionNode,
    ASTNodeBase,
    ErrorDiagnostic,
    Fraction,
    analyzeScoreSyntax,
    parseNoteName,
    preprocessSource,
    quoteSourceString,
    readCall,
    type CompileScoreResult,
    type SourceEdit,
    type SourceSpan,
    type SyntaxAnalysis,
    type TemporalNodeBase,
} from "jpfun";
import { labelSymbolAt } from "../language.js";
import { adjacentEditTarget, countTemporalsInSubtree, editTargetAt } from "./index-targets.js";
import {
    allocateLabels,
    applySourceEditsToText,
    deleteRangeCleanly,
    formatNoteWithRhythm,
    formatPitchToken,
    formatStemSlice,
    isTopLevelLineBreakAllowed,
    mapSpanThroughEdits,
    needsCommaProtection,
    wrapInsertionText,
} from "./spans.js";
import {
    BAR_SUGAR,
    isRelationKind,
    rhythmDuration,
    type BarEditTarget,
    type DashEditTarget,
    type MeterEditTarget,
    type NoteEditTarget,
    type RelationCommandSpec,
    type RestEditTarget,
    type RhythmSpec,
    type ScoreEditAction,
    type ScoreEditIndex,
    type ScoreEditResult,
    type ScoreEditTarget,
    type ScoreInsertSlot,
} from "./types.js";

/**
 * 原位改写单个音符的音高、变音记号与八度：
 * - 若原音符为语法糖（如 `#1'`），直接重写 `noteSpan` 并处理函数实参内的低八度逗号保护 `{1,}`
 * - 若原音符为显式 `@note(...)` 调用，按位置或命名参数精准重写 `name` / `acc` / `octave` 槽位
 */
function rewriteNotePitchInPlace(
    source: string,
    masked: string,
    target: NoteEditTarget,
    nextPitch: string,
    nextAcc: string,
    nextOctave: number,
): SourceEdit[] {
    const span = target.noteSpan;
    if (nextPitch === "-") return [{ span, text: "-" }];
    const call = readCall(masked, span.start, span.end);
    const isExplicit = Boolean(call && call.span.end === span.end && call.closeParenSpan);
    const unpitched = nextPitch === "0" || nextPitch === "8" || nextPitch === "9";
    const cleanAcc = unpitched ? "" : nextAcc;
    const cleanOctave = unpitched ? 0 : nextOctave;
    const pitchToken = formatPitchToken(nextPitch, cleanAcc, cleanOctave);

    if (!isExplicit) {
        let replacement = pitchToken.includes(",") && needsCommaProtection(masked, span) ? `{${pitchToken}}` : pitchToken;
        const afterChar = source[span.end] ?? "";
        if (afterChar && /[0-9A-Za-z#b',]/.test(afterChar)) {
            const parsed = parseNoteName(replacement + afterChar, 0, replacement.length + 1, false);
            if (!parsed || parsed.next !== replacement.length) replacement += " ";
        }
        return [{ span, text: replacement }];
    }

    const slots = new Map<string | number, SourceSpan>();
    call!.args.forEach((arg, idx) => {
        if (arg.valueSpan.start < arg.valueSpan.end) {
            slots.set(arg.nameSpan ? masked.slice(arg.nameSpan.start, arg.nameSpan.end).toLowerCase() : idx, arg.valueSpan);
        }
    });
    const nameSlot = slots.get("name") ?? slots.get(0);
    const accSlot = slots.get("acc") ?? slots.get(1);
    const octSlot = slots.get("octave") ?? slots.get(2);
    const edits: SourceEdit[] = [];
    const writeVal = (slot: SourceSpan, val: string) => {
        edits.push({ span: slot, text: !val || val.includes(",") || source[slot.start] === '"' ? quoteSourceString(val) : val });
    };
    const inlineAcc = accSlot || target.hasDefaultAcc ? "" : cleanAcc;
    const inlineOct = octSlot ? "" : (cleanOctave < 0 ? ",".repeat(-cleanOctave) : "'".repeat(cleanOctave));
    if (nameSlot) writeVal(nameSlot, `${inlineAcc}${nextPitch}${inlineOct}`);
    if (accSlot) writeVal(accSlot, cleanAcc);
    else if (target.hasDefaultAcc) {
        const at = call!.closeParenSpan!.start;
        const prefix = masked.slice(call!.openParenSpan.end, at).trimEnd();
        edits.push({ span: { start: at, end: at }, text: `${prefix ? (prefix.endsWith(",") ? " " : ", ") : ""}acc=${quoteSourceString(cleanAcc)}` });
    }
    if (octSlot) edits.push({ span: octSlot, text: String(cleanOctave) });
    return edits;
}

/** 收集最外层共享 `@div` 块及其内部嵌套的所有多音共享 `@div` 节点，以便在改写单音时值时一次性展开 */
function collectNestedSharedDivs(
    root: ASTNodeBase,
    astToTemporal: ReadonlyMap<ASTNodeBase, TemporalNodeBase[]>,
    out: (ASTFunctionNode & { content: ASTNodeBase; n: number })[] = [],
) {
    if (root instanceof ASTFunctionNode && root.callName === "div" && countTemporalsInSubtree(root, astToTemporal) > 1) {
        out.push(root as ASTFunctionNode & { content: ASTNodeBase; n: number });
    }
    for (const child of root.children ?? []) collectNestedSharedDivs(child, astToTemporal, out);
    return out;
}

/**
 * 原位改写音符或延长线的时值（减时线 `div` 与附点 `dot`）：
 * - 若目标处于 `{1 2}/` 或 `{{1 2}/ 3}/` 等多音共享 `@div` 块中，自动剥离外层共享 `@div(...)` 包装，
 *   为每个成员独立补齐各自的 `/` 与 `.`，同时完整保留块内的小节线、倚音或装饰符号
 * - 若目标带有 `{1^$accent}/` 形式的单音外层包装，将其规范化为内层 `1/^$accent`
 */
function rewriteNoteRhythmInPlace(
    source: string,
    compiled: CompileScoreResult,
    index: ScoreEditIndex,
    target: NoteEditTarget | DashEditTarget,
    nextRhythm: RhythmSpec,
): { edits: SourceEdit[]; selectSpan: SourceSpan } {
    const rhythm: RhythmSpec = {
        div: Math.max(0, Math.min(3, Math.trunc(nextRhythm.div))),
        dot: Math.max(0, Math.min(2, Math.trunc(nextRhythm.dot))),
    };
    const sharedDiv = target.outerSharedDiv;

    if (sharedDiv) {
        const allSharedDivs = collectNestedSharedDivs(sharedDiv, compiled.lowering.astToTemporal);
        const cSpan = sharedDiv.content.sourceSpan;
        const innerSpan: SourceSpan = sharedDiv.content instanceof ASTBraceNode && source[cSpan.start] === "{" && source[cSpan.end - 1] === "}"
            ? { start: cSpan.start + 1, end: cSpan.end - 1 }
            : { ...cSpan };

        const members = index.streamTargets.filter((t): t is NoteEditTarget | DashEditTarget =>
            (t.kind === "note" || t.kind === "dash")
            && !(t.kind === "note" && t.isGrace)
            && !t.isChordMember
            && t.stemSpan.start >= innerSpan.start && t.stemSpan.end <= innerSpan.end
        );
        if (members.length > 0) {
            const innerEdits: SourceEdit[] = [];
            for (const nested of allSharedDivs.slice(1)) {
                const nc = nested.content.sourceSpan;
                const nStart = nested.content instanceof ASTBraceNode && source[nc.start] === "{" ? nc.start + 1 : nc.start;
                const nEnd = nested.content instanceof ASTBraceNode && source[nc.end - 1] === "}" ? nc.end - 1 : nc.end;
                if (nested.sourceSpan.start < nStart) innerEdits.push({ span: { start: nested.sourceSpan.start - innerSpan.start, end: nStart - innerSpan.start }, text: "" });
                if (nEnd < nested.sourceSpan.end) innerEdits.push({ span: { start: nEnd - innerSpan.start, end: nested.sourceSpan.end - innerSpan.start }, text: "" });
            }

            let targetRelSpan: SourceSpan = { start: target.stemSpan.start - innerSpan.start, end: target.stemSpan.end - innerSpan.start };
            for (const member of members) {
                const isTarget = member.span.start === target.span.start && member.span.end === target.span.end;
                const relSpan: SourceSpan = { start: member.stemSpan.start - innerSpan.start, end: member.stemSpan.end - innerSpan.start };
                innerEdits.push({ span: relSpan, text: formatStemSlice(source, member, isTarget ? rhythm : member.rhythm) });
                if (isTarget) targetRelSpan = relSpan;
            }
            const replacedInner = applySourceEditsToText(source.slice(innerSpan.start, innerSpan.end), innerEdits);
            const mappedRel = mapSpanThroughEdits(targetRelSpan, innerEdits);
            return {
                edits: [{ span: sharedDiv.sourceSpan, text: replacedInner }],
                selectSpan: { start: sharedDiv.sourceSpan.start + mappedRel.start, end: sharedDiv.sourceSpan.start + mappedRel.end },
            };
        }
    }

    const newStem = formatStemSlice(source, target, rhythm);
    if (target.kind === "note" && target.hasOuterWrapper && target.foldSpan) {
        const foldSlice = source.slice(target.foldSpan.start, target.foldSpan.end);
        const relStart = target.stemSpan.start - target.foldSpan.start;
        const relEnd = target.stemSpan.end - target.foldSpan.start;
        const updatedFold = foldSlice.slice(0, relStart) + newStem + foldSlice.slice(relEnd);
        const trailingLabel = target.label && !newStem.includes(`@${target.label}`) && !updatedFold.includes(`@${target.label}`) ? `@${target.label}` : "";
        return {
            edits: [{ span: target.unitSpan, text: `${updatedFold}${trailingLabel}` }],
            selectSpan: { start: target.unitSpan.start + relStart, end: target.unitSpan.start + relStart + newStem.length },
        };
    }

    const edits: SourceEdit[] = source.slice(target.stemSpan.start, target.stemSpan.end) !== newStem
        ? [{ span: target.stemSpan, text: newStem }]
        : [];
    return { edits, selectSpan: { start: target.stemSpan.start, end: target.stemSpan.start + newStem.length } };
}

/**
 * 在音符上挂载或卸载装饰符号（`^$staccato`、`^$accent` 等）：
 * 注意 `$symbol` 与 `@label` 词法器均吞到空白为止，因此追加符号时需在 `@label` 或已有 `$symbol` 后加空格分隔。
 */
function toggleSymbolOnNote(source: string, target: NoteEditTarget, symbolName: string): { edits: SourceEdit[]; selectSpan: SourceSpan } {
    const normalized = symbolName.replace(/^\$/, "");
    const unitEnd = target.unitSpan.end;
    if (!target.symbols.some(s => s.toLowerCase() === normalized.toLowerCase())) {
        const sliceBefore = source.slice(target.stemSpan.start, unitEnd);
        const needsSpace = /@[A-Za-z0-9_]+$/.test(sliceBefore) || /\$\S+$/.test(sliceBefore);
        const afterChar = source[unitEnd] ?? "";
        const trailSpace = afterChar && !/[\s)}\],]/.test(afterChar) ? " " : "";
        return {
            edits: [{ span: { start: unitEnd, end: unitEnd }, text: `${needsSpace ? " " : ""}^$${normalized}${trailSpace}` }],
            selectSpan: target.span,
        };
    }
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\s*[\\^_]\\s*\\$${escaped}(?=\\s|$|[\\^_)}])`, "i").exec(source.slice(target.stemSpan.end, unitEnd));
    if (!match) return { edits: [], selectSpan: target.span };
    const removeStart = target.stemSpan.end + match.index;
    let removeEnd = removeStart + match[0].length;
    if (removeStart === target.stemSpan.end) {
        while (removeEnd < unitEnd && (source[removeEnd] === " " || source[removeEnd] === "\t")) removeEnd++;
    }
    return { edits: [{ span: { start: removeStart, end: removeEnd }, text: "" }], selectSpan: target.span };
}

/**
 * 删除多音关系调用（`@tie` / `@gliss` / `@tuplet` 等）：
 * - 对 `@tuplet({1 2 3}, 2)` 解包还原内部音符序列，不误删音符本身
 * - 对基于 `@label` 引用的关系函数，若某 `@label` 声明不再被其他位置引用，则级联清理该孤立标签声明
 */
function deleteRelationCallAndOrphanLabels(
    source: string,
    maskedSource: string,
    callSpan: SourceSpan,
    relationKind?: string,
    syntax: SyntaxAnalysis = analyzeScoreSyntax(source).syntax,
): SourceEdit[] {
    const call = readCall(maskedSource, callSpan.start, callSpan.end);
    if (relationKind === "tuplet" && call && call.args.length >= 1) {
        const cSpan = call.args[0].valueSpan;
        let inner = source.slice(cSpan.start, cSpan.end).trim();
        if (inner.startsWith("{") && inner.endsWith("}")) inner = inner.slice(1, -1).trim();
        return [{ span: callSpan, text: inner }];
    }
    const edits: SourceEdit[] = [{ span: deleteRangeCleanly(source, callSpan), text: "" }];
    if (!call) return edits;
    const removed = new Set<string>();
    for (const arg of call.args) {
        if (arg.nameSpan) continue;
        const group = labelSymbolAt(source, syntax, arg.valueSpan.start);
        if (!group || group.references.some(r => r.start < callSpan.start || r.end > callSpan.end)) continue;
        const declSpan: SourceSpan = { start: group.declaration.start - 1, end: group.declaration.end };
        const key = `${declSpan.start}:${declSpan.end}`;
        if (!removed.has(key)) {
            removed.add(key);
            edits.push({ span: declSpan, text: "" });
        }
    }
    return edits;
}

/**
 * 按当前拍号重排后续普通单小节线 `|`（保留双小节线 `||`、终止线 `|||` 与反复记号作为硬锚点，且不拆散 `@tuplet`）
 */
function reflowBarsForCurrentMeter(source: string, index: ScoreEditIndex, anchorSpan?: SourceSpan | null): SourceEdit[] {
    const meters = index.streamTargets.filter((t): t is MeterEditTarget => t.kind === "meter");
    const active = (anchorSpan && meters.find(m => m.span.start <= anchorSpan.start && m.span.end >= anchorSpan.end))
        ?? meters.find(m => !anchorSpan || m.span.start <= anchorSpan.start)
        ?? meters[0];
    if (!active || active.numerator <= 0 || active.denominator <= 0) return [];

    const measureDuration = new Fraction(active.numerator * 4, active.denominator);
    const nextMeter = meters.find(m => m.span.start > active.span.end);
    const rangeEnd = nextMeter ? nextMeter.span.start : source.length;
    const items = index.streamTargets.filter((t): t is NoteEditTarget | DashEditTarget | BarEditTarget | RestEditTarget =>
        t.span.start >= active.unitSpan.end && t.unitSpan.end <= rangeEnd
        && (t.kind === "note" || t.kind === "dash" || t.kind === "bar" || t.kind === "rest")
        && !(t.kind === "note" && t.isGrace) && !t.isChordMember
        && (t.kind === "bar" || t.trackIndex === 0)
    );
    if (items.length === 0) return [];

    const edits: SourceEdit[] = [];
    const acc = new Fraction(0, 1);
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "bar") {
            if (item.barType === 0) edits.push({ span: deleteRangeCleanly(source, item.span), text: "" });
            else acc.set(0, 1);
            continue;
        }
        acc.add(item.compiledDuration.compare(0) > 0
            ? item.compiledDuration
            : item.kind === "rest"
                ? new Fraction(item.measures * measureDuration.numerator, measureDuration.denominator)
                : rhythmDuration(item.rhythm));
        while (acc.compare(measureDuration) >= 0) acc.sub(measureDuration);
        if (!acc.isZero()) continue;

        const nextNonPlain = items.slice(i + 1).find(c => !(c.kind === "bar" && c.barType === 0));
        if (nextNonPlain?.kind === "bar") continue;
        if (item.enclosingTupletSpan && nextNonPlain && nextNonPlain.span.end <= item.enclosingTupletSpan.end) continue;
        const insertPos = item.enclosingTupletSpan ? Math.max(item.unitSpan.end, item.enclosingTupletSpan.end) : item.unitSpan.end;
        edits.push({ span: { start: insertPos, end: insertPos }, text: " |" });
    }
    return edits;
}

function advanceAfterPitchEdit(index: ScoreEditIndex, targetSpan: SourceSpan, edits: SourceEdit[], advance = true): ScoreEditResult {
    const mappedCurrent = mapSpanThroughEdits(targetSpan, edits);
    if (!advance) return { edits, nextMode: "select", nextSpan: mappedCurrent };
    const next = adjacentEditTarget(index, targetSpan, 1);
    return next && (next.kind === "note" || next.kind === "dash")
        ? { edits, nextMode: "select", nextSpan: mapSpanThroughEdits(next.span, edits) }
        : { edits, nextMode: "insert", nextSpan: mappedCurrent };
}

function applySettingEdit(
    source: string,
    index: ScoreEditIndex,
    target: ScoreEditTarget | null,
    slot: ScoreInsertSlot | undefined,
    inPlaceText: string | null,
    callText: string,
): ScoreEditResult {
    if (target && inPlaceText !== null) {
        return {
            edits: [{ span: target.span, text: inPlaceText }],
            nextMode: "select",
            nextSpan: { start: target.span.start, end: target.span.start + inPlaceText.length },
        };
    }
    const insertPos = target?.kind === "bar" ? target.unitSpan.end : target ? target.unitSpan.start : (slot ?? index.defaultInsertSlot).insertAt;
    const { fullText, innerStart, innerEnd } = wrapInsertionText(source, insertPos, callText);
    return {
        edits: [{ span: { start: insertPos, end: insertPos }, text: fullText }],
        nextMode: target ? "select" : "insert",
        nextSpan: { start: innerStart, end: innerEnd },
    };
}

export function applyScoreEditAction(
    source: string,
    compiled: CompileScoreResult,
    index: ScoreEditIndex,
    target: ScoreEditTarget | null,
    action: ScoreEditAction,
): ScoreEditResult {
    const { maskedSource } = preprocessSource(source);

    switch (action.type) {
        case "set-pitch": {
            if (!target) return { edits: [], nextMode: "select", nextSpan: null };
            if (target.kind === "note") {
                const edits = rewriteNotePitchInPlace(source, maskedSource, target, action.pitch, target.acc, target.octave);
                return advanceAfterPitchEdit(index, target.span, edits, action.advance !== false);
            }
            if (target.kind === "dash") {
                const edits: SourceEdit[] = [{ span: target.span, text: formatNoteWithRhythm(action.pitch, "", 0, target.rhythm, target.label) }];
                return advanceAfterPitchEdit(index, target.span, edits, action.advance !== false);
            }
            return { edits: [], nextMode: "select", nextSpan: target.span };
        }

        case "set-accidental": {
            if (target?.kind !== "note") return { edits: [], nextMode: "select", nextSpan: target?.span ?? null };
            const edits = rewriteNotePitchInPlace(source, maskedSource, target, target.pitch, target.acc === action.acc ? "" : action.acc, target.octave);
            return { edits, nextMode: "select", nextSpan: mapSpanThroughEdits(target.span, edits) };
        }

        case "adjust-octave": {
            if (target?.kind !== "note") return { edits: [], nextMode: "select", nextSpan: target?.span ?? null };
            const nextOct = Math.max(-4, Math.min(4, target.octave + action.delta));
            const edits = rewriteNotePitchInPlace(source, maskedSource, target, target.pitch, target.acc, nextOct);
            return { edits, nextMode: "select", nextSpan: mapSpanThroughEdits(target.span, edits) };
        }

        case "set-rhythm": {
            if (target?.kind === "note" || target?.kind === "dash") {
                const merged: RhythmSpec = { div: action.rhythm.div ?? target.rhythm.div, dot: action.rhythm.dot ?? target.rhythm.dot };
                const { edits, selectSpan } = rewriteNoteRhythmInPlace(source, compiled, index, target, merged);
                return { edits, nextMode: "select", nextSpan: selectSpan };
            }
            return { edits: [], nextMode: "select", nextSpan: target?.span ?? null };
        }

        case "toggle-symbol": {
            if (target?.kind !== "note") return { edits: [], nextMode: "select", nextSpan: target?.span ?? null };
            const { edits, selectSpan } = toggleSymbolOnNote(source, target, action.symbol);
            return { edits, nextMode: "select", nextSpan: selectSpan };
        }

        case "insert-grace": {
            if (target?.kind !== "note") return { edits: [], nextMode: "select", nextSpan: target?.span ?? null };
            const gracePitch = action.pitch ?? "6";
            if (action.side === "pre") {
                const hostText = source.slice(target.noteSpan.start, target.noteSpan.end);
                return {
                    edits: [{ span: target.noteSpan, text: `${gracePitch}>${hostText}` }],
                    nextMode: "select",
                    nextSpan: { start: target.noteSpan.start, end: target.noteSpan.start + gracePitch.length },
                };
            }
            const stemText = source.slice(target.stemSpan.start, target.stemSpan.end);
            const graceStart = target.stemSpan.start + stemText.length + 1;
            return {
                edits: [{ span: target.stemSpan, text: `${stemText}<${gracePitch}` }],
                nextMode: "select",
                nextSpan: { start: graceStart, end: graceStart + gracePitch.length },
            };
        }

        case "insert-note": {
            const { slot, pitch, acc = "", octave = 0, rhythm, autoBar = true } = action;
            const noteText = formatNoteWithRhythm(pitch, acc, octave, rhythm);
            let withBar = noteText;
            if (autoBar && slot.meter && slot.measureUsed.clone().add(rhythmDuration(rhythm)).equals(slot.meter.measureDuration)) {
                const tail = maskedSource.slice(slot.insertAt).trimStart();
                if (!/^(\||:\||@bar|@\|)/.test(tail)) withBar = `${noteText} |`;
            }
            const { fullText, innerStart, innerEnd } = wrapInsertionText(source, slot.insertAt, withBar);
            return {
                edits: [{ span: { start: slot.insertAt, end: slot.insertAt }, text: fullText }],
                nextMode: "insert",
                nextSpan: { start: innerStart, end: innerEnd },
            };
        }

        case "set-bar": {
            const barToken = BAR_SUGAR[action.barType] ?? "|";
            if (target?.kind === "bar") {
                const call = readCall(maskedSource, target.span.start, target.span.end);
                const typeArg = call?.closeParenSpan && call.args.find((a, idx) =>
                    a.nameSpan ? maskedSource.slice(a.nameSpan.start, a.nameSpan.end).toLowerCase() === "type" : idx === 0
                );
                if (typeArg) {
                    const edits: SourceEdit[] = [{ span: typeArg.valueSpan, text: String(action.barType) }];
                    return { edits, nextMode: "select", nextSpan: mapSpanThroughEdits(target.span, edits) };
                }
                return {
                    edits: [{ span: target.span, text: barToken }],
                    nextMode: "select",
                    nextSpan: { start: target.span.start, end: target.span.start + barToken.length },
                };
            }
            const insertPos = target ? target.postGroupInsertEnd : (action.slot ?? index.defaultInsertSlot).insertAt;
            const { fullText, innerStart, innerEnd } = wrapInsertionText(source, insertPos, barToken);
            return {
                edits: [{ span: { start: insertPos, end: insertPos }, text: fullText }],
                nextMode: "insert",
                nextSpan: { start: innerStart, end: innerEnd },
            };
        }

        case "insert-line-break": {
            const insertPos = target ? target.postGroupInsertEnd : (action.slot ?? index.defaultInsertSlot).insertAt;
            if (isTopLevelLineBreakAllowed(maskedSource, insertPos)) {
                let start = insertPos, end = insertPos;
                while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
                while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
                return {
                    edits: [{ span: { start, end }, text: "\n\n" }],
                    nextMode: "insert",
                    nextSpan: { start: start + 1, end: start + 2 },
                };
            }
            const { fullText, innerStart, innerEnd } = wrapInsertionText(source, insertPos, "@br()");
            return {
                edits: [{ span: { start: insertPos, end: insertPos }, text: fullText }],
                nextMode: "insert",
                nextSpan: { start: innerStart, end: innerEnd },
            };
        }

        case "set-meter": {
            const { numerator, denominator } = action;
            const callText = `@meter(${numerator}, ${denominator})`;
            const inPlace = target?.kind === "meter"
                ? (source.slice(target.span.start, target.span.end).trimStart().startsWith("@") ? callText : `${numerator}/${denominator}`)
                : null;
            return applySettingEdit(source, index, target, action.slot, inPlace, callText);
        }

        case "set-key": {
            const tonality = action.tonality.trim() || "C";
            const raw = target?.kind === "key" ? source.slice(target.span.start, target.span.end).trimStart() : "";
            const inPlace = target?.kind === "key"
                ? (raw.startsWith("@key") ? `@key(${tonality})` : raw.startsWith("@1") ? `@1(${tonality})` : `1=${tonality}`)
                : null;
            return applySettingEdit(source, index, target, action.slot, inPlace, `@1(${tonality})`);
        }

        case "set-tempo": {
            const bpm = Math.max(20, Math.min(320, Math.round(action.bpm)));
            const callText = `@tempo(${bpm})`;
            const inPlace = target?.kind === "tempo"
                ? (source.slice(target.span.start, target.span.end).trimStart().startsWith("@") ? callText : String(bpm))
                : null;
            return applySettingEdit(source, index, target, action.slot, inPlace, callText);
        }

        case "reflow-bars": {
            const edits = reflowBarsForCurrentMeter(source, index, target?.span);
            return {
                edits,
                nextMode: target ? "select" : "insert",
                nextSpan: target ? mapSpanThroughEdits(target.span, edits) : null,
            };
        }

        case "delete": {
            if (!target) {
                const brSpan = action.slot?.afterSpan;
                if (brSpan && !editTargetAt(index, brSpan)) {
                    const prev = [...index.streamTargets].reverse().find(t => t.unitSpan.end <= brSpan.start) ?? null;
                    const start = source[brSpan.start] === "\n" && brSpan.start > 0 && source[brSpan.start - 1] === "\n"
                        ? brSpan.start - 1
                        : brSpan.start;
                    const delSpan = source[start] === "\n" ? { start, end: brSpan.end } : deleteRangeCleanly(source, brSpan);
                    const replacement = delSpan.start > 0 && delSpan.end < source.length && !/\s/.test(source[delSpan.end]) ? " " : "";
                    const edits: SourceEdit[] = [{ span: delSpan, text: replacement }];
                    return { edits, nextMode: "insert", nextSpan: prev ? mapSpanThroughEdits(prev.span, edits) : null };
                }
                return { edits: [], nextMode: "insert", nextSpan: null };
            }
            if (target.kind === "relation") {
                const prev = [...index.streamTargets].reverse().find(t => t.span.end <= target.span.start)
                    ?? index.streamTargets[0] ?? null;
                const edits = deleteRelationCallAndOrphanLabels(source, maskedSource, target.span, target.relationKind);
                return { edits, nextMode: prev ? "select" : "insert", nextSpan: prev ? mapSpanThroughEdits(prev.span, edits) : null };
            }
            if ((target.kind === "meter" || target.kind === "key") && target.inHeader) {
                return { edits: [], nextMode: "select", nextSpan: target.span };
            }
            if (target.kind === "note" && target.isGrace && target.graceBranchParent) {
                const gp = target.graceBranchParent;
                if (countTemporalsInSubtree(gp.grace, compiled.lowering.astToTemporal) <= 1) {
                    const hostText = source.slice(gp.host.sourceSpan.start, gp.host.sourceSpan.end);
                    return {
                        edits: [{ span: gp.sourceSpan, text: hostText }],
                        nextMode: "select",
                        nextSpan: { start: gp.sourceSpan.start, end: gp.sourceSpan.start + hostText.length },
                    };
                }
            }
            const effectiveUnitSpan = target.kind === "note" && target.graceHostParent
                ? target.graceHostParent.sourceSpan
                : target.unitSpan;
            const neighbor = [...index.streamTargets].reverse().find(t => t.unitSpan.end <= effectiveUnitSpan.start)
                ?? index.streamTargets.find(t => t.span.start >= effectiveUnitSpan.end) ?? null;
            const delSpan = deleteRangeCleanly(source, effectiveUnitSpan);
            const edits: SourceEdit[] = [{ span: delSpan, text: "" }];

            if ((target.kind === "note" || target.kind === "dash") && target.label) {
                const { syntax } = analyzeScoreSyntax(source);
                const labelPos = source.indexOf(`@${target.label}`, target.stemSpan.start);
                const group = labelPos >= 0 ? labelSymbolAt(source, syntax, labelPos) : null;
                if (group) {
                    for (const call of syntax.calls) {
                        const rawName = call.name.toLowerCase();
                        if (!isRelationKind(rawName) || !group.references.some(r => r.start >= call.span.start && r.end <= call.span.end)) continue;
                        for (const relEdit of deleteRelationCallAndOrphanLabels(source, maskedSource, call.span, rawName, syntax)) {
                            if (relEdit.span.end < delSpan.start || relEdit.span.start > delSpan.end) edits.push(relEdit);
                            else {
                                delSpan.start = Math.min(delSpan.start, relEdit.span.start);
                                delSpan.end = Math.max(delSpan.end, relEdit.span.end);
                            }
                        }
                    }
                }
            }
            return { edits, nextMode: neighbor ? "select" : "insert", nextSpan: neighbor ? mapSpanThroughEdits(neighbor.span, edits) : null };
        }
    }
}

export function applyRelationCommand(source: string, spec: RelationCommandSpec): ScoreEditResult {
    const picked = spec.targets
        .filter((t): t is NoteEditTarget | DashEditTarget => t.kind === "note" || t.kind === "dash")
        .sort((a, b) => a.span.start - b.span.start);

    if (spec.kind === "tuplet") {
        if (picked.length < 1) throw new ErrorDiagnostic("E_EDIT_TUPLET_TARGETS", "@tuplet 至少需要选择一个音符", { start: 0, end: 0 });
        const rangeSpan: SourceSpan = { start: picked[0].unitSpan.start, end: picked.at(-1)!.unitSpan.end };
        const replacement = `@tuplet({${source.slice(rangeSpan.start, rangeSpan.end)}}, ${spec.normal ?? 2})`;
        return {
            edits: [{ span: rangeSpan, text: replacement }],
            nextMode: "select",
            nextSpan: { start: rangeSpan.start, end: rangeSpan.start + replacement.length },
        };
    }

    if (picked.length < 2) throw new ErrorDiagnostic("E_EDIT_RELATION_TARGETS", `@${spec.kind} 至少需要选择两个端点`, { start: 0, end: 0 });
    const endpoints = spec.kind === "tie" || spec.kind === "beam" ? picked : [picked[0], picked.at(-1)!];
    const allocated = allocateLabels(source, spec.kind[0], endpoints.filter(ep => !ep.label).length);
    let allocIndex = 0;

    const edits: SourceEdit[] = [];
    const labels = endpoints.map(ep => {
        if (ep.label) return ep.label;
        const label = allocated[allocIndex++];
        const pos = ep.labelInsertOffset;
        const afterChar = source[pos] ?? "";
        edits.push({ span: { start: pos, end: pos }, text: `@${label}${afterChar && !/[\s(){},]/.test(afterChar) ? " " : ""}` });
        return label;
    });

    const extraArg = spec.kind === "dyn" ? `, ${spec.dv ?? 24}`
        : spec.kind === "ottava" ? `, ${spec.shift ?? 1}`
        : spec.kind === "volta" ? `, ${spec.pass ?? 1}` : "";
    const callText = `@${spec.kind}(${labels.join(", ")}${extraArg})`;

    const lastEndpoint = endpoints.at(-1)!;
    const insertAt = lastEndpoint.unitSpan.end;
    const prevEdit = edits.at(-1);
    if (prevEdit && prevEdit.span.start === insertAt && prevEdit.span.end === insertAt) {
        const trail = insertAt < source.length && !/[\s)}\],]/.test(source[insertAt]) ? " " : "";
        prevEdit.text = `${prevEdit.text.trimEnd()} ${callText}${trail}`;
    } else {
        edits.push({ span: { start: insertAt, end: insertAt }, text: wrapInsertionText(source, insertAt, callText).fullText });
    }

    return { edits, nextMode: "select", nextSpan: mapSpanThroughEdits(lastEndpoint.span, edits) };
}
