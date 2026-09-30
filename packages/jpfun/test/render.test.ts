import { test } from "node:test";
import { strictEqual } from "node:assert";

import type { DocumentLayoutResult } from "../src/layout/engine.js";
import { pathBounds } from "../src/layout/path.js";
import { renderLayoutPagesToCanvas } from "../src/render/canvas.js";
import { layoutPageBounds } from "../src/render/paint.js";
import { renderLayoutPagesToSvg, SvgPainter } from "../src/render/svg.js";
import { CanvasTextMeasurer, canvasFont } from "../src/render/text.js";
import type { PathCommand, TextStyle } from "../src/render/types.js";
import { assert, expectSnapshot, layoutOf, nearly, recordCommands } from "./helpers.js";

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
    assert((svg.match(/xml:space="preserve"/g) ?? []).length === (svg.match(/<text /g) ?? []).length,
        "every SVG text node must preserve the whitespace measured during layout");
    assert(!svg.includes(">8</text>"), "hidden placeholder note 8 must not create SVG text");
    assert(!svg.includes("NaN") && !svg.includes("Infinity"), "SVG output must not contain invalid coordinates");
    assert(!svg.includes("<defs") && !svg.includes("<use ")
        && !svg.includes("transform=") && !svg.includes("vector-effect="),
        "SVG paths must contain final geometry without definitions or SVG transforms");

    const whitespacePainter = new SvgPainter();
    whitespacePainter.drawText("A   B", 0, 0, { fontSize: 16 });
    assert(whitespacePainter.toSvg({ x: 0, y: 0, w: 100, h: 20 }).includes(">A   B</text>"),
        "consecutive spaces must remain in the serialized text content");
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

test("voice connectors use the same finite paths in SVG and Canvas", () => {
    const voices = '@voice({1}, A), @voice({2}, B), @voice({3}, C)';
    for (const [connect, paths, curves, rectangles] of [
        ["", 0, 0, 1],
        ["{-}", 1, 20, 1],
        ["[-]", 2, 4, 2],
        ["[-]{-}", 3, 24, 2],
    ] as const) {
        const result = layoutOf(`@voices(${voices}, connect="${connect}")`);
        assert(recordCommands(result).every(allNumbersFinite), "all connector coordinates must be finite");
        const [svg] = renderLayoutPagesToSvg(result);
        const canvas = recordCanvasCalls(result);
        strictEqual((svg.match(/<path d=/g) ?? []).length, paths, connect);
        strictEqual((svg.match(/<rect /g) ?? []).length, rectangles, connect);
        strictEqual(canvas.filter(call => call === "bezierCurveTo").length, curves, connect);
        strictEqual(canvas.filter(call => call === "fillRect").length, rectangles, connect);
    }
});

test("curved brace preserves the supplied MuseScore SVG outline after fitting", () => {
    const reference = `M2.98438,-165.5
C8.9375,-171.781 20.5156,-184.688 20.5156,-208.531
C20.5156,-238.641 7.60938,-269.094 7.60938,-287.969
C7.60938,-308.156 19.2031,-327.016 19.8594,-327.688
C19.8594,-328.016 19.8594,-328.016 19.8594,-328.344
C19.8594,-328.672 19.8594,-329 19.5313,-329.344
C19.2031,-329.344 18.5313,-329.344 18.2031,-328.672
C17.875,-328.344 0,-310.469 0,-283.328
C0,-254.203 11.5781,-233.688 11.5781,-195.625
C11.5781,-188.328 8.60938,-176.75 0.328125,-166.484
C0,-166.484 0,-165.828 0,-165.5
C-0.328125,-165.172 0,-164.828 0.328125,-164.5
C8.60938,-154.25 11.5781,-142.656 11.5781,-135.375
C11.5781,-97.3125 0,-76.7969 0,-47.6563
C0,-20.8594 17.875,-2.64063 18.2031,-2.3125
C18.5313,-1.65625 19.2031,-1.32813 19.5313,-1.65625
C19.8594,-1.98438 20.1875,-2.3125 19.8594,-2.64063
C19.8594,-2.64063 19.8594,-2.98438 19.8594,-3.3125
C19.2031,-3.96875 7.60938,-22.8438 7.60938,-43.0313
C7.60938,-61.8906 20.5156,-92.3438 20.5156,-122.469
C20.5156,-146.625 8.9375,-159.203 2.98438,-165.5`;
    const expected = [...reference.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
    const referenceBounds = {
        x: -0.13591382515367184, y: -329.344,
        w: 20.65151382515367, h: 327.8164728734988,
    };
    for (const size of [12, 22, 40]) {
        const layout = layoutOf('@voices(@voice({1}), @voice({2}), @voice({3}), connect="{-}")', size);
        const path = recordCommands(layout).find(command => command.kind === "path")!;
        const bounds = pathBounds(path.commands);
        const x = (value: number) => (value - bounds.x) / bounds.w * referenceBounds.w + referenceBounds.x;
        const y = (value: number) => (value - bounds.y) / bounds.h * referenceBounds.h + referenceBounds.y;
        const actual = path.commands.flatMap(command => {
            if (command.op === "Z") return [];
            if (command.op === "M") return [x(command.x), y(command.y)];
            assert(command.op === "C", "the reference uses only cubic curves");
            return [x(command.cx1), y(command.cy1), x(command.cx2), y(command.cy2), x(command.x), y(command.y)];
        });
        strictEqual(actual.length, expected.length);
        for (let i = 0; i < expected.length; i++) {
            assert(nearly(actual[i], expected[i]), `reference coordinate ${i} must survive scaling at ${size}px`);
        }
        strictEqual(path.commands.at(-1)!.op, "Z", "brace contour must be closed");
    }
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

test("CanvasTextMeasurer 用绘制时的同一份字体串测量", () => {
    const seen: string[] = [];
    let width = 40;
    const context = {
        set font(value: string) { seen.push(value); },
        get font() { return seen.at(-1) ?? ""; },
        measureText: () => ({ width }),
    } as unknown as CanvasRenderingContext2D;
    const measurer = new CanvasTextMeasurer(context);
    const style: TextStyle = { fontSize: 20, fontFamily: "Cascadia Mono", fontWeight: "bold" };

    const metrics = measurer.measureText("abc", style);
    assert(seen.length === 1 && seen[0] === canvasFont(style),
        "the measurer must select the exact font string CanvasPainter draws with");
    assert(nearly(metrics.w, 40), "width must come from the host font metrics");
    assert(nearly(metrics.h, 20) && nearly(metrics.baseline, 16),
        "height and baseline must keep the deterministic em-box convention");

    measurer.measureText("abc", style);
    assert(seen.length === 1, "repeated measurements of one string must be cached");
    const largerStyle: TextStyle = { ...style, fontSize: 30 };
    measurer.measureText("abc", largerStyle);
    assert(seen.at(-1) === canvasFont(largerStyle), "a different style must not reuse the cached width");
    const samples = [["abc", style], ["def", style], ["abc", largerStyle],
        ["abc", { ...style, fontFamily: "serif" }], ["abc", { ...style, fontWeight: "normal" }]] as const;
    for (const [text, sampleStyle] of samples) measurer.measureText(text, sampleStyle);
    strictEqual(seen.length, samples.length, "text, size, family and weight must have separate cache entries");
    width = 60;
    for (const [text, sampleStyle] of samples) {
        assert(measurer.measureText(text, sampleStyle).w === 40, "cached widths remain until invalidated");
    }
    measurer.clearCache();
    for (const [text, sampleStyle] of samples) {
        const refreshed = measurer.measureText(text, sampleStyle);
        assert(refreshed.w === 60 && refreshed.h === sampleStyle.fontSize
            && nearly(refreshed.baseline, sampleStyle.fontSize * 0.8), "clear must refresh all widths and preserve em metrics");
    }
    strictEqual(seen.length, samples.length * 2, "clearing must invalidate every entry");
    width = 0;
    measurer.clearCache();
    assert(measurer.measureText("abc", style).w === 5, "refreshed widths retain the minimum width clamp");
});
