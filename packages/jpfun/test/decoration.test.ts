import { test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { GraceTemporal } from "../src/functions/grace/index.js";
import { isVisualTemporalNode } from "../src/functions/temporal.js";
import { getLayoutBounds, layoutDocument } from "../src/layout/engine.js";
import { assert, compileValid, layoutContext, lower, nearly, recordCommands } from "./helpers.js";

test("above 和 below 由内向外排列，纯留白不进入内容边界", () => {
    const lowered = lower("1");
    const node = lowered.columns[0][0];
    assert(isVisualTemporalNode(node), "the note must be visual");
    const positions: number[] = [];
    const prepare = node.prepareLayout;
    node.prepareLayout = context => {
        prepare.call(node, context);
        node.decorations.push(
            { above: { order: 100, gap: 1, height: 4, place: y => positions.push(y) }, paint() {} },
            { above: { order: 0, gap: 2, height: 3, place: y => positions.push(y) }, paint() {} },
            { above: { order: Infinity, height: 8 } },
            { below: { order: 0, gap: 1, height: 3, place: y => positions.push(y) }, paint() {} },
            { below: { order: Infinity, height: 5 } },
        );
    };
    layoutDocument(lowered, layoutContext);
    deepStrictEqual(positions, [-5, -10, 23]);
    const content = getLayoutBounds(node, true);
    const occupied = getLayoutBounds(node);
    assert(nearly(content.y, node.box.y - 10) && nearly(content.h, 36), "only painted slots extend content");
    assert(nearly(occupied.y, node.box.y - 18) && nearly(occupied.h, 49), "both sides include pure spacing");
    positions.length = 0;
    layoutDocument(lowered, layoutContext);
    deepStrictEqual(positions, [-5, -10, 23]);
    deepStrictEqual(getLayoutBounds(node), occupied);
});

test("一列上八度点只有一个 above 装饰，数字端口仍以正文为基准", () => {
    const { layout } = compileValid("1''/ 2,,/");
    const [upper, lower] = layout.objects;
    assert(upper.decorations.filter(decoration => decoration.above).length === 1, "upper dots share one decoration");
    assert(lower.decorations.filter(decoration => decoration.below).length === 2, "lower dots follow div");
    assert(upper.ports["shoulder"].y === 0, "the shoulder stays at the number's top");
    assert(getLayoutBounds(upper, true).y < upper.box.y, "content bounds include upper dots");
});

test("下方装饰保留负 gap 的既有占高，不能额外补回正文高度", () => {
    const lowered = lower("1");
    const node = lowered.columns[0][0];
    assert(isVisualTemporalNode(node), "the note must be visual");
    const prepare = node.prepareLayout;
    node.prepareLayout = context => {
        prepare.call(node, context);
        node.decorations.push({ below: { order: 0, gap: -2, height: 1 }, paint() {} });
    };
    layoutDocument(lowered, layoutContext);
    assert(nearly(node.box.h, 21) && nearly(getLayoutBounds(node).h, 21), "negative gaps preserve legacy height");
});

test("上下装饰独立排序，但绘制仍保留注册顺序", () => {
    const lowered = lower("1");
    const node = lowered.columns[0][0];
    assert(isVisualTemporalNode(node), "the note must be visual");
    const order: string[] = [];
    const positions: [string, number][] = [];
    const prepare = node.prepareLayout;
    node.prepareLayout = context => {
        prepare.call(node, context);
        node.decorations.push(
            {
                above: { order: 100, height: 2, place: y => positions.push(["first.above", y]) },
                below: { order: 0, height: 3, place: y => positions.push(["first.below", y]) },
                paint() { order.push("first"); },
            },
            {
                above: { order: 0, height: 4, place: y => positions.push(["second.above", y]) },
                below: { order: 100, height: 5, place: y => positions.push(["second.below", y]) },
                paint() { order.push("second"); },
            },
        );
    };
    const result = layoutDocument(lowered, layoutContext);
    deepStrictEqual(positions, [["second.above", -4], ["first.above", -6], ["first.below", 22], ["second.below", 25]]);
    assert(nearly(getLayoutBounds(node).h, 36), "both sides reserve their complete extent");
    recordCommands(result);
    deepStrictEqual(order, ["first", "second"]);
});

test("上方负间距越过正文时，两侧仍独立排列并保留各自边界", () => {
    for (const [paintAbove, gap, height, contentHeight] of [
        [true, 0, 3, 30],
        [true, -20, 1, 30],
        [false, -20, 1, 3],
    ] as const) {
        const lowered = lower("1");
        const node = lowered.columns[0][0];
        assert(isVisualTemporalNode(node), "the note must be visual");
        const positions: number[] = [];
        const prepare = node.prepareLayout;
        node.prepareLayout = context => {
            prepare.call(node, context);
            node.decorations.push(
                {
                    above: { order: 0, gap: -30, height: 4, place: y => positions.push(y) },
                    ...(paintAbove && { paint() {} }),
                },
                { below: { order: 0, gap, height, place: y => positions.push(y) }, paint() {} },
            );
        };
        layoutDocument(lowered, layoutContext);
        deepStrictEqual(positions, [26, 22 + gap]);
        assert(nearly(getLayoutBounds(node).h, 30), "occupied bounds contain both sides");
        assert(nearly(getLayoutBounds(node, true).h, contentHeight), "pure above spacing is excluded from content");
        assert(nearly(node.box.h, contentHeight), "negative below gaps retain cursor height unless above content extends it");
    }
});

test("倚音钩线使用内容下沿，不包含下方纯留白", () => {
    for (const source of ["2>1", "1<2"]) {
        const lowered = lower(source);
        const node = lowered.columns[0][0];
        assert(node instanceof GraceTemporal, "the composite must be a grace note");
        const grace = node.graces[0];
        const prepare = grace.prepareLayout;
        grace.prepareLayout = context => {
            prepare.call(grace, context);
            grace.decorations.push(
                { above: { order: 0, height: 8 }, paint() {} },
                { below: { order: Infinity, height: 15 } },
            );
        };
        const result = layoutDocument(lowered, layoutContext);
        const content = getLayoutBounds(grace, true);
        const occupied = getLayoutBounds(grace);
        const hook = recordCommands(result).find(command => command.kind === "path");
        assert(hook?.kind === "path", "the grace hook must be drawn");
        const start = hook.commands[0];
        assert(start.op === "M", "the hook starts with a move");
        assert(nearly(content.y + content.h, grace.box.y + grace.box.h), "content bottom is the box bottom");
        assert(nearly(start.y, content.y + content.h), "the hook uses the content bottom");
        assert(nearly(occupied.y + occupied.h - start.y, 15), "pure spacing stays outside the hook");
    }
});
