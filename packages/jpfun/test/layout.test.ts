import { deepStrictEqual, throws } from "node:assert/strict";
import { test } from "node:test";

import { DIV_ADDON_KEY } from "../src/functions/div/index.js";
import { GraceTemporal } from "../src/functions/grace/index.js";
import { layoutDocument } from "../src/layout/engine.js";
import type { Extent, LayoutAttachment } from "../src/layout/types.js";
import { isVisualTemporalNode } from "../src/functions/temporal.js";
import { compileScore } from "../src/pipeline.js";
import { assert, expectSnapshot, layoutContext, layoutOf, lower, nearly, recordCommands } from "./helpers.js";

/** 综合样例：数字、升降号、减时线、小节线、延音与文本 */
const result = compileScore(`1 #2'./ | - @text("进入")`, { rowGap: 12 }).layout;

test("装饰处理器从主函数名推导注册键", () => {
    assert(layoutContext.decorationHandlers.has(DIV_ADDON_KEY),
        "div layout must derive its handler key from the primary function name");
});

test("extent overloads return a scalar for one track and a map for all tracks", () => {
    const lowered = lower("@stack({1 2},{3 4})");
    const host = lowered.columns[0][0];
    const absentTrack = lower("5").rootTrack;
    const probe: LayoutAttachment = {
        layer: "foreground",
        createGeometry(context) {
            const all: ReadonlyMap<typeof host.track, Readonly<Extent>> = context.getRangeExtents(0);
            const single: Readonly<Extent> | undefined = context.getRangeExtents(0, undefined, host.track);
            assert(all instanceof Map && all.size === 2, "all-track queries must retain a map");
            assert(single && !(single instanceof Map), "single-track queries must return an extent");
            deepStrictEqual(single, all.get(host.track));
            deepStrictEqual(context.getRangeExtents(0, [0, 1], host.track), single);
            assert(context.getRangeExtents(0, [1, 0], host.track) === undefined, "an empty range has no scalar extent");
            assert(context.getRangeExtents(0, [1, 0]).size === 0, "an empty all-track range returns an empty map");
            assert(context.getRangeExtents(0, undefined, absentTrack) === undefined, "an absent track has no extent");
            assert(context.getRangeExtents(10, undefined, host.track) === undefined, "an absent line has no scalar extent");
            assert(context.getRangeExtents(10).size === 0, "an absent line returns an empty all-track map");
            return { regions: [], paint() {} };
        },
    };
    lowered.attachments.push(probe);
    layoutDocument(lowered, layoutContext);
});

test("range queries preserve local endpoints only when a track is selected", () => {
    const lowered = lower("@stack({@grace(1,{2 3}) 4}, {@grace(5,{6 7}) 1})");
    const graces = lowered.columns.flat().filter(node => node instanceof GraceTemporal);
    assert(graces.length === 2, "expected two grace groups in the same document column");
    const [first, second] = graces;
    const last = lowered.columns.at(-1)!.find(node => node.track === first.track && isVisualTemporalNode(node));
    assert(last && isVisualTemporalNode(last), "expected a following host on the first track");
    let calls = 0;
    const probe: LayoutAttachment = {
        layer: "foreground",
        createGeometry(context) {
            calls++;
            const local = context.getRangeExtents(first.layoutLine, [first.graces[1], last], first.track);
            assert(local && !(local instanceof Map), "a single-track query must return an extent directly");
            const axis = context.getVisualAxis(first.layoutLine, first.track);
            const expected = [first.graces[1], first.host, last];
            assert(nearly(local.top + axis, Math.min(...expected.map(host => host.box.y))),
                "local endpoints must measure their actual member boxes");
            const whole = context.getRangeExtents(first.layoutLine, [first.graces[1], last]);
            assert(whole.has(second.track), "an all-track query must include the other track's document columns");
            const secondAxis = context.getVisualAxis(first.layoutLine, second.track);
            assert(nearly(whole.get(second.track)!.top + secondAxis, second.box.y),
                "an all-track query must retain the entire parallel composite");
            return { regions: [], paint() {} };
        },
    };
    lowered.attachments.push(probe);
    layoutDocument(lowered, layoutContext);
    assert(calls > 0, "the query probe must run");
});

test("local endpoint attachments participate in subsequent range avoidance", () => {
    for (const first of ["@dyn(a,b,24)", "@tie(a,b)"]) {
        for (const wrap of [(body: string) => body, (body: string) => `@grace(1,{${body}})`]) {
            const source = wrap(`2@a 3@b ${first} @dyn(a,b,24)`);
            const result = layoutOf(source);
            const before = result.attachments.find(attachment => attachment.sourceSpan?.start === source.indexOf(first));
            const after = result.attachments.find(attachment => attachment.sourceSpan?.start === source.lastIndexOf("@dyn"));
            assert(before && after && before !== after, "expected two distinct endpoint attachments");
            assert(after.box.y + after.box.h <= before.box.y,
                `a later dynamic must clear the preceding relation in both document and local ranges: ${source}`);
        }
    }
});

test("endpoint occupancy remains isolated between compressed local sequences", () => {
    const group = "@grace(1,{2@a 3@b @tie(a,b) @dyn(a,b,24) @dyn(a,b,24)})";
    assert(nearly(layoutOf(group).bounds.h, layoutOf(Array(30).fill(group).join(" ")).bounds.h),
        "endpoint attachment buckets must not leak into adjacent grace groups under compression");
});

test("local occupancy is visible to ancestors and the document but not sibling scopes", () => {
    const lowered = lower("@grace(1,{@grace(2,{3 4}) 5}) @grace(6,{7 1})");
    const [outer, sibling] = lowered.columns.flat().filter(node => node instanceof GraceTemporal);
    const inner = outer.graces.find(node => node instanceof GraceTemporal);
    assert(inner instanceof GraceTemporal, "expected nested local sequences");
    let passes = 0;
    let occupiedTop = 0;
    const attachment: LayoutAttachment = {
        layer: "foreground",
        endPoints: inner.graces,
        createGeometry() {
            passes++;
            occupiedTop = Math.min(...inner.graces.map(node => node.box.y)) - 50;
            return {
                regions: [{
                    x: inner.graces[0].box.x, y: occupiedTop,
                    w: inner.graces.at(-1)!.box.x + inner.graces.at(-1)!.box.w - inner.graces[0].box.x,
                    h: 5, line: inner.layoutLine, track: inner.track,
                }],
                paint() {},
            };
        },
    };
    const probe: LayoutAttachment = {
        layer: "foreground",
        createGeometry(context) {
            const axis = context.getVisualAxis(inner.layoutLine, inner.track);
            for (const owner of [inner, outer]) {
                const extent = context.getRangeExtents(owner.layoutLine, [owner, owner], owner.track);
                assert(extent && nearly(extent.top + axis, occupiedTop),
                    "local occupancy must be visible to its own and enclosing sequences in each pass");
            }
            const document = context.getRangeExtents(inner.layoutLine).get(inner.track);
            assert(document && nearly(document.top + axis, occupiedTop), "the document scope must include local occupancy");
            const isolated = context.getRangeExtents(sibling.layoutLine, [sibling, sibling], sibling.track);
            assert(isolated && nearly(isolated.top + axis, Math.min(sibling.host.box.y, ...sibling.graces.map(node => node.box.y))),
                "sibling queries must contain only their own hosts and attachments");
            return { regions: [], paint() {} };
        },
    };
    lowered.attachments.push(attachment, probe);
    layoutDocument(lowered, layoutContext);
    assert(passes === 2, "the probe must cover both initial measurement and vertical replacement");
});

test("local query topology is snapshotted and closed after preparation", () => {
    const lowered = lower("1^3 5");
    const owner = lowered.columns[0][0];
    const spare = lowered.columns[1][0];
    const members = [...lowered.astToTemporal.values()].flat().filter(node => node.foldedInto === owner).filter(isVisualTemporalNode);
    assert(isVisualTemporalNode(owner) && isVisualTemporalNode(spare), "expected visible test hosts");
    const columns = members.map(member => [member]);
    const prepare = owner.prepareLayout;
    let register: NonNullable<typeof layoutContext.registerLocalColumns>;
    owner.prepareLayout = context => {
        prepare.call(owner, context);
        register = context.registerLocalColumns!;
        register(owner, columns);
        columns[0].push(spare);
        columns.reverse();
    };
    const horizontal = owner.prepareHorizontal;
    owner.prepareHorizontal = line => {
        throws(() => register(spare, [[owner]]), /preparation|sealed/);
        horizontal?.call(owner, line);
    };
    const probe: LayoutAttachment = {
        layer: "foreground",
        createGeometry(context) {
            deepStrictEqual(context.getRangeColumns(0, [owner, owner], owner.track), members.map(member => [member]));
            throws(() => register(spare, [[owner]]), /preparation|sealed/);
            return { regions: [], paint() {} };
        },
    };
    lowered.attachments.push(probe);
    layoutDocument(lowered, layoutContext);
});

test("local query boundaries follow pre/post order, nesting and document lines", () => {
    for (const source of [
        "@grace(1,{2''' 3}) 4",
        "@grace(1,{2''' 3},side=post) 4",
        "@grace(@grace(1,{2''' 3}),{5 6},side=post) 4",
        "@grace(1,{2''' 3}) @br() 4",
    ]) {
        const lowered = lower(source);
        const events = [...lowered.astToTemporal.values()].flat();
        const from = events.find(node => node.ast.sourceSpan.start === source.indexOf("3"));
        const to = events.find(node => node.ast.sourceSpan.start === source.lastIndexOf("4"));
        assert(from && to && isVisualTemporalNode(from) && isVisualTemporalNode(to), "expected visible endpoints");
        const probe: LayoutAttachment = {
            layer: "foreground",
            createGeometry(context) {
                for (let line = from.layoutLine; line <= to.layoutLine; line++) {
                    const forward: Readonly<Extent> | undefined = context.getRangeExtents(line, [from, to], from.track);
                    const reverse: Readonly<Extent> | undefined = context.getRangeExtents(line, [to, from], from.track);
                    deepStrictEqual(forward, reverse);
                    assert(forward, "cross-line queries must retain the selected track");
                }
                const local = context.getRangeExtents(from.layoutLine, [from, from], from.track)!;
                const axis = context.getVisualAxis(from.layoutLine, from.track);
                assert(nearly(local.top + axis, from.box.y) && nearly(local.bottom + axis, from.box.y + from.box.h),
                    "a one-member query must exclude the earlier tall grace and its containing composite");
                return { regions: [], paint() {} };
            },
        };
        lowered.attachments.push(probe);
        layoutDocument(lowered, layoutContext);
    }
});

test("opaque folded members share a column while nested registered sequences remain queryable", () => {
    const lowered = lower("{@grace(1,{2 3})}^5 6");
    const events = [...lowered.astToTemporal.values()].flat();
    const grace = events.find(node => node instanceof GraceTemporal);
    const fold = lowered.columns[0][0];
    assert(grace instanceof GraceTemporal && isVisualTemporalNode(fold), "expected a grace inside an opaque fold");
    const probe: LayoutAttachment = {
        layer: "foreground",
        createGeometry(context) {
            const axis = context.getVisualAxis(0, fold.track);
            const local = context.getRangeExtents(0, [grace.graces[0], grace.graces[1]], fold.track)!;
            assert(nearly(local.top + axis, Math.min(...grace.graces.map(node => node.box.y))),
                "a registered sequence inside a fold must remain locally addressable");
            const member = events.find(node => node !== fold && node.foldedInto === fold && node !== grace);
            assert(member && isVisualTemporalNode(member), "expected the upper member");
            const column = context.getRangeExtents(0, [member, member], fold.track)!;
            assert(nearly(column.top + axis, fold.box.y), "an opaque fold member selects its whole column");
            return { regions: [], paint() {} };
        },
    };
    lowered.attachments.push(probe);
    layoutDocument(lowered, layoutContext);
});

test("custom composites register query columns without changing document columns", () => {
    const lowered = lower("1^3^5 6");
    const owner = lowered.columns[0][0];
    const members = [...lowered.astToTemporal.values()].flat().filter(node =>
        node.foldedInto === owner && isVisualTemporalNode(node)).filter(isVisualTemporalNode);
    assert(isVisualTemporalNode(owner) && members.length === 3, "expected a custom three-member test composite");
    const prepare = owner.prepareLayout;
    owner.prepareLayout = context => {
        prepare.call(owner, context);
        context.registerLocalColumns!(owner, members.map(member => [member]));
    };
    const probe: LayoutAttachment = {
        layer: "foreground",
        createGeometry(context) {
            deepStrictEqual(context.getRangeColumns(0, [members[1], members[2]], owner.track).flat(), members.slice(1));
            deepStrictEqual(context.getRangeColumns(0, [members[1], members[2]]).flat(), [owner]);
            deepStrictEqual(context.getRangeColumns(0, [owner, owner], owner.track).flat(), members);
            assert(lowered.columns.length === 2 && context.lines[0].columns.length === 2,
                "query expansion must leave time and solver columns unchanged");
            return { regions: [], paint() {} };
        },
    };
    lowered.attachments.push(probe);
    layoutDocument(lowered, layoutContext);
    assert(layoutContext.registerLocalColumns === undefined, "registration must not leak into the caller's reusable context");
});

test("two grace sequences inside one fold remain independent", () => {
    const lowered = lower("@up(@grace(1,{2 3}),@grace(4,{5 6},side=post)) 7");
    const graces = [...lowered.astToTemporal.values()].flat().filter(node => node instanceof GraceTemporal);
    const fold = lowered.columns[0][0];
    assert(graces.length === 2 && isVisualTemporalNode(fold), "expected two local sequences in one folded column");
    const [first, second] = graces;
    const probe: LayoutAttachment = {
        layer: "foreground",
        createGeometry(context) {
            for (const grace of graces) {
                const [from, to] = grace.graces;
                deepStrictEqual(context.getRangeColumns(0, [from, to], fold.track), [[from], [to]]);
                const members = grace.side === "pre" ? [...grace.graces, grace.host] : [grace.host, ...grace.graces];
                deepStrictEqual(context.getRangeColumns(0, [grace, grace], fold.track), members.map(member => [member]));
                deepStrictEqual(context.getRangeColumns(0, [from, to]), [[fold]]);
            }
            deepStrictEqual(context.getRangeColumns(0, [first.graces[1], second.graces[0]], fold.track), [[fold]]);
            return { regions: [], paint() {} };
        },
    };
    lowered.attachments.push(probe);
    layoutDocument(lowered, layoutContext);
});

test("local column registration rejects empty sequences, duplicate members and cycles", () => {
    for (const invalid of ["empty", "empty-column", "duplicate", "same-track", "cycle", "registration"]) {
        const lowered = lower("1^3");
        const owner = lowered.columns[0][0];
        const member = [...lowered.astToTemporal.values()].flat().find(node => node.foldedInto === owner);
        assert(isVisualTemporalNode(owner) && member && isVisualTemporalNode(member), "expected folded test members");
        const prepare = owner.prepareLayout;
        owner.prepareLayout = context => {
            prepare.call(owner, context);
            let columns = [[member]];
            if (invalid === "empty") columns = [];
            if (invalid === "empty-column") columns = [[]];
            if (invalid === "duplicate") columns = [[member], [member]];
            if (invalid === "cycle") columns = [[owner]];
            if (invalid === "same-track") columns = [[...lowered.astToTemporal.values()].flat()
                .filter(node => node.foldedInto === owner).filter(isVisualTemporalNode)];
            context.registerLocalColumns!(owner, columns);
            if (invalid === "registration") context.registerLocalColumns!(owner, columns);
        };
        throws(() => layoutDocument(lowered, layoutContext), /local layout|Local layout/);
    }
});

test("content measurement filters empty and non-layout attachments and rejects forward dependencies", () => {
    const lowered = lower("1");
    const host = lowered.columns[0][0];
    assert(isVisualTemporalNode(host), "expected one measured host");
    const empty: LayoutAttachment = { layer: "foreground", createGeometry: () => ({ regions: [], paint() {} }) };
    const later: LayoutAttachment = { layer: "foreground", createGeometry: () => ({ regions: [], paint() {} }) };
    const probe: LayoutAttachment = {
        layer: "foreground",
        createGeometry(context) {
            const bounds = context.getContentBounds({ nodes: [host], attachments: [empty, {}] });
            deepStrictEqual(bounds, { x: host.box.x, y: host.box.y, w: host.box.w, h: host.box.h });
            assert(context.getContentBounds({ nodes: [], attachments: [empty, {}] }) === undefined,
                "empty geometry must not create a box at the origin");
            throws(() => context.getContentBounds({ nodes: [], attachments: [later] }), /has not been measured/);
            return { regions: [], paint() {} };
        },
    };
    lowered.attachments.push(empty, probe, later);
    layoutDocument(lowered, layoutContext);
});

test("finalizeLayout sees completed decorations before horizontal preparation", () => {
    const lowered = lower("1.//");
    const host = lowered.columns.flat().find(isVisualTemporalNode);
    assert(host, "the lifecycle test requires a visual host");
    const calls: string[] = [];
    const finalize = host.finalizeLayout;
    host.finalizeLayout = context => {
        calls.push("finalize");
        assert(host.decorations.length === 2 && host.box.h > host.ast.size,
            "finalization must see both decorators and their completed below-space");
        finalize?.call(host, context);
    };
    host.prepareHorizontal = () => {
        calls.push("horizontal");
        deepStrictEqual(host.ports.lyric, { x: host.box.anchor, y: host.box.h });
    };
    layoutDocument(lowered, layoutContext);
    deepStrictEqual(calls, ["finalize", "horizontal"]);
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

test("局部横排先完成全部尺寸，再注册约束、创建零间隙输入并执行 hook", () => {
    const lowered = lower("@grace(1,{2 3})");
    const node = lowered.columns.flat().find(item => item instanceof GraceTemporal);
    assert(node instanceof GraceTemporal, "expected a grace composite");
    const [first, last] = node.graces;
    const calls: string[] = [];
    first.prepareHorizontal = line => {
        calls.push("prepare");
        assert(last.box.w > 0 && last.springConfig.alpha_L !== undefined,
            "all local members must be measured and their spring defaults completed");
        assert(line.columnOf(first) === 0 && line.columnOf(last) === 1 && first.t.equals(last.t),
            "local columns must follow written order even when global times coincide");
        first.springConfig.alpha_R = 99;
        line.registerHorizontalLayoutHook(first, last, ({ columns, start, end }) => {
            calls.push("hook");
            assert(columns[start][0].config.alpha_R === 99,
                "input creation must follow prepareHorizontal");
            assert(columns.every(column => column.every(element =>
                element.margin_L === 0 && element.margin_R === 0
                && element.duration_L > 0 && element.duration_R > 0)),
                "hooks must receive zero margins without zeroing duration or stiffness");
            columns[start][0].WL += 7;
            columns[end][0].WR += 11;
        });
    };
    layoutDocument(lowered, layoutContext);
    deepStrictEqual(calls, ["prepare", "hook"]);
    assert(nearly(first.box.x - node.box.x, 7), "the saved offset must retain the left hook inset");
    assert(nearly(node.box.w,
        first.box.w + last.box.w + 18 + node.host.box.w + node.ast.size * 0.7 * 0.2),
        "the composite must measure both edges of the solved occupancy");
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

test("完全被宿主包含的附件不触发重排", () => {
    const noExpansion = lower("1");
    const host = noExpansion.columns[0]?.find(isVisualTemporalNode);
    assert(host, "the contained occupancy test requires one visual host");
    let layoutCalls = 0;
    const containedRelation: LayoutAttachment = {
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
    };
    noExpansion.attachments.push(containedRelation);
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
    const expandingRelation: LayoutAttachment = {
        layer: "foreground",
        createGeometry(context) {
            layoutCalls++;
            return {
                regions: [{ x: 10, y: context.getVisualAxis(0, host.track) - 100, w: 30, h: 10, line: 0, track: host.track }],
                paint() {},
            };
        },
    };
    withOccupancy.attachments.push(expandingRelation);
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
    const optionFontSizeResult = compileScore(`1`, { variables: { fontsize: 18 } });
    assert(optionFontSizeResult.layout.objects[0].ast.size === 18, "compileScore fontSize must initialize the root parse scope");

    const [smallDecoratedNote, smallBar] = compileScore(`1.// |`, { variables: { fontsize: 20 } }).layout.objects;
    const [largeDecoratedNote, largeBar] = compileScore(`2.// |`, { variables: { fontsize: 40 } }).layout.objects;
    assert(nearly(largeDecoratedNote.box.w, smallDecoratedNote.box.w * 2), "dot width must scale with its host font size");
    assert(nearly(largeDecoratedNote.box.h, smallDecoratedNote.box.h * 2), "div height must scale with its host font size");
    assert(nearly(largeBar.box.w, smallBar.box.w * 2), "bar geometry must use its parse-time font size");
    assert(nearly(largeBar.box.h, smallBar.box.h * 2), "bar height must use its parse-time font size");
});
