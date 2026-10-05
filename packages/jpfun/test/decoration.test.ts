import { test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { DIV_ADDON_KEY, divLineWidth } from "../src/functions/div/index.js";
import { GraceTemporal } from "../src/functions/grace/index.js";
import { isVisualTemporalNode } from "../src/functions/temporal.js";
import { getLayoutBounds, layoutDocument, type DocumentLayoutResult } from "../src/layout/engine.js";
import { assert, compileValid, layoutContext, lower, nearly, recordCommands } from "./helpers.js";

function octaveGeometry(layout: DocumentLayoutResult) {
    const commands = recordCommands(layout);
    const number = commands.find(command => command.kind === "text" && command.text === "1");
    assert(number?.kind === "text", "the lower-octave host must paint its number");
    const dots = commands.filter(command => command.kind === "circle").filter(dot => nearly(dot.cx, number.x));
    const lines = commands.filter(command => command.kind === "line").filter(line => line.x1 < number.x && line.x2 > number.x);
    assert(dots.length > 0, "the lower-octave host must paint its dots");
    return { dots, lines, size: number.style.fontSize, top: dots[0].cy - dots[0].r - number.y };
}

test("above 和 below 由内向外排列，纯留白不进入内容边界", () => {
    const lowered = lower('@text("1", size=22px)');
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

test("无减时线的下八度点贴近数字，有减时线时保留避让间距", () => {
    for (const size of [10, 22, 40]) {
        for (const count of [1, 3]) {
            const note = `1${",".repeat(count)}`;
            const firstDotTops: number[] = [];
            for (let level = 0; level < 3; level++) {
                const { layout } = compileValid(note + "/".repeat(level), { variables: { fontsize: size } });
                const { dots, lines, top } = octaveGeometry(layout);
                const host = layout.objects[0];
                const octave = host.decorations.find(decoration => decoration.below?.order === 100);
                assert(octave?.below && nearly(octave.below.gap ?? 0, size * 0.08), "octave dots always use a fixed gap");
                assert(dots.length === count && lines.length === level, "all octave dots and div levels must be painted");
                firstDotTops.push(top);
                if (level === 0) assert(nearly(top, size * 0.12), "unlined dots must sit close to the number baseline");
                else assert(nearly(dots[0].cy - dots[0].r - lines.at(-1)!.y1 - divLineWidth(size) / 2, size * 0.08),
                    "octave dots must retain their gap below the last div stroke");
                for (let dot = 1; dot < dots.length; dot++) {
                    assert(nearly(dots[dot].cy - dots[dot - 1].cy, size * 0.23), "octave dot spacing must stay unchanged");
                }
                const lastDot = dots.at(-1)!;
                assert(nearly(host.box.y + host.box.h, lastDot.cy + lastDot.r), "the note box must end at its last dot");
                assert(nearly(host.ports["lyric"].y, host.box.h), "lyrics must follow the updated note height");
            }
            assert(nearly(firstDotTops[1] - firstDotTops[0], size * 0.08 + divLineWidth(size)),
                "the first div line must visibly move lower-octave dots away from the number");
            assert(nearly(firstDotTops[2] - firstDotTops[1], size * 0.14), "each extra div level must reserve one line gap");
        }
    }
});

test("显式音符、零层减时与折叠宿主使用相同的下八度点间距", () => {
    for (const source of ["1,", "C3", '@note("1,")', "@div({1,}, 0)", "@up({1,}, 3)", "2>{1,}"]) {
        for (const suffix of ["", "/"]) {
            const { top, size } = octaveGeometry(compileValid(source + suffix).layout);
            const expected = suffix ? size * 0.2 + divLineWidth(size) : size * 0.12;
            assert(nearly(top, expected), `${source + suffix}: lower-octave spacing must match a plain note`);
        }
    }
});

test("八度点只跟随实际 decoration，不依赖 div 语义，重复布局不累积", () => {
    const lowered = lower("1,/");
    const node = lowered.columns[0][0];
    assert(isVisualTemporalNode(node), "the note must be visual");
    const original = octaveGeometry(compileValid("1,").layout).top;
    const context = { ...layoutContext, decorationHandlers: new Map(layoutContext.decorationHandlers) };
    for (const space of [null, { gap: 2, height: 5 }, { gap: 3, height: 9 }]) {
        context.decorationHandlers.set(DIV_ADDON_KEY, () => space ? { below: { order: 50, ...space }, paint() {} } : null);
        for (let pass = 0; pass < 2; pass++) {
            const { top } = octaveGeometry(layoutDocument(lowered, context));
            assert(node.addon?.[DIV_ADDON_KEY] === 1, "div semantics must remain unchanged");
            assert(nearly(top - original, space ? space.gap + space.height : 0),
                "only the actual decoration gap and height may move octave dots");
        }
    }
});

test("宿主可以提供下方装饰起点，上方排列与主体绘制位置不变", () => {
    const lowered = lower('@text("1", size=22px)');
    const node = lowered.columns[0][0];
    assert(isVisualTemporalNode(node), "the host must be visual");
    const positions: number[] = [];
    const prepare = node.prepareLayout;
    node.prepareLayout = context => {
        prepare.call(node, context);
        node.ports["decoration.below"] = { x: node.box.anchor, y: 18 };
        node.decorations.push(
            { above: { order: 0, gap: 1, height: 2, place: y => positions.push(y) }, paint() {} },
            { below: { order: 0, gap: 2, height: 3, place: y => positions.push(y) }, paint() {} },
        );
    };
    for (let pass = 0; pass < 2; pass++) {
        positions.length = 0;
        const commands = recordCommands(layoutDocument(lowered, layoutContext));
        deepStrictEqual(positions, [-3, 20]);
        const number = commands.find(command => command.kind === "text");
        assert(number?.kind === "text" && nearly(number.y - node.box.y, node.ast.size * 0.8),
            "the decoration origin must not shift the number baseline");
    }
});

test("下方装饰起点不吞掉纯留白，留白始终包围完整内容", () => {
    for (const source of ["1", "1,", "1/", "1,/"]) {
        const lowered = lower(source);
        const node = lowered.columns[0][0];
        assert(isVisualTemporalNode(node), "the host must be visual");
        layoutDocument(lowered, layoutContext);
        const contentHeight = getLayoutBounds(node, true).h;
        const occupiedHeight = getLayoutBounds(node).h;
        const prepare = node.prepareLayout;
        node.prepareLayout = context => {
            prepare.call(node, context);
            node.decorations.push({ below: { order: Infinity, height: 5 } });
        };
        for (let pass = 0; pass < 2; pass++) {
            layoutDocument(lowered, layoutContext);
            assert(nearly(getLayoutBounds(node, true).h, contentHeight), "pure spacing must not change content height");
            assert(nearly(getLayoutBounds(node).h, occupiedHeight + 5), `${source}: the full padding must be reserved`);
        }
    }
});

test("下方装饰保留负 gap 的既有占高，不能额外补回正文高度", () => {
    const lowered = lower('@text("1", size=22px)');
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
    const lowered = lower('@text("1", size=22px)');
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
        const lowered = lower('@text("1", size=22px)');
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
