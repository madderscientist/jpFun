import { test } from "node:test";

import { DIV_ADDON_KEY } from "../src/functions/div/index.js";
import { layoutDocument } from "../src/layout/engine.js";
import { isVisualTemporalNode } from "../src/lowering/types.js";
import { compileScore } from "../src/pipeline.js";
import { assert, expectSnapshot, layoutContext, lower, nearly } from "./helpers.js";

/** 综合样例：数字、升降号、减时线、小节线、延音与文本 */
const result = compileScore(`1 #2'./ | - @text("进入")`, { rowGap: 12 }).layout;

test("装饰处理器从主函数名推导注册键", () => {
    assert(layoutContext.decorationHandlers.has(DIV_ADDON_KEY),
        "div layout must derive its handler key from the primary function name");
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
    assert(decoratedNote.decorations.length === 2, "dot and div must create two independent decorations");
    assert(decoratedNote.box.w > decoratedNote.ast.size * 0.62, "dot must extend the note width");
    assert(decoratedNote.box.h > decoratedNote.ast.size, "div or octave dots must extend the note height");

    expectSnapshot("layout-metrics",
        `objects=${result.objects.length} width=${result.bounds.w.toFixed(2)} height=${result.bounds.h.toFixed(2)}`);
});

test("完全被宿主包含的附件不触发重排", () => {
    const noExpansion = lower("1");
    const host = noExpansion.columns[0]?.find(isVisualTemporalNode);
    assert(host, "the contained occupancy test requires one visual host");
    let layoutCalls = 0;
    noExpansion.attachments.push({
        layer: "foreground",
        createGeometry(context) {
            layoutCalls++;
            const axis = context.getVisualAxis(0, host.track);
            const extent = context.getHostExtent(0, host.track);
            assert(extent, "the contained occupancy test requires a host extent");
            return {
                regions: [{
                    x: 10,
                    y: axis + extent.top,
                    w: 30,
                    h: extent.bottom - extent.top,
                    line: 0,
                    track: host.track,
                }],
                paint() {},
            };
        },
    });
    const noExpansionResult = layoutDocument(noExpansion, layoutContext);
    assert(layoutCalls === 1, "contained track occupancy must not trigger a redundant relayout");
    assert(noExpansionResult.attachments[0].box.h === host.box.h,
        "a single-pass attachment must retain its measured bounds");
    assert(noExpansionResult.attachments[0].regions?.length === 1,
        "a single-pass attachment must retain its measured regions");
});

test("撑开轨道的附件在最终基线上重新布局", () => {
    const withOccupancy = lower("1");
    const host = withOccupancy.columns.flat().find(isVisualTemporalNode);
    assert(host, "the occupancy test requires one visual host");
    let layoutCalls = 0;
    withOccupancy.attachments.push({
        layer: "foreground",
        createGeometry(context) {
            layoutCalls++;
            return {
                regions: [{ x: 10, y: context.getVisualAxis(0, host.track) - 100, w: 30, h: 10, line: 0, track: host.track }],
                paint() {},
            };
        },
    });
    const withOccupancyResult = layoutDocument(withOccupancy, layoutContext);
    const finalAxis = host.box.y + host.box.visualAxis;
    assert(layoutCalls === 2, "an attachment with track occupancy must be re-laid out on final axes");
    assert(nearly(withOccupancyResult.attachments[0].box.y, finalAxis - 100),
        "a re-laid attachment must expose bounds from its final geometry");
    assert(nearly(withOccupancyResult.attachments[0].regions[0].y, finalAxis - 100),
        "a re-laid attachment must expose regions from its final geometry");
});

test("可见附件保留最终区域与源码范围", () => {
    const samples = [
        `@box({1/@a 2/@b @tie(a,b) @beam(a,b)}, 2px, 1px) @tuplet({3 4}, 3)`,
        `@voices(@voice({1 2}, A, "你 好"), @voice({3 4}, B))`,
    ];
    for (const source of samples) {
        const layout = compileScore(source).layout;
        const visibleAttachments = layout.attachments.filter(attachment => attachment.box.w > 0 || attachment.box.h > 0);
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
    const autoBeam = compileScore(autoSource).layout.attachments.find(attachment => attachment.box.w > 0);
    assert(autoBeam?.sourceSpan?.start === 0 && autoBeam.sourceSpan.end === autoSource.length,
        "an automatic attachment must map to the source range covered by its endpoints");
});

test("字号选项与解析期字号驱动所有几何缩放", () => {
    const optionFontSizeResult = compileScore(`1`, { fontSize: 18 });
    assert(optionFontSizeResult.layout.objects[0].ast.size === 18, "compileScore fontSize must initialize the root parse scope");

    const [smallDecoratedNote, smallBar] = compileScore(`1.// |`, { fontSize: 20 }).layout.objects;
    const [largeDecoratedNote, largeBar] = compileScore(`2.// |`, { fontSize: 40 }).layout.objects;
    assert(nearly(largeDecoratedNote.box.w, smallDecoratedNote.box.w * 2), "dot width must scale with its host font size");
    assert(nearly(largeDecoratedNote.box.h, smallDecoratedNote.box.h * 2), "div height must scale with its host font size");
    assert(nearly(largeBar.box.w, smallBar.box.w * 2), "bar geometry must use its parse-time font size");
    assert(nearly(largeBar.box.h, smallBar.box.h * 2), "bar height must use its parse-time font size");
});
