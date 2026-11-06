import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";

import { layoutPageBounds, paintLayout, paintLayoutPages } from "../src/render/paint.js";
import { RecordingPainter, type RecordedPaintCommand } from "../src/render/recording.js";
import { renderLayoutPagesToSvg, SvgPainter } from "../src/render/svg.js";
import { assert, compileValid } from "./helpers.js";

type SvgGroup = { kind: string; children: SvgNode[] };
type SvgLeaf = { tag: string; text?: string };
type SvgNode = SvgGroup | SvgLeaf;

const SVG_TOKEN = /<g data-kind="([^"]*)">|<\/g>|<(text|line|rect|circle|path)\b[^>]*?(?:\/>|>([^<]*)<\/text>)/g;

/** 只识别 SvgPainter 会输出的元素，顺带检查 <g> 开闭平衡 */
function groupTree(svg: string): SvgGroup {
    const root: SvgGroup = { kind: "", children: [] };
    const stack = [root];
    for (const match of svg.matchAll(SVG_TOKEN)) {
        const top = stack[stack.length - 1];
        if (match[0] === "</g>") {
            assert(stack.length > 1, `多余的 </g>: ${svg}`);
            stack.pop();
        } else if (match[1] !== undefined) {
            const group: SvgGroup = { kind: match[1], children: [] };
            top.children.push(group);
            stack.push(group);
        } else {
            top.children.push({ tag: match[2], text: match[3] });
        }
    }
    strictEqual(stack.length, 1, `存在未闭合的 <g>: ${svg}`);
    return root;
}

/** 组写成 kind(...)，文本写成 text:内容，其余图元只写标签名 */
function shape(node: SvgNode): string {
    if ("tag" in node) return node.text === undefined ? node.tag : `text:${node.text}`;
    return `${node.kind}(${node.children.map(shape).join(" ")})`;
}

function pageShapes(svgs: readonly string[]) {
    return svgs.map(svg => groupTree(svg).children.map(shape).join(" "));
}

function svgShapes(source: string) {
    return pageShapes(renderLayoutPagesToSvg(compileValid(source).layout));
}

/** 每页顶层组的 kind，用于不关心组内图元细节的用例 */
function topKinds(source: string) {
    return renderLayoutPagesToSvg(compileValid(source).layout).map(svg =>
        groupTree(svg).children.map(node => "kind" in node ? node.kind : node.tag));
}

/** 录制命令的紧凑形式：开组写成 <kind>，闭组写成 </>，图元只写命令种类 */
function commandShape(commands: readonly RecordedPaintCommand[]) {
    return commands.map(command => {
        if (command.kind === "begin-group") return `<${command.group.kind}>`;
        if (command.kind === "end-group") return "</>";
        return command.kind;
    }).join(" ");
}

function recordPages(source: string) {
    const { layout } = compileValid(source);
    const recordings = layoutPageBounds(layout).map(() => new RecordingPainter());
    paintLayoutPages(layout, recordings);
    return { layout, recordings };
}

const PAGED = "@page(width=200px, height=70px, top=10px, bottom=10px, left=20px, right=20px, gap=5px)";

test("时值对象的 kind 默认取函数主名，糖语法与别名不影响", () => {
    const kinds = (source: string) => compileValid(source).layout.objects.map(node => node.kind);
    deepStrictEqual(kinds("@meter(2,4) 1 2 | @rest(1) | @text(A)"), ["meter", "note", "note", "bar", "rest", "bar", "text"]);
    deepStrictEqual(kinds("1 ^ 3"), ["up"]);
    deepStrictEqual(kinds("2>1 1<2"), ["grace", "grace"]);
    deepStrictEqual(kinds("@arpeggio({1 ^ 3})"), ["arp"]);
});

test("容器组包含成员的组", () => {
    deepStrictEqual(svgShapes("@up(1, 3)"), ["up(note(text:1) note(text:3))"]);
    deepStrictEqual(svgShapes("1 ^ 3"), ["up(note(text:1) note(text:3))"]);
    // grace 组里依次是宿主、倚音和钩线
    deepStrictEqual(svgShapes("2>1"), ["grace(note(text:1) note(text:2 line) path)"]);
    deepStrictEqual(svgShapes("1<2"), ["grace(note(text:1) note(text:2 line) path)"]);
    deepStrictEqual(svgShapes("@grace({1^3},4)/ 2/"), [
        "grace(up(note(text:1) note(text:3)) note(text:4 line) path) note(text:2) beam(line)",
    ]);
    // arp 组里是波浪线和宿主
    deepStrictEqual(svgShapes("@arp({1 ^ 3 ^ 5})"), [
        "arp(path up(note(text:1) note(text:3) note(text:5)))",
    ]);
});

test("装饰画在所属对象的组内，相连的减时线画在 beam 组内", () => {
    deepStrictEqual(svgShapes("#2'./"), ["note(path text:2 circle circle line)"]);
    deepStrictEqual(svgShapes("1'. 2/"), ["note(text:1 circle circle) note(text:2 line)"]);
    deepStrictEqual(svgShapes("1/ 2/"), ["note(text:1) note(text:2) beam(line)"]);
});

test("每个 attachment 各成一组，kind 由实现声明", () => {
    const tie = "note(text:1) note(text:2) tie(path)";
    const cases: [source: string, shape: string][] = [
        ["1@a 2@b @tie(a,b)", tie],
        ["@set(div.autobeam=false) 1/@a 2/@b @beam(a,b)", "note(text:1) note(text:2) beam(line)"],
        // 倚音 beam 与自动 beam 各自成组
        ["{2/ 3/}>1/ 4/", "grace(note(text:1) note(text:2) note(text:3) path) note(text:4) beam(line line) beam(line)"],
        ["@voice({1 2}, , \"甲 乙\")", "note(text:1) note(text:2) lyrics(text:甲 text:乙)"],
        // @adjust 包装后 kind 不变
        ["1@x 2@y @adjust(@tie(x,y), dy=-6px)", tie],
        ["@adjust({1@a 2@b @tie(a,b)}, dx=5px)", tie],
    ];
    for (const [source, shape] of cases) deepStrictEqual(svgShapes(source), [shape], source);
});

test("其余 attachment 的组 kind", () => {
    const cases: [source: string, kinds: string[]][] = [
        ["@box({1 2}, 2px, 1px) @text(A)", ["box", "note", "note", "text"]],
        ["1@a 2 3@b @dyn(a,b,20)", ["note", "note", "note", "dyn"]],
        ["1@a 5@b @gliss(a,b)", ["note", "note", "gliss"]],
        ["1@a 2@b @ottava(a,b)", ["note", "note", "ottava"]],
        ["@slide(1)", ["note", "slide"]],
        ["@tremolo(1)", ["note", "tremolo"]],
        ["@tuplet({1 2 3}, 2)", ["note", "note", "note", "tuplet"]],
        ["1@a 2@b :| @volta(a,b,1)", ["note", "note", "bar", "volta"]],
    ];
    for (const [source, kinds] of cases) deepStrictEqual(topKinds(source), [kinds], source);
});

test("多声部的歌词每个声部一组，小节号全文一组", () => {
    const voices = topKinds(`@voices(@voice({1 2}, A, "你 好"), @voice({3 4}, B, "啊 呀"))`)[0];
    strictEqual(voices[0], "voices");
    strictEqual(voices.filter(kind => kind === "lyrics").length, 2);
    strictEqual(voices.filter(kind => kind === "voice").length, 2);

    const [page] = svgShapes("@page(barNumbering=\"1\")\n@meter(2,4) 1 2 | 3 4 |\n\n@rest(3) |\n\n5 6 |");
    assert(page.endsWith(" bar-number(text:3 text:6)"), page);
    strictEqual(page.split("bar-number(").length, 2, page);
});

test("跨页对象在每页各输出一个组", () => {
    deepStrictEqual(svgShapes(`${PAGED}\n1@a @br() 2 @br() 3 @br() 4@b @tie(a,b)`), [
        "note(text:1) tie(path)",
        "note(text:2) tie(path)",
        "note(text:3) tie(path)",
        "note(text:4) tie(path)",
    ]);

    const numbered = "@page(width=200px, height=90px, top=10px, bottom=20px, left=20px, right=20px, gap=5px, numbering=\"1 / 1\")\n"
        + "1 @br() 2 @br() 3 @br() 4 @br() 5 @br() 6";
    deepStrictEqual(svgShapes(numbered), [
        "note(text:1) note(text:2) page-number(text:1 / 3)",
        "note(text:3) note(text:4) page-number(text:2 / 3)",
        "note(text:5) note(text:6) page-number(text:3 / 3)",
    ]);
});

test("分页时只在有图元的页开组", () => {
    // 占位音符 8 不画任何东西，第二页只有连音线的一段
    const { recordings } = recordPages(`${PAGED}\n1@a 8 @br() 8 @br() 3@b @tie(a,b)`);
    deepStrictEqual(recordings.map(recording => commandShape(recording.commands)), [
        "<note> text </> <tie> path </>",
        "<tie> path </>",
        "<note> text </> <tie> path </>",
    ]);
});

test("直接绘制时不画东西的对象留下空组，SvgPainter 会删掉它", () => {
    const { layout } = compileValid("1 8 2");
    const recording = new RecordingPainter();
    paintLayout(layout, recording);
    strictEqual(commandShape(recording.commands), "<note> text </> <note> </> <note> text </>");

    const painter = new SvgPainter();
    paintLayout(layout, painter);
    deepStrictEqual(pageShapes([painter.toSvg(layout.bounds)]), ["note(text:1) note(text:2)"]);
});

test("SvgPainter 递归删除空组、忽略多余的 endGroup 并转义 kind", () => {
    const painter = new SvgPainter();
    painter.beginGroup({ kind: "outer" });
    painter.beginGroup({ kind: "inner" });
    painter.endGroup();
    painter.endGroup();
    painter.beginGroup({ kind: "kept" });
    painter.beginGroup({ kind: "empty" });
    painter.endGroup();
    painter.beginGroup({ kind: "a\"<b" });
    painter.drawLine(0, 0, 1, 1);
    painter.endGroup();
    painter.endGroup();
    painter.endGroup();
    const svg = painter.toSvg({ x: 0, y: 0, w: 10, h: 10 });
    deepStrictEqual(groupTree(svg).children.map(shape), ["kept(a&quot;&lt;b(line))"]);
    assert(svg.includes("<g data-kind=\"a&quot;&lt;b\">"), svg);
});

test("分页录制后回放与直接导出 SVG 一致", () => {
    const source = "@page(width=200px, height=90px, top=10px, bottom=20px, left=20px, right=20px, gap=5px, numbering=\"1 / 1\")\n"
        + "{2/ 3/}>1/ 4/ @arp({1 ^ 3 ^ 5}) @br() #2'./ 1@a 8 @br() @voice({1 2}, , \"甲 乙\") @br() 5@b @tie(a,b)";
    const { layout, recordings } = recordPages(source);
    const bounds = layoutPageBounds(layout);
    const expected = renderLayoutPagesToSvg(layout);
    const replayed = recordings.map((recording, index) => {
        const painter = new SvgPainter();
        recording.replay(painter);
        return painter.toSvg(bounds[index]);
    });
    deepStrictEqual(replayed, expected);
    strictEqual(expected.length, 4);
    for (const svg of expected) assert(svg.includes("<g data-kind=\"page-number\">"), svg);
});
