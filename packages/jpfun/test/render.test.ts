import { test } from "node:test";
import { strictEqual } from "node:assert";

import type { DocumentLayoutResult } from "../src/layout/engine.js";
import { CanvasPainter, renderLayoutPagesToCanvas } from "../src/render/canvas.js";
import { layoutPageBounds } from "../src/render/paint.js";
import { renderLayoutPagesToSvg, SvgPainter } from "../src/render/svg.js";
import { CanvasTextMeasurer, canvasFont } from "../src/render/text.js";
import type { PathCommand, TextStyle } from "../src/render/types.js";
import { assert, layoutOf, nearly, recordCommands } from "./helpers.js";

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

test("SVG 文本正确转义、保留空白且不输出无效坐标", () => {
    assert(svg.includes("text-anchor=\"middle\""), "note numbers must use centered text alignment");
    assert(svg.includes("&lt;tag &amp; text&gt;"), "arbitrary SVG text must be XML escaped");
    assert((svg.match(/xml:space="preserve"/g) ?? []).length === (svg.match(/<text /g) ?? []).length,
        "every SVG text node must preserve the whitespace measured during layout");
    assert(!svg.includes(">8</text>"), "hidden placeholder note 8 must not create SVG text");
    assert(!svg.includes("NaN") && !svg.includes("Infinity"), "SVG output must not contain invalid coordinates");

    const whitespacePainter = new SvgPainter();
    whitespacePainter.drawText("A   B", 0, 0, { fontSize: 16 });
    assert(whitespacePainter.toSvg({ x: 0, y: 0, w: 100, h: 20 }).includes(">A   B</text>"),
        "consecutive spaces must remain in the serialized text content");
});

test("Fine 在 SVG 和 Canvas 中使用斜体，不影响普通文本", () => {
    for (const source of ["$fine", "@symbol(fine)"]) {
        const layout = layoutOf(`${source} "Plain"`);
        const [svg] = renderLayoutPagesToSvg(layout);
        strictEqual((svg.match(/font-style="italic"/g) ?? []).length, 1);
        assert(/<text [^>]*font-style="italic"[^>]*>Fine\.<\/text>/.test(svg),
            "Fine 文字应输出斜体样式");

        const fonts: string[] = [];
        const context = recordingCanvasContext([]);
        context.fillText = () => { fonts.push(context.font); };
        renderLayoutPagesToCanvas(layout, [context]);
        strictEqual(fonts.length, 2);
        strictEqual(fonts.filter(font => font.startsWith("italic ")).length, 1);
        assert(fonts[0].includes('"Times New Roman", serif'), "Fine 应保留原有字体");
        assert(fonts[0].startsWith("italic "), "Canvas 中的 Fine 也应使用斜体");
    }
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

test("颤音尾巴在 SVG 与 Canvas 中都逐截绘制", () => {
    for (let count = 0; count <= 3; count++) {
        const result = layoutOf(`$tr${"+".repeat(count)}`);
        const [svg] = renderLayoutPagesToSvg(result);
        const calls = recordCanvasCalls(result);
        strictEqual((svg.match(/<path d=/g) ?? []).length, count + 1);
        strictEqual(calls.filter(call => call === "fill").length, count + 1);
        assert(recordCommands(result).every(allNumbersFinite)
            && !/NaN|Infinity/.test(svg), "尾巴绘制坐标必须有限");
    }
});

test("Canvas 圆形支持 fill=none，默认圆形仍填充黑色", () => {
    for (const fill of [undefined, "none", "#f00"]) {
        const calls: string[] = [];
        const context = recordingCanvasContext(calls);
        new CanvasPainter(context).drawCircle(5, 5, 4, { fill, stroke: "#000", strokeWidth: 1 });
        strictEqual(calls.filter(call => call === "fill").length, fill === "none" ? 0 : 1);
        strictEqual(calls.filter(call => call === "stroke").length, 1);
        if (fill !== "none") strictEqual(context.fillStyle, fill ?? "#000");
    }
});

test("内置新增符号在 SVG 和 Canvas 中使用相同的有限矢量图元，不依赖字体", () => {
    for (const [source, paths, lines, circles] of [
        ["$tremolo $harmonic", 1, 0, 1],
        ["$tenuto $marcato $staccato $turn $iturn", 4, 2, 0],
    ] as const) {
        const layout = layoutOf(source);
        const [svg] = renderLayoutPagesToSvg(layout);
        const calls = recordCanvasCalls(layout);
        strictEqual((svg.match(/<path d=/g) ?? []).length, paths);
        strictEqual((svg.match(/<line /g) ?? []).length, lines);
        strictEqual((svg.match(/<circle /g) ?? []).length, circles);
        strictEqual(calls.filter(call => call === "fill").length, paths);
        strictEqual(calls.filter(call => call === "stroke").length, lines + circles);
        strictEqual(calls.filter(call => call === "arc").length, circles);
        if (circles) assert(/<circle [^>]*fill="none"[^>]*stroke="#000"/.test(svg), "泛音只描边");
        assert(!svg.includes("<text ") && !svg.includes('fill="#fff"') && !calls.includes("fillText"),
            "不依赖字体或白色遮挡");
        assert(recordCommands(layout).every(allNumbersFinite) && !/NaN|Infinity/.test(svg), "绘制坐标必须有限");
    }
});

test("高低多八度号的斜体标签、虚线与折钩在 SVG 和 Canvas 中一致", () => {
    for (const shift of [2, -3]) {
        const layout = layoutOf(`1@a @br() 2@b @ottava(a,b,${shift})`);
        const commands = recordCommands(layout);
        const [svg] = renderLayoutPagesToSvg(layout);
        const calls = recordCanvasCalls(layout);
        const text = String(Math.abs(shift) * 7 + 1);
        strictEqual((svg.match(new RegExp(`>${text}</text>`, "g")) ?? []).length, 1);
        strictEqual((svg.match(/font-style="italic"/g) ?? []).length, 1);
        strictEqual((svg.match(/<text /g) ?? []).length, 3);
        strictEqual(calls.filter(call => call === "fillText").length, 3);
        strictEqual((svg.match(/<path d=/g) ?? []).length, 0);
        const lines = commands.filter(command => command.kind === "line").length;
        assert(lines > 1, "八度号仍绘制续行虚线和末端折钩");
        strictEqual((svg.match(/<line /g) ?? []).length, lines);
        strictEqual(calls.filter(call => call === "stroke").length, lines);
        assert(commands.every(allNumbersFinite) && !/NaN|Infinity/.test(svg), "所有后端坐标须有限");
    }
});

test("voice connectors use the same finite paths in SVG and Canvas", () => {
    const voices = '@voice({1}, A), @voice({2}, B), @voice({3}, C)';
    for (const connect of ["", "{-}", "[-]", "[-]{-}"]) {
        const result = layoutOf(`@voices(${voices}, connect="${connect}")`);
        assert(recordCommands(result).every(allNumbersFinite), "all connector coordinates must be finite");
        const [svg] = renderLayoutPagesToSvg(result);
        const canvas = recordCanvasCalls(result);
        strictEqual(svg.includes("<path "), connect !== "", connect);
        strictEqual(canvas.includes("bezierCurveTo"), connect !== "", connect);
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
    strictEqual(canvasCalls.filter(call => call === "save").length, 1,
        "Canvas backend should only save/restore once per page, not per primitive");
    strictEqual(canvasCalls.filter(call => call === "restore").length, 1,
        "Canvas backend should only save/restore once per page, not per primitive");

    const calls: string[] = [];
    const alphas: number[] = [];
    const joins: string[] = [];
    const context = recordingCanvasContext(calls);
    context.globalAlpha = 0.8;
    context.fillText = () => {
        calls.push("fillText");
        alphas.push(context.globalAlpha);
    };
    context.strokeRect = () => {
        calls.push("strokeRect");
        joins.push(context.lineJoin);
    };
    const painter = new CanvasPainter(context);
    painter.drawText("A", 0, 0, { fontSize: 16, opacity: 0.5 });
    painter.drawPath([{ op: "M", x: 0, y: 0 }, { op: "L", x: 5, y: 5 }], { stroke: "#000" });
    painter.drawRect(0, 0, 10, 10, { stroke: "#000" });
    assert(nearly(alphas[0], 0.4), "drawText must multiply caller globalAlpha by style.opacity");
    assert(nearly(context.globalAlpha, 0.8), "CanvasPainter must restore globalAlpha after drawing with opacity");
    strictEqual(joins[0], "miter", "drawRect stroke must reset lineJoin after drawPath");
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
    const style: TextStyle = { fontSize: 20, fontFamily: "Cascadia Mono", fontWeight: "bold", fontStyle: "italic" };

    const metrics = measurer.measureText("abc", style);
    assert(seen.length === 1 && seen[0] === canvasFont(style),
        "the measurer must select the exact font string CanvasPainter draws with");
    strictEqual(seen[0], "italic bold 20px Cascadia Mono");
    let drawnFont = "";
    const drawingContext = recordingCanvasContext([]);
    Object.defineProperty(drawingContext, "font", {
        set(value: string) { drawnFont = value; },
    });
    new CanvasPainter(drawingContext).drawText("abc", 0, 0, style);
    strictEqual(drawnFont, canvasFont(style));
    assert(nearly(metrics.w, 40), "width must come from the host font metrics");
    assert(nearly(metrics.h, 20) && nearly(metrics.baseline, 16),
        "height and baseline must keep the deterministic em-box convention");

    measurer.measureText("abc", style);
    assert(seen.length === 1, "repeated measurements of one string must be cached");
    const largerStyle: TextStyle = { ...style, fontSize: 30 };
    measurer.measureText("abc", largerStyle);
    assert(seen.at(-1) === canvasFont(largerStyle), "a different style must not reuse the cached width");
    const samples = [["abc", style], ["def", style], ["abc", largerStyle],
        ["abc", { ...style, fontFamily: "serif" }], ["abc", { ...style, fontWeight: "normal" }],
        ["abc", { ...style, fontStyle: "normal" }]] as const;
    for (const [text, sampleStyle] of samples) measurer.measureText(text, sampleStyle);
    strictEqual(seen.length, samples.length, "text, size, family, weight and slant must have separate cache entries");
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
