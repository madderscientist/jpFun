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
import type { Painter, TextStyle } from "../../render/types.js";
import type { VisualTemporalNode } from "../temporal.js";
import type { VoiceNameTemporal } from "./voice.js";

const WHITESPACE_RE = /\s/;
const LYRIC_CONTROL_CHAR_RE = /[\\{}@-]/;
const LYRIC_CONTROL_GLOBAL_RE = /[\\{}@-]/g;

/** 歌词与歌词行名称相对声部字号的字号 */
export const LYRIC_SIZE_RATIO = 0.82;

// 分词跟后面的标点
const LYRIC_OPENING_PUNCTUATION = new Set("（([［｛〈《「『【〔〖〘〚‘“");
// 不发声的标点；位于歌词槽首尾时只渲染，不占位，也不参与对齐中心计算
const LYRIC_SILENT_PUNCTUATION = new Set([
    ...LYRIC_OPENING_PUNCTUATION,
    ..."，。！？；：、,.!?;:）)]］｝〉》」』】〕〗〙〛’”\"'…—–",
]);

/** 一段已经定位好的歌词或左侧名称文本，同时就是报给引擎的占用区域 */
export type PreparedLyricText = LayoutRegion & {
    text: string;          // 最终绘制的 token 或名称
    style: TextStyle;      // 当前文本使用的字体和颜色
    textBaselineY: number; // 字体 baseline 距文本盒顶部的距离
};

/** 歌词行名称的宽度决定标签列宽度，因此声部名事件和歌词附件必须用同一个样式测量 */
export function lyricNameStyle(size: number, fontFamily: string): TextStyle {
    return {
        fontFamily,
        fontSize: size * LYRIC_SIZE_RATIO,
        fill: "#000",
        fontWeight: 600,
    };
}

export function splitLyricText(text: string) {
    let start = 0;
    let end = text.length;
    while (start < end && LYRIC_SILENT_PUNCTUATION.has(text[start])) start++;
    while (end > start && LYRIC_SILENT_PUNCTUATION.has(text[end - 1])) end--;
    return { prefix: text.slice(0, start), body: text.slice(start, end) };
}

/**
 * 把歌词拆成与音符一一对应的槽位。
 * 例如 `hello world` 拆成 `hello`、`world`，`hel-lo` 拆成 `hel-`、`lo`；
 * `你好吗` 默认逐字拆分，`你 @ 好` 中的 `@` 留出一个空槽，`{你好} 啊` 则把 `你好` 放在同一个槽位。
 * 转义符：hel\-lo \@ {你\}好} 会得到 ["hel-lo", "@", "你}好"]，而不是把 -、@、} 当控制符
 */
export function parseLyric(value: string): string[] {
    const result: string[] = [];
    let token = "";
    let prefix = "";
    const pushSlot = (text: string) => {
        result.push(prefix + text);
        prefix = "";
    };
    const pushToken = () => {
        if (token) pushSlot(token);
        token = "";
    };
    for (let i = 0; i < value.length; i++) {
        const ch = String.fromCodePoint(value.codePointAt(i)!);
        i += ch.length - 1;
        if (ch === "\\" && i + 1 < value.length && LYRIC_CONTROL_CHAR_RE.test(value[i + 1])) {
            token += value[++i];
        } else if (ch === "{") {
            let close = i + 1;
            let grouped = "";
            for (; close < value.length && value[close] !== "}"; close++) {
                if (value[close] === "\\" && close + 1 < value.length && LYRIC_CONTROL_CHAR_RE.test(value[close + 1])) {
                    grouped += value[++close];
                } else grouped += value[close];
            }
            if (close < value.length) {
                pushToken();
                pushSlot(grouped);
                i = close;
            } else token += ch;
        } else if (WHITESPACE_RE.test(ch)) {
            pushToken();
        } else if (ch === "-") {
            // 如果前面有内容 则把-放到前一个词里
            token += ch;
            if (token.length > 1) pushToken();
        } else if (ch === "@") {
            if (token) {
                token += ch;
                pushToken();
            }
            result.push("");
        } else if (LYRIC_OPENING_PUNCTUATION.has(ch)) {
            pushToken();
            prefix += ch;
        } else if (LYRIC_SILENT_PUNCTUATION.has(ch)) {
            if (token) token += ch;
            else if (prefix || !result.at(-1)) prefix += ch;
            else result[result.length - 1] += ch;
        } else if (ch.charCodeAt(0) > 0x7F) {
            // 遇到中文等非ASCII字符 直接切分成单个字符
            pushToken();
            pushSlot(ch);
        } else token += ch;
    }
    pushToken();
    if (prefix) {
        if (result.at(-1)) result[result.length - 1] += prefix;
        else result.push(prefix);
    } return result;
}

export function serializeLyric(tokens: readonly string[]): string {
    return quote(tokens.map(token => token.length === 0
        ? "@" : `{${token.replace(LYRIC_CONTROL_GLOBAL_RE, "\\$&")}}`).join(" "));
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

        const style: TextStyle = { fontSize: size * LYRIC_SIZE_RATIO, fontFamily: font, fill: "#000" };
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            let halfWidth = 0;
            for (const lyric of lyrics) {
                const text = lyric.tokens[i];
                if (text) {
                    const { body } = splitLyricText(text);
                    if (body) halfWidth = Math.max(halfWidth, context.textMeasurer.measureText(body, style).w / 2);
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
                    painter.drawText(item.text, item.x, item.y + item.textBaselineY, item.style);
                }
            },
        };
    }

    private prepareGeometry(context: AttachmentLayoutContext) {
        const { lyrics, size, font } = this.nameHost.ast;
        const preparedText: PreparedLyricText[] = [];

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

        const fontSize = size * LYRIC_SIZE_RATIO;
        const rowGap = size * 0.24;
        const firstRowGap = size * 0.32;
        const lyricStyle: TextStyle = { fontSize, fontFamily: font, fill: "#000" };
        const nameStyle = lyricNameStyle(size, font);
        const baselineOffset = context.textMeasurer.measureText("M", lyricStyle).baseline + firstRowGap;
        const baselineOf = (bottom: number, row: number) => bottom + baselineOffset + row * (fontSize + rowGap);
        // 跨轨框外的歌词由最下轨承担占用，各原始轨的歌词行依次排列
        if (this.frames.length) for (const [line, byTrack] of baselines) {
            if (byTrack.size < 2) continue;
            const rows = new Map<Track, number>();
            for (const [, baseline] of [...byTrack].sort(([left], [right]) =>
                context.getVisualAxis(line, left) - context.getVisualAxis(line, right))) {
                const row = rows.get(baseline.owner) ?? 0;
                baseline.bottom += row * lyrics.length * (fontSize + rowGap);
                rows.set(baseline.owner, row + 1);
            }
        }

        // 歌词行名称与声部名共用左侧那一列，因此只出现在声部名所在的那一行
        const { box: labelBox, layoutLine: labelLine, track: labelTrack } = this.nameHost;
        const labelBaseline = baselines.get(labelLine)?.get(labelTrack);

        for (let row = 0; row < lyrics.length; row++) {
            const lyric = lyrics[row];

            for (let i = 0; i < lyric.tokens.length && i < targets.length; i++) {
                const text = lyric.tokens[i];
                const target = targets[i];
                const baseline = baselines.get(target.layoutLine)?.get(target.track);
                if (!text || !baseline) continue;

                const metrics = context.textMeasurer.measureText(text, lyricStyle);
                const { prefix, body } = splitLyricText(text);
                const bodyWidth = body ? context.textMeasurer.measureText(body, lyricStyle).w : 0;
                const prefixWidth = prefix ? context.textMeasurer.measureText(prefix, lyricStyle).w : 0;
                preparedText.push({
                    text,
                    style: lyricStyle,
                    textBaselineY: metrics.baseline,
                    x: target.box.x + target.ports["lyric"].x - bodyWidth / 2 - prefixWidth,
                    y: baselineOf(baseline.bottom, row) - metrics.baseline,
                    w: metrics.w,
                    h: metrics.h,
                    line: target.layoutLine,
                    track: baseline.owner,
                });
            }

            if (!lyric.name || !labelBox || !labelBaseline) continue;

            const metrics = context.textMeasurer.measureText(lyric.name, nameStyle);
            preparedText.push({
                text: lyric.name,
                style: nameStyle,
                textBaselineY: metrics.baseline,
                x: labelBox.x + labelBox.anchor - metrics.w,
                y: baselineOf(labelBaseline.bottom, row) - metrics.baseline,
                w: metrics.w,
                h: metrics.h,
                line: labelLine,
                track: labelBaseline.owner,
            });
        } return preparedText;
    }
}
