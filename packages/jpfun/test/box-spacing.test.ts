import { test } from "node:test";
import { deepStrictEqual, throws } from "node:assert/strict";
import { isVisualTemporalNode } from "../src/functions/temporal.js";
import { layoutDocument } from "../src/layout/engine.js";
import type { LayoutAttachment } from "../src/layout/types.js";
import { assert, compileValid, expectLayoutError, layoutContext, lower, nearly } from "./helpers.js";

function frames(source: string) {
    return compileValid(source).layout.attachments.filter(item => item.layer === "background");
}

test("box 的上下留白在 up 和 down 内参与成员间距", () => {
    for (const side of ["up", "down"]) {
        for (const content of [
            "3", "3''/", "@box(3,padding=4px,stroke=2px)", "@arp(@up(3,5))",
            "@arp(@box(@up(3,5),padding=4px,stroke=2px))", "{2}>3", "{2}>@box(3,padding=4px,stroke=2px)",
        ]) {
            const source = `@${side}(1,@box(${content},padding=10px,stroke=2px))`;
            const result = compileValid(source);
            const host = [...result.lowering.astToTemporal.values()].flat()
                .find(node => isVisualTemporalNode(node) && node.ast.sourceSpan.start === source.indexOf("1,"));
            assert(host && isVisualTemporalNode(host), source);
            const frame = result.layout.attachments.filter(item => item.layer === "background").at(-1);
            assert(frame, source);
            const gap = host.ast.size * 0.12;
            assert(side === "up"
                ? frame.box.y + frame.box.h <= host.box.y - gap + 1e-6
                : frame.box.y >= host.box.y + host.box.h + gap - 1e-6, source);
        }
    }
});

test("范围框只扩外围占用，不改变跨轨内容的内部间距", () => {
    const plain = compileValid("@box(@stack(1,2),padding=0px,stroke=0px)").layout;
    const padded = compileValid("@box(@stack(1,2),padding=10px,stroke=2px)").layout;
    const axes = (layout: typeof plain) => layout.objects.map(node => node.box.y + node.box.visualAxis);
    const before = axes(plain);
    const after = axes(padded);
    assert(nearly(after[1] - after[0], before[1] - before[0]), "padding must not expand the internal track gap");
    assert(nearly(after[0] - before[0], 11), "the upper perimeter must reserve padding and half the stroke");
    const frame = padded.attachments[0].box;
    assert(frame.y >= 0, "the frame must be included in line placement");
});

test("歌词避让内层范围框，但仍能作为外层框的内容", () => {
    for (const content of ["{1 2}", "@stack(1,2)", "1"]) {
        const result = compileValid(`@voice(@box(${content},padding=20px,stroke=2px),,ha ha)`).layout;
        const frame = result.attachments.find(item => item.layer === "background");
        const lyrics = result.attachments.find(item => item.layer === "foreground" && item.regions.length);
        assert(frame && lyrics, content);
        assert(lyrics.box.y > frame.box.y + frame.box.h, `lyrics must stay outside ${content}`);
        const regions = lyrics.regions;
        for (let index = 1; index < regions.length; index++) {
            const left = regions[index - 1];
            const right = regions[index];
            assert(left.x + left.w <= right.x || right.x + right.w <= left.x
                || left.y + left.h <= right.y || right.y + right.h <= left.y, "lyric rows must not overlap");
        }
    }
    const outer = compileValid("@box(@voice({1 2},,ha ha),padding=20px,stroke=2px)").layout;
    const frame = outer.attachments.find(item => item.layer === "background");
    const lyrics = outer.attachments.find(item => item.layer === "foreground" && item.regions.length);
    assert(frame && lyrics, "the outer box must include lyrics");
    assert(frame.box.y + frame.box.h > lyrics.box.y + lyrics.box.h, "lyrics declared inside stay inside");
});

test("嵌套框的每层 padding 只计入一次", () => {
    const [inner, outer] = frames("@box(@box(1,padding=4px,stroke=2px),padding=7px,stroke=2px)");
    assert(nearly(inner.box.y - outer.box.y, 8), "outer top padding must not be doubled");
    assert(nearly(outer.box.h - inner.box.h, 16), "outer padding must be applied once per edge");
});

test("只有关系或一个主体加关系的框保留完整范围和布局占用", () => {
    for (const content of ["@tie(a,b,height=60px)", "{3 @tie(a,b,height=60px)}"]) {
        const result = compileValid(`1@a 2@b @box(${content},padding=10px,stroke=2px)`).layout;
        const baseline = compileValid(`1@a 2@b @box(${content},padding=0px,stroke=0px)`).layout;
        const frame = result.attachments.find(item => item.layer === "background");
        const tie = result.attachments.find(item => item.layer === "foreground");
        assert(frame && tie, content);
        assert(frame.box.y >= -1e-6, "relationship padding must reserve space above the line");
        assert(nearly(tie.box.y - frame.box.y, 11), "the frame must contain the complete relation");
        assert(nearly(tie.box.y - baseline.attachments.find(item => item.layer === "foreground")!.box.y, 11),
            "relation-only padding must participate in layout");
    }
});

test("带跨轨关系的范围框按关系轨道归属稳定占位", () => {
    const result = compileValid(`
@stack(1@a,4@b)
@box({2 3 @tie(a,b,height=60px)},padding=10px,stroke=2px)
`).layout;
    const frame = result.attachments.find(item => item.layer === "background");
    assert(frame && frame.box.y >= -1e-6, "the relation's upper track must own the upper perimeter");
});

test("box 的后置平移不被占用重排抵消，也不移动邻轨", () => {
    for (const content of ["1", "{1 2}", "@up(1,2)", "{2}>1"]) {
        for (const dy of [-15, 15]) {
            const source = (offset: number) => `@stack(@adjust(@box(${content},padding=10px,stroke=2px),dy=${offset}px),3)`;
            const baseline = compileValid(source(0));
            const shifted = compileValid(source(dy));
            const before = baseline.layout.attachments.find(item => item.layer === "background");
            const after = shifted.layout.attachments.find(item => item.layer === "background");
            assert(before && after, content);
            assert(nearly(after.box.y - before.box.y, dy), `${content}: the frame must follow dy exactly`);
            const neighbor = (result: typeof baseline) => result.layout.objects.find(node =>
                "name" in node.ast && node.ast.name === "3")!.box.y;
            assert(nearly(neighbor(baseline), neighbor(shifted)), `${content}: dy must not move the other track`);
            const repeated = layoutDocument(shifted.lowering, layoutContext);
            deepStrictEqual(repeated.attachments.map(item => item.box), shifted.layout.attachments.map(item => item.box));
        }
    }
});

test("多个内层框共用最低轨占用，各原始轨的多行歌词只排列一次", () => {
    const { layout } = compileValid(
        '@voice(@stack(@box({1 2},padding=4px),@box({3 4},padding=15px)),Lead,"la la la la",Row="ho ho ho ho")',
    );
    const notes = layout.objects.filter(node => node.box.h > 0);
    const lowest = notes.reduce((left, right) =>
        left.box.y + left.box.visualAxis > right.box.y + right.box.visualAxis ? left : right);
    const lyrics = layout.attachments.find(item => item.layer === "foreground" && item.regions.length);
    assert(lyrics, "lyrics must be measured");
    assert(lyrics.regions.every(region => region.track === lowest.track), "the lowest track owns the lyric occupancy");
    const [first, second, third, fourth, fifth, , seventh] = lyrics.regions;
    assert(nearly(first.y, second.y) && nearly(third.y, fourth.y), "notes on the same track share a baseline");
    assert(fifth.y > first.y && seventh.y > third.y, "each original track keeps its lyric row order");
    assert(first.y >= seventh.y + seventh.h || third.y >= fifth.y + fifth.h, "the complete lyric blocks do not overlap");
});

test("歌词不把 voice 作用域外的框当成自己的避让对象", () => {
    const plain = compileValid('1 @voice(2,Lead,la)').layout;
    const framed = compileValid('@box(1,padding=40px) @voice(2,Lead,la)').layout;
    const gap = (layout: typeof plain) => {
        const target = layout.objects.at(-1)!;
        const lyrics = layout.attachments.find(item => item.layer === "foreground" && item.regions.length);
        assert(lyrics, "lyrics must be measured");
        return lyrics.box.y - target.box.y;
    };
    assert(nearly(gap(plain), gap(framed)), "only frames declared inside the voice affect relative lyric placement");
});

test("只有跨行关系的框仍报告自己的跨行错误", () => {
    const source = '1@a @br() 2@b @box(@tie(a,b),padding=4px)';
    const error = expectLayoutError(source, "E_BOX_CROSS_LINE");
    assert(source.slice(error.span.start, error.span.end).startsWith("@box"), "the error points to the enclosing box");
});

test("子域成员分别微调时，外层位移仍只作用一次且不移动邻轨", () => {
    for (const [dx, dy] of [[0, 0], [3, -7], [-5, 11]]) {
        const graces = `{@adjust(@box(1/,padding=3px),dx=${dx}px,dy=${dy}px) @adjust(@box(2/,padding=6px),dx=-2px,dy=9px)}>3`;
        const baseline = compileValid(`@stack(${graces},4)`).layout;
        const shifted = compileValid(`@stack(@adjust(${graces},dx=13px,dy=17px),4)`).layout;
        const before = baseline.attachments.filter(attachment => attachment.layer === "background");
        const after = shifted.attachments.filter(attachment => attachment.layer === "background");
        assert(before.length === 2 && after.length === 2, "both grace frames must survive");
        for (let index = 0; index < before.length; index++) {
            assert(nearly(after[index].box.x - before[index].box.x, 13), "each frame follows outer dx once");
            assert(nearly(after[index].box.y - before[index].box.y, 17), "each frame follows outer dy once");
        }
        assert(nearly(shifted.objects.at(-1)!.box.y, baseline.objects.at(-1)!.box.y), "the other track stays fixed");
    }
});

test("附件占用查询只暴露有效区域，未测依赖与显式空占用保持区分", () => {
    const lowered = lower("1");
    const future: LayoutAttachment = {
        layer: "foreground",
        createGeometry() { return { regions: [{ x: 0, y: 0, w: 1, h: 1 }], occupancy: [], paint() {} }; },
    };
    const probe: LayoutAttachment = {
        layer: "foreground",
        createGeometry(context) {
            assert(context.getAttachmentOccupancy(future) === undefined, "future geometry is not yet visible");
            throws(() => context.getAttachmentBox(future), /dependency has not been measured/);
            throws(() => context.getContentBounds({ nodes: [], attachments: [future] }), /dependency has not been measured/);
            return { regions: [], paint() {} };
        },
    };
    const observer: LayoutAttachment = {
        layer: "foreground",
        createGeometry(context) {
            deepStrictEqual(context.getAttachmentOccupancy(future), []);
            assert(!("getAttachmentGeometry" in context), "the broader geometry query is not exposed");
            return { regions: [], paint() {} };
        },
    };
    lowered.attachments.push(probe, future, observer);
    layoutDocument(lowered, layoutContext);
});
