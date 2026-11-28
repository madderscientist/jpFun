import { test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";

import { layoutDocument } from "../src/layout/engine.js";
import { DEFAULT_PAGE_CONFIG, normalizePageConfig, paginateLayoutLines } from "../src/layout/page.js";
import { isVisualTemporalNode } from "../src/functions/temporal.js";
import { compileScore } from "../src/pipeline.js";
import { compilePlayback } from "../src/playback/compile.js";
import { paintLayoutPages } from "../src/render/paint.js";
import { RecordingPainter } from "../src/render/recording.js";
import {
    assert,
    attachmentCommands,
    compileValid,
    expectCompileError,
    expectLayoutError,
    expectLoweringError,
    layoutContext,
    layoutOf,
    lower,
    nearly,
    playedNotes,
} from "./helpers.js";

test("br 在 lowering 阶段就固化行号，并把文档切成两个系统", () => {
    const lowered = lower(`1 2 @br() 3 4`);
    const nodes = lowered.columns.flat();
    deepStrictEqual(nodes.filter(isVisualTemporalNode).map(node => node.layoutLine), [0, 0, 1, 1]);
    assert(nodes.find(node => !isVisualTemporalNode(node))?.layoutLine === 1,
        "br must receive the new line number of its own merged column");

    const { lineCount, objects } = layoutDocument(lowered, layoutContext);
    assert(lineCount === 2, "br must split the document into two layout systems");
    deepStrictEqual(objects.map(node => node.layoutLine), [0, 0, 1, 1]);
    assert(nearly(objects[0].box.x, objects[2].box.x), "each system must restart horizontal layout at the same origin");
    assert(objects[2].box.y > objects[0].box.y + objects[0].box.h, "the second system must be below the first system");
});

test("br 只换一行，行距由 gap 单处覆盖、@set 设置后续默认", () => {
    assert(layoutOf(`1 @br(2) 2`).lineCount === 2, "a positional br argument is a gap, not a line offset");
    const { objects } = layoutOf(`@set(br.gap=5px) 1 @br() 2 @br(20px) 3 @set(br.gap=12px) @br() 4 @br(-3px) 5`);
    deepStrictEqual(objects.slice(1).map((node, i) => Math.round(node.box.y - objects[i].box.y - objects[i].box.h)), [5, 20, 12, -3],
        "gap must override one break, @set must change later defaults, and negative gaps overlap lines");

    const lineTwoY = (source: string) => layoutOf(source).objects.find(node => node.layoutLine === 1)!.box.y;
    assert(nearly(lineTwoY(`@stack({1 @br(gap=8px) 2}, {3 @br(gap=15px) 4})`), lineTwoY(`@stack({1 @br(gap=15px) 2}, {3 @br(gap=15px) 4})`)),
        "simultaneous breaks must use the larger gap");

    const em = lower(`@set(fontsize=30) @set(br.gap=1em, br.minGap=0.5em) 1 @br() 2`).columns.flat()
        .find(node => node.addon?.breakBefore)?.addon?.breakBefore;
    deepStrictEqual(em, { gap: 30, minGap: 15 }, "em must resolve with the font size at the br call");
});

test("并行轨的同时刻 br 归并成一列，只换一次行；跨越换行点的持续事件报错", () => {
    const lowered = lower(`@stack({1 @br() 2}, {3 @br() 4})`);
    assert(lowered.columns.filter(column => column.some(node => node.addon?.breakBefore)).length === 1,
        "simultaneous parallel br controls must merge into one column");
    const parallel = layoutDocument(lowered, layoutContext);
    assert(parallel.lineCount === 2, "simultaneous br controls on different tracks must break the score only once");
    deepStrictEqual(parallel.objects.map(node => node.layoutLine), [0, 0, 1, 1]);

    assert(layoutOf(`1 @br() @br() 2`).lineCount === 3, "two br controls on one track must accumulate into two line offsets");

    // 只有一轨写了 br 时，同一合并列里的另一轨事件也要换到新行
    const afterBreak = lower(`@stack({1 @br() 2}, {3 4})`).columns.flat()
        .filter(node => isVisualTemporalNode(node) && node.t.equals(1));
    deepStrictEqual(afterBreak.map(node => node.layoutLine), [1, 1]);

    expectLoweringError(`@stack({1.},{2 @br() 3})`, "E_BREAK_INSIDE_EVENT");
});

test("默认页面与配置归一化", () => {
    const [defaultPage, ...rest] = layoutOf("1").pages;
    assert(rest.length === 0 && defaultPage.bounds.w === 794 && defaultPage.bounds.h < Infinity,
        "default layout must create one A4-wide page with a natural finite height");

    const partial = normalizePageConfig({ width: 320, marginTop: -5 });
    deepStrictEqual([partial.width, partial.marginTop, partial.marginBottom, partial.fillRatio],
        [320, 0, DEFAULT_PAGE_CONFIG.marginBottom, 0.5]);
    for (const height of [0, -1]) {
        assert(normalizePageConfig({ height }).height === Infinity,
            "page normalization must treat non-positive heights as Infinity");
    }

    for (const fillRatio of [0.75, -1, 2]) {
        assert(compileScore(`@page(fillRatio=${fillRatio}) 1`).lowering.page?.fillRatio === fillRatio,
            "page declarations must solidify any finite fillRatio, including values outside [0, 1]");
    }
    const infiniteFill = compileScore(`@page(fillRatio=Infinity) 1`);
    assert(infiniteFill.lowering.page?.fillRatio === DEFAULT_PAGE_CONFIG.fillRatio
        && infiniteFill.diagnostics.some(item => item.code === "W_INVALID_NUMBER"),
        "page declarations must diagnose non-finite numbers and use the default");
});

test("非法页面参数指向它的声明，非正高度固化为无限", () => {
    const invalidPageSource = `@page(width=-1px, top=5px) 1 @br() 2`;
    const invalidPageDiagnostic = expectCompileError(invalidPageSource, "E_INVALID_PAGE_CONFIG");
    assert(invalidPageSource.slice(invalidPageDiagnostic.span.start, invalidPageDiagnostic.span.end)
        === "@page(width=-1px, top=5px)", "an invalid page diagnostic must point to the page declaration");

    for (const source of [
        `@page(top=-1px) 1`,
        `@page(bottom=15px, numbering="1") 1`,
    ]) {
        expectCompileError(source, "E_INVALID_PAGE_CONFIG");
    }

    const naturalPages = compileValid(`@set(br.gap=5px) 1 @br() 2`).layout.pages;
    for (const height of ["0px", "-1px", "-1em"]) {
        const result = compileValid(`@page(height=${height}) @set(br.gap=5px) 1 @br() 2`);
        assert(result.lowering.page?.height === Infinity, "a non-positive page height must solidify as Infinity");
        deepStrictEqual(result.layout.pages, naturalPages, "a non-positive page height must use natural-height layout");
    }
});

test("有限高度的页面把系统分页并分配行间距", () => {
    const paged = layoutOf(`
@page(width=200px, height=80px, top=10px, bottom=10px, left=20px, right=20px) @set(br.gap=5px)
1 @br() 2 @br() 3 @br() 4
`);
    deepStrictEqual(paged.pages.map(page => [page.lineStart, page.lineEnd]), [[0, 2], [2, 4]]);
    assert(paged.pages[0].bounds.h === 80 && paged.pages[1].bounds.y === 80, "finite pages must keep exact stacked paper bounds");
    assert(paged.bounds.w === 200 && paged.bounds.h === 160, "document bounds must include both complete pages");

    const [pageLine0, pageLine1, pageLine2, pageLine3] = paged.objects;
    const fullPageGap = pageLine1.box.y - pageLine0.box.y - pageLine0.box.h;
    const lastPageGap = pageLine3.box.y - pageLine2.box.y - pageLine2.box.h;
    const share = (80 - 10 - 10 - pageLine0.box.h - pageLine1.box.h - 5) / 2;
    const fullPageBottom = 80 - 10 - pageLine1.box.y - pageLine1.box.h;
    assert(nearly(pageLine0.box.y, 10), "a closed full page must keep its first system at the top margin");
    assert(nearly(fullPageGap, 5 + share), "a closed full page must add one share below each non-final system");
    assert(nearly(fullPageBottom, share), "a closed full page must leave the final system's share at the bottom");
    assert(nearly(lastPageGap, 5), "the final page must retain the configured minimum system gap");

    const singlePerPage = layoutOf(`
@page(width=200px, height=50px, top=10px, bottom=10px, left=20px, right=20px) @set(br.gap=5px)
1 @br() 2
`);
    assert(singlePerPage.pages.length === 2, "the sample must place one system on each page");
    assert(nearly(singlePerPage.objects[0].box.y, 10),
        "a closed page with one system must keep it at the top instead of centering it");
});

test("重复与嵌套的 page 声明只报警并保留第一份", () => {
    for (const [source, code, width] of [
        ["@page(width=200px) @page(width=-1px) 1", "W_DUPLICATE_PAGE", 200],
        ["{@page(width=-1px) 1}", "W_PAGE_NOT_TOP_LEVEL", 794],
    ] as const) {
        const { diagnostics, layout } = compileScore(source);
        assert(diagnostics.some(item => item.code === code), source);
        assert(layout.pages[0].bounds.w === width, "only the first top-level page declaration may take effect");
    }
});

test("放不下的内容和无效的版心各自报错", () => {
    const pageOverflow = expectLayoutError(
        `@page(width=200px, height=36px, top=10px, bottom=10px, left=10px, right=10px) 1`,
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
        const { layout } = compileValid(`
@page(width=200px, height=90px, top=10px, bottom=20px,
    left=20px, right=20px, numbering="${pattern}") @set(br.gap=5px)
1 @br() 2 @br() 3 @br() 4 @br() 5 @br() 6
`);
        deepStrictEqual(attachmentCommands(layout.attachments[0])
            .filter(command => command.kind === "text")
            .map(command => command.text), [...expected], pattern);
    }
});

test("页码是 @page 自己注册的 attachment，逐页浮在下边距带内", () => {
    const paged = layoutOf(`
@page(width=200px, height=90px, top=10px, bottom=20px, left=20px, right=20px, numbering="1 / 1") @set(br.gap=5px)
1 @br() 2 @br() 3 @br() 4 @br() 5 @br() 6
`);
    assert(paged.attachments.length === 1, "numbering must contribute exactly one attachment");
    const [numbering] = paged.attachments;
    const numbers = attachmentCommands(numbering).filter(command => command.kind === "text");
    deepStrictEqual(numbers.map(command => command.text), ["1 / 3", "2 / 3", "3 / 3"]);
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

test("page.barNumbering 从第二行起在行首显示小节号，默认隐藏，支持模板", () => {
    for (const [setting, expected] of [
        ["", []],
        ['@page(barNumbering="")', []],
        ['@page(barNumbering="1")', ["3", "6"]],
        ['@page(barNumbering="(1)")', ["(3)", "(6)"]],
    ] as const) {
        const layout = layoutOf([
            setting,
            "@meter(2,4) 1 2 | 3 4 |",
            "",
            "@rest(3) |",
            "",
            "5 6 |",
        ].join("\n"));
        const texts = layout.attachments.flatMap(att => attachmentCommands(att)).filter(cmd => cmd.kind === "text");
        deepStrictEqual(texts.map(cmd => cmd.text), [...expected]);
    }

    // 单行曲谱即使开启 barNumbering 也不生成小节号附件
    assert(layoutOf('@page(barNumbering="(1)") 1 2 | 3 4 |').attachments.length === 0,
        "single-line score must not emit bar numbers");

    // 单声部行首无连谱号时，小节号错开在首个音符左上方且未闭合小节跨行不重复标号
    const singleLayout = layoutOf('@page(barNumbering="(1)")\nN: 1 2 4 5 | 1 2 3 4 |\n\nN: 1 2 4 5 | 1 2 3 4\n\nN: 1 2 4 5 | 1 2 3 4');
    const singleTexts = singleLayout.attachments.flatMap(att => attachmentCommands(att)).filter(cmd => cmd.kind === "text");
    deepStrictEqual(singleTexts.map(cmd => cmd.text), ["(3)"]);
    const secondLineNote = singleLayout.objects.find(obj => obj.layoutLine === 1 && !obj.T.isZero())!;
    assert(singleTexts[0].x < secondLineNote.box.x && singleTexts[0].y < secondLineNote.box.y,
        "single-voice bar numbers must sit to the upper-left of the line");

    // 行首零时值文字不影响小节号的字号与高度
    const barNumberOf = (line: string) => attachmentCommands(
        layoutOf(`@page(barNumbering="1")\n1 2 | 3 4 |\n\n${line} | 5 6 |`).attachments[0],
    ).find(cmd => cmd.kind === "text")!;
    const plain = barNumberOf("123");
    const withText = barNumberOf('"(" 123")"');
    assert(plain.kind === "text" && withText.kind === "text", "bar numbers must be text commands");
    deepStrictEqual([withText.text, withText.style.fontSize, withText.y], [plain.text, plain.style.fontSize, plain.y]);

    // 多声部行首锚定在连谱号正上方居中
    const mvLayout = layoutOf([
        '@page(barNumbering="(1)")',
        "N: 1 2 | 3 4 |",
        "N: 5 6 | 1 2 |",
        "",
        "N: 2 3 | 4 5 |",
        "N: 6 7 | 1 2 |",
    ].join("\n"));
    const mvAttachment = mvLayout.attachments.find(att => att.layer === "foreground" && att.regions.length === 1)!;
    const mvTexts = attachmentCommands(mvAttachment).filter(cmd => cmd.kind === "text");
    deepStrictEqual(mvTexts.map(cmd => cmd.text), ["(3)"]);
    const topName = mvLayout.objects.find(obj => obj.layoutLine === 1 && obj.mergeKey === -2)!;
    const topNote = mvLayout.objects.find(obj => obj.layoutLine === 1 && obj.T.compare(0) > 0)!;
    assert(mvAttachment.regions.every(region => region.track === topNote.track),
        "multi-voice bar numbers must only claim the topmost track");
    assert(mvTexts[0].x < topNote.box.x && mvTexts[0].x > topName.box.x + topName.box.anchor,
        "multi-voice bar numbers must sit directly above the system connector (连谱号)");
});

test("pb 自动换行换页，不绘制内容也不改变播放时间", () => {
    const source = `1 2 @pb() 3 4`;
    const result = compileValid(source);
    const control = result.lowering.columns.flat().find(node => node.addon?.pageBreakBefore !== undefined);
    assert(control && !isVisualTemporalNode(control) && control.T.isZero(), "pb must be an invisible zero-duration control");
    assert(control.addon?.breakBefore && control.layoutLine === 1, "pb must use the existing line break");
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
    const page = normalizePageConfig({ height: 100, marginTop: 10, marginBottom: 10 });
    const gaps = [5, 5, 5, 5];
    for (const justify of [true, false]) {
        const result = paginateLayoutLines([10, 10, 10, 10], page, [undefined, undefined, justify], gaps);
        deepStrictEqual(result.lineTops, [10, justify ? 52.5 : 25, 110, 125]);
        deepStrictEqual(result.pages.map(item => [item.lineStart, item.lineEnd]), [[0, 2], [2, 4]]);
    }

    const natural = { ...page, height: Infinity };
    for (const justify of [true, false]) {
        const result = paginateLayoutLines([10, 10, 10], natural, [undefined, undefined, justify], gaps);
        deepStrictEqual(result.lineTops, [10, 25, 55]);
        deepStrictEqual(result.pages.map(item => item.bounds.h), [45, 30]);
    }

    const overflow = paginateLayoutLines([40, 40, 10], page, [undefined, false], gaps);
    deepStrictEqual(overflow.pages.map(item => [item.lineStart, item.lineEnd]), [[0, 1], [1, 3]]);
    deepStrictEqual(overflow.lineTops, [10, 110, 155]);
});

test("pb 的 justify 开关控制当前页，末页仍保持自然行距", () => {
    for (const justify of [true, false]) {
        const { layout } = compileValid(`
@page(height=200px, top=10px, bottom=10px) @set(br.gap=5px)
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

test("pb 严格保留空白页、并行归并，并包含在分页绘制中", () => {
    for (const [source, expected] of [
        ["1 @pb() 2", 2],
        ["@pb() 1", 2],
        ["1 @pb()", 2],
        ["1 @pb() @pb() 2", 3],
        // 同时刻的 pb 归并为一次换页，不同时刻的各自换页
        ["@stack({1 @pb() 2}, {3 @pb(false) 4})", 2],
        ["@stack({1 @pb() 2 3}, {4 5 @pb() 6})", 3],
    ] as const) {
        const { layout } = compileValid(`@page(height=200px, top=10px, bottom=10px) @set(br.gap=5px) ${source}`);
        assert(layout.pages.length === expected, `${source} must produce ${expected} pages`);
    }

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
    expectLayoutError("@page(height=36px, top=10px, bottom=10px) @pb() 1", "E_PAGE_OVERFLOW");
    assert(compileValid("{1 @pb(false) 2}").layout.pages.length === 2, "ordinary content blocks must support pb");
    for (const [source, code] of [["1 @pb(justify=invalid) 2", "W_INVALID_BOOL"], ["1 @pb(true, false) 2", "W_TOO_MANY_POS_ARGS"]]) {
        assert(compileScore(source).diagnostics.some(item => item.code === code), source);
    }
});
