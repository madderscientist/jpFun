/** MIDI 与 MusicXML 共享的 jpFun 源码片段生成工具 */
type HeadTextField = "title" | "subtitle" | "author";
export type PitchMode = "relative" | "absolute";

export interface SourcePitch {
    name: string;
    accidental: string;
    octave: number;
}

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

export function quote(value: string) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/** 按书写顺序把多个零时长标记叠到主体上方。 */
export function attachAbove(source: string, additions: readonly string[]) {
    for (let index = additions.length - 1; index >= 0; index--) {
        source = `{${source} ^ ${additions[index]}}`;
    }
    return source;
}

/** 把已解释为目标记谱方式的音高写成 jpFun token。 */
export function renderPitch(pitch: SourcePitch, mode: PitchMode, suffix = "") {
    if (mode === "absolute") {
        return pitch.octave === 0
            ? `@note(${pitch.name}, ${pitch.accidental}, 0)${suffix}`
            : `${pitch.name}${pitch.accidental}${pitch.octave}${suffix}`;
    }
    const octaveMarks = pitch.octave > 0 ? "'".repeat(pitch.octave) : ",".repeat(-pitch.octave);
    return `${pitch.name}${pitch.accidental}${octaveMarks}${suffix}`;
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