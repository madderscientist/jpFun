import { test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";

import { layoutDocument } from "../src/layout/engine.js";
import { DEFAULT_PAGE_CONFIG, normalizePageConfig, paginateLayoutLines } from "../src/layout/page.js";
import type { LayoutAttachment } from "../src/layout/types.js";
import { isVisualTemporalNode, TemporalNodeBase, transferFunctionAddons } from "../src/functions/temporal.js";
import { defaultFunctions } from "../src/functions/default.js";
import { BrNode } from "../src/functions/br/index.js";
import { PageBreakNode } from "../src/functions/pagebreak/index.js";
import { compileScore } from "../src/pipeline.js";
import { compilePlayback } from "../src/playback/compile.js";
import { paintLayoutPages } from "../src/render/paint.js";
import { RecordingPainter } from "../src/render/recording.js";
import {
    assert,
    attachmentCommands,
    compileValid,
    createLowering,
    expectCompileError,
    expectDiagnostic,
    expectLayoutError,
    expectLoweringError,
    expectSnapshot,
    layoutContext,
    layoutOf,
    lower,
    nearly,
    parse,
    playedNotes,
    recordCommands,
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
    assert(zeroBreakResult.diagnostics.some(item => item.code === "W_BR_OFFSET"),
        "br(0) must report that its offset was corrected");
    assert(zeroBreakResult.layout.lineCount === 2, "br(0) must be corrected to br(1)");
    assert(zeroBreakResult.layout.objects[1].layoutLine === 1, "br(0) must move following events to the next line");
});

test("并行轨的同时刻 br 归并成一列，只换一次行", () => {
    const loweredParallelBreak = lower(`@stack({1 @br() 2}, {3 @br() 4})`);
    const parallelBreakResult = layoutDocument(loweredParallelBreak, layoutContext);
    const parallelBreakColumns = loweredParallelBreak.columns.filter(column =>
        column.some(node => (node.addon?.breakBefore ?? 0) > 0)
    );
    assert(parallelBreakColumns.length === 1, "simultaneous parallel br controls must merge into one column");
    assert(parallelBreakResult.lineCount === 2, "simultaneous br controls on different tracks must break the score only once");
    assert(parallelBreakResult.objects[2].layoutLine === 1 && parallelBreakResult.objects[3].layoutLine === 1, "both parallel tracks must continue on the same new line");

    assert(layoutOf(`1 @br() @br() 2`).lineCount === 3, "two br controls on one track must accumulate into two line offsets");

    const loweredAsymmetricBreak = lower(`@stack({1 @br() 2}, {3 4})`);
    const simultaneousAfterBreak = loweredAsymmetricBreak.columns
        .flat()
        .filter(node => isVisualTemporalNode(node) && node.t.equals(1));
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
    assert(partialPageConfig.fillRatio === 0.5, "page normalization must default fillRatio to 0.5");
    for (const height of [0, -1]) {
        assert(normalizePageConfig({ height }).height === Infinity,
            "page normalization must treat non-positive heights as Infinity");
    }

    const configuredFill = compileScore(`@page(fillRatio=0.75) 1`);
    assert(configuredFill.lowering.page?.fillRatio === 0.75,
        "page declarations must solidify the configured fillRatio");
    assert(compileScore(`@page(fillRatio=-1) 1`).lowering.page?.fillRatio === -1,
        "page declarations must allow fillRatio below zero");
    assert(compileScore(`@page(fillRatio=2) 1`).lowering.page?.fillRatio === 2,
        "page declarations must allow fillRatio above one");
    const infiniteFill = compileScore(`@page(fillRatio=Infinity) 1`);
    assert(infiniteFill.lowering.page?.fillRatio === DEFAULT_PAGE_CONFIG.fillRatio
        && infiniteFill.diagnostics.some(item => item.code === "W_INVALID_NUMBER"),
        "page declarations must diagnose non-finite numbers and use the default");
});

test("非法页面参数指向它的声明，非正高度固化为无限", () => {
    const invalidPageSource = `@page(width=-1px, gap=5px) 1 @br() 2`;
    const invalidPageDiagnostic = expectCompileError(invalidPageSource, "E_INVALID_PAGE_CONFIG");
    assert(invalidPageSource.slice(invalidPageDiagnostic.span.start, invalidPageDiagnostic.span.end)
        === "@page(width=-1px, gap=5px)", "an invalid page diagnostic must point to the page declaration");

    for (const source of [
        `@page(top=-1px) 1`,
        `@page(gap=-1px) 1`,
        `@page(bottom=15px, numbering="1") 1`,
    ]) {
        expectCompileError(source, "E_INVALID_PAGE_CONFIG");
    }

    const naturalPages = compileValid(`@page(gap=5px) 1 @br() 2`).layout.pages;
    for (const height of ["0px", "-1px", "-1em"]) {
        const result = compileValid(`@page(height=${height}, gap=5px) 1 @br() 2`);
        assert(result.lowering.page?.height === Infinity, "a non-positive page height must solidify as Infinity");
        deepStrictEqual(result.layout.pages, naturalPages, "a non-positive page height must use natural-height layout");
    }

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
    const remaining = 80 - 10 - 10 - pageLine0.box.h - pageLine1.box.h - 5;
    const share = remaining / 2;
    const fullPageBottom = 80 - 10 - pageLine1.box.y - pageLine1.box.h;
    assert(nearly(pageLine0.box.y, 10), "a closed full page must keep its first system at the top margin");
    assert(nearly(fullPageGap, 5 + share), "a closed full page must add one share below each non-final system");
    assert(nearly(fullPageBottom, share), "a closed full page must leave the final system's share at the bottom");
    assert(nearly(lastPageGap, 5), "the final page must retain the configured minimum system gap");

    const singlePerPage = layoutOf(`
@page(width=200px, height=50px, top=10px, bottom=10px, left=20px, right=20px, gap=5px)
1 @br() 2
`);
    assert(singlePerPage.pages.length === 2, "the sample must place one system on each page");
    assert(nearly(singlePerPage.objects[0].box.y, 10),
        "a closed page with one system must keep it at the top instead of centering it");
});

test("重复与嵌套的 page 声明只报警并保留第一份", () => {
    const duplicatePageResult = compileScore(`@page(width=200px) @page(width=-1px) 1`);
    assert(duplicatePageResult.diagnostics.some(item => item.code === "W_DUPLICATE_PAGE"), "a repeated page declaration must create a diagnostic");
    assert(duplicatePageResult.layout.pages[0].bounds.w === 200, "the first page declaration must win");

    const nestedPageResult = compileScore(`{@page(width=-1px) 1}`);
    assert(nestedPageResult.diagnostics.some(item => item.code === "W_PAGE_NOT_TOP_LEVEL"), "a nested page declaration must create a diagnostic");
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

test("页码单个占位符显示当前页，多个占位符的末尾显示总页数", () => {
    for (const [pattern, expected] of [
        ["1", ["1", "2", "3"]],
        ["-- 1 --", ["-- 1 --", "-- 2 --", "-- 3 --"]],
        ["第1页", ["第1页", "第2页", "第3页"]],
        ["1-1-1", ["1-1-3", "2-2-3", "3-3-3"]],
        ["固定文字", ["固定文字", "固定文字", "固定文字"]],
    ] as const) {
        const result = compileScore(`
@page(width=200px, height=100px, top=10px, bottom=20px,
    left=20px, right=20px, gap=5px, numbering="${pattern}")
1 @br() 2 @br() 3 @br() 4 @br() 5 @br() 6
`);
        assert(result.diagnostics.length === 0, `${pattern} must compile without diagnostics`);
        assert(result.layout.pages.length === 3, "the sample must contain three pages");
        const texts = attachmentCommands(result.layout.attachments[0])
            .filter(command => command.kind === "text")
            .map(command => command.text);
        assert(JSON.stringify(texts) === JSON.stringify(expected),
            `${pattern}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(texts)}`);
    }
});

test("页码是 @page 自己注册的 attachment，逐页浮在下边距带内", () => {
    const paged = layoutOf(`
@page(width=200px, height=100px, top=10px, bottom=20px, left=20px, right=20px, gap=5px, numbering="1 / 1")
1 @br() 2 @br() 3 @br() 4 @br() 5 @br() 6
`);
    assert(paged.attachments.length === 1, "numbering must contribute exactly one attachment");
    const [numbering] = paged.attachments;
    const numbers = attachmentCommands(numbering)
        .filter(command => command.kind === "text");
    assert(numbers.map(command => command.text).join("|") === "1 / 3|2 / 3|3 / 3",
        "each page must render one number whose last counting symbol is the total page count");
    assert(numbering.regions.every(region => region.line === void 0),
        "page numbers live in the margin and must not claim any track");

    for (const [index, command] of numbers.entries()) {
        const { x, y, w, h } = paged.pages[index].bounds;
        assert(command.style.textAlign === "center" && nearly(command.x, x + w / 2),
            "page numbers must be centered on their own page");
        assert(command.y > y + h - 20 && command.y < y + h,
            "page numbers must stay inside their own bottom margin band");
    }

    const pagePainters = paged.pages.map(() => new RecordingPainter());
    paintLayoutPages(paged, pagePainters);
    assert(
        pagePainters.every((painter, index) => painter.commands
            .filter(command => command.kind === "text" && command.text === `${index + 1} / 3`).length === 1),
        "the paged painter must route each page number to its own page",
    );

    assert(layoutOf(`@page(width=200px) 1`).attachments.length === 0,
        "a document without numbering must not create the attachment");
    const single = attachmentCommands(layoutOf(`@page(bottom=16px, numbering="-- 1 --") 1`).attachments[0]);
    assert(single.length === 1 && single[0].kind === "text" && single[0].text === "-- 1 --",
        "a single counting symbol must render the current page only, and bottom may equal the font size");
});

test("pb 自动换行换页，不绘制内容也不改变播放时间", () => {
    const source = `1 2 @pb() 3 4`;
    const result = compileValid(source);
    const control = result.lowering.columns.flat().find(node => node.addon?.pageBreakBefore !== undefined);
    assert(control && !isVisualTemporalNode(control) && control.T.isZero(), "pb must be an invisible zero-duration control");
    assert(control.addon?.breakBefore === 1 && control.layoutLine === 1, "pb must use the existing line offset");
    assert(!("breakBefore" in control) && !("pageBreakBefore" in control), "boundary declarations must live only in addon");
    assert(control.ast.toString(source) === "@pagebreak(justify=true)", "pb must serialize using the primary name");
    deepStrictEqual(result.layout.objects.map(node => node.layoutLine), [0, 0, 1, 1]);
    assert(result.layout.pages.length === 2, "pb must split even a natural-height document");

    const playback = compilePlayback(result.lowering);
    const original = compilePlayback(lower(source.replace("@pb()", "@br()")));
    deepStrictEqual(playback.diagnostics, []);
    deepStrictEqual(playedNotes(playback), playedNotes(original));
    assert(playback.durationSeconds === original.durationSeconds, "pagination must preserve playback duration");

    for (const name of ["pagebreak", "pb"]) {
        const configured = compileValid(`@set(${name}.justify=false) 1 @pb() 2 @pagebreak(true) 3`);
        deepStrictEqual(configured.lowering.columns.flat().filter(node => node.addon?.pageBreakBefore !== undefined)
            .map(node => node.addon?.pageBreakBefore), [false, true]);
    }
    assert(compileValid(`1 @pb(false) 2`).lowering.columns.flat().some(node => node.addon?.pageBreakBefore === false),
        "the single boolean argument must also accept positional syntax");
    assert(compileValid("1 @pagebreak() 2").layout.pages.length === 2, "the full function name must work like its alias");
});

test("分页器强制封页精确复用原来的空间分配，false 保留最小行距", () => {
    const page = normalizePageConfig({ height: 100, marginTop: 10, marginBottom: 10, lineGap: 5 });
    for (const justify of [true, false]) {
        const result = paginateLayoutLines([10, 10, 10, 10], page, [undefined, undefined, justify]);
        deepStrictEqual(result.lineTops, [10, justify ? 52.5 : 25, 110, 125]);
        deepStrictEqual(result.pages.map(item => [item.lineStart, item.lineEnd]), [[0, 2], [2, 4]]);
    }

    const natural = { ...page, height: Infinity };
    for (const justify of [true, false]) {
        const result = paginateLayoutLines([10, 10, 10], natural, [undefined, undefined, justify]);
        deepStrictEqual(result.lineTops, [10, 25, 55]);
        deepStrictEqual(result.pages.map(item => item.bounds.h), [45, 30]);
    }

    const overflow = paginateLayoutLines([40, 40, 10], page, [undefined, false]);
    deepStrictEqual(overflow.pages.map(item => [item.lineStart, item.lineEnd]), [[0, 1], [1, 3]]);
    deepStrictEqual(overflow.lineTops, [10, 110, 155]);
});

test("pb 的 justify 开关控制当前页，末页仍保持自然行距", () => {
    for (const justify of [true, false]) {
        const { layout } = compileValid(`
@page(height=200px, top=10px, bottom=10px, gap=5px)
1 @br() 2 @pb(justify=${justify}) 3 @br() 4`);
        assert(layout.pages.length === 2, "the explicit boundary must close the underfilled first page");
        const [first, second, third, fourth] = layout.objects;
        const remaining = 180 - first.box.h - second.box.h - 5;
        assert(nearly(first.box.y, 10) && nearly(third.box.y, 210), "both pages must start at their top margin");
        assert(nearly(second.box.y - first.box.y - first.box.h, 5 + (justify ? remaining / 2 : 0)),
            "the explicit boundary must preserve the original justification formula");
        assert(nearly(fourth.box.y - third.box.y - third.box.h, 5), "the final page must remain unexpanded");
    }
});

test("pb 严格保留开头、连续和末尾的空白页", () => {
    const cases = [
        ["1 @pb() 2", 2],
        ["@pb() 1", 2],
        ["1 @pb()", 2],
        ["1 @pb() @pb() 2", 3],
        ["@pb()", 2],
        ["@pb() @pb()", 3],
    ] as const;
    for (const height of [-200, 0, 200]) {
        for (const [source, expected] of cases) {
            for (const justify of [true, false]) {
                const { layout } = compileValid(
                    `@page(height=${height}px, top=10px, bottom=10px, gap=5px) `
                    + source.replaceAll("@pb()", `@pb(justify=${justify})`),
                );
                assert(layout.pages.length === expected, `${source} must produce ${expected} pages`);
                for (const [index, page] of layout.pages.entries()) {
                    assert(Number.isFinite(page.bounds.h) && Number.isFinite(page.bounds.y), "page bounds must be finite");
                    if (index > 0) assert(nearly(page.bounds.y, layout.pages[index - 1].bounds.y + layout.pages[index - 1].bounds.h),
                        "page bounds must be stacked without gaps");
                    if (height > 0) assert(page.bounds.h === height, "even a blank finite page must keep its full height");
                    else if (!layout.objects.some(node => node.layoutLine >= page.lineStart && node.layoutLine < page.lineEnd)) {
                        assert(nearly(page.bounds.h, 20), "a blank natural page must contain margins only");
                    }
                }
            }
        }
    }
    assert(compileValid("1 @br()").layout.lineCount === 1, "ordinary trailing br must retain its existing behavior");
    assert(compileValid("1 @pb() @br()").layout.pages.length === 2, "a trailing br must not discard a page already opened by pb");
});

test("并行 pb 只换一次页，justify 按 false 优先且不受声部顺序影响", () => {
    for (const [left, right] of [[true, true], [true, false], [false, true], [false, false]]) {
        const { lowering, layout } = compileValid(`
@page(height=200px, top=10px, bottom=10px, gap=5px)
@stack({1 @br() 2 @pb(justify=${left}) 3}, {4 @br() 5 @pb(justify=${right}) 6})`);
        const controls = lowering.columns.filter(column => column.some(node => node.addon?.pageBreakBefore !== undefined));
        assert(controls.length === 1 && controls[0].length === 2, "simultaneous pb controls must merge into one column");
        assert(layout.pages.length === 2 && layout.lineCount === 3, "parallel pb must create a single document boundary");
        const lineTop = (line: number) => Math.min(...layout.objects.filter(node => node.layoutLine === line).map(node => node.box.y));
        const lineBottom = Math.max(...layout.objects.filter(node => node.layoutLine === 0).map(node => node.box.y + node.box.h));
        const gap = lineTop(1) - lineBottom;
        assert(left && right ? gap > 5 : nearly(gap, 5), "any explicit false must suppress justification");
    }
    assert(compileValid("@stack({1 @pb() 2 3}, {4 5 @pb() 6})").layout.pages.length === 3,
        "pb at different times must create separate page boundaries");
    assert(compileValid("@stack({1 @pb(false) 2}, {3 @br() 4})").layout.pages.length === 2,
        "a simultaneous br must not overwrite pb options");
});

test("同轨连续 pb 分别使用自己的 justify 参数", () => {
    const { layout } = compileValid(`
@page(height=200px, top=10px, bottom=10px, gap=5px)
1 @br() 2 @pb(false) 3 @br() 4 @pb() 5`);
    assert(layout.pages.length === 3, "sequential pb controls must each open a page");
    assert(nearly(layout.objects[1].box.y - layout.objects[0].box.y - layout.objects[0].box.h, 5),
        "the first explicit page must remain compact");
    assert(layout.objects[3].box.y - layout.objects[2].box.y - layout.objects[2].box.h > 5,
        "the second explicit page must use its own default justification");
});

test("分页信号不依赖具体函数名", () => {
    const lowered = lower("1 @br()");
    const control = lowered.columns.flat().find(node => (node.addon?.breakBefore ?? 0) > 0);
    assert(control, "the sample must include an ordinary br control");
    control.addon = { ...control.addon, pageBreakBefore: false };
    const layout = layoutDocument(lowered, layoutContext);
    assert(layout.pages.length === 2 && layout.lineCount === 2, "a generic signal must retain even the final blank page");
});

test("复合节点只下放函数 addon，分页声明在重复布局后仍留在全局事件上", () => {
    for (const composite of [
        "@up(2/, 3)",
        "@grace(2/, {3 4})",
        "@arp({2/ ^ 3})",
        "@grace(@arp({2/ ^ 3}), {4 5})",
        "@arp({@grace(2/, {3 4}) ^ 5})",
    ]) {
        for (const justify of [true, false]) {
            const lowered = lower(`@page(height=200px) 1 @br() @div(${composite}, 1) @pb() 4`);
            const host = lowered.columns.flat().find(node => isVisualTemporalNode(node) && node.layoutLine === 1)!;
            const divisions = host.addon?.["@div"];
            assert(typeof divisions === "number" && divisions > 0, "the composite must initially carry rhythm semantics");
            host.addon = { ...host.addon, breakBefore: 1, pageBreakBefore: justify };
            let handled = 0;
            host.addon["@test"] = { value: 1 };
            const context = {
                ...layoutContext,
                decorationHandlers: new Map(layoutContext.decorationHandlers).set("@test", (_host, value) => {
                    deepStrictEqual(value, { value: 1 });
                    handled++;
                    return null;
                }),
            };
            const first = layoutDocument(lowered, context);
            assert(first.pages.length === 3, "the boundary on the composite must open its own page");
            const pages = first.pages.map(page => ({ ...page.bounds }));
            const commands = recordCommands(first);
            for (let pass = 0; pass < 3; pass++) {
                deepStrictEqual(host.addon, { breakBefore: 1, pageBreakBefore: justify },
                    "forwarding decorations must retain only the boundary declarations on the global event");
                const again = layoutDocument(lowered, context);
                deepStrictEqual(again.pages.map(page => page.bounds), pages);
                deepStrictEqual(recordCommands(again), commands, "forwarded rhythm decorations must remain stable");
            }
            assert(handled === 4, "private function semantics must be forwarded and handled once per layout");
        }
    }
});

test("函数 addon 转交保留核心声明与目标语义，不重建核心对象", () => {
    const source = new TemporalNodeBase();
    const target = new TemporalNodeBase();
    source.addon = { breakBefore: 1, pageBreakBefore: false, "@div": 2 };
    target.addon = { breakBefore: 2, "@dot": 1, "@div": 1 };
    const core = source.addon;
    transferFunctionAddons(source, target);
    assert(source.addon === core, "transferring private semantics must retain the original core object");
    deepStrictEqual(source.addon, { breakBefore: 1, pageBreakBefore: false });
    deepStrictEqual(target.addon, { breakBefore: 2, "@dot": 1, "@div": 2 });
    const destination = target.addon;
    transferFunctionAddons(source, target);
    assert(source.addon === core && target.addon === destination, "a core-only transfer must not allocate new addons");
    source.addon = { "@dot": 3 };
    transferFunctionAddons(source, target);
    assert(source.addon === undefined, "an emptied source must release its addon");
    deepStrictEqual(target.addon, { breakBefore: 2, "@dot": 3, "@div": 2 });
});

test("仅注册 pagebreak 时仍校验跨持续事件，共享校验器每轮只执行一次", () => {
    const functions = defaultFunctions.filter(node => node !== BrNode);
    for (const name of ["pagebreak", "pb"]) {
        expectDiagnostic(() => compileScore(`@stack({1.}, {2 @${name}() 3})`, { functions }), "E_BREAK_INSIDE_EVENT");
        assert(compileValid(`1 @${name}() 2`, { functions }).layout.pages.length === 2,
            "pagebreak must work independently of br registration");
    }
    assert(BrNode.loweringFinalize && BrNode.loweringFinalize === PageBreakNode.loweringFinalize,
        "line and page breaks must share the same validator");
    let calls = 0;
    const finalize = BrNode.loweringFinalize;
    const shared = (result: Parameters<typeof finalize>[0]) => {
        calls++;
        finalize(result);
    };
    const context = createLowering();
    context.registerFunctions([BrNode, PageBreakNode].map(node => Object.assign(
        class extends node {}, { loweringFinalize: shared },
    )));
    context.lowerDocument(parse("1 @pb() 2"));
    deepStrictEqual(calls, 1, "the shared finalizer must run once, not once per function");
    context.lowerDocument(parse("1 @br() 2"));
    deepStrictEqual(calls, 2, "the validator must run again for a fresh lowering");
});

test("折叠前校验可见成员的 addon 换行声明，不因清空 addon 而吞掉边界", () => {
    for (const source of ["@up(1, 3)", "@down(1, 3)", "@grace(1, {3})"]) {
        for (const justify of [undefined, true, false]) {
            const ast = parse(source);
            const composite = ast.children[0];
            const content = composite.children?.[1];
            assert(content, "the sample must have a folded member or grace content");
            const grace = source.startsWith("@grace");
            const member = grace ? content.children?.[0] : content;
            assert(member, "the sample must include a visible member");
            const enter = member.loweringEnter.bind(member);
            member.loweringEnter = (...args) => {
                const events = [...enter(...args)];
                events[0].addon = { breakBefore: 1, pageBreakBefore: justify };
                return events;
            };
            expectDiagnostic(() => createLowering().lowerDocument(ast),
                grace ? "E_GRACE_INVALID_CONTENT" : "E_UP_INVALID_CHILD");
        }
    }
});

test("附件扩张行高后的第二轮分页仍遵守 pb 及其 justify 参数", () => {
    for (const justify of [true, false]) {
        const lowered = lower(`@page(height=200px, top=10px, bottom=10px, gap=5px) 1 @br() 2 @pb(${justify}) 3`);
        const host = lowered.columns.flat().find(isVisualTemporalNode)!;
        let measurements = 0;
        const attachment: LayoutAttachment = {
            layer: "foreground",
            createGeometry() {
                measurements++;
                return {
                    regions: [{ x: host.box.x, y: host.box.y, w: host.box.w, h: 60, line: host.layoutLine, track: host.track }],
                    paint() {},
                };
            },
        };
        lowered.attachments.push(attachment);
        const layout = layoutDocument(lowered, layoutContext);
        assert(measurements === 2, "the attachment must actually trigger a second vertical pass");
        assert(layout.pages.length === 2, "relayout must retain the explicit boundary");
        const [first, second, third] = layout.objects;
        const remaining = 180 - 60 - second.box.h - 5;
        assert(nearly(second.box.y - first.box.y - 60, 5 + (justify ? remaining / 2 : 0)),
            "final justification must use the measured attachment height");
        assert(nearly(third.box.y, 210), "the content after pb must stay on the new page");
    }
});

test("页码与分页面绘制包含 pb 产生的空白页和歌词", () => {
    const { layout } = compileValid(`
@page(height=200px, top=10px, bottom=20px, numbering="1 / 1")
@pb() N: 1 @pb(false) 2 @pb()
L: 甲乙`);
    assert(layout.pages.length === 4, "leading and trailing blank pages must be counted");
    const painters = layout.pages.map(() => new RecordingPainter());
    paintLayoutPages(layout, painters);
    for (const [index, painter] of painters.entries()) {
        const texts = painter.commands.filter(command => command.kind === "text").map(command => command.text);
        assert(texts.includes(`${index + 1} / 4`), "each page must receive its own updated number");
        assert(texts.includes("甲") === (index === 1) && texts.includes("乙") === (index === 2),
            "lyrics must follow their notes across the explicit boundary");
    }
});

test("pb 沿用跨持续事件、刚性复合体和单行溢出的校验", () => {
    expectLoweringError("@stack({1.}, {2 @pb() 3})", "E_BREAK_INSIDE_EVENT");
    expectLoweringError("@up({1 @pb() 2}, 3)", "E_UP_INVALID_CHILD");
    expectLoweringError("@grace(3, {1 @pb() 2})", "E_GRACE_INVALID_CONTENT");
    expectLoweringError("@head(center={@pb()})", "E_HEAD_INTERNAL_BREAK");
    expectLayoutError("@page(height=40px, top=10px, bottom=10px) @pb() 1", "E_PAGE_OVERFLOW");
    assert(compileValid("{1 @pb(false) 2}").layout.pages.length === 2, "ordinary content blocks must support pb");
    const invalid = compileScore("1 @pb(justify=invalid) 2");
    assert(invalid.diagnostics.some(item => item.code === "W_INVALID_BOOL"), "invalid justify must be diagnosed");
    const extra = compileScore("1 @pb(true, false) 2");
    assert(extra.diagnostics.some(item => item.code === "W_TOO_MANY_POS_ARGS"), "extra arguments must be diagnosed");
});
