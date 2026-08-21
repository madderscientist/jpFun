import { test } from "node:test";

import type { DocumentLayoutResult } from "../src/layout/engine.js";
import { renderLayoutToCanvas } from "../src/render/canvas.js";
import { renderLayoutToSvg, SvgPainter } from "../src/render/svg.js";
import type { PathCommand } from "../src/render/types.js";
import { assert, expectSnapshot, layoutOf, recordCommands } from "./helpers.js";

function allNumbersFinite(value: unknown): boolean {
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(allNumbersFinite);
    if (!value || typeof value !== "object") return true;
    return Object.values(value).every(allNumbersFinite);
}

/** Canvas 后端没有记录器，用只记方法名的假 context 观察它实际调用了哪些绘制原语 */
function recordCanvasCalls(result: DocumentLayoutResult) {
    const calls: string[] = [];
    const note = (name: string) => () => { calls.push(name); };
    renderLayoutToCanvas(result, {
        globalAlpha: 1,
        save: note("save"), restore: note("restore"), translate: note("translate"),
        beginPath: note("beginPath"), closePath: note("closePath"),
        moveTo: note("moveTo"), lineTo: note("lineTo"), arc: note("arc"),
        quadraticCurveTo: note("quadraticCurveTo"), bezierCurveTo: note("bezierCurveTo"),
        fill: note("fill"), stroke: note("stroke"), fillText: note("fillText"),
        fillRect: note("fillRect"), strokeRect: note("strokeRect"),
    } as unknown as CanvasRenderingContext2D);
    return calls;
}

/** 综合样例：一次画出文本、减时线、方框、八度点与连音线，供多个用例共享 */
const result = layoutOf(`@box({1@a #2'./ 8 9# 3@b @tie(a,b)}, 2px, 1px) @text("<tag & text>")`);
const commands = recordCommands(result);
const svg = renderLayoutToSvg(result, { padding: 4 });
const canvasCalls = recordCanvasCalls(result);

test("综合乐谱产生各类绘制命令且坐标全部有限", () => {
    const kinds = new Set(commands.map(command => command.kind));
    assert(kinds.has("text"), "arbitrary text must emit text commands");
    assert(kinds.has("line"), "div decorations must emit line commands");
    assert(kinds.has("rect"), "box must emit a rectangle command");
    assert(kinds.has("circle"), "octave and dot decorations must emit circle commands");
    assert(kinds.has("path"), "tie must emit a path command");
    assert(commands.every(allNumbersFinite), "all recorded drawing coordinates must be finite");
    assert(!commands.some(command => command.kind === "text" && command.text === "8"),
        "hidden placeholder note 8 must not emit text");
    assert(commands.some(command => command.kind === "text" && command.text === "X"),
        "beat marker note 9 must be drawn as X");
    assert(!commands.some(command => command.kind === "text" && command.text === "9"),
        "beat marker note 9 must not emit its digit");
});

test("SVG 输出已转义、无无效坐标、不依赖 defs 与 transform", () => {
    assert(svg.includes("text-anchor=\"middle\""), "note numbers must use centered text alignment");
    assert(svg.includes("Cascadia Mono"), "note numbers must request a normal monospaced font");
    assert(svg.includes("&lt;tag &amp; text&gt;"), "arbitrary SVG text must be XML escaped");
    assert(!svg.includes(">8</text>"), "hidden placeholder note 8 must not create SVG text");
    assert(!svg.includes("NaN") && !svg.includes("Infinity"), "SVG output must not contain invalid coordinates");
    assert(!svg.includes("<defs") && !svg.includes("<use ")
        && !svg.includes("transform=") && !svg.includes("vector-effect="),
        "SVG paths must contain final geometry without definitions or SVG transforms");
});

test("SVG 路径把平移与正负缩放烘进最终几何", () => {
    const scaledPathPainter = new SvgPainter();
    const scaledPathCommands: readonly PathCommand[] = [
        { op: "M", x: 0, y: 0 },
        { op: "L", x: 1, y: 1 },
    ];
    scaledPathPainter.drawPath(scaledPathCommands, { stroke: "#000", strokeWidth: 1 },
        { x: 7, y: 8, scaleX: 4, scaleY: -6 });
    const scaledPathSvg = scaledPathPainter.toSvg({ x: 0, y: 0, w: 20, h: 20 });
    assert(scaledPathSvg.includes('<path d="M7 8 L11 2"'),
        "SVG paths must bake translation and positive or negative scaling into final geometry");
});

test("动态与固定图形各自使用一个 SVG 元素", () => {
    const dynamicPathSvg = renderLayoutToSvg(layoutOf(`1@a 2@b @tie(a,b)`));
    assert((dynamicPathSvg.match(/<path d=/g) ?? []).length === 1,
        "a dynamic tie must remain one direct SVG path");

    const fixedOnlySvg = renderLayoutToSvg(layoutOf("1 2 3"));
    assert((fixedOnlySvg.match(/<text /g) ?? []).length === 3, "each fixed note number must use one normal text element");
});

test("多页输出的 SVG 尺寸包含堆叠后的整个纸面", () => {
    const twoPageLayout = layoutOf(`
@page(width=200px, height=80px, top=10px, bottom=10px, left=20px, right=20px, gap=5px)
1 @br() 2 @br() 3 @br() 4
`);
    const twoPageSvg = renderLayoutToSvg(twoPageLayout);
    assert(twoPageLayout.pages.length === 2, "the renderer sample must contain two pages");
    assert(twoPageSvg.includes('width="200"') && twoPageSvg.includes('height="160"'), "SVG dimensions must include complete stacked page bounds");
});

test("Canvas 后端能执行描边、曲线与文本绘制", () => {
    assert(canvasCalls.includes("stroke"), "Canvas backend must stroke local accidental paths");
    assert(canvasCalls.includes("bezierCurveTo"), "Canvas backend must execute tie curves");
    assert(canvasCalls.includes("fillText"), "Canvas backend must draw arbitrary text");
});

test("综合样例的绘制规模基线", () => {
    expectSnapshot("render-metrics",
        `commands=${commands.length} svgBytes=${svg.length} canvasCalls=${canvasCalls.length}`);
});
