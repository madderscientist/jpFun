import { test } from "node:test";

import type { DocumentLayoutResult } from "../src/layout/engine.js";
import { renderLayoutPagesToCanvas } from "../src/render/canvas.js";
import { layoutPageBounds } from "../src/render/paint.js";
import { renderLayoutPagesToSvg, SvgPainter } from "../src/render/svg.js";
import type { PathCommand } from "../src/render/types.js";
import { assert, expectSnapshot, layoutOf, recordCommands } from "./helpers.js";

function allNumbersFinite(value: unknown): boolean {
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(allNumbersFinite);
    if (!value || typeof value !== "object") return true;
    return Object.values(value).every(allNumbersFinite);
}

function recordingCanvasContext(calls: string[]) {
    const note = (name: string) => () => { calls.push(name); };
    return {
        globalAlpha: 1,
        save: note("save"), restore: note("restore"),
        translate: (x: number, y: number) => { calls.push(`translate(${x},${y})`); },
        beginPath: note("beginPath"), closePath: note("closePath"),
        moveTo: note("moveTo"), lineTo: note("lineTo"), arc: note("arc"),
        quadraticCurveTo: note("quadraticCurveTo"), bezierCurveTo: note("bezierCurveTo"),
        fill: note("fill"), stroke: note("stroke"), fillText: note("fillText"),
        fillRect: note("fillRect"), strokeRect: note("strokeRect"),
    } as unknown as CanvasRenderingContext2D;
}

/** Canvas 后端没有记录器，用只记方法名的假 context 观察它实际调用了哪些绘制原语 */
function recordCanvasCalls(result: DocumentLayoutResult) {
    const calls: string[] = [];
    renderLayoutPagesToCanvas(result, layoutPageBounds(result).map(() => recordingCanvasContext(calls)));
    return calls;
}

/** 综合样例：一次画出文本、减时线、方框、八度点与连音线，供多个用例共享 */
const result = layoutOf(`@box({1@a #2'./ 8 9# 3@b @tie(a,b)}, 2px, 1px) @text("<tag & text>")`);
const commands = recordCommands(result);
const [svg] = renderLayoutPagesToSvg(result, { padding: 4 });
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
    const [dynamicPathSvg] = renderLayoutPagesToSvg(layoutOf(`1@a 2@b @tie(a,b)`));
    assert((dynamicPathSvg.match(/<path d=/g) ?? []).length === 1,
        "a dynamic tie must remain one direct SVG path");

    const [fixedOnlySvg] = renderLayoutPagesToSvg(layoutOf("1 2 3"));
    assert((fixedOnlySvg.match(/<text /g) ?? []).length === 3, "each fixed note number must use one normal text element");
});

test("分页 SVG 与 Canvas 保持纸张尺寸、内容归属和页面原点", () => {
    const twoPageLayout = layoutOf(`
@page(width=200px, height=80px, top=10px, bottom=10px, left=20px, right=20px, gap=5px)
1 @br() 2 @br() 3 @br() 4
`);
    assert(twoPageLayout.pages.length === 2, "the renderer sample must contain two pages");
    const pages = renderLayoutPagesToSvg(twoPageLayout);
    assert(pages.length === 2, "page rendering must create one SVG per layout page");
    assert(pages.every(page => page.includes('width="200"') && page.includes('height="80"')),
        "each page SVG must preserve the configured paper size");
    assert((pages[0].match(/<text /g) ?? []).length === 2 && (pages[1].match(/<text /g) ?? []).length === 2,
        "each page SVG must contain only the objects assigned to that page");
    assert(pages[0].includes(">1</text>") && pages[0].includes(">2</text>") && !pages[0].includes(">3</text>"),
        "the first SVG must not duplicate content from later pages");
    assert(pages[1].includes(">3</text>") && pages[1].includes(">4</text>") && !pages[1].includes(">2</text>"),
        "the second SVG must not duplicate content from earlier pages");

    const canvasCalls = pages.map(() => [] as string[]);
    renderLayoutPagesToCanvas(twoPageLayout, canvasCalls.map(recordingCanvasContext));
    assert(canvasCalls.every(calls => calls.filter(call => call === "fillText").length === 2),
        "each page Canvas must draw only the objects assigned to that page");
    assert(canvasCalls[0].includes("translate(0,0)") && canvasCalls[1].includes("translate(0,-80)"),
        "each page Canvas must translate global layout coordinates to its own page origin");
    assert(canvasCalls.every(calls => calls[0] === "save" && calls[1].startsWith("translate(")
        && calls.at(-1) === "restore" && calls.indexOf("fillText") > 1),
        "page Canvas transforms must wrap all drawing and restore the caller context");

    const crossPageTie = layoutOf(`
@page(width=200px, height=80px, top=10px, bottom=10px, left=20px, right=20px, gap=5px)
1@a @br() 2 @br() 3 @br() 4@b @tie(a,b)
`);
    const tiePages = renderLayoutPagesToSvg(crossPageTie);
    assert(tiePages.reduce((count, page) => count + (page.match(/<path /g) ?? []).length, 0) === 4,
        "cross-page attachments must route each path segment once instead of duplicating every segment per page");
    assert(tiePages.length === 4 && tiePages.every(page => (page.match(/<path /g) ?? []).length === 1),
        "cross-page attachment segments must be assigned to their corresponding pages");
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
