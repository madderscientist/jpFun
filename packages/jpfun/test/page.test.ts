import { test } from "node:test";

import { layoutDocument } from "../src/layout/engine.js";
import { DEFAULT_PAGE_CONFIG, normalizePageConfig } from "../src/layout/page.js";
import { isVisualTemporalNode } from "../src/lowering/types.js";
import { compileScore } from "../src/pipeline.js";
import {
    assert,
    expectCompileError,
    expectLayoutError,
    expectLoweringError,
    expectSnapshot,
    layoutContext,
    layoutOf,
    lower,
    nearly,
} from "./helpers.js";

test("br 在 lowering 阶段就固化行号，并把文档切成两个系统", () => {
    const loweredBreak = lower(`1 2 @br() 3 4`);
    const loweredBreakLines = loweredBreak.columns
        .flat()
        .filter(isVisualTemporalNode)
        .map(node => node.layoutLine);
    const loweredBreakControl = loweredBreak.columns
        .flat()
        .find(node => !isVisualTemporalNode(node));
    assert(
        loweredBreakLines.join(",") === "0,0,1,1",
        "lowering must solidify visible event line numbers before layout",
    );
    assert(loweredBreakControl?.layoutLine === 1, "br must receive the new line number of its own merged column");
    const breakResult = layoutDocument(loweredBreak, layoutContext);

    assert(breakResult.lineCount === 2, "br must split the document into two layout systems");
    assert(breakResult.objects[0].layoutLine === 0 && breakResult.objects[1].layoutLine === 0, "objects before br must stay on line 0");
    assert(breakResult.objects[2].layoutLine === 1 && breakResult.objects[3].layoutLine === 1, "objects after br must move to line 1");
    assert(nearly(breakResult.objects[0].box.x, breakResult.objects[2].box.x), "each system must restart horizontal layout at the same origin");
    assert(breakResult.objects[2].box.y > breakResult.objects[0].box.y + breakResult.objects[0].box.h, "the second system must be below the first system");

    expectSnapshot("page-break",
        `lines=${breakResult.lineCount} firstY=${breakResult.objects[0].box.y.toFixed(2)}`
        + ` secondY=${breakResult.objects[2].box.y.toFixed(2)}`);
});

test("br 的偏移参数保留空行，0 被修正并报警", () => {
    const offsetBreakResult = compileScore(`1 @br(2) 2`);
    assert(offsetBreakResult.layout.lineCount === 3, "br(2) must preserve one empty intermediate line");
    assert(offsetBreakResult.layout.objects[0].layoutLine === 0, "the event before br(2) must stay on line 0");
    assert(offsetBreakResult.layout.objects[1].layoutLine === 2, "the event after br(2) must move to line 2");

    const zeroBreakResult = compileScore(`1 @br(0) 2`);
    assert(zeroBreakResult.parser.diagnostics.some(item => item.code === "W_BR_OFFSET"),
        "br(0) must report that its offset was corrected");
    assert(zeroBreakResult.layout.lineCount === 2, "br(0) must be corrected to br(1)");
    assert(zeroBreakResult.layout.objects[1].layoutLine === 1, "br(0) must move following events to the next line");
});

test("并行轨的同时刻 br 归并成一列，只换一次行", () => {
    const loweredParallelBreak = lower(`@stack({1 @br() 2}, {3 @br() 4})`);
    const parallelBreakResult = layoutDocument(loweredParallelBreak, layoutContext);
    const parallelBreakColumns = loweredParallelBreak.columns.filter(column =>
        column.some(node => node.breakBefore > 0)
    );
    assert(parallelBreakColumns.length === 1, "simultaneous parallel br controls must merge into one column");
    assert(parallelBreakResult.lineCount === 2, "simultaneous br controls on different tracks must break the score only once");
    assert(parallelBreakResult.objects[2].layoutLine === 1 && parallelBreakResult.objects[3].layoutLine === 1, "both parallel tracks must continue on the same new line");

    assert(layoutOf(`1 @br() @br() 2`).lineCount === 3, "two br controls on one track must accumulate into two line offsets");

    const loweredAsymmetricBreak = lower(`@stack({1 @br() 2}, {3 4})`);
    const simultaneousAfterBreak = loweredAsymmetricBreak.columns
        .flat()
        .filter(node => isVisualTemporalNode(node) && nearly(node.t, 1));
    assert(simultaneousAfterBreak.length === 2, "the asymmetric break sample must retain both simultaneous events");
    assert(
        simultaneousAfterBreak.every(node => node.layoutLine === 1),
        "a pre-column line offset must move every event in the merged column to the next line",
    );
});

test("换行切开所有轨道，跨越换行点的持续事件报错", () => {
    expectLoweringError(`@stack({1.},{2 @br() 3})`, "E_BREAK_INSIDE_EVENT");
});

test("默认页面与配置归一化", () => {
    const defaultPageResult = layoutOf("1");
    assert(defaultPageResult.pages.length === 1, "default infinite-height layout must create one page");
    assert(defaultPageResult.pages[0].bounds.w === 794, "default page width must use the A4 approximation");
    assert(defaultPageResult.pages[0].bounds.h < Infinity, "an infinite-height page must expose its natural finite height");

    const partialPageConfig = normalizePageConfig({ width: 320, marginTop: -5 });
    assert(partialPageConfig.width === 320, "page normalization must preserve provided values");
    assert(partialPageConfig.marginTop === 0, "page normalization must clamp provided margins");
    assert(partialPageConfig.marginBottom === DEFAULT_PAGE_CONFIG.marginBottom,
        "page normalization must fill omitted values from the default config");
});

test("非法页面参数指向它的声明，高度 0 固化为无限", () => {
    const negativeHeightSource = `@page(height=-1px, gap=5px) 1 @br() 2`;
    const negativeHeightDiagnostic = expectCompileError(negativeHeightSource, "E_INVALID_PAGE_CONFIG");
    assert(negativeHeightSource.slice(negativeHeightDiagnostic.span.start, negativeHeightDiagnostic.span.end)
        === "@page(height=-1px, gap=5px)", "an invalid page diagnostic must point to the page declaration");

    for (const source of [`@page(top=-1px) 1`, `@page(gap=-1px) 1`]) {
        expectCompileError(source, "E_INVALID_PAGE_CONFIG");
    }

    const nonPositiveHeightResult = compileScore(`@page(height=0px, gap=5px) 1 @br() 2`);
    assert(nonPositiveHeightResult.lowering.page?.height === Infinity, "page height 0 must solidify as Infinity");
    assert(nonPositiveHeightResult.layout.pages.length === 1, "an infinite-height page must never paginate");

    const emPageResult = compileScore(`@set(fontsize=30) @page(gap=1em) 1`);
    assert(emPageResult.lowering.page?.lineGap === 30, "page gap em must solidify using the parse-time font size");
});

test("有限高度的页面把系统分页并分配行间距", () => {
    const paged = layoutOf(`
@page(width=200px, height=80px, top=10px, bottom=10px, left=20px, right=20px, gap=5px)
1 @br() 2 @br() 3 @br() 4
`);
    assert(paged.pages.length === 2, "four systems must split into two finite pages");
    assert(paged.pages.every(page => page.lineEnd > page.lineStart), "every generated page must contain at least one system");
    assert(paged.pages[0].lineStart === 0 && paged.pages[0].lineEnd === 2, "the first page must contain systems 0 and 1");
    assert(paged.pages[1].lineStart === 2 && paged.pages[1].lineEnd === 4, "the second page must contain systems 2 and 3");
    assert(paged.pages[0].bounds.h === 80 && paged.pages[1].bounds.y === 80, "finite pages must keep exact stacked paper bounds");
    assert(paged.bounds.w === 200 && paged.bounds.h === 160, "document bounds must include both complete pages");

    const [pageLine0, pageLine1, pageLine2, pageLine3] = paged.objects;
    const fullPageGap = pageLine1.box.y - pageLine0.box.y - pageLine0.box.h;
    const lastPageGap = pageLine3.box.y - pageLine2.box.y - pageLine2.box.h;
    const expectedFullPageGap = 80 - 10 - 10 - pageLine0.box.h - pageLine1.box.h;
    assert(nearly(fullPageGap, expectedFullPageGap), "a closed full page must distribute all remaining height into its system gaps");
    assert(nearly(lastPageGap, 5), "the final page must retain the configured minimum system gap");
});

test("重复与嵌套的 page 声明只报警并保留第一份", () => {
    const duplicatePageResult = compileScore(`@page(width=200px) @page(width=-1px) 1`);
    assert(duplicatePageResult.parser.diagnostics.some(item => item.code === "W_DUPLICATE_PAGE"), "a repeated page declaration must create a diagnostic");
    assert(duplicatePageResult.layout.pages[0].bounds.w === 200, "the first page declaration must win");

    const nestedPageResult = compileScore(`{@page(width=-1px) 1}`);
    assert(nestedPageResult.parser.diagnostics.some(item => item.code === "W_PAGE_NOT_TOP_LEVEL"), "a nested page declaration must create a diagnostic");
    assert(nestedPageResult.layout.pages[0].bounds.w === 794, "a nested page declaration must be ignored");
});

test("放不下的内容和无效的版心各自报错", () => {
    const pageOverflow = expectLayoutError(
        `@page(width=200px, height=40px, top=10px, bottom=10px, left=10px, right=10px) 1`,
        "E_PAGE_OVERFLOW",
    );
    assert(pageOverflow.span.start === pageOverflow.span.end - 1,
        "page overflow must point to the unplaceable score content");

    expectCompileError(
        `@page(width=200px, height=20px, top=10px, bottom=10px) 1`,
        "E_INVALID_PAGE_CONFIG",
    );
});
