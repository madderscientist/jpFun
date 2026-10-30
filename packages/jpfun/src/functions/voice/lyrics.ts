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
export const LYRIC_SIZE_RATIO = 0.82;

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

/**
 * 把歌词拆成与音符一一对应的富文本槽位，同时支持跨槽或槽内的 Markdown 样式（`**`、`*`、`_`、`^`）。
 * 例如 `hello world` 拆成 `hello`、`world`，`hel-lo` 拆成 `hel-`、`lo`；
 * `你好吗` 默认逐字拆分，`你 @ 好` 中的 `@` 留出一个空槽，`{你好} 啊` 则把 `你好` 放在同一个槽位。
 */
export function parseLyric(value: string): RichTextRun[][] {
    let closeBraces = 0;
    for (let i = 0; i < value.length; i++) {
        if (value[i] === "\\") i++;
        else if (value[i] === "}") closeBraces++;
    }

    const result: RichTextRun[][] = [];
    let pending: RichTextRun[] = [];
    let hasBody = false;
    let grouped = false;

    const add = (text: string, mask: number) => {
        appendRun(pending, text, mask);
        hasBody = true;
    };
    const flush = (force = false) => {
        if (!force && !hasBody) return;
        result.push(pending);
        pending = [];
        hasBody = false;
    };

    scanMarkdown(value, (ch, mask, escaped) => {
        if (!escaped && ch === "}") closeBraces--;
        if (grouped) {
            if (!escaped && ch === "}") {
                flush(true);
                grouped = false;
            } else {
                appendRun(pending, ch, mask);
            }
        } else if (!escaped && ch === "{" && closeBraces > 0) {
            flush();
            grouped = true;
        } else if (escaped) {
            add(ch, mask);
        } else if (WHITESPACE_RE.test(ch)) {
            flush();
        } else if (ch === "-") {
            const shouldFlush = hasBody;
            add(ch, mask);
            if (shouldFlush) flush();
        } else if (ch === "@") {
            if (hasBody) {
                add(ch, mask);
                flush();
            }
            result.push([]);
        } else if (LYRIC_OPENING_PUNCTUATION.has(ch)) {
            flush();
            appendRun(pending, ch, mask);
        } else if (LYRIC_SILENT_PUNCTUATION.has(ch)) {
            appendRun(pending.length > 0 || !result.at(-1)?.length ? pending : result.at(-1)!, ch, mask);
        } else if (ch.charCodeAt(0) > 0x7F) {
            flush();
            add(ch, mask);
            flush();
        } else {
            add(ch, mask);
        }
    }, "\\*_{}@-^");

    flush();
    if (pending.length > 0) {
        if (result.at(-1)?.length) {
            for (const run of pending) appendRun(result.at(-1)!, run.text, run.mask);
        } else {
            result.push(pending);
        }
    }
    return result;
}

export function serializeLyric(tokens: readonly (readonly RichTextRun[])[]): string {
    return quote(tokens.map(runs => {
        if (runs.length === 0) return "@";
        let mask = 0;
        let inner = "";
        for (const run of runs) {
            inner += markdownToggles(mask ^ run.mask) + run.text.replace(/[\\{}@\-*_^]/g, "\\$&");
            mask = run.mask;
        }
        return `{${inner}${markdownToggles(mask)}}`;
    }).join(" "));
}

export class VoiceLyricsAttachment implements LayoutAttachment {
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
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            let halfWidth = 0;
            for (const lyric of lyrics) {
                const runs = lyric.tokens[i];
                if (runs?.length) {
                    halfWidth = Math.max(halfWidth, measureLyricToken(runs, style, context.textMeasurer).bodyWidth / 2);
                }
            }
            if (halfWidth === 0) continue;
            // 只扩大求解占用；视觉盒和端口不动，音符内部几何因此保持原位。
            lines[target.layoutLine]?.registerHorizontalLayoutHook(target, target, ({ columns, start }) => {
                const element = columns[start].find(item => item.time === target);
                if (!element) return;
                const lyricOffset = target.ports["lyric"].x - target.box.anchor;
                element.WL = Math.max(element.WL, halfWidth - lyricOffset);
                element.WR = Math.max(element.WR, halfWidth + lyricOffset);
            });
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
        const rowAdvance = style.fontSize + size * 0.24;
        const baselineOffset = context.textMeasurer.measureText("M", style).baseline + size * 0.32;
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
                if (!runs.length || !baseline) continue;

                const { richLine, prefixWidth, bodyWidth } = measureLyricToken(runs, style, context.textMeasurer);
                preparedText.push({
                    ...richLine,
                    x: target.box.x + target.ports["lyric"].x - bodyWidth / 2 - prefixWidth,
                    y: baselineOf(baseline.bottom, row) - richLine.baseline,
                    line: target.layoutLine,
                    track: baseline.owner,
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
