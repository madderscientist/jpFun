/**
 * AST 父链分析、谱面目标索引与空间命中解析
 *
 * 将一次 CompileScoreResult 的 lowering/layout 产物整理为按源码顺序排列的可编辑流目标（`streamTargets`）、
 * 多音关系附件目标（`relationTargets`）以及带小节拍数进度感知的 `[+]` 插入槽（`ScoreInsertSlot`）。
 */
import {
    ANCHOR_KEY,
    ASTBraceNode,
    ASTFunctionNode,
    ASTLabelNode,
    ASTNodeBase,
    ASTTextNode,
    Fraction,
    getLayoutBounds,
    layoutPageBounds,
    readCall,
    type CompileScoreResult,
    type Rect,
    type SourceSpan,
    type TemporalNodeBase,
    type Track,
    type VisualTemporalNode,
} from "jpfun";
import { collectVisibleTemporalNodes, previewHitAt, type PreviewNavigationMap } from "../navigation.js";
import { unionRects } from "./spans.js";
import {
    isRelationKind,
    type ActiveMeterInfo,
    type BaseEditTarget,
    type RelationEditTarget,
    type ScoreEditIndex,
    type ScoreEditTarget,
    type ScoreInsertSlot,
    type ScoreStreamTarget,
} from "./types.js";

const GROUP_WRAPPERS = new Set(["tuplet", "box", "grace", "div", "dot", "up", "down", "arp", "tremolo", "adjust", "slide"]);

export function callNameOf(node: ASTNodeBase): string {
    return node instanceof ASTFunctionNode ? node.callName : "";
}

/** 统计某 AST 子树下实际产出的音符与延长线数量，用于区分单音包装与多音共享 `@div({1 2})` */
export function countTemporalsInSubtree(node: ASTNodeBase, astToTemporal: ReadonlyMap<ASTNodeBase, TemporalNodeBase[]>): number {
    let count = 0;
    for (const t of astToTemporal.get(node) ?? []) {
        const name = callNameOf(t.ast);
        if (name === "note" || name === "dash") count++;
    }
    for (const child of node.children ?? []) count += countTemporalsInSubtree(child, astToTemporal);
    return count;
}

interface AncestorContext {
    inHeader: boolean;
    isChordMember: boolean;
    enclosingTupletSpan?: SourceSpan;
    graceBranchParent?: ASTFunctionNode & { host: ASTNodeBase; grace: ASTNodeBase };
    graceHostParent?: ASTFunctionNode & { host: ASTNodeBase; grace: ASTNodeBase };
    outerSharedDiv?: ASTFunctionNode & { content: ASTNodeBase; n: number };
}

/**
 * 沿 AST `.parent` 链单次向上扫描（O(depth)），一次性收集该节点所处的：
 * - `@head` 头部区域标记
 * - `@up` / `@down` 和弦从属音标记
 * - 外层 `@tuplet` 区间
 * - `@grace` 倚音分支或宿主关系
 * - 最外层多音共享 `@div` 包装节点
 */
function analyzeAncestors(node: ASTNodeBase, astToTemporal: ReadonlyMap<ASTNodeBase, TemporalNodeBase[]>): AncestorContext {
    let inHeader = false;
    let isChordMember = false;
    let enclosingTupletSpan: SourceSpan | undefined;
    let graceBranchParent: (ASTFunctionNode & { host: ASTNodeBase; grace: ASTNodeBase }) | undefined;
    let graceHostParent: (ASTFunctionNode & { host: ASTNodeBase; grace: ASTNodeBase }) | undefined;
    let outerSharedDiv: (ASTFunctionNode & { content: ASTNodeBase; n: number }) | undefined;

    for (let cur: ASTNodeBase | null = node; cur?.parent; cur = cur.parent) {
        const p: ASTNodeBase = cur.parent;
        if (!(p instanceof ASTFunctionNode)) continue;
        const name = p.callName;
        if (name === "head") inHeader = true;
        else if (name === "tuplet") enclosingTupletSpan = { ...p.sourceSpan };
        else if ((name === "up" || name === "down") && p.children && p.children[0] !== cur) isChordMember = true;
        else if (name === "grace") {
            const g = p as ASTFunctionNode & { host: ASTNodeBase; grace: ASTNodeBase };
            if (g.grace === cur) graceBranchParent = g;
            else if (g.host === cur) graceHostParent = g;
        } else if (name === "div" && countTemporalsInSubtree(p, astToTemporal) > 1) {
            outerSharedDiv = p as ASTFunctionNode & { content: ASTNodeBase; n: number };
        }
    }
    return { inHeader, isChordMember, enclosingTupletSpan, graceBranchParent, graceHostParent, outerSharedDiv };
}

/** 沿父链向上攀爬所有仅包裹当前单个音符的 `{...}`、`@div`、`@dot` 节点，定位该音符独占的 `stemAst` 或 `outerAst` */
function climbSingleWrappers(start: ASTNodeBase, astToTemporal: ReadonlyMap<ASTNodeBase, TemporalNodeBase[]>): ASTNodeBase {
    let cur = start;
    for (let p = cur.parent; p; p = cur.parent) {
        if (p instanceof ASTBraceNode) {
            const items = p.content.filter(c => !(c instanceof ASTLabelNode) && !(c instanceof ASTTextNode));
            if (items.length === 1 && items[0] === cur) { cur = p; continue; }
            break;
        }
        if (p instanceof ASTFunctionNode && (p.callName === "div" || p.callName === "dot") && countTemporalsInSubtree(p, astToTemporal) <= 1) {
            cur = p;
            continue;
        }
        break;
    }
    return cur;
}

/** 在指定子树及其紧邻右侧兄弟节点中查找绑定到目标 AST 节点集合的 `@label` 节点 */
function findLabelNodeFor(root: ASTNodeBase, targets: ReadonlySet<ASTNodeBase>): ASTLabelNode | undefined {
    if (root instanceof ASTLabelNode && targets.has(root.target)) return root;
    for (const child of root.children ?? []) {
        const found = findLabelNodeFor(child, targets);
        if (found) return found;
    }
    const siblings = root.parent?.children;
    if (!siblings) return undefined;
    for (let i = siblings.indexOf(root) + 1; i > 0 && i < siblings.length; i++) {
        const sib = siblings[i];
        if (sib instanceof ASTLabelNode && targets.has(sib.target)) return sib;
        if (!(sib instanceof ASTTextNode)) break;
    }
    return undefined;
}

/**
 * 解析音符或延长线的多级 AST 边界（`noteAst` -> `stemAst` -> `foldAst` -> `outerAst`），
 * 提取生效的时值（`div`/`dot`）、折叠装饰符号列表（`symbols`）与绑定的 `@label`。
 */
function resolveNoteAst(
    temporal: VisualTemporalNode,
    astToTemporal: ReadonlyMap<ASTNodeBase, TemporalNodeBase[]>,
    isGrace: boolean,
) {
    const noteAst = temporal.ast as unknown as ASTFunctionNode;
    const labelTargets = new Set<ASTNodeBase>([noteAst]);
    const stemAst = climbSingleWrappers(noteAst, astToTemporal);
    let outerAst = stemAst;
    let foldAst: ASTFunctionNode | undefined;
    let div = Number(temporal.addon?.["@div"]) || 0;
    let dot = Number(temporal.addon?.["@dot"]) || 0;

    if (outerAst.parent instanceof ASTFunctionNode
        && (outerAst.parent.callName === "up" || outerAst.parent.callName === "down")
        && outerAst.parent.children?.[0] === outerAst) {
        foldAst = outerAst.parent;
        labelTargets.add(foldAst);
        const rootHost = temporal.rootHost;
        div = Math.max(div, Number(rootHost.addon?.["@div"]) || 0);
        dot = Math.max(dot, Number(rootHost.addon?.["@dot"]) || 0);
        outerAst = climbSingleWrappers(foldAst, astToTemporal);
    }

    // 倚音在 lowering 时默认多加了一层 @div(1)，还原回源码书写的减时线数
    if (isGrace) div = Math.max(0, div - 1);

    const symbols: string[] = [];
    for (const child of (foldAst?.children ?? []).slice(1)) {
        if (child instanceof ASTFunctionNode && child.callName === "symbol") {
            const def = (child as ASTFunctionNode & { definition?: { name: string } }).definition;
            if (def?.name) symbols.push(def.name);
        }
    }

    const labelNode = findLabelNodeFor(outerAst, labelTargets) ?? findLabelNodeFor(stemAst, labelTargets);
    const label = labelNode?.label ?? noteAst.label ?? foldAst?.label;
    const unitEnd = Math.max(outerAst.sourceSpan.end, labelNode?.sourceSpan.end ?? 0);

    return {
        noteAst,
        stemAst,
        outerAst,
        foldAst,
        unitSpan: { start: outerAst.sourceSpan.start, end: unitEnd },
        label,
        symbols,
        rhythm: { div, dot },
    };
}

/** 若当前流元素是外层分组（如 `@tuplet`、`@div`、`@grace`）中的最后一个元素，将后续插入点推进到分组右括号之外 */
function resolvePostGroupInsertOffset(ast: ASTNodeBase, fallbackEnd: number, allStreamSpans: readonly SourceSpan[]): number {
    let end = fallbackEnd;
    for (let cur: ASTNodeBase | null = ast.parent; cur; cur = cur.parent) {
        if (cur instanceof ASTFunctionNode && (cur.callName === "voice" || cur.callName === "voices")) break;
        if (cur instanceof ASTFunctionNode && GROUP_WRAPPERS.has(cur.callName)) {
            const hasLaterSibling = allStreamSpans.some(s => s.start >= fallbackEnd && s.end <= cur!.sourceSpan.end);
            if (!hasLaterSibling) end = Math.max(end, cur.sourceSpan.end);
        }
    }
    return end;
}

/** 统计指定源码偏移区间内出现的换行节点（`\n\n` 或 `@br`），供插入槽定位到下一行行首 */
function findBreaksBetween(compiled: CompileScoreResult, fromOffset: number, toOffset: number): { count: number; lastSpan: SourceSpan | null } {
    let count = 0;
    let lastSpan: SourceSpan | null = null;
    const seen = new Set<ASTNodeBase>();
    for (const column of compiled.lowering.columns) {
        for (const node of column) {
            if (seen.has(node.ast) || callNameOf(node.ast) !== "br") continue;
            if (node.ast.sourceSpan.start < fromOffset || node.ast.sourceSpan.end > toOffset) continue;
            seen.add(node.ast);
            count += Number(node.addon?.breakBefore) || 1;
            if (!lastSpan || node.ast.sourceSpan.end > lastSpan.end) lastSpan = { ...node.ast.sourceSpan };
        }
    }
    return { count, lastSpan };
}

/** 根据前驱元素区域与换行次数，计算 `[+]` 插入槽在谱面页面坐标系中的矩形框 */
function computeInsertSlotGeometry(compiled: CompileScoreResult, afterRegion: Rect | null, lineBreaks = 0): Rect {
    const boxW = 17, boxH = 24;
    const pages = layoutPageBounds(compiled.layout);
    const page = (afterRegion && pages.find(p => afterRegion.y >= p.y && afterRegion.y <= p.y + p.h))
        ?? pages[0] ?? { x: 0, y: 0, w: 794, h: 200 };
    const left = compiled.lowering.page?.marginLeft ?? 40;
    const top = compiled.lowering.page?.marginTop ?? 45;
    const lineGap = compiled.lowering.page?.lineGap ?? 22;

    if (afterRegion) {
        return lineBreaks > 0
            ? { x: page.x + left, y: afterRegion.y + afterRegion.h + lineGap * lineBreaks, w: boxW, h: boxH }
            : { x: afterRegion.x + afterRegion.w + 8, y: afterRegion.y + (afterRegion.h - boxH) / 2, w: boxW, h: boxH };
    }
    return { x: page.x + left, y: page.y + top + (lineBreaks > 0 ? (boxH + lineGap) * lineBreaks : 0), w: boxW, h: boxH };
}

/** 扫描 `offset` 之前的谱面时间列，计算该插入点生效的拍号以及当前小节已消耗/剩余拍数 */
function computeMeterStateAtOffset(compiled: CompileScoreResult, offset: number, targetTrack?: Track) {
    let activeMeter: ActiveMeterInfo | null = null;
    const measureUsed = new Fraction(0, 1);
    const countedHosts = new Set<TemporalNodeBase>();
    const mainTrack = targetTrack ?? compiled.lowering.tracks[0] ?? compiled.lowering.rootTrack;

    for (const column of compiled.lowering.columns) {
        if (Math.min(...column.map(n => n.ast.sourceSpan.start)) >= offset) break;
        for (const node of column) {
            if (node.ast.sourceSpan.start < offset && node.ast instanceof ASTFunctionNode && node.ast.callName === "meter") {
                const m = node.ast as ASTFunctionNode & { numerator: number; denominator: number; measureDuration?: Fraction };
                activeMeter = m.measureDuration
                    ? { numerator: m.numerator, denominator: m.denominator, measureDuration: m.measureDuration.clone() }
                    : null;
                measureUsed.set(0, 1);
            }
        }
        if (column.some(n => n.mergeKey === ANCHOR_KEY && n.ast.sourceSpan.start < offset)) {
            measureUsed.set(0, 1);
            continue;
        }
        for (const node of column) {
            const host = node.rootHost;
            if (!countedHosts.has(host) && host.ast.sourceSpan.start < offset && !host.T.isZero() && host.track === mainTrack) {
                countedHosts.add(host);
                measureUsed.add(host.T);
            }
        }
    }

    const rem = activeMeter ? activeMeter.measureDuration.clone().sub(measureUsed) : null;
    return {
        meter: activeMeter,
        measureUsed,
        measureRemaining: rem ? (rem.compare(0) > 0 ? rem : new Fraction(0, 1)) : null,
    };
}

export function insertSlotAfter(
    source: string,
    compiled: CompileScoreResult,
    index: ScoreEditIndex,
    afterSpan?: SourceSpan | null,
): ScoreInsertSlot {
    if (!afterSpan) return index.defaultInsertSlot;
    const matched = index.streamTargets.find(t =>
        (t.span.start === afterSpan.start && t.span.end === afterSpan.end)
        || (t.unitSpan.start === afterSpan.start && t.unitSpan.end === afterSpan.end)
        || (t.span.start <= afterSpan.start && t.unitSpan.end >= afterSpan.end)
    );
    if (!matched) {
        const clamped = Math.min(source.length, Math.max(0, afterSpan.end));
        const prev = [...index.streamTargets].reverse().find(t =>
            !((t.kind === "meter" || t.kind === "key" || t.kind === "tempo") && t.inHeader)
            && !(t.kind === "note" && t.isGrace)
            && t.postGroupInsertEnd <= clamped
        );
        const breaks = findBreaksBetween(compiled, prev ? prev.unitSpan.end : 0, clamped);
        return {
            insertAt: clamped,
            afterSpan,
            region: computeInsertSlotGeometry(compiled, prev ? prev.region : null, breaks.count),
            ...computeMeterStateAtOffset(compiled, clamped),
        };
    }
    const nextStream = index.streamTargets.find(t => t.span.start >= matched.postGroupInsertEnd);
    const breaks = findBreaksBetween(compiled, matched.unitSpan.end, nextStream ? nextStream.span.start : source.length);
    const insertAt = breaks.lastSpan ? Math.max(matched.postGroupInsertEnd, breaks.lastSpan.end) : matched.postGroupInsertEnd;
    return {
        insertAt,
        afterSpan: breaks.lastSpan ?? matched.span,
        region: computeInsertSlotGeometry(compiled, matched.region, breaks.count),
        ...computeMeterStateAtOffset(compiled, insertAt),
    };
}

export function createScoreEditIndex(source: string, compiled: CompileScoreResult): ScoreEditIndex {
    const astToTemporal = compiled.lowering.astToTemporal;
    const visuals = collectVisibleTemporalNodes(compiled);

    const STREAM_KINDS = new Set(["note", "dash", "bar", "meter", "key", "tempo", "rest"]);
    const rawTemporals = [...visuals]
        .filter(v => v.ast instanceof ASTFunctionNode && STREAM_KINDS.has(v.ast.callName))
        .sort((a, b) => a.ast.sourceSpan.start - b.ast.sourceSpan.start || a.order - b.order);

    const ctxByAst = new Map<ASTNodeBase, AncestorContext>();
    for (const v of rawTemporals) {
        if (!ctxByAst.has(v.ast)) ctxByAst.set(v.ast, analyzeAncestors(v.ast, astToTemporal));
    }

    const rawNonHeaderSpans = rawTemporals
        .filter(v => {
            const c = ctxByAst.get(v.ast)!;
            return !c.inHeader && !c.graceBranchParent;
        })
        .map(v => v.ast.sourceSpan);

    const streamTargets: ScoreStreamTarget[] = [];
    const seenAst = new Set<ASTNodeBase>();

    for (const temporal of rawTemporals) {
        const ast = temporal.ast as unknown as ASTFunctionNode;
        if (seenAst.has(ast)) continue;
        seenAst.add(ast);
        const callName = ast.callName;
        const anc = ctxByAst.get(ast)!;
        const base: BaseEditTarget = {
            span: { ...ast.sourceSpan },
            unitSpan: { ...ast.sourceSpan },
            postGroupInsertEnd: anc.inHeader || anc.graceBranchParent
                ? ast.sourceSpan.end
                : resolvePostGroupInsertOffset(ast, ast.sourceSpan.end, rawNonHeaderSpans),
            region: getLayoutBounds(temporal, true),
            compiledDuration: temporal.rootHost.T.clone(),
            enclosingTupletSpan: anc.enclosingTupletSpan,
            isChordMember: anc.isChordMember,
            trackIndex: Math.max(0, compiled.lowering.tracks.indexOf(temporal.rootHost.track)),
        };

        if (callName === "note" || callName === "dash") {
            const isGrace = Boolean(anc.graceBranchParent);
            const resolved = resolveNoteAst(temporal, astToTemporal, isGrace);
            const postGroupInsertEnd = isGrace
                ? resolved.unitSpan.end
                : resolvePostGroupInsertOffset(ast, resolved.unitSpan.end, rawNonHeaderSpans);
            const common = {
                ...base,
                span: { ...resolved.stemAst.sourceSpan },
                stemSpan: { ...resolved.stemAst.sourceSpan },
                unitSpan: resolved.unitSpan,
                postGroupInsertEnd,
                outerSharedDiv: anc.outerSharedDiv,
                labelInsertOffset: resolved.stemAst.sourceSpan.end,
                rhythm: resolved.rhythm,
                label: resolved.label,
                sharedDiv: Boolean(anc.outerSharedDiv),
            };
            if (callName === "note") {
                const nt = temporal as VisualTemporalNode & { name: string; acc: string; octave: number };
                streamTargets.push({
                    ...common,
                    kind: "note",
                    noteSpan: { ...resolved.noteAst.sourceSpan },
                    foldSpan: resolved.foldAst ? { ...resolved.foldAst.sourceSpan } : undefined,
                    graceBranchParent: anc.graceBranchParent,
                    graceHostParent: anc.graceHostParent,
                    hasOuterWrapper: Boolean(resolved.foldAst && resolved.outerAst !== resolved.foldAst),
                    hasDefaultAcc: Boolean((resolved.noteAst as ASTFunctionNode & { hasDefaultAcc?: boolean }).hasDefaultAcc),
                    pitch: nt.name,
                    acc: nt.acc,
                    octave: nt.octave,
                    symbols: resolved.symbols,
                    isGrace,
                });
            } else {
                streamTargets.push({ ...common, kind: "dash" });
            }
        } else if (callName === "bar") {
            streamTargets.push({ ...base, kind: "bar", barType: (ast as ASTFunctionNode & { type?: number }).type ?? 0 });
        } else if (callName === "meter") {
            const m = ast as ASTFunctionNode & { numerator: number; denominator: number };
            streamTargets.push({ ...base, kind: "meter", numerator: m.numerator, denominator: m.denominator, inHeader: anc.inHeader });
        } else if (callName === "key") {
            const k = ast as ASTFunctionNode & { tonality: string; displayName: string; displayAcc: string };
            streamTargets.push({ ...base, kind: "key", tonality: k.tonality, displayName: k.displayName, displayAcc: k.displayAcc, inHeader: anc.inHeader });
        } else if (callName === "tempo") {
            streamTargets.push({ ...base, kind: "tempo", bpm: (ast as ASTFunctionNode & { bpm: number }).bpm, inHeader: anc.inHeader });
        } else if (callName === "rest") {
            streamTargets.push({ ...base, kind: "rest", measures: (ast as ASTFunctionNode & { n?: number }).n ?? 1 });
        }
    }

    const relationTargets: RelationEditTarget[] = [];
    for (const attachment of compiled.layout.attachments) {
        if (!attachment.sourceSpan || attachment.regions.length === 0) continue;
        const rawName = readCall(compiled.maskedSource, attachment.sourceSpan.start, attachment.sourceSpan.end)?.name.toLowerCase() ?? "";
        if (!isRelationKind(rawName)) continue;
        relationTargets.push({
            kind: "relation",
            relationKind: rawName,
            span: { ...attachment.sourceSpan },
            unitSpan: { ...attachment.sourceSpan },
            postGroupInsertEnd: attachment.sourceSpan.end,
            region: unionRects(attachment.regions),
            regions: attachment.regions,
            compiledDuration: new Fraction(0, 1),
            isChordMember: false,
            trackIndex: 0,
        });
    }

    const bodyTargets = streamTargets.filter(t =>
        !((t.kind === "meter" || t.kind === "key" || t.kind === "tempo") && t.inHeader)
        && !(t.kind === "note" && t.isGrace)
    );
    const lastMusical = [...bodyTargets].reverse().find(t =>
        t.kind === "note" || t.kind === "dash" || t.kind === "bar" || t.kind === "rest"
    ) ?? bodyTargets.at(-1);

    const baseInsertAt = lastMusical ? lastMusical.postGroupInsertEnd : source.length;
    const trailingBreaks = findBreaksBetween(compiled, lastMusical ? lastMusical.unitSpan.end : 0, source.length);
    const defaultInsertAt = trailingBreaks.lastSpan ? Math.max(baseInsertAt, trailingBreaks.lastSpan.end) : baseInsertAt;

    return {
        targets: [...streamTargets, ...relationTargets],
        streamTargets,
        defaultInsertSlot: {
            insertAt: defaultInsertAt,
            afterSpan: trailingBreaks.lastSpan ?? (lastMusical ? lastMusical.span : null),
            region: computeInsertSlotGeometry(compiled, lastMusical ? lastMusical.region : null, trailingBreaks.count),
            ...computeMeterStateAtOffset(compiled, defaultInsertAt),
        },
    };
}

export function editTargetAt(index: ScoreEditIndex, spanOrPos: SourceSpan | number): ScoreEditTarget | null {
    if (typeof spanOrPos === "number") {
        let best: ScoreEditTarget | null = null, bestLen = Infinity;
        for (const t of index.targets) {
            const len = t.span.end - t.span.start;
            if (spanOrPos >= t.span.start && spanOrPos < t.unitSpan.end && len < bestLen) {
                best = t;
                bestLen = len;
            }
        }
        return best;
    }
    for (const t of index.targets) {
        if ((t.span.start === spanOrPos.start && t.span.end === spanOrPos.end)
            || (t.kind === "note" && t.noteSpan.start === spanOrPos.start && t.noteSpan.end === spanOrPos.end)
            || (t.unitSpan.start === spanOrPos.start && t.unitSpan.end === spanOrPos.end)) return t;
    }
    let best: ScoreEditTarget | null = null, bestDiff = Infinity;
    for (const t of index.targets) {
        if (Math.max(t.unitSpan.start, spanOrPos.start) >= Math.min(t.unitSpan.end, spanOrPos.end)) continue;
        const diff = Math.abs(t.span.start - spanOrPos.start) + Math.abs(t.span.end - spanOrPos.end);
        if (diff < bestDiff) { best = t; bestDiff = diff; }
    }
    return best;
}

function rectDistance(x: number, y: number, r: Rect): number {
    const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - (r.x + r.w) : 0;
    const dy = y < r.y ? r.y - y : y > r.y + r.h ? y - (r.y + r.h) : 0;
    return Math.hypot(dx, dy);
}

export function editHitAt(
    index: ScoreEditIndex,
    navigation: PreviewNavigationMap,
    x: number,
    y: number,
    tolerance: number,
    activeInsertSlot?: ScoreInsertSlot | null,
): { kind: "target"; target: ScoreEditTarget } | { kind: "insert"; slot: ScoreInsertSlot } | null {
    const navHit = previewHitAt(navigation, x, y, tolerance);
    if (navHit) {
        const matched = editTargetAt(index, navHit.target.span);
        if (matched) return { kind: "target", target: matched };
    }
    let best: ScoreEditTarget | null = null, bestDist = Infinity;
    for (const target of index.streamTargets) {
        const dist = rectDistance(x, y, target.region);
        if (dist <= tolerance && dist < bestDist) { best = target; bestDist = dist; }
    }
    if (best) return { kind: "target", target: best };

    const slot = activeInsertSlot === undefined ? index.defaultInsertSlot : activeInsertSlot;
    return slot && rectDistance(x, y, slot.region) <= tolerance ? { kind: "insert", slot } : null;
}

export function adjacentEditTarget(index: ScoreEditIndex, currentSpan: SourceSpan, direction: -1 | 1): ScoreStreamTarget | null {
    const pos = index.streamTargets.findIndex(t =>
        (t.span.start === currentSpan.start && t.span.end === currentSpan.end)
        || (t.unitSpan.start <= currentSpan.start && t.unitSpan.end >= currentSpan.end)
    );
    return pos < 0 ? (index.streamTargets[0] ?? null) : (index.streamTargets[pos + direction] ?? null);
}
