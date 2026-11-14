/**
 * 自动断行与声部语法糖重排引擎
 *
 * 1. 基于 AST 为无标签 `@tie` / `@beam` 补齐标签，并对重排域内的同名重复标签去重；
 * 2. 将 `@voices` / `@voice` 与 `V:` / `N:` / `L:` 统一拉平为多轨时间流，跨行自动补齐歌词 `@` 与 JE 八度括号；
 * 3. 超宽版心单次 `horizontalOnly` 试排测宽（按对象时间 `obj.t` 直接归入切点段）+ 动态规划选出最优断点；
 * 4. 输出规范 `V:` / `N:` / `L:` 语法糖（无词顶层单旋律保持原貌），关系调用挂在最晚端点所在系统末尾。
 */
import {
    ANCHOR_KEY,
    ASTBraceNode,
    ASTFunctionNode,
    ASTLabelNode,
    ASTNodeBase,
    ASTTextNode,
    ErrorDiagnostic,
    Fraction,
    LYRIC_OPENING_PUNCTUATION,
    LYRIC_SILENT_PUNCTUATION,
    LoweringContext,
    ParserContext,
    VoiceFunction,
    VoiceNameTemporal,
    VoicesFunction,
    callArgName,
    createLayoutPrepareContext,
    defaultFunctions,
    findClosingQuote,
    layoutDocument,
    markdownToggles,
    normalizePageConfig,
    preprocessSource,
    quoteSourceString,
    readCall,
    resolveConnections,
    type CompileScoreResult,
    type ConnectionSpec,
    type LyricSlot,
    type SourceEdit,
    type SourceSpan,
    type TemporalNodeBase,
    type TextMeasurer,
    type VisualTemporalNode,
    type VoiceConnection,
} from "jpfun";
import { allocateLabels, applySourceEditsToText } from "./spans.js";
import { isRelationKind } from "./types.js";

export interface ReflowLineBreaksOptions {
    readonly barsPerLine?: number;
    readonly textMeasurer?: TextMeasurer;
    readonly ranges?: readonly SourceSpan[];
}

const BARRIER_CALLS = new Set(["page", "head", "pagebreak", "set"]);
const IMPLICIT_RELATIONS = new Set(["tie", "beam"]);

interface Patch { start: number; end: number; order: number; text: string }
interface RawPiece {
    span: SourceSpan;
    labels: ASTLabelNode[];
    isText: boolean;
    barType: number;
    t: Fraction;
    end: Fraction;
    je0: number;
    je1: number;
}
interface VoiceSys {
    name: string;
    pieces: RawPiece[];
    rels: ASTFunctionNode[];
    lyricTimes: Fraction[];
    lyrics: { name: string; tokens: readonly LyricSlot[] }[];
    end: Fraction;
    je1: number;
    blocked: boolean;
}
interface SystemInfo {
    span: SourceSpan;
    sugar: boolean;
    explicitConn: boolean;
    specs: readonly ConnectionSpec[];
    conns: readonly VoiceConnection[];
    braceSpace: number;
    fontSize: number;
    voices: VoiceSys[];
    rels: ASTFunctionNode[];
    finalBar: boolean;
    ok: boolean;
}
interface MergedBlock {
    span: SourceSpan;
    sugar: boolean;
    explicitConn: boolean;
    conns: readonly VoiceConnection[];
    repGroups: boolean;
    braceSpace: number;
    fontSize: number;
    voices: {
        name: string;
        repName: boolean;
        pieces: { text: string; barType: number; t: Fraction; end: Fraction; je0: number; je1: number }[];
        lyricTimes: Fraction[];
        lyrics: { name: string; repName: boolean; slots: LyricSlot[] }[];
    }[];
    rels: { text: string; latest: Fraction }[];
    cuts: { time: Fraction; indices: number[] }[];
}

const callNameOf = (n: ASTNodeBase) => (n instanceof ASTFunctionNode ? n.callName : "");
const jeOpen = (n: number) => (n > 0 ? "[".repeat(n) : n < 0 ? "(".repeat(-n) : "");
const jeClose = (n: number) => (n > 0 ? "]".repeat(n) : n < 0 ? ")".repeat(-n) : "");
const isPureJe = (s: string) => /^[()[\]\s]+$/.test(s);

function hasComment(comments: readonly SourceSpan[], a: number, b: number): boolean {
    let lo = 0, hi = comments.length;
    while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (comments[m].end <= a) lo = m + 1; else hi = m;
    }
    return a < b && lo < comments.length && comments[lo].start < b;
}

function lowerBoundTime(times: readonly Fraction[], target: Fraction): number {
    let lo = 0, hi = times.length;
    while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (times[m].compare(target) < 0) lo = m + 1; else hi = m;
    }
    return lo;
}

function createTemporalLookup(astToTemporal: ReadonlyMap<ASTNodeBase, TemporalNodeBase[]>) {
    const cache = new WeakMap<ASTNodeBase, TemporalNodeBase[]>();
    const get = (n: ASTNodeBase): TemporalNodeBase[] => {
        let r = cache.get(n);
        if (!r) {
            r = [...(astToTemporal.get(n) ?? [])];
            for (const c of n.children ?? []) r.push(...get(c));
            cache.set(n, r);
        }
        return r;
    };
    return get;
}

function endpointsOf(rel: ASTFunctionNode): ASTFunctionNode[] {
    const m = (rel as ASTFunctionNode & { endPoints?: ASTFunctionNode[] }).endPoints;
    if (m) return m;
    const { from, to } = rel as ASTFunctionNode & { from?: ASTFunctionNode; to?: ASTFunctionNode };
    return from && to ? [from, to] : [];
}

function collapseNewlines(text: string): string {
    if (!/[\r\n]/.test(text)) return text;
    let out = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            const c = findClosingQuote(text, i, text.length);
            if (c >= 0) { out += text.slice(i, c + 1); i = c; continue; }
        }
        if (ch === "\r" || ch === "\n") {
            out = out.replace(/[ \t]+$/, "");
            while (i + 1 < text.length && /[\r\n \t]/.test(text[i + 1])) i++;
            if (out) out += " ";
        } else out += ch;
    }
    return out.trim();
}

function jeDelta(masked: string, start: number, end: number): number {
    let d = 0, br = 0;
    for (let i = start; i < end; i++) {
        const ch = masked[i];
        if (ch === '"') { const c = findClosingQuote(masked, i, end); if (c >= 0) i = c; }
        else if (ch === "@") { const c = readCall(masked, i, end); if (c?.closeParenSpan) i = c.closeParenSpan.end - 1; }
        else if (ch === "{") br++;
        else if (ch === "}") br = Math.max(0, br - 1);
        else if (br === 0) d += ch === "(" || ch === "]" ? -1 : ch === "[" || ch === ")" ? 1 : 0;
    }
    return d;
}

function slicePatched(src: string, a: number, b: number, patches: readonly Patch[]): string {
    let out = "", pos = a;
    for (const p of patches) {
        if (p.start < a || p.end > b || p.start < pos) continue;
        out += src.slice(pos, p.start) + p.text;
        pos = p.end;
    }
    return pos === a ? src.slice(a, b) : out + src.slice(pos, b);
}

function trimEdit(src: string, a: number, b: number, next: string): SourceEdit | null {
    const orig = src.slice(a, b);
    if (orig === next) return null;
    let p = 0, mp = Math.min(orig.length, next.length);
    while (p < mp && orig.charCodeAt(p) === next.charCodeAt(p)) p++;
    if (p > 0 && orig.charCodeAt(p - 1) >= 0xd800 && orig.charCodeAt(p - 1) <= 0xdbff) p--;
    let s = 0, ms = Math.min(orig.length - p, next.length - p);
    while (s < ms && orig.charCodeAt(orig.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
    if (s > 0 && orig.charCodeAt(orig.length - s) >= 0xdc00 && orig.charCodeAt(orig.length - s) <= 0xdfff) s--;
    return { span: { start: a + p, end: b - s }, text: next.slice(p, next.length - s) };
}

/** 将 `LyricSlot[]` 切片还原为自然 `L:` 歌词（单汉字紧凑连写、ASCII 空格分词、自动闭合跨行 Markdown） */
function formatLyricSlice(allSlots: readonly LyricSlot[], from: number, to: number): string | null {
    const slice = allSlots.slice(from, to);
    let last = -1, hasTok = false;
    for (let i = slice.length - 1; i >= 0; i--) {
        if (slice[i]?.length) { hasTok = true; if (last < 0) last = i; break; }
        if (slice[i] === null && last < 0) last = i;
    }
    if (!hasTok) return null;

    let out = "", mask = 0, prevCjk = false;
    for (let i = 0; i <= last;) {
        const runs = slice[i];
        if (!runs?.length) {
            const close = mask & ~(slice.slice(i + 1, last + 1).find(r => r?.length)?.[0].mask ?? 0);
            if (close) { out += markdownToggles(close); mask ^= close; }
            out += out ? " @" : "@";
            prevCjk = false;
            i++;
            continue;
        }
        let span = 0;
        while (i + 1 + span <= last && slice[i + 1 + span] === null) span++;

        const plain = runs.map(r => r.text).join(""), chars = [...plain];
        let a = 0, b = chars.length;
        while (a < b && LYRIC_OPENING_PUNCTUATION.has(chars[a])) a++;
        while (b > a && LYRIC_SILENT_PUNCTUATION.has(chars[b - 1]) && !LYRIC_OPENING_PUNCTUATION.has(chars[b - 1])) b--;
        const core = chars.slice(a, b);
        const isCjk = span === 0 && core.length === 1 && core[0].codePointAt(0)! > 0x7f;
        const hyphen = span === 0 && b === chars.length && plain.length >= 2 && plain.endsWith("-") && !plain.slice(0, -1).includes("-");
        const isAscii = span === 0 && core.length >= 1 && /^[\x21-\x7e]+$/.test(plain) && (hyphen || !plain.includes("-"));

        if (out && !(prevCjk && isCjk)) {
            const close = mask & ~runs[0].mask;
            if (close) { out += markdownToggles(close); mask ^= close; }
            out += " ";
        }
        let tok = "";
        runs.forEach((run, ri) => {
            if (mask !== run.mask) { tok += markdownToggles(mask ^ run.mask); mask = run.mask; }
            const keepH = isAscii && hyphen && ri === runs.length - 1 && run.text.endsWith("-");
            tok += (keepH ? run.text.slice(0, -1) : run.text).replace(/[\\{}@\-*_^]/g, "\\$&") + (keepH ? "-" : "");
        });
        out += !isCjk && !isAscii ? `{${tok}${"@".repeat(span)}}` : tok;
        prevCjk = isCjk;
        i += 1 + span;
    }
    if (mask) out += markdownToggles(mask);
    return /[\r\n%"]/.test(out) || out.endsWith("\\") || out.trim() !== out ? quoteSourceString(out) : out;
}

function buildRelationPlan(src: string, compiled: CompileScoreResult, reflowSpans: readonly SourceSpan[]) {
    const inside = (s: SourceSpan) => reflowSpans.some(r => s.start >= r.start && s.end <= r.end);
    const { maskedSource: masked } = compiled;
    const lblNodes = new Map<ASTFunctionNode, ASTLabelNode>();
    const seen = new Set<string>(), dups: ASTFunctionNode[] = [], unlbl: ASTFunctionNode[] = [], seenUn = new Set<ASTFunctionNode>();

    const visit = (n: ASTNodeBase) => {
        if (n instanceof ASTLabelNode && n.target instanceof ASTFunctionNode) {
            lblNodes.set(n.target, n);
            if (seen.has(n.label)) { if (inside(n.sourceSpan)) dups.push(n.target); } else seen.add(n.label);
        } else if (n instanceof ASTFunctionNode && IMPLICIT_RELATIONS.has(n.callName) && inside(n.sourceSpan)) {
            const eps = endpointsOf(n), call = readCall(masked, n.sourceSpan.start, n.sourceSpan.end);
            const posN = call?.args.filter(a => a.valueSpan.start < a.valueSpan.end && !callArgName(masked, a)).length ?? 0;
            if (eps.length >= 2 && posN < eps.length) {
                for (const ep of eps) if (!ep.label && !seenUn.has(ep) && inside(ep.sourceSpan)) { seenUn.add(ep); unlbl.push(ep); }
            }
        }
        for (const c of n.children ?? []) visit(c);
    };
    visit(compiled.ast);

    const epLabels = new Map<ASTFunctionNode, string>(), patches: Patch[] = [], bareAt = new Set<number>();
    const fresh = allocateLabels(src, "t", dups.length + unlbl.length);
    let fi = 0;

    for (const tgt of dups) {
        const f = fresh[fi++], ln = lblNodes.get(tgt);
        epLabels.set(tgt, f);
        if (ln) patches.push({ start: ln.sourceSpan.start, end: ln.sourceSpan.end, order: 1, text: `@${f}` });
    }
    for (const ep of unlbl) {
        const f = fresh[fi++];
        epLabels.set(ep, f);
        let wrap: ASTNodeBase = ep;
        for (let p = wrap.parent; p; p = p.parent) {
            const nonTrivial = (b: ASTBraceNode) => b.content.filter(c => !(c instanceof ASTLabelNode) && !(c instanceof ASTTextNode));
            if (p instanceof ASTBraceNode && nonTrivial(p).length === 1 && nonTrivial(p)[0] === wrap) { wrap = p; continue; }
            if (p instanceof ASTFunctionNode && (p.callName === "div" || p.callName === "dot")) {
                const inner = (p as ASTFunctionNode & { content?: ASTNodeBase }).content;
                if (!(inner instanceof ASTBraceNode && nonTrivial(inner).length > 1)) { wrap = p; continue; }
            }
            break;
        }
        const needBrace = (ep.callName === "up" || ep.callName === "down") && src[ep.sourceSpan.end - 1] !== ")"
            && !(wrap instanceof ASTBraceNode && src[wrap.sourceSpan.start] === "{")
            && !(ep.parent instanceof ASTBraceNode && src[ep.parent.sourceSpan.start] === "{");
        const end = wrap.sourceSpan.end;
        if (src[end] === "@" && (end + 1 >= src.length || /[\s(){},]/.test(src[end + 1]))) bareAt.add(end);
        const nxt = src[bareAt.has(end) ? end + 1 : end] ?? "";
        const sp = nxt && !/[\s(){},]/.test(nxt) ? " " : "";
        if (needBrace) {
            patches.push({ start: wrap.sourceSpan.start, end: wrap.sourceSpan.start, order: 0, text: "{" });
            patches.push({ start: end, end: end, order: 2, text: `}@${f}${sp}` });
        } else patches.push({ start: end, end: end, order: 1, text: `@${f}${sp}` });
    }
    patches.sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);
    return { epLabels, patches, bareAt };
}

function formatRelation(src: string, masked: string, rel: ASTFunctionNode, epLabels: ReadonlyMap<ASTFunctionNode, string>): string {
    const eps = endpointsOf(rel), call = readCall(masked, rel.sourceSpan.start, rel.sourceSpan.end);
    const raw = () => src.slice(rel.sourceSpan.start, rel.sourceSpan.end).trim();
    if (!call?.closeParenSpan || eps.length < 2) return raw();
    const posN = call.args.filter(a => a.valueSpan.start < a.valueSpan.end && !callArgName(masked, a)).length;
    const implicit = IMPLICIT_RELATIONS.has(rel.callName) && posN < eps.length;
    if (!implicit && !eps.some(ep => epLabels.has(ep) || !ep.label)) return raw();
    const names = eps.map(ep => epLabels.get(ep) ?? ep.label);
    if (names.some(n => !n)) return raw();
    if (IMPLICIT_RELATIONS.has(rel.callName)) {
        const named = call.args.filter(a => a.valueSpan.start < a.valueSpan.end && Boolean(callArgName(masked, a)))
            .map(a => src.slice(a.span.start, a.span.end).trim());
        return `@${rel.callName}(${[...names, ...named].join(", ")})`;
    }
    const argPatches: Patch[] = [];
    let pi = 0;
    for (const a of call.args) {
        if (a.valueSpan.start >= a.valueSpan.end) continue;
        const k = callArgName(masked, a)?.toLowerCase();
        const idx = k === "from" ? 0 : k === "to" ? 1 : !k && pi < 2 ? pi : -1;
        if (!k) pi++;
        if (idx >= 0) argPatches.push({ start: a.valueSpan.start, end: a.valueSpan.end, order: 0, text: names[idx]! });
    }
    return slicePatched(src, rel.sourceSpan.start, rel.sourceSpan.end, argPatches).trim();
}

function extractStream(
    src: string,
    masked: string,
    items: readonly ASTNodeBase[],
    temporalsOf: (n: ASTNodeBase) => TemporalNodeBase[],
    startT: Fraction,
    initJe = 0,
) {
    const pieces: RawPiece[] = [], rels: ASTFunctionNode[] = [];
    let cur = startT.clone(), maxEnd = startT.clone(), je = initJe, blocked = false;

    for (let i = 0; i < items.length; i++) {
        const item = items[i], name = callNameOf(item);
        if (name === "br") { if (((item as ASTFunctionNode & { offset?: number }).offset ?? 1) >= 2) blocked = true; continue; }
        if (name === "pagebreak") { blocked = true; continue; }
        if (name && isRelationKind(name) && name !== "tuplet") { rels.push(item as ASTFunctionNode); continue; }
        if (item instanceof ASTLabelNode) { pieces.at(-1)?.labels.push(item); continue; }

        const je0 = je;
        if (item instanceof ASTTextNode) {
            const t = src.slice(item.sourceSpan.start, item.sourceSpan.end).trim();
            if (!t) continue;
            je += jeDelta(masked, item.sourceSpan.start, item.sourceSpan.end);
            const prev = pieces.at(-1);
            if (prev?.isText && prev.span.end === item.sourceSpan.start && isPureJe(t) && isPureJe(src.slice(prev.span.start, prev.span.end))) {
                prev.span = { start: prev.span.start, end: item.sourceSpan.end };
                prev.je1 = je;
            } else pieces.push({ span: item.sourceSpan, labels: [], isText: true, barType: -1, t: cur.clone(), end: cur.clone(), je0, je1: je });
            continue;
        }
        if (name === "set") blocked = true;
        je += jeDelta(masked, item.sourceSpan.start, item.sourceSpan.end);
        if (name === "note") {
            const nj = (item as ASTFunctionNode & { jeOctaveOffset?: number }).jeOctaveOffset;
            if (typeof nj === "number") je = nj;
        }
        const labels: ASTLabelNode[] = [];
        let adj = item.sourceSpan.end;
        while (i + 1 < items.length && items[i + 1] instanceof ASTLabelNode && items[i + 1].sourceSpan.start === adj) {
            const l = items[++i] as ASTLabelNode;
            labels.push(l);
            adj = l.sourceSpan.end;
        }
        let t0 = cur.clone(), t1 = cur.clone();
        for (const [k, t] of temporalsOf(item).entries()) {
            const e = t.T.isZero() ? t.t : t.t.clone().add(t.T);
            if (k === 0 || t.t.compare(t0) < 0) t0 = t.t.clone();
            if (k === 0 || e.compare(t1) > 0) t1 = e;
        }
        if (t1.compare(cur) > 0) cur = t1.clone();
        if (t1.compare(maxEnd) > 0) maxEnd = t1.clone();
        pieces.push({
            span: item.sourceSpan, labels, isText: false,
            barType: name === "bar" ? ((item as ASTFunctionNode & { type?: number }).type ?? 0) : -1,
            t: t0, end: t1, je0, je1: je,
        });
    }
    return { pieces, rels, end: maxEnd, je1: je, blocked };
}

function extractSystems(src: string, compiled: CompileScoreResult, comments: readonly SourceSpan[], temporalsOf: (n: ASTNodeBase) => TemporalNodeBase[]) {
    const { maskedSource: masked } = compiled, top = compiled.ast.content;
    const lyricObjs: VisualTemporalNode[] = compiled.layout.objects.filter(o => Boolean(o.ports?.["lyric"]));
    const systems: SystemInfo[] = [], gapsOk: boolean[] = [];
    let barrier = false, topJe = 0;

    const push = (sys: SystemInfo, prevEnd: number) => {
        if (systems.length) gapsOk.push(!barrier && !hasComment(comments, prevEnd, sys.span.start) && !systems.at(-1)!.finalBar);
        systems.push(sys);
        barrier = false;
    };

    for (let i = 0; i < top.length;) {
        const node = top[i], name = callNameOf(node);
        if (node instanceof ASTTextNode && !src.slice(node.sourceSpan.start, node.sourceSpan.end).trim()) { i++; continue; }
        if (name === "br") { if (((node as ASTFunctionNode & { offset?: number }).offset ?? 1) >= 2) barrier = true; i++; continue; }
        if (BARRIER_CALLS.has(name)) { barrier = true; i++; continue; }

        if (node instanceof VoiceFunction || node instanceof VoicesFunction) {
            const multi = node instanceof VoicesFunction, vNodes = multi ? node.voices : [node];
            const specs = multi ? node.connectionSpecs : [], conns = multi ? resolveConnections(specs, vNodes.length, node.sourceSpan) : [];
            let explicitConn = false, customGap = false;
            if (multi) {
                if (masked[node.sourceSpan.start] === "@") {
                    for (const a of readCall(masked, node.sourceSpan.start, node.sourceSpan.end)?.args ?? []) {
                        const k = callArgName(masked, a)?.toLowerCase();
                        if (k === "connect") explicitConn = true; else if (k === "gap" || k === "mingap") customGap = true;
                    }
                } else {
                    explicitConn = node.sourceSpan.start < vNodes[0].sourceSpan.start
                        || vNodes.some((v, k) => k > 0 && Boolean(masked.slice(vNodes[k - 1].sourceSpan.end, v.sourceSpan.start).trim()));
                }
            }
            const voices: VoiceSys[] = vNodes.map(v => {
                const startT = temporalsOf(v)[0]?.t.clone() ?? new Fraction(), raw = v.content as ASTNodeBase;
                const s = extractStream(src, masked, raw instanceof ASTBraceNode ? raw.content : [raw], temporalsOf, startT);
                const cs = raw.sourceSpan;
                return {
                    name: v.name, pieces: s.pieces, rels: s.rels, end: s.end, je1: s.je1, blocked: s.blocked,
                    lyricTimes: lyricObjs.filter(o => o.ast.sourceSpan.start >= cs.start && o.ast.sourceSpan.end <= cs.end).map(o => o.t.clone()),
                    lyrics: v.lyrics.map(l => ({ name: l.name, tokens: l.tokens })),
                };
            });
            const rels: ASTFunctionNode[] = [];
            let endOff = node.sourceSpan.end, idx = i + 1;
            while (idx < top.length) {
                const c = top[idx];
                if (c instanceof ASTTextNode && !src.slice(c.sourceSpan.start, c.sourceSpan.end).trim()) { idx++; continue; }
                const cn = callNameOf(c);
                if (!cn || !isRelationKind(cn) || cn === "tuplet") break;
                if (hasComment(comments, endOff, c.sourceSpan.start) || /\r?\n[ \t]*\r?\n/.test(masked.slice(endOff, c.sourceSpan.start))) break;
                rels.push(c as ASTFunctionNode);
                endOff = c.sourceSpan.end;
                idx++;
            }
            if (endOff > node.sourceSpan.start && src[endOff - 1] === "\r" && src[endOff] === "\n") endOff--;
            let prevTo = 0;
            const connOk = conns.every(c => { const ok = c.from > prevTo && c.from <= c.to; prevTo = c.to; return ok; });
            push({
                span: { start: node.sourceSpan.start, end: endOff }, sugar: true, explicitConn, specs, conns,
                braceSpace: multi && vNodes.length > 1 ? node.braceSpace : 0, fontSize: node.size, voices, rels,
                finalBar: voices.every(v => v.pieces.at(-1)?.barType === 2),
                ok: !customGap && topJe === 0 && connOk && !hasComment(comments, node.sourceSpan.start, endOff)
                    && voices.every(v => v.pieces.length > 0 && !v.blocked),
            }, systems.at(-1)?.span.end ?? node.sourceSpan.start);
            i = idx;
            continue;
        }

        const bare: ASTNodeBase[] = [];
        let b0 = node.sourceSpan.start, b1 = node.sourceSpan.end, j = i;
        while (j < top.length) {
            const cur = top[j], cn = callNameOf(cur);
            if (cn === "br" || BARRIER_CALLS.has(cn) || cur instanceof VoiceFunction || cur instanceof VoicesFunction) break;
            if (bare.length && hasComment(comments, b1, cur.sourceSpan.start)) break;
            if (!bare.length) b0 = cur.sourceSpan.start;
            bare.push(cur); b1 = cur.sourceSpan.end; j++;
        }
        const s = extractStream(src, masked, bare, temporalsOf, bare.flatMap(n => temporalsOf(n))[0]?.t.clone() ?? new Fraction(), topJe);
        topJe = s.je1;
        const hasBar = s.pieces.some(p => p.barType >= 0), lastP = s.pieces.at(-1);
        if (!hasBar) barrier = true;
        push({
            span: { start: b0, end: b1 }, sugar: false, explicitConn: false, specs: [], conns: [], braceSpace: 0, fontSize: 18,
            voices: [{
                name: "", pieces: s.pieces, rels: [], end: s.end, je1: s.je1, blocked: s.blocked, lyrics: [],
                lyricTimes: lyricObjs.filter(o => o.ast.sourceSpan.start >= b0 && o.ast.sourceSpan.end <= b1).map(o => o.t.clone()),
            }],
            rels: s.rels, finalBar: lastP?.barType === 2,
            ok: hasBar && !hasComment(comments, b0, b1) && !s.blocked,
        }, systems.at(-1)?.span.end ?? b0);
        if ((lastP?.barType ?? -1) < 0) barrier = true;
        i = j;
    }
    return { systems, gapsOk };
}

function groupSystems(systems: readonly SystemInfo[], gapsOk: readonly boolean[], ranges?: readonly SourceSpan[]) {
    const overlaps = (s: SourceSpan) => !ranges?.length || ranges.some(r => r.start < s.end && r.end > s.start);
    const groups: SystemInfo[][] = [];
    for (let i = 0; i < systems.length;) {
        const first = systems[i];
        if (!first.ok) { i++; continue; }
        let hasSugar = first.sugar;
        const gNames = first.conns.map(c => c.name ?? ""), vNames = first.voices.map(v => v.name);
        const lNames = first.voices.map(v => v.lyrics.map(l => l.name));
        let end = i + 1;
        while (end < systems.length && gapsOk[end - 1]) {
            const prev = systems[end - 1], next = systems[end], vc = prev.voices.length;
            if (!next.ok || vc !== next.voices.length) break;
            if (!prev.sugar && next.sugar && prev.voices.some(v => v.je1 !== 0)) break;
            if (prev.voices.some(v => !v.end.equals(prev.voices[0].end))) break;
            if (vc > 1 && (prev.conns.length !== next.conns.length || prev.conns.some((a, c) => {
                const b = next.conns[c];
                return a.kind !== b.kind || a.from !== b.from || a.to !== b.to || Boolean(b.name && b.name !== gNames[c]);
            }))) break;
            if (next.voices.some((nv, v) => (hasSugar && nv.name && nv.name !== vNames[v])
                || nv.lyrics.some((nl, r) => lNames[v][r] !== undefined && nl.name && nl.name !== lNames[v][r]))) break;
            if (!hasSugar && next.sugar) { hasSugar = true; next.voices.forEach((nv, v) => { vNames[v] = nv.name; }); }
            next.voices.forEach((nv, v) => nv.lyrics.forEach((nl, r) => { lNames[v][r] ??= nl.name; }));
            end++;
        }
        const slice = systems.slice(i, end);
        for (let s = 0; s < slice.length;) {
            if (!overlaps(slice[s].span)) { s++; continue; }
            let se = s + 1;
            while (se < slice.length && overlaps(slice[se].span)) se++;
            groups.push(slice.slice(s, se));
            s = se;
        }
        i = end;
    }
    return groups;
}

function buildBlock(
    src: string,
    masked: string,
    systems: readonly SystemInfo[],
    plan: ReturnType<typeof buildRelationPlan>,
    temporalsOf: (n: ASTNodeBase) => TemporalNodeBase[],
    blockedIntervals: readonly { start: Fraction; end: Fraction }[],
): MergedBlock {
    const first = systems[0], vc = first.voices.length, sugar = systems.some(s => s.sugar);
    const baseSpecs = (systems.find(s => s.specs.length > 0) ?? first).specs;
    const mergedSpecs = baseSpecs.map((sp, k) => {
        const name = sp.name ?? systems.map(s => s.specs[k]?.name).find(Boolean);
        return { ...sp, ...(name ? { name } : {}) };
    });
    const conns = vc > 1 ? resolveConnections(mergedSpecs, vc, first.span) : [];
    const repGroups = systems.length > 1 && mergedSpecs.some(c => Boolean(c.name))
        && systems.every(s => mergedSpecs.every((c, k) => !c.name || s.specs[k]?.name === c.name));

    const latestOf = (rel: ASTFunctionNode) => {
        let max: Fraction | null = null;
        for (const ep of endpointsOf(rel)) for (const t of temporalsOf(ep)) if (!max || t.t.compare(max) > 0) max = t.t.clone();
        return max ?? new Fraction();
    };
    const rels = systems.flatMap(s => [...s.voices.flatMap(v => v.rels), ...s.rels])
        .map(r => ({ text: formatRelation(src, masked, r, plan.epLabels), latest: latestOf(r) }));

    const voices = Array.from({ length: vc }, (_, v) => {
        const name = systems.map(s => s.voices[v].name).find(Boolean) ?? "";
        const repName = Boolean(name) && systems.length > 1 && systems.every(s => s.voices[v].name === name);
        const maxRows = Math.max(0, ...systems.map(s => s.voices[v].lyrics.length));
        const rowNames = Array.from({ length: maxRows }, (_, r) => systems.map(s => s.voices[v].lyrics[r]?.name).find(Boolean) ?? "");
        const repRows = rowNames.map((rn, r) => Boolean(rn) && systems.length > 1 && systems.every(s => s.voices[v].lyrics[r]?.name === rn));
        const slotsByRow: LyricSlot[][] = Array.from({ length: maxRows }, () => []);
        const pieces: MergedBlock["voices"][number]["pieces"] = [], lyricTimes: Fraction[] = [];

        systems.forEach((sys, si) => {
            const sv = sys.voices[v], before = pieces.length;
            for (const p of sv.pieces) {
                let text: string | null;
                if (p.isText) {
                    const raw = src.slice(p.span.start, p.span.end).trim();
                    text = raw === "@" && plan.bareAt.has(p.span.start) ? null : raw;
                } else {
                    text = collapseNewlines(slicePatched(src, p.span.start, p.span.end, plan.patches).trim());
                    for (const l of p.labels) {
                        const lt = slicePatched(src, l.sourceSpan.start, l.sourceSpan.end, plan.patches).trim();
                        text += `${/\$[^\s(){},]+$/.test(text) ? " " : ""}${lt}`;
                    }
                }
                if (text !== null) pieces.push({ text, barType: p.barType, t: p.t, end: p.end, je0: p.je0, je1: p.je1 });
            }
            if (sugar && si < systems.length - 1 && sv.je1 !== 0 && pieces.length > before) {
                const last = pieces[pieces.length - 1];
                pieces[pieces.length - 1] = { ...last, text: `${last.text} ${jeClose(sv.je1)}`, je1: 0 };
            }
            lyricTimes.push(...sv.lyricTimes);
            const nSlots = sv.lyricTimes.length;
            for (let r = 0; r < maxRows; r++) {
                const row = sv.lyrics[r], dst = slotsByRow[r];
                if (!row) for (let k = 0; k < nSlots; k++) dst.push([]);
                else if (systems.length === 1) dst.push(...row.tokens);
                else {
                    const u = row.tokens.slice(0, nSlots);
                    dst.push(...u);
                    for (let k = u.length; k < nSlots; k++) dst.push([]);
                }
            }
        });
        return { name, repName, pieces, lyricTimes, lyrics: slotsByRow.map((slots, r) => ({ name: rowNames[r], repName: repRows[r], slots })) };
    });

    const isBlocked = (at: Fraction) => blockedIntervals.some(iv => iv.start.compare(at) < 0 && iv.end.compare(at) > 0);
    const perVoice = voices.map(v => {
        const map = new Map<string, { time: Fraction; index: number }>();
        let m0 = -1, m1 = -1;
        v.pieces.forEach((p, idx) => { if (p.barType < 0 && p.end.compare(p.t) > 0) { if (m0 < 0) m0 = idx; m1 = idx; } });
        if (m0 < 0) return map;
        v.pieces.forEach((p, idx) => {
            if (p.barType < 0) return;
            let cut = p.barType === 3 ? idx : idx + 1;
            if (p.barType === 3) while (cut > 0 && v.pieces[cut - 1].barType < 0 && isPureJe(v.pieces[cut - 1].text) && v.pieces[cut - 1].je0 === 0) cut--;
            else while (cut < v.pieces.length && v.pieces[cut].barType < 0 && isPureJe(v.pieces[cut].text) && v.pieces[cut].je1 === 0) cut++;
            if (m0 >= cut || m1 < cut || isBlocked(p.t)) return;
            const k = p.t.toString();
            if (!map.has(k) || p.barType !== 3) map.set(k, { time: p.t, index: cut });
        });
        return map;
    });

    const cuts: { time: Fraction; indices: number[] }[] = [];
    if (perVoice.length) {
        for (const [k, c] of perVoice[0]) {
            if (perVoice.every(m => m.has(k))) cuts.push({ time: c.time, indices: perVoice.map(m => m.get(k)!.index) });
        }
        cuts.sort((a, b) => a.time.compare(b.time));
    }
    return {
        span: { start: first.span.start, end: systems.at(-1)!.span.end }, sugar,
        explicitConn: systems.some(s => s.explicitConn), conns, repGroups,
        braceSpace: Math.max(...systems.map(s => s.braceSpace)), fontSize: first.fontSize, voices, rels, cuts,
    };
}

function formatHeader(prefix: "N" | "L" | "V{" | "V[", name = ""): string {
    if (prefix === "V{" || prefix === "V[") {
        const c = prefix === "V{" ? "}" : "]";
        if (!name) return `${prefix}${c}:`;
        return `${prefix}${/[\[\]{}%"\r\n\\]/.test(name) || name.trim() !== name ? quoteSourceString(name) : name}${c}:`;
    }
    if (!name) return `${prefix}:`;
    return `${prefix}(${/[(){}%"\r\n\\]/.test(name) || name.trim() !== name ? quoteSourceString(name) : name}):`;
}

function renderBlock(block: MergedBlock, chosen: readonly number[], eol: string): string {
    const sysCount = chosen.length + 1, startCuts = [-1, ...chosen], endCuts = [...chosen, block.cuts.length];
    const relsBySys: string[][] = Array.from({ length: sysCount }, () => []);
    for (const r of block.rels) {
        let s = 0;
        while (s < chosen.length && r.latest.compare(block.cuts[chosen[s]].time) >= 0) s++;
        relsBySys[s].push(r.text);
    }

    if (!block.sugar) {
        const v = block.voices[0];
        return Array.from({ length: sysCount }, (_, s) => {
            const p0 = startCuts[s] < 0 ? 0 : block.cuts[startCuts[s]].indices[0];
            const p1 = endCuts[s] >= block.cuts.length ? v.pieces.length : block.cuts[endCuts[s]].indices[0];
            return [...v.pieces.slice(p0, p1).map(p => p.text), ...relsBySys[s]].join(" ");
        }).join(`${eol}${eol}`);
    }

    const startSpec = new Map(block.conns.map(c => [c.from, c] as const)), endVoices = new Set(block.conns.map(c => c.to));
    return Array.from({ length: sysCount }, (_, s) => {
        const firstSys = s === 0, lines: string[] = [];
        const prevCut = startCuts[s] < 0 ? null : block.cuts[startCuts[s]];
        const nextCut = endCuts[s] >= block.cuts.length ? null : block.cuts[endCuts[s]];

        block.voices.forEach((v, vi) => {
            if (block.voices.length > 1 && block.explicitConn) {
                const sp = startSpec.get(vi + 1);
                if (!block.conns.length && vi === 0) lines.push("V|:");
                else if (sp) lines.push(formatHeader(sp.kind === "brace" ? "V{" : "V[", firstSys || block.repGroups ? sp.name : ""));
                else if (endVoices.has(vi)) lines.push("V|:");
            }
            const p0 = prevCut ? prevCut.indices[vi] : 0, p1 = nextCut ? nextCut.indices[vi] : v.pieces.length;
            const open = jeOpen(p0 > 0 && p0 < v.pieces.length ? v.pieces[p0].je0 : 0);
            const close = jeClose(nextCut && p1 > p0 ? v.pieces[p1 - 1].je1 : 0);
            const tokens = [...(open ? [open] : []), ...v.pieces.slice(p0, p1).map(p => p.text), ...(close ? [close] : [])];
            lines.push(`${formatHeader("N", firstSys || v.repName ? v.name : "")} ${tokens.join(" ")}`);

            if (v.lyrics.length) {
                const s0 = prevCut ? lowerBoundTime(v.lyricTimes, prevCut.time) : 0;
                const s1 = nextCut ? lowerBoundTime(v.lyricTimes, nextCut.time) : Math.max(v.lyricTimes.length, ...v.lyrics.map(l => l.slots.length));
                const rows = v.lyrics.map(lt => ({ lt, body: formatLyricSlice(lt.slots, s0, s1) }));
                rows.forEach(({ lt, body }, ri) => {
                    const lName = firstSys || lt.repName ? lt.name : "";
                    if (body !== null) lines.push(`${formatHeader("L", lName)} ${body}`);
                    else if (lName || rows.slice(ri + 1).some(r => r.body !== null)) lines.push(`${formatHeader("L", lName)} @`);
                });
            }
        });
        if (relsBySys[s].length) lines.push(relsBySys[s].join(" "));
        return lines.join(eol);
    }).join(`${eol}${eol}`);
}

function guardSugar(rendered: string, block: MergedBlock, src: string, masked: string, sugarSpans: readonly SourceSpan[], nextSugarStart: number, eol: string): string {
    if (!block.sugar) return rendered;
    let l = block.span.start - 1, lNl = 0;
    while (l >= 0 && /\s/.test(masked[l])) { if (masked[l] === "\n") lNl++; l--; }
    const lead = l >= 0 && lNl < 2 && sugarSpans.some(sp => sp.end - 1 === l) ? eol.repeat(2 - lNl) : "";

    let r = block.span.end, rNl = 0, trail = "";
    while (r < masked.length && /\s/.test(masked[r])) { if (masked[r] === "\n") rNl++; r++; }
    if (r < masked.length && r !== nextSugarStart) {
        if (sugarSpans.some(sp => sp.start === r) && rNl < 2) trail = eol.repeat(2 - rNl);
        else if (block.span.end < src.length && !/^[\r\n]/.test(src.slice(block.span.end))) trail = eol;
    }
    return `${lead}${rendered}${trail}`;
}

function chooseAutoWidthCuts(segBounds: readonly { left: number; right: number }[], originLeft: number, contPrefix: number, contentW: number): number[] {
    const n = segBounds.length;
    if (n <= 1) return [];
    const target = contentW * 1.03, limit = contentW * 1.25;
    const best: { cost: number; prev: number }[] = [{ cost: 0, prev: -1 }];

    for (let end = 1; end <= n; end++) {
        let pick: { cost: number; prev: number } | undefined, single: { cost: number; prev: number } | undefined;
        for (let start = end - 1; start >= Math.max(0, end - 16); start--) {
            let l = Infinity, r = -Infinity;
            for (let m = start; m < end; m++) { l = Math.min(l, segBounds[m].left); r = Math.max(r, segBounds[m].right); }
            const w = start === 0 ? (Number.isFinite(r) ? Math.max(0, r - originLeft) : 0) : (Number.isFinite(l) ? Math.max(0, r - l) : 0) + contPrefix;
            const d = w - target;
            const cand = { cost: best[start].cost + d * d * (w < contentW ? 4 : 1), prev: start };
            if (start === end - 1) single = cand;
            if (w <= limit && (!pick || cand.cost < pick.cost)) pick = cand;
        }
        best[end] = pick ?? single!;
    }
    const chosen: number[] = [];
    for (let end = n; best[end].prev > 0; end = best[end].prev) chosen.push(best[end].prev - 1);
    return chosen.reverse();
}

export function reflowLineBreaks(source: string, compiled: CompileScoreResult, options: ReflowLineBreaksOptions = {}): SourceEdit[] {
    const err = compiled.diagnostics.find(d => d instanceof ErrorDiagnostic);
    if (err) throw err;
    if (!source.trim()) return [];

    const { maskedSource: masked } = compiled, { commentSpans } = preprocessSource(source);
    const temporalsOf = createTemporalLookup(compiled.lowering.astToTemporal);
    const blocked: { start: Fraction; end: Fraction }[] = [];
    for (const col of compiled.lowering.columns) {
        for (const n of col) if (!n.T.isZero()) blocked.push({ start: n.t, end: n.t.clone().add(n.T) });
    }
    const collectBeams = (n: ASTNodeBase) => {
        if (n instanceof ASTFunctionNode && n.callName === "beam") {
            let a: Fraction | null = null, b: Fraction | null = null;
            for (const ep of endpointsOf(n)) for (const t of temporalsOf(ep)) {
                const e = t.T.isZero() ? t.t : t.t.clone().add(t.T);
                if (!a || t.t.compare(a) < 0) a = t.t.clone();
                if (!b || e.compare(b) > 0) b = e;
            }
            if (a && b && a.compare(b) < 0) blocked.push({ start: a, end: b });
        }
        for (const c of n.children ?? []) collectBeams(c);
    };
    collectBeams(compiled.ast);

    const { systems, gapsOk } = extractSystems(source, compiled, commentSpans, temporalsOf);
    const groups = groupSystems(systems, gapsOk, options.ranges);
    if (!groups.length) return [];

    const sugarSpans = systems.filter(s => s.sugar).map(s => s.span);
    const plan = buildRelationPlan(source, compiled, groups.map(g => ({ start: g[0].span.start, end: g.at(-1)!.span.end })));
    const blocks = groups.map(g => buildBlock(source, masked, g, plan, temporalsOf, blocked));
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const fixedBars = options.barsPerLine && options.barsPerLine > 0 ? Math.trunc(options.barsPerLine) : 0;
    const chosen: number[][] = blocks.map(() => []);

    if (fixedBars > 0) {
        blocks.forEach((b, i) => { for (let c = fixedBars - 1; c < b.cuts.length; c += fixedBars) chosen[i].push(c); });
    } else if (blocks.some(b => b.cuts.length > 0)) {
        const draftSpans: SourceSpan[] = [];
        let delta = 0;
        const flatEdits = blocks.map((b, i) => {
            const nextSugar = i + 1 < blocks.length && blocks[i + 1].sugar ? blocks[i + 1].span.start : -1;
            const text = guardSugar(renderBlock(b, [], eol), b, source, masked, sugarSpans, nextSugar, eol);
            const start = b.span.start + delta;
            draftSpans.push({ start, end: start + text.length });
            delta += text.length - (b.span.end - b.span.start);
            return { span: b.span, text };
        });

        const draft = applySourceEditsToText(source, flatEdits);
        const parser = new ParserContext({ source: preprocessSource(draft).maskedSource });
        parser.registerFunctions(defaultFunctions);
        const lowering = new LoweringContext().lowerDocument(new ASTBraceNode({ start: 0, end: draft.length }, parser.parse()), parser.diagnostics);
        const basePage = normalizePageConfig(lowering.page);
        lowering.page = { ...basePage, width: Math.max(10_000_000, draft.length * 128), marginLeft: 0, marginRight: 0, fillRatio: 1 };
        const layout = layoutDocument(lowering, createLayoutPrepareContext(defaultFunctions, { textMeasurer: options.textMeasurer }), { horizontalOnly: true });
        const contentW = basePage.width - basePage.marginLeft - basePage.marginRight;

        blocks.forEach((b, i) => {
            if (!b.cuts.length) return;
            const dSpan = draftSpans[i], cutTimes = b.cuts.map(c => c.time);
            const segBounds = Array.from({ length: cutTimes.length + 1 }, () => ({ left: Infinity, right: -Infinity }));
            let originLeft = b.sugar ? 0 : Infinity;

            for (const obj of layout.objects) {
                const pos = obj.ast.sourceSpan.start;
                if (obj.box.w <= 0 || pos < dSpan.start || pos >= dSpan.end) continue;
                originLeft = Math.min(originLeft, obj.box.x);
                if (obj instanceof VoiceNameTemporal) continue;
                // 按对象谱面时间直接定位段号：同刻的普通小节线归左侧段，前反复线 |: 与起音事件归右侧段
                let seg = lowerBoundTime(cutTimes, obj.t);
                if (seg < cutTimes.length && obj.t.equals(cutTimes[seg])) {
                    const isLeftBar = obj.mergeKey === ANCHOR_KEY && (obj.ast as { type?: number }).type !== 3;
                    if (!isLeftBar) seg++;
                }
                segBounds[seg].left = Math.min(segBounds[seg].left, obj.box.x);
                segBounds[seg].right = Math.max(segBounds[seg].right, obj.box.x + obj.box.w);
            }
            if (!Number.isFinite(originLeft)) originLeft = 0;
            const repAny = b.repGroups || b.voices.some(v => v.repName || v.lyrics.some(l => l.repName));
            const firstLeft = segBounds.find(sb => Number.isFinite(sb.left))?.left ?? originLeft;
            const contPrefix = repAny ? Math.max(0, firstLeft - originLeft) : (b.voices.length > 1 ? b.braceSpace + b.fontSize * 0.45 : 0);
            chosen[i] = chooseAutoWidthCuts(segBounds, originLeft, contPrefix, contentW);
        });
    }

    const edits: SourceEdit[] = [];
    blocks.forEach((b, i) => {
        const nextSugar = i + 1 < blocks.length && blocks[i + 1].sugar ? blocks[i + 1].span.start : -1;
        const text = guardSugar(renderBlock(b, chosen[i], eol), b, source, masked, sugarSpans, nextSugar, eol);
        const trimmed = trimEdit(source, b.span.start, b.span.end, text);
        if (trimmed) edits.push(trimmed);
    });
    return edits;
}
