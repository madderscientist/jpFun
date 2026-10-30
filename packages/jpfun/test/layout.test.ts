import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";

import { GraceTemporal } from "../src/functions/grace/index.js";
import { getLayoutBounds, layoutDocument } from "../src/layout/engine.js";
import { isLayoutAttachment, type LayoutAttachment } from "../src/layout/types.js";
import { isVisualTemporalNode } from "../src/functions/temporal.js";
import { compileScore } from "../src/pipeline.js";
import { assert, layoutContext, layoutOf, lower, nearly, recordCommands } from "./helpers.js";

/** 综合样例：数字、升降号、减时线、小节线、延音与文本 */
const result = compileScore(`1 #2'./ | - @text("进入")`, { rowGap: 12 }).layout;

test("horizontalOnly 保留横向约束与子域尺寸，跳过文档放置、附件测量与分页", () => {
    const run = (horizontalOnly: boolean) => {
        const lowered = lower("@grace(1/@a,{@box({2/ 3/},padding=8px)}) 1/@b | @tie(a,b) @br() @stack({2/ 3/},{4})");
        const first = lowered.columns.flat().find(isVisualTemporalNode)!;
        let subdomainMeasured = 0;
        for (const attachment of lowered.attachments) {
            if (!isLayoutAttachment(attachment)) continue;
            const createGeometry = attachment.createGeometry.bind(attachment);
            attachment.createGeometry = context => (subdomainMeasured++, createGeometry(context));
        }
        let prepared = 0, placed = 0, docMeasured = 0;
        first.onPlaced = () => { placed++; };
        const probe: LayoutAttachment = {
            layer: "foreground",
            prepareHorizontal() { prepared++; first.springConfig.alpha_R! *= 0.5; },
            createGeometry() { docMeasured++; return { regions: [], paint() {} }; },
        };
        lowered.attachments.push(probe);
        return {
            layout: layoutDocument(lowered, layoutContext, { horizontalOnly }),
            counts: { subdomainMeasured, prepared, placed, docMeasured },
        };
    };
    const complete = run(false);
    const horizontal = run(true);
    const geometry = (layout: typeof complete.layout) => layout.objects
        .map(node => [node.layoutLine, node.box.x, node.box.w, node.box.h, node.box.anchor]);
    deepStrictEqual(geometry(horizontal.layout), geometry(complete.layout));
    assert(horizontal.layout.lineCount === complete.layout.lineCount, "横向测量必须保留全部行");
    assert(horizontal.counts.subdomainMeasured > 0, "子域内部附件仍须参与复合体尺寸计算");
    deepStrictEqual(horizontal.counts, {
        subdomainMeasured: horizontal.counts.subdomainMeasured,
        prepared: 1, placed: 0, docMeasured: 0,
    });
    assert(complete.counts.placed > 0 && complete.counts.docMeasured > 0,
        "默认布局必须继续执行放置和附件测量");
    deepStrictEqual(horizontal.layout.attachments, []);
    deepStrictEqual(horizontal.layout.pages, []);
    deepStrictEqual(horizontal.layout.bounds, { x: 0, y: 0, w: 0, h: 0 });
    deepStrictEqual(horizontal.layout.diagnostics, complete.layout.diagnostics);
});

test("local endpoint attachments participate in subsequent range avoidance", () => {
    for (const first of ["@dyn(a,b,24)", "@tie(a,b)"]) {
        for (const wrap of [(body: string) => body, (body: string) => `@grace(1,{${body}})`]) {
            const source = wrap(`2@a 3@b ${first} @dyn(a,b,24)`);
            const result = layoutOf(source);
            const before = result.attachments.find(attachment => attachment.sourceSpan?.start === source.indexOf(first));
            const after = result.attachments.find(attachment => attachment.sourceSpan?.start === source.lastIndexOf("@dyn"));
            assert(before && after && before !== after, "expected two distinct endpoint attachments");
            assert(after.regions[0].y + after.regions[0].h <= before.regions[0].y,
                `a later dynamic must clear the preceding relation in both document and local ranges: ${source}`);
        }
    }
});

test("endpoint occupancy remains isolated between compressed local sequences", () => {
    const group = "@grace(1,{2@a 3@b @tie(a,b) @dyn(a,b,24) @dyn(a,b,24)})";
    assert(nearly(layoutOf(group).bounds.h, layoutOf(Array(30).fill(group).join(" ")).bounds.h),
        "endpoint attachment buckets must not leak into adjacent grace groups under compression");
});

test("document ranges across a multi-voice grace avoid every voice", () => {
    const source = "1@a {3 & 5}>2 4@b @dyn(a,b,24)";
    const layout = layoutOf(source);
    const grace = layout.objects.find(object => object instanceof GraceTemporal);
    const hairpin = layout.attachments.find(attachment => attachment.sourceSpan?.start === source.indexOf("@dyn"));
    assert(grace instanceof GraceTemporal && hairpin, "expected a grace and a hairpin");
    assert(hairpin.regions[0].y + hairpin.regions[0].h <= Math.min(...grace.graces.map(member => member.box.y)) + 1e-6,
        "a document range must clear the upper grace voice");
});

test("repeated placement synchronization and painting do not accumulate offsets", () => {
    const sources = [
        "@adjust(@up(1,3), dx=3px, dy=-4px) 2",
        "@adjust(@grace(@box(1,padding=5px),{@box({2 3},padding=8px)}),dx=7px,dy=-4px) 2",
        "@adjust({1@a}, dx=5px) 2@b @tie(a,b,height=60px)",
        "@head(left={@text(L)}, center={@box(@text(C))}, right={@text(R)}) @br() 1",
    ];
    for (const source of sources) {
        const layout = layoutOf(source);
        const boxes = layout.objects.map(object => ({ ...object.box }));
        const commands = recordCommands(layout);
        for (let repeat = 0; repeat < 2; repeat++) {
            for (const object of layout.objects) object.onPlaced?.();
            deepStrictEqual(recordCommands(layout), commands);
            deepStrictEqual(layout.objects.map(object => ({ ...object.box })), boxes);
        }
    }
});

test("综合样例的每个 LayoutBox 都有效且保持横向顺序", () => {
    assert(result.objects.length === 5, `Expected 5 visible objects, got ${result.objects.length}`);

    let previousX = -Infinity;
    for (const object of result.objects) {
        const values = [
            object.box.x,
            object.box.y,
            object.box.w,
            object.box.h,
            object.box.anchor,
            object.box.visualAxis,
        ];
        assert(values.every(Number.isFinite), "Every LayoutBox field must be finite");
        assert(object.box.w > 0, "Visible objects must have positive width");
        assert(object.box.h > 0, "Visible objects must have positive height");
        assert(object.box.anchor >= 0 && object.box.anchor <= object.box.w, "anchor must stay inside the box");
        assert(object.box.visualAxis >= 0 && object.box.visualAxis <= object.box.h, "visualAxis must stay inside the box");
        assert(object.box.x >= previousX, "Single-track objects must keep horizontal order");
        previousX = object.box.x;
    }

    const decoratedNote = result.objects[1];
    assert(decoratedNote.decorations.length === 3, "octave dots, dot and div must create independent decorations");
    assert(decoratedNote.box.w > decoratedNote.ast.size * 0.62, "dot must extend the note width");
    assert(getLayoutBounds(decoratedNote).h > decoratedNote.ast.size, "div or octave dots must extend occupied height");

});

test("增时线与附点之间保留细小间隙", () => {
    const commands = recordCommands(layoutOf("1 -."));
    const dash = commands.find(command => command.kind === "line");
    const dot = commands.find(command => command.kind === "circle");
    assert(dash?.kind === "line" && dot?.kind === "circle", "应绘制一根增时线和一个附点");

    const gap = dot.cx - dot.r - (dash.x2 + (dash.style?.strokeWidth ?? 0) / 2);
    assert(gap > 0 && gap < 22 * 0.2, `增时线与附点应留一丁点间隙，实际为 ${gap}px`);
});

test("所有行超过半页时横向撑满，短行保持自然宽度", () => {
    const page = "@page(width=200px,left=10px,right=10px) ";
    const filled = layoutOf(`${page}1 2 3 4 @br() 5`);
    const filledLine = filled.objects.filter(object => object.layoutLine === 0);
    assert(nearly(filledLine[0].box.x, 10), "a filled line must start at the left content edge");
    assert(nearly(filledLine.at(-1)!.box.x + filledLine.at(-1)!.box.w, 190),
        "a non-final line wider than half the content area must reach the right edge");

    const compressed = layoutOf(`${page}1 2 3 4 5 6 7 1 2 3 @br() 4`);
    const compressedLine = compressed.objects.filter(object => object.layoutLine === 0);
    assert(nearly(compressedLine[0].box.x, 10), "a compressed line must start at the left content edge");
    assert(nearly(compressedLine.at(-1)!.box.x + compressedLine.at(-1)!.box.w, 190),
        "a compressed line must distribute its outside gaps and reach the right edge");

    const short = layoutOf(`${page}1 2 @br() 3`).objects.filter(object => object.layoutLine === 0);
    assert(short.at(-1)!.box.x + short.at(-1)!.box.w < 100,
        "a line shorter than half the content area must keep its natural spacing");

    const unfilled = layoutOf(`${page.replace(")", ",fillRatio=1)")}1 2 3 4 @br() 5`)
        .objects.filter(object => object.layoutLine === 0);
    assert(unfilled.at(-1)!.box.x + unfilled.at(-1)!.box.w < 190,
        "fillRatio must control when a line expands to the content width");

    const final = layoutOf(`${page}1 2 3 4`).objects;
    assert(nearly(final[0].box.x, 10), "a filled final line must start at the left content edge");
    assert(nearly(final.at(-1)!.box.x + final.at(-1)!.box.w, 190),
        "a final line wider than half the content area must reach the right edge");

    const shortFinal = layoutOf(`${page}1 2`).objects;
    assert(shortFinal.at(-1)!.box.x + shortFinal.at(-1)!.box.w < 100,
        "a short final line must keep its natural spacing");
});

test("可见附件保留最终区域与源码范围", () => {
    const samples = [
        `@box({1/@a 2/@b @tie(a,b) @beam(a,b)}, 2px, 1px) @tuplet({3 4}, 3)`,
        `@voices(@voice({1 2}, A, "你 好"), @voice({3 4}, B))`,
    ];
    for (const source of samples) {
        const layout = compileScore(source).layout;
        const visibleAttachments = layout.attachments.filter(attachment => attachment.regions.length > 0);
        assert(visibleAttachments.length > 0, "the source mapping sample must create visible attachments");
        for (const attachment of visibleAttachments) {
            assert(attachment.sourceSpan, "every visible built-in attachment must expose a source span");
            assert(attachment.sourceSpan.start >= 0 && attachment.sourceSpan.end <= source.length,
                "attachment source spans must stay inside the document");
            assert(attachment.regions && attachment.regions.length > 0,
                "every visible built-in attachment must expose final layout regions");
        }
    }

    const autoSource = `1/ 2/`;
    const autoBeam = compileScore(autoSource).layout.attachments.find(attachment => attachment.regions.length > 0);
    assert(autoBeam?.sourceSpan?.start === 0 && autoBeam.sourceSpan.end === autoSource.length,
        "an automatic attachment must map to the source range covered by its endpoints");
});

test("字号选项与解析期字号驱动所有几何缩放", () => {
    const optionFontSizeResult = compileScore(`1`, { variables: { fontsize: 18 } });
    assert(optionFontSizeResult.layout.objects[0].ast.size === 18, "compileScore fontSize must initialize the root parse scope");

    const [smallDecoratedNote, smallBar] = compileScore(`1.// |`, { variables: { fontsize: 20 } }).layout.objects;
    const [largeDecoratedNote, largeBar] = compileScore(`2.// |`, { variables: { fontsize: 40 } }).layout.objects;
    assert(nearly(largeDecoratedNote.box.w, smallDecoratedNote.box.w * 2), "dot width must scale with its host font size");
    assert(nearly(largeDecoratedNote.box.h, smallDecoratedNote.box.h * 2), "div height must scale with its host font size");
    assert(nearly(largeBar.box.w, smallBar.box.w * 2), "bar geometry must use its parse-time font size");
    assert(nearly(largeBar.box.h, smallBar.box.h * 2), "bar height must use its parse-time font size");
});

test("重复调用 layoutDocument 重置 springConfig，不累乘连梁、小节线与谱头弹簧参数", () => {
    const lowered = lower(`@head(center={@text(标题)}, right={@text(作者)}) @br() 1/ 2/ | @up(3/, 5) 2>4 @arp({1^3})`);
    const first = layoutDocument(lowered, layoutContext);
    const snapshot = (layout: typeof first) => layout.objects.map(node => ({
        box: { ...node.box },
        springConfig: { ...node.springConfig },
    }));
    const expected = snapshot(first);
    const commands = recordCommands(first);
    for (let pass = 0; pass < 2; pass++) {
        const again = layoutDocument(lowered, layoutContext);
        deepStrictEqual(snapshot(again), expected, "springConfig and boxes must remain idempotent across layout passes");
        deepStrictEqual(recordCommands(again), commands);
    }
});
