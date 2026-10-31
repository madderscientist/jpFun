/** MIDI 与 MusicXML 共享的 jpFun 源码片段生成工具 */
import { quote } from "../parser/parse-utils/string-utils.js";
export { quote } from "../parser/parse-utils/string-utils.js";

type HeadTextField = "title" | "subtitle" | "author";
export type PitchMode = "relative" | "absolute";

interface HeadOptions {
    title?: string;
    subtitle?: string;
    author?: string;
    key: string;
    meter: readonly [numerator: number, denominator: number];
    tempo: number;
}

const HEAD_TEXT_PRESET = {
    title: "size=2em, align=center",
    subtitle: "size=0.85em, align=center",
    author: "size=0.8em, align=right",
} as const satisfies Record<HeadTextField, string>;

const RELATIVE_NAMES = ["1", "#1", "2", "#2", "3", "4", "#4", "5", "#5", "6", "#6", "7"] as const;

/** 按书写顺序把多个零时长标记叠到主体上方。 */
export function attachAbove(source: string, additions: readonly string[]) {
    for (let index = additions.length - 1; index >= 0; index--) {
        source = `{${source} ^ ${additions[index]}}`;
    }
    return source;
}

/** 将相对主音的半音差写成简谱音高 token。 */
export function renderRelativePitch(semitoneOffset: number) {
    const pitchClass = ((semitoneOffset % 12) + 12) % 12;
    const octave = Math.floor(semitoneOffset / 12);
    const octaveMarks = octave > 0 ? "'".repeat(octave) : ",".repeat(-octave);
    return `${RELATIVE_NAMES[pitchClass]}${octaveMarks}`;
}

/** 将绝对音名、升降号与八度写成 jpFun 音高 token。 */
export function renderAbsolutePitch(name: string, accidental: string, octave: number) {
    return octave === 0 ? `@note(${name}, ${accidental}, 0)` : `${name}${accidental}${octave}`;
}

function renderHeadText(field: HeadTextField, value: string) {
    // 会被注释、续行或 DSL 语法误读的文本改用显式 @text，其余保留简洁的 H.* 裸文本
    const needsExplicitText = value.trim() !== value
        || /[\r\n%]/.test(value) || /^\s*[@{]/.test(value) || value.endsWith("\\");
    return needsExplicitText
        ? `H.${field}: @text(${quote(value)}, ${HEAD_TEXT_PRESET[field]})`
        : `H.${field}: ${value}`;
}

export function renderHead(options: HeadOptions) {
    const [numerator, denominator] = options.meter;
    const lines: string[] = [];
    if (options.title) lines.push(renderHeadText("title", options.title));
    if (options.subtitle) lines.push(renderHeadText("subtitle", options.subtitle));
    if (options.author) lines.push(renderHeadText("author", options.author));
    lines.push(`H.signature: 1=${options.key} ${numerator}/${denominator}`);
    lines.push(`H.tempo: ${options.tempo}`);
    return lines.join("\n");
}

/** 把“每个声部的各系统”转置成“每个系统的完整声部组” */
export function renderSystems(groups: readonly (readonly string[])[]) {
    const systemCount = Math.max(0, ...groups.map(lines => lines.length));
    return Array.from({ length: systemCount }, (_, index) =>
        groups.map(lines => lines[index]).filter(Boolean).join("\n")).join("\n\n");
}