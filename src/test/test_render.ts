import { paintLayout } from "../layout/engine.js";
import { compileScore } from "../pipeline.js";
import { renderLayoutToCanvas } from "../render/canvas.js";
import { RecordingPainter, type RecordedPaintCommand } from "../render/recording.js";
import { renderLayoutToSvg } from "../render/svg.js";
import type { PathCommand } from "../render/types.js";
import { PREVIEW_EXAMPLE } from "../demo/previewExample.js";

function assert(condition: unknown, message: string): asserts condition {
    if (condition) return;
    throw new Error(message);
}

function layout(source: string, fontSize?: number) {
    return compileScore(source, { fontSize }).layout;
}

function recordLayout(result: ReturnType<typeof layout>) {
    const recording = new RecordingPainter();
    paintLayout(result, recording);
    return recording.commands;
}

function record(source: string, fontSize?: number) {
    return recordLayout(layout(source, fontSize));
}

function commandsOfKind<K extends RecordedPaintCommand["kind"]>(
    source: string,
    kind: K,
    fontSize?: number,
) {
    return record(source, fontSize).filter(
        (command): command is Extract<RecordedPaintCommand, { kind: K }> => command.kind === kind,
    );
}

function allNumbersFinite(value: unknown): boolean {
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(allNumbersFinite);
    if (!value || typeof value !== "object") return true;
    return Object.values(value).every(allNumbersFinite);
}

function commandBounds(commands: readonly PathCommand[]) {
    const xs: number[] = [];
    const ys: number[] = [];
    const point = (x: number, y: number) => {
        xs.push(x);
        ys.push(y);
    };

    for (const command of commands) {
        if (command.op === "Z") continue;
        if (command.op === "Q") point(command.cx, command.cy);
        if (command.op === "C") {
            point(command.cx1, command.cy1);
            point(command.cx2, command.cy2);
        }
        point(command.x, command.y);
    }

    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const result = layout(`@box({1@a #2'./ 8 3@b @tie(a,b)}, 2px, 1px) @text("<tag & text>")`);
const commands = recordLayout(result);

const kinds = new Set(commands.map(command => command.kind));
assert(kinds.has("text"), "arbitrary text must emit text commands");
assert(kinds.has("line"), "div decorations must emit line commands");
assert(kinds.has("rect"), "box must emit a rectangle command");
assert(kinds.has("circle"), "octave and dot decorations must emit circle commands");
assert(kinds.has("path"), "tie must emit a path command");
assert(commands.every(allNumbersFinite), "all recorded drawing coordinates must be finite");
assert(!commands.some(command => command.kind === "text" && command.text === "8"),
    "hidden placeholder note 8 must not emit text");

const svg = renderLayoutToSvg(result, {
    padding: 4,
    idPrefix: "render-test",
});
assert(svg.includes("<defs>"), "SVG must contain a definitions section");
assert(svg.includes("text-anchor=\"middle\""), "note numbers must use centered text alignment");
assert(svg.includes("Cascadia Mono"), "note numbers must request a normal monospaced font");
assert(svg.includes("&lt;tag &amp; text&gt;"), "arbitrary SVG text must be XML escaped");
assert(!svg.includes(">8</text>"), "hidden placeholder note 8 must not create SVG text");
assert(!svg.includes("NaN") && !svg.includes("Infinity"), "SVG output must not contain invalid coordinates");

const repeatedPathSvg = renderLayoutToSvg(layout("#1 #2"), { idPrefix: "path-cache" });
assert((repeatedPathSvg.match(/<path id=/g) ?? []).length === 1,
    "one repeated local path must create one SVG definition");
assert((repeatedPathSvg.match(/<use /g) ?? []).length === 2,
    "every repeated local path placement must use the shared SVG definition");

const dynamicPathSvg = renderLayoutToSvg(layout(`1@a 2@b @tie(a,b)`), { idPrefix: "dynamic-path" });
assert(!dynamicPathSvg.includes("<use "), "dynamic absolute paths must not use SVG definitions");
assert((dynamicPathSvg.match(/<path d=/g) ?? []).length === 1,
    "a dynamic tie must remain one direct SVG path");

const fixedOnlySvg = renderLayoutToSvg(layout("1 2 3"), { idPrefix: "fixed-only" });
assert((fixedOnlySvg.match(/<text /g) ?? []).length === 3, "each fixed note number must use one normal text element");

const nearTiePaths = commandsOfKind(`1@a 2@b @tie(a,b)`, "path");
assert(nearTiePaths.length === 1, "a near tie must emit one path");
assert(
    nearTiePaths[0].commands.map(command => command.op).join(",") === "M,C,C,Z",
    "a same-line tie must be a closed ribbon made of an outer and an inner cubic",
);
assert(nearTiePaths[0].style?.fill === "#000", "the tie ribbon must be filled instead of stroked");

/** 两个控制点同高的三次贝塞尔，实际弧高是抬高的 3/4 */
function tieApexHeight(path: { commands: readonly PathCommand[] }) {
    const [start, outer] = path.commands;
    if (start.op !== "M" || outer.op !== "C") throw new Error("unexpected tie path shape");
    return (start.y - outer.cy1) * 0.75;
}
assert(Math.abs(tieApexHeight(nearTiePaths[0]) - 11) < 1e-6, "the default tie height must be half an em at the declaration site");

const smallTiePath = commandsOfKind(`1@a 2@b @tie(a,b)`, "path", 20)[0];
const largeTiePath = commandsOfKind(`1@a 2@b @tie(a,b)`, "path", 40)[0];
assert(
    Math.abs(tieApexHeight(largeTiePath) - tieApexHeight(smallTiePath) * 2) < 1e-6,
    "tie geometry must scale with the declaration font size",
);

const farTiePaths = commandsOfKind(`1@a 2 3 4 5 6 7 1@b @tie(a,b)`, "path");
assert(farTiePaths.length === 1, "a far same-line tie must emit one path");
assert(
    farTiePaths[0].commands.map(command => command.op).join(",") === "M,C,C,Z",
    "distance must not change the same-line tie drawing type",
);

const explicitHeightPath = commandsOfKind(`1@a 2@b @tie(a,b,height=10px)`, "path")[0];
assert(Math.abs(tieApexHeight(explicitHeightPath) - 10) < 1e-6, "tie height must honor its fixed length argument");

const crossLineTiePaths = commandsOfKind(`1@a @br() 2@b @tie(a,b)`, "path");
assert(crossLineTiePaths.length === 2, "a two-system tie must emit first and final segments");
assert(
    crossLineTiePaths[0].commands.map(command => command.op).join(",") === "M,Q,L,L,L,Q,Z",
    "the first system tie segment must rise, extend to the right edge and close back",
);
assert(
    crossLineTiePaths[1].commands.map(command => command.op).join(",") === "M,L,Q,Q,L,Z",
    "the final system tie segment must enter from the left edge, fall and close back",
);

const threeLineTiePaths = commandsOfKind(`1@a @br() 2 @br() 3@b @tie(a,b)`, "path");
assert(threeLineTiePaths.length === 3, "a three-system tie must emit first, middle and final segments");
assert(
    threeLineTiePaths[1].commands.map(command => command.op).join(",") === "M,L,L,L,Z",
    "every intermediate system must use one full horizontal tie band",
);

const emptyMiddleTiePaths = commandsOfKind(`1@a @br(2) 2@b @tie(a,b)`, "path");
assert(emptyMiddleTiePaths.length === 3, "a tie spanning an empty system must still emit three segments");
assert(
    emptyMiddleTiePaths[1].commands.every(command => command.op === "Z" || command.y > 0),
    "an attachment-only middle system must receive a final positive visual-axis position",
);

const twoPageLayout = compileScore(`
@page(width=200px, height=80px, top=10px, bottom=10px, left=20px, right=20px, gap=5px)
1 @br() 2 @br() 3 @br() 4
`).layout;
const twoPageSvg = renderLayoutToSvg(twoPageLayout, { idPrefix: "two-page" });
assert(twoPageLayout.pages.length === 2, "the renderer sample must contain two pages");
assert(twoPageSvg.includes('width="200"') && twoPageSvg.includes('height="160"'), "SVG dimensions must include complete stacked page bounds");

const lowerOctaveDivResult = layout(`@div({1 2,}, 1)`);
const lowerOctaveDivCommands = recordLayout(lowerOctaveDivResult);
const numberBaselines = lowerOctaveDivCommands
    .filter(command => command.kind === "text")
    .map(command => command.y);
const numberTexts = lowerOctaveDivCommands
    .filter(command => command.kind === "text");
const divLineYs = lowerOctaveDivCommands
    .filter(command => command.kind === "line")
    .map(command => command.y1);
const mergedDivLines = lowerOctaveDivCommands
    .filter(command => command.kind === "line");
const lowerOctaveDotYs = lowerOctaveDivCommands
    .filter(command => command.kind === "circle")
    .map(command => command.cy);

assert(numberBaselines.length === 2, "two notes must emit two centered number texts");
assert(mergedDivLines.length === 1, "one connected div level must emit exactly one merged line");
assert(mergedDivLines[0].x1 < mergedDivLines[0].x2, "the merged div line must cover the complete endpoint range");
assert(divLineYs.every(y => Math.abs(y - divLineYs[0]) < 1e-6), "all same-level div segments must be horizontal");
assert(lowerOctaveDotYs.length === 1, "one lower-octave mark must emit one dot");
assert(Math.max(...numberBaselines) < divLineYs[0], "div lines must be below note numbers");
assert(divLineYs[0] < lowerOctaveDotYs[0], "lower-octave dots must be below div lines");

const numberBottom = Math.max(...numberTexts.map(command =>
    command.y + command.style.fontSize * 0.2
));
const divStrokeWidth = mergedDivLines[0].style?.strokeWidth ?? 0;
const divVisualGap = divLineYs[0] - divStrokeWidth / 2 - numberBottom;
assert(divVisualGap >= -2 && divVisualGap < 1, "div line must stay close to the number box with at most a slight overlap");

const explicitDivLines = commandsOfKind(`@div({1@a 2@b @beam(a,b)}, 1)`, "line");
assert(explicitDivLines.length === 1, "explicit beam over divided notes must emit one merged line");

const standaloneDivLines = commandsOfKind(`1/`, "line");
assert(standaloneDivLines.length === 1, "an unconnected divided note must keep one local line");

const adjacentAutoBeamLines = commandsOfKind(`1/ 2// 3/`, "line");
assert(adjacentAutoBeamLines.length === 2, "default auto beam must merge the shared level and keep one inner beamlet");

const explicitBeam = `@set(autobeam=false) 1/@a 2/@b @beam(a,b)`;
const smallBeamLine = commandsOfKind(explicitBeam, "line", 20)[0];
const largeBeamLine = commandsOfKind(explicitBeam, "line", 40)[0];
assert(smallBeamLine?.kind === "line" && largeBeamLine?.kind === "line", "scaled beam samples must emit merged lines");
assert(
    Math.abs((largeBeamLine.style?.strokeWidth ?? 0) - (smallBeamLine.style?.strokeWidth ?? 0) * 2) < 1e-6,
    "beam stroke width must scale with the largest endpoint font size",
);

const disabledAutoBeamLines = commandsOfKind(`@set(autobeam=false) 1/ 2// 3/`, "line");
assert(disabledAutoBeamLines.length === 4, "disabled auto beam must paint separately written div lines locally");

const disabledScopeBeamLines = commandsOfKind(`@set(autobeam=false) @div({1 2}, 1)`, "line");
assert(disabledScopeBeamLines.length === 1, "one div scope must keep one merged line while auto beam is disabled");

const explicitDisabledBeamLines = commandsOfKind(explicitBeam, "line");
assert(explicitDisabledBeamLines.length === 1, "explicit beam must replace local lines while auto beam is disabled");

const accidentalCommands = record(`#1`);
const accidentalPath = accidentalCommands.find(command => command.kind === "path");
const accidentalNumberText = accidentalCommands.find(command => command.kind === "text");
assert(accidentalPath?.kind === "path", "sharp note must emit one accidental path");
assert(accidentalNumberText?.kind === "text", "sharp note must emit one centered number text");

const accidentalBounds = commandBounds(accidentalPath.commands);
const numberWidth = accidentalNumberText.style.fontSize * 0.62;
const numberLeft = accidentalNumberText.x - numberWidth / 2;
const accidentalRight = accidentalBounds.x + accidentalBounds.w;
const numberTop = accidentalNumberText.y - accidentalNumberText.style.fontSize * 0.8;
const accidentalGap = numberLeft - accidentalRight;

assert(accidentalGap >= 0, "accidental must stay to the left of the number cell");
assert(accidentalGap < accidentalNumberText.style.fontSize * 0.06, "accidental must sit close to the number left edge");
assert(accidentalBounds.y < numberTop + accidentalNumberText.style.fontSize * 0.2,
    "accidental must be raised to the number upper-left area");

const hangingAccidentalResult = layout(`#2.//`);
const plainDecoratedResult = layout(`2.//`);
const hangingCommands = recordLayout(hangingAccidentalResult);
const hangingNumber = hangingCommands.find(command => command.kind === "text");
const hangingPath = hangingCommands.find(command => command.kind === "path");
const hangingLines = hangingCommands.filter(command => command.kind === "line");
const hangingDot = hangingCommands.find(command => command.kind === "circle");

assert(hangingNumber?.kind === "text", "decorated note must emit its number text");
assert(hangingPath?.kind === "path", "decorated note must emit its hanging accidental");
assert(hangingDot?.kind === "circle", "decorated note must emit its augmentation dot");
assert(hangingLines.length === 2, "double-divided note must emit two local lines");
assert(
    hangingAccidentalResult.objects[0].box.w > plainDecoratedResult.objects[0].box.w,
    "accidental must increase the complete decorated note LayoutBox width",
);

const hangingNumberHalfWidth = hangingNumber.style.fontSize * 0.62 / 2;
const hangingNumberLeft = hangingNumber.x - hangingNumberHalfWidth;
const hangingNumberRight = hangingNumber.x + hangingNumberHalfWidth;
const hangingPathBounds = commandBounds(hangingPath.commands);
assert(
    hangingLines.every(line => Math.abs(line.x1 - hangingNumberLeft) < 1e-6),
    "div lines must start at the number left edge",
);
assert(
    hangingLines.every(line => Math.abs(line.x2 - hangingNumberRight) < 1e-6),
    "div lines must end at the number right edge",
);
assert(hangingPathBounds.x + hangingPathBounds.w < hangingNumberLeft,
    "hanging accidental must stay outside the rhythm range");
assert(hangingDot.cx > hangingNumberRight, "augmentation dot must stay outside the rhythm range");
assert(hangingAccidentalResult.bounds.x <= hangingPathBounds.x,
    "document bounds must include the complete accidental path");

const lyricBaselines = commandsOfKind(`@voice({1/ 2 3}, , "一 二 三")`, "text")
    .filter(command => /[一二三]/.test(command.text))
    .map(command => command.y);
assert(lyricBaselines.length === 3, "the lyric row must contain all three tokens");
assert(lyricBaselines.every(y => Math.abs(y - lyricBaselines[0]) < 1e-6), "all tokens in one lyric row must share a baseline");

const scaledLyric = commandsOfKind(`@voice({1}, , "词")`, "text", 40)
    .find(command => command.text === "词");
assert(scaledLyric?.kind === "text", "scaled voice must emit its lyric");
assert(Math.abs(scaledLyric.style.fontSize - 32.8) < 1e-6, "voice lyric size must use the voice parse-time font size");

const barAlignmentCommands = record(`1 | 2/ 3, |`);
const alignedNumberCenters = barAlignmentCommands
    .filter(command => command.kind === "text")
    .filter(command => /^[0-9]$/.test(command.text))
    .map(command => command.y - command.style.fontSize * 0.3);
const alignedBarCenters = barAlignmentCommands
    .filter(command => command.kind === "rect")
    .filter(command => command.style?.fill === "#000")
    .map(command => command.y + command.h / 2);

assert(alignedNumberCenters.length === 3, "bar alignment sample must contain three number centers");
assert(alignedBarCenters.length === 2, "bar alignment sample must contain two bar centers");
assert(
    [...alignedNumberCenters, ...alignedBarCenters].every(center =>
        Math.abs(center - alignedNumberCenters[0]) < 1e-6
    ),
    "bar geometry centers must align with number visual centers",
);

const dottedNoteCommands = record(`1.`);
const dottedNumber = dottedNoteCommands.find(command => command.kind === "text");
const augmentationDot = dottedNoteCommands.find(command => command.kind === "circle");
assert(dottedNumber?.kind === "text" && augmentationDot?.kind === "circle", "dotted note must emit number text and one dot");
assert(
    Math.abs(augmentationDot.cy - (dottedNumber.y - dottedNumber.style.fontSize * 0.16)) < 1e-6,
    "augmentation dot must use its named port instead of the visual alignment axis",
);

const defaultDotResult = layout(`@dot(@text("x"), 1)`);
const defaultDot = recordLayout(defaultDotResult).find(command => command.kind === "circle");
const defaultDotTarget = defaultDotResult.objects[0];
assert(defaultDot?.kind === "circle", "a target without a dot port must still emit an augmentation dot");
assert(defaultDotTarget.ports["dot"] === undefined, "the generic dot fallback must not mutate target ports");
assert(
    Math.abs(defaultDot.cy - (defaultDotTarget.box.y + defaultDotTarget.box.visualAxis)) < 1e-6,
    "a missing dot port must fall back to the target right edge and visual axis",
);

const canvasCalls: string[] = [];
const fakeCanvas = {
    globalAlpha: 1,
    save() { canvasCalls.push("save"); },
    restore() { canvasCalls.push("restore"); },
    translate() { canvasCalls.push("translate"); },
    beginPath() { canvasCalls.push("beginPath"); },
    closePath() { canvasCalls.push("closePath"); },
    moveTo() { canvasCalls.push("moveTo"); },
    lineTo() { canvasCalls.push("lineTo"); },
    quadraticCurveTo() { canvasCalls.push("quadraticCurveTo"); },
    bezierCurveTo() { canvasCalls.push("bezierCurveTo"); },
    fill() { canvasCalls.push("fill"); },
    stroke() { canvasCalls.push("stroke"); },
    fillText() { canvasCalls.push("fillText"); },
    fillRect() { canvasCalls.push("fillRect"); },
    strokeRect() { canvasCalls.push("strokeRect"); },
    arc() { canvasCalls.push("arc"); },
} as unknown as CanvasRenderingContext2D;

renderLayoutToCanvas(result, fakeCanvas);
assert(canvasCalls.includes("stroke"), "Canvas backend must stroke local accidental paths");
assert(canvasCalls.includes("bezierCurveTo"), "Canvas backend must execute tie curves");
assert(canvasCalls.includes("fillText"), "Canvas backend must draw arbitrary text");

const compiled = compileScore("1 2 | 3");
assert(compiled.layout.objects.length === 4, "compileScore must return a directly renderable layout");
assert(compiled.lowering.columns.length === 4, "compileScore must preserve the complete lowering result");
assert(compiled.parser.diagnostics.length === 0, "valid default pipeline input must not create diagnostics");

const previewCompiled = compileScore(PREVIEW_EXAMPLE);
assert(previewCompiled.layout.lineCount === 2, "the web demo example must contain two systems");
assert(
    new Set(previewCompiled.layout.objects.map(object => object.track)).size === 4,
    "the web demo example must contain three voice lanes plus one temporary stack lane",
);
assert(
    !previewCompiled.layout.objects.some(object => object.track === previewCompiled.lowering.rootTrack),
    "no voice may reuse the empty host track of a voices block",
);
const previewCommands = recordLayout(previewCompiled.layout);
assert(
    previewCommands.some(command => command.kind === "text" && command.text === "春"),
    "the web demo final track must render lyrics",
);
assert(
    previewCommands.filter(command => command.kind === "path").length >= 2,
    "the web demo must render a cross-system tie",
);

console.log(`render commands=${commands.length} svgBytes=${svg.length} canvasCalls=${canvasCalls.length}`);