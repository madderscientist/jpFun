import { getLayoutBounds } from "../../layout/engine.js";
import type {
    AttachmentLayoutContext,
    HorizontalLineView,
    LayoutAttachment,
    LayoutPrepareContext,
    LayoutRegion,
} from "../../layout/types.js";
import type { Track } from "../../lowering/track.js";
import { quote } from "../../parser/parse-utils/string-utils.js";
import type { SourceSpan } from "../../parser/types.js";
import {
    appendRun,
    markdownToggles,
    paintRichLine,
    prepareRichLine,
    scanMarkdown,
    type PreparedRichLine,
    type RichTextRun,
} from "../../render/text.js";
import type { Painter, TextMeasurer, TextStyle } from "../../render/types.js";
import type { VisualTemporalNode } from "../temporal.js";
import type { VoiceNameTemporal } from "./voice.js";

const WHITESPACE_RE = /\s/;

/** 歌词与歌词行名称相对声部字号的字号 */
export const LYRIC_SIZE_RATIO = 0.88;

// 分词跟后面的标点
const LYRIC_OPENING_PUNCTUATION = new Set("（([［｛〈《「『【〔〖〘〚‘“");
// 不发声的标点；位于歌词槽首尾时只渲染，不占位，也不参与对齐中心计算
const LYRIC_SILENT_PUNCTUATION = new Set([
    ...LYRIC_OPENING_PUNCTUATION,
    ..."，。！？；：、,.!?;:）)]］｝〉》」』】〕〗〙〛’”\"'…—–",
]);

/** 歌词行名称与歌词正文共用同一个基础样式 */
export function lyricNameStyle(size: number, fontFamily: string): TextStyle {
    return {
        fontFamily,
        fontSize: size * LYRIC_SIZE_RATIO,
        fill: "#000",
    };
}

function measureLyricToken(runs: readonly RichTextRun[], style: TextStyle, measurer: TextMeasurer) {
    const richLine = prepareRichLine(runs, style, measurer);
    const plain = richLine.runs.map(r => r.text).join("");
    let start = 0;
    let end = plain.length;
    while (start < end && LYRIC_SILENT_PUNCTUATION.has(plain[start])) start++;
    while (end > start && LYRIC_SILENT_PUNCTUATION.has(plain[end - 1])) end--;

    const rangeWidth = (from: number, to: number) => {
        let w = 0, pos = 0;
        for (const run of richLine.runs) {
            const runEnd = pos + run.text.length;
            const a = Math.max(from, pos), b = Math.min(to, runEnd);
            if (a < b) {
                w += a === pos && b === runEnd
                    ? run.w
                    : measurer.measureText(run.text.slice(a - pos, b - pos), run.style).w;
            }
            pos = runEnd;
        }
        return w;
    };
    return { richLine, prefixWidth: rangeWidth(0, start), bodyWidth: rangeWidth(start, end) };
}

export type LyricSlot = RichTextRun[] | null;

function lyricLeftPortX(target: VisualTemporalNode): number {
    return target.ports["body.left"]?.x ?? 0;
}

/** 将刚性半宽提升至 min，并从同侧弹簧 margin 中等量扣减：未超长时保持 WL/WR+margin 总宽不变，压缩时以刚性下界防重叠 */
function reserveSide(el: { WL: number; WR: number; margin_L: number; margin_R: number }, side: "L" | "R", min: number) {
    const w = side === "L" ? "WL" : "WR";
    const m = side === "L" ? "margin_L" : "margin_R";
    if (min > el[w]) {
        el[m] = Math.max(0, el[w] + el[m] - min);
        el[w] = min;
    }
}

/**
 * 把歌词拆成与音符一一对应的富文本槽位，同时支持跨槽或槽内的 Markdown 样式（`**`、`*`、`_`、`^`）。
 * 例如 `hello world` 拆成 `hello`、`world`，`hel-lo` 拆成 `hel-`、`lo`；
 * `你好吗` 默认逐字拆分，`你 @ 好` 中的 `@` 留出一个空槽，
 * `{你好} 啊` 把 `你好` 放在同一个槽位，`{a@@}` 则左对齐并覆盖三个槽位（后续槽记为 `null`）。
 */
export function parseLyric(value: string, offsets?: readonly number[], tokenSpans?: (SourceSpan | undefined)[]): LyricSlot[] {
    let closeBraces = 0;
    for (let i = 0; i < value.length; i++) {
        if (value[i] === "\\") i++;
        else if (value[i] === "}") closeBraces++;
    }

    const result: LyricSlot[] = [];
    let pending: RichTextRun[] = [];
    let lastToken: RichTextRun[] | undefined;
    let lastSpan: SourceSpan | undefined;
    let tokStart = -1, tokEnd = 0, keepRuns = 0, keepLen = 0, span = 0;
    let hasBody = false, grouped = false;

    const mark = (from: number, to: number) => { if (tokStart < 0) tokStart = from; tokEnd = to; };
    const add = (text: string, mask: number, from: number, to: number) => {
        appendRun(pending, text, mask);
        mark(from, to);
        hasBody = true;
    };
    const flush = (force = false) => {
        if (!force && !hasBody) return;
        if (tokenSpans && offsets && tokStart >= 0) {
            tokenSpans[result.length] = lastSpan = { start: offsets[tokStart], end: offsets[tokEnd] };
        }
        result.push(lastToken = pending);
        pending = [];
        tokStart = -1;
        hasBody = false;
    };

    scanMarkdown(value, (ch, mask, escaped, from, to) => {
        if (!escaped && ch === "}") closeBraces--;
        if (grouped) {
            if (!escaped && ch === "}") {
                mark(from, to);
                if (span) {
                    pending.length = keepRuns;
                    if (keepRuns) pending[keepRuns - 1].text = pending[keepRuns - 1].text.slice(0, keepLen);
                }
                if (!keepRuns && span) { while (span--) result.push([]); tokStart = -1; }
                else { flush(true); while (span--) result.push(null); }
                keepRuns = keepLen = span = 0;
                grouped = false;
            } else if (!escaped && (ch === "@" || WHITESPACE_RE.test(ch))) {
                if (ch === "@") span++;
                add(ch, mask, from, to);
            } else {
                add(ch, mask, from, to);
                keepRuns = pending.length;
                keepLen = pending[keepRuns - 1].text.length;
                span = 0;
            }
        } else if (!escaped && ch === "{" && closeBraces > 0) {
            flush();
            mark(from, to);
            grouped = true;
        } else if (escaped) {
            add(ch, mask, from, to);
        } else if (WHITESPACE_RE.test(ch)) {
            flush();
        } else if (ch === "-") {
            const shouldFlush = hasBody;
            add(ch, mask, from, to);
            if (shouldFlush) flush();
        } else if (ch === "@") {
            if (hasBody) { add(ch, mask, from, to); flush(); }
            result.push([]);
            lastToken = lastSpan = undefined;
        } else if (LYRIC_OPENING_PUNCTUATION.has(ch)) {
            flush();
            mark(from, to);
            appendRun(pending, ch, mask);
        } else if (LYRIC_SILENT_PUNCTUATION.has(ch)) {
            if (pending.length > 0 || !lastToken?.length) { mark(from, to); appendRun(pending, ch, mask); }
            else { appendRun(lastToken, ch, mask); if (lastSpan && offsets) lastSpan.end = offsets[to]; }
        } else if (ch.charCodeAt(0) > 0x7F) {
            flush();
            add(ch, mask, from, to);
            flush();
        } else {
            add(ch, mask, from, to);
        }
    }, "\\*_{}@-^");

    flush();
    if (pending.length > 0) {
        if (lastToken?.length) {
            for (const run of pending) appendRun(lastToken, run.text, run.mask);
            if (lastSpan && offsets) lastSpan.end = offsets[tokEnd];
        } else {
            if (tokenSpans && offsets && tokStart >= 0) {
                tokenSpans[result.length] = { start: offsets[tokStart], end: offsets[tokEnd] };
            }
            result.push(pending);
        }
    }
    return result;
}

export function serializeLyric(tokens: readonly (readonly RichTextRun[] | null)[]): string {
    return quote(tokens.flatMap((runs, i) => {
        if (runs === null) return [];
        if (runs.length === 0) return "@";
        let span = 0, mask = 0, inner = "";
        while (tokens[i + 1 + span] === null) span++;
        for (const run of runs) {
            inner += markdownToggles(mask ^ run.mask) + run.text.replace(/[\\{}@\-*_^]/g, "\\$&");
            mask = run.mask;
        }
        return `{${inner}${markdownToggles(mask)}${"@".repeat(span)}}`;
    }).join(" "));
}

export class VoiceLyricsAttachment implements LayoutAttachment {
    readonly kind = "lyrics";
    layer = "foreground" as const;

    get sourceSpan() { return this.nameHost.ast.sourceSpan; }

    constructor(
        private readonly nodes: readonly VisualTemporalNode[],
        private readonly nameHost: VoiceNameTemporal,
        private readonly frames: readonly LayoutAttachment[],
    ) {}

    prepareHorizontal(lines: HorizontalLineView[], context: LayoutPrepareContext) {
        const targets = this.nodes.filter(node => node.ports?.["lyric"]);
        if (targets.length === 0) return;
        const { lyrics, size, font } = this.nameHost.ast;
        const style = lyricNameStyle(size, font);

        for (const { tokens } of lyrics) {
            for (let i = 0; i < tokens.length && i < targets.length; i++) {
                const runs = tokens[i];
                if (!runs?.length) continue;
                const { bodyWidth } = measureLyricToken(runs, style, context.textMeasurer);
                if (bodyWidth === 0) continue;
                const first = targets[i];
                if (tokens[i + 1] !== null) {
                    // 只扩大求解占用；视觉盒和端口不动，音符内部几何因此保持原位。
                    lines[first.layoutLine]?.registerHorizontalLayoutHook(first, first, ({ columns, start }) => {
                        const element = columns[start].find(item => item.time === first);
                        if (!element) return;
                        const lyricOffset = first.ports["lyric"].x - first.box.anchor;
                        element.WL = Math.max(element.WL, bodyWidth / 2 - lyricOffset);
                        element.WR = Math.max(element.WR, bodyWidth / 2 + lyricOffset);
                    });
                    continue;
                }
                let end = i;
                while (tokens[i + 1] === null) {
                    i++;
                    if (targets[i]?.layoutLine === first.layoutLine && targets[i].track === first.track) end = i;
                }
                const leftExtent = first.box.anchor - lyricLeftPortX(first);
                const rightSpan = Math.max(0, bodyWidth - leftExtent);
                // 跨槽词从首音符 body.left 向右延伸 rightSpan：
                // 1. 词未超过自然宽度（total - lastEl.margin_R）时，按各段自然宽度比例从 margin 置换刚性下界，自然间距不变；
                // 2. 词超过自然宽度时，scale > 1 按原间距比例等比撑开各列，并借 keepMargin 保留末音右侧的弹性间隙。
                lines[first.layoutLine]?.registerHorizontalLayoutHook(first, targets[end], ({ columns, start, end }) => {
                    const row = columns[start].findIndex(item => item.time === first);
                    if (row < 0) return;
                    const lastEl = columns[end][row];
                    reserveSide(columns[start][row], "L", leftExtent);
                    let total = lastEl.WR + lastEl.margin_R;
                    for (let c = start; c < end; c++) {
                        const a = columns[c][row], b = columns[c + 1][row];
                        total += a.WR + a.margin_R + b.WL + b.margin_L;
                    }
                    const keepMargin = Math.max(0, Math.min(lastEl.margin_R, rightSpan - (total - lastEl.margin_R)));
                    const scale = (rightSpan + keepMargin) / total;
                    for (let c = start; c < end; c++) {
                        const a = columns[c][row], b = columns[c + 1][row];
                        reserveSide(a, "R", (a.WR + a.margin_R) * scale);
                        reserveSide(b, "L", (b.WL + b.margin_L) * scale);
                    }
                    reserveSide(lastEl, "R", (lastEl.WR + lastEl.margin_R) * scale - keepMargin);
                });
            }
        }
    }

    createGeometry(context: AttachmentLayoutContext) {
        const preparedText = this.prepareGeometry(context);
        // 同一行同一轨的多行歌词由引擎合并成一段占用
        return {
            regions: preparedText,
            paint(painter: Painter) {
                for (const item of preparedText) {
                    paintRichLine(painter, item, item.x, item.y + item.baseline);
                }
            },
        };
    }

    private prepareGeometry(context: AttachmentLayoutContext) {
        const { lyrics, size, font } = this.nameHost.ast;
        const preparedText: (LayoutRegion & PreparedRichLine)[] = [];

        const targets = this.nodes.filter(node => node.ports?.["lyric"]);
        if (targets.length === 0) return preparedText;

        // 同一行、原始轨共用下沿，跨轨框外的占用可归属另一条轨
        const baselines = new Map<number, Map<Track, { bottom: number; owner: Track }>>();
        for (const target of targets) {
            let byTrack = baselines.get(target.layoutLine);
            if (!byTrack) baselines.set(target.layoutLine, byTrack = new Map());
            const baseline = byTrack.get(target.track) ?? { bottom: -Infinity, owner: target.track };
            const bounds = getLayoutBounds(target);
            let bottom = bounds.y + bounds.h;
            let owner = target.track;
            for (const frame of this.frames) {
                const box = context.getAttachmentBox(frame);
                if (box.x + box.w < bounds.x || box.x > bounds.x + bounds.w || box.y + box.h <= bottom) continue;
                const regions = context.getAttachmentOccupancy(frame);
                if (!regions) throw new Error("Layout attachment dependency has not been measured");
                const tracks = regions.filter(region => region.line === target.layoutLine);
                if (regions.some(region => region.line !== undefined) && tracks.length === 0) continue;
                bottom = box.y + box.h;
                for (const region of tracks) {
                    if (region.line !== undefined && context.getVisualAxis(region.line, region.track)
                        > context.getVisualAxis(target.layoutLine, owner)) owner = region.track;
                }
            }
            if (bottom >= baseline.bottom) baseline.owner = owner;
            baseline.bottom = Math.max(baseline.bottom, bottom);
            byTrack.set(target.track, baseline);
        }

        const style = lyricNameStyle(size, font);
        const rowAdvance = style.fontSize + size * 0.25;
        const baselineOffset = context.textMeasurer.measureText("M", style).baseline + size * 0.4;
        const baselineOf = (bottom: number, row: number) => bottom + baselineOffset + row * rowAdvance;
        // 跨轨框外的歌词由最下轨承担占用，各原始轨的歌词行依次排列
        if (this.frames.length) for (const [line, byTrack] of baselines) {
            if (byTrack.size < 2) continue;
            const rows = new Map<Track, number>();
            for (const [, baseline] of [...byTrack].sort(([left], [right]) =>
                context.getVisualAxis(line, left) - context.getVisualAxis(line, right))) {
                const row = rows.get(baseline.owner) ?? 0;
                baseline.bottom += row * lyrics.length * rowAdvance;
                rows.set(baseline.owner, row + 1);
            }
        }

        // 歌词行名称与声部名共用左侧那一列，因此只出现在声部名所在的那一行
        const { box: labelBox, layoutLine: labelLine, track: labelTrack } = this.nameHost;
        const labelBaseline = baselines.get(labelLine)?.get(labelTrack);

        for (let row = 0; row < lyrics.length; row++) {
            const lyric = lyrics[row];

            for (let i = 0; i < lyric.tokens.length && i < targets.length; i++) {
                const runs = lyric.tokens[i];
                const target = targets[i];
                const baseline = baselines.get(target.layoutLine)?.get(target.track);
                if (!runs?.length || !baseline) continue;

                const { richLine, prefixWidth, bodyWidth } = measureLyricToken(runs, style, context.textMeasurer);
                const leftAligned = lyric.tokens[i + 1] === null;
                const ast = this.nameHost.ast;
                preparedText.push({
                    ...richLine,
                    x: target.box.x + (leftAligned
                        ? lyricLeftPortX(target) - prefixWidth
                        : target.ports["lyric"].x - bodyWidth / 2 - prefixWidth),
                    y: baselineOf(baseline.bottom, row) - richLine.baseline,
                    line: target.layoutLine,
                    track: baseline.owner,
                    get sourceSpan() { return ast.lyricTokenSpan(row, i); },
                });
            }

            if (!lyric.name || !labelBox || !labelBaseline) continue;

            const richLine = prepareRichLine(lyric.name, style, context.textMeasurer);
            preparedText.push({
                ...richLine,
                x: labelBox.x + labelBox.anchor - richLine.w,
                y: baselineOf(labelBaseline.bottom, row) - richLine.baseline,
                line: labelLine,
                track: labelBaseline.owner,
            });
        } return preparedText;
    }
}
