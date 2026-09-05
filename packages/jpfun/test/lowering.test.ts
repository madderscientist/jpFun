import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";

import { Fraction } from "../src/fraction.js";
import { ASTFunctionNode, ASTNodeBase } from "../src/functions/ASTtypes.js";
import { layoutDocument } from "../src/layout/engine.js";
import { LoweringContext } from "../src/lowering/loweringContext.js";
import { Track } from "../src/lowering/track.js";
import type { LoweringResult } from "../src/lowering/types.js";
import { assert, createLowering, layoutContext, layoutOf, lower, nearly, parse } from "./helpers.js";

test("dot 与 div 的嵌套顺序不影响时值和计数", () => {
    const outerDiv = lower(`@div(@dot(1, 1), 2)`).columns[0][0];
    const outerDot = lower(`@dot(@div(1, 2), 1)`).columns[0][0];
    for (const temporal of [outerDiv, outerDot]) {
        assert(temporal.T.equals(3, 8), "dot and div nesting order must not change duration");
        assert(temporal.addon?.["@div"] === 2 && temporal.addon?.["@dot"] === 1,
            "dot and div nesting order must not change modifier addon counts");
    }

    const nestedDiv = lower(`@div(@div(1, 1), 2)`).columns[0][0];
    assert(nestedDiv.T.equals(1, 8) && nestedDiv.addon?.["@div"] === 3,
        "nested modifiers of the same kind must accumulate duration and addon counts");
    const nestedDot = lower(`@dot(@dot(1, 1), 1)`).columns[0][0];
    assert(nestedDot.T.equals(7, 4) && nestedDot.addon?.["@dot"] === 2,
        "nested dots must use their combined count instead of multiplying independent factors");

    const interleavedModifiers = lower(
        `@dot(@div(@dot(@div(A2, 1), 2), 3), 1)`,
    ).columns[0][0];
    assert(interleavedModifiers.addon?.["@div"] === 4 && interleavedModifiers.addon?.["@dot"] === 3,
        "interleaved div and dot scopes must merge counts before applying them");
    assert(interleavedModifiers.T.equals(15, 128),
        "four divs and three dots must be applied from their merged counts");
});

test("修饰作用域在推进时间前逐个更新事件", () => {
    const scopedDiv = lower(`@div({1 2}, 1)`);
    assert(scopedDiv.columns[0][0].t.equals(0) && scopedDiv.columns[1][0].t.equals(1, 2)
        && scopedDiv.duration.equals(1),
        "a modifier scope must update each event before advancing the time cursor");

    const mixedHistoryDiv = lower(`@div({@up(@div(1,1),3) 2},1)`);
    const mixedHistoryChord = mixedHistoryDiv.columns[0][0];
    const mixedHistoryNote = mixedHistoryDiv.columns[1][0];
    assert(mixedHistoryChord.T.equals(1, 4) && mixedHistoryChord.addon?.["@div"] === 2,
        "an outer div must extend the count already applied inside up");
    assert(mixedHistoryNote.t.equals(1, 4) && mixedHistoryNote.T.equals(1, 2)
        && mixedHistoryNote.addon?.["@div"] === 1 && mixedHistoryDiv.duration.equals(3, 4),
        "one group must keep independent modifier history for each event");
});

test("控制事件默认独占一列，不吞掉并行轨的同时刻音符", () => {
    const [tempoMark, upperNote, lowerNote] = layoutOf(`@stack({@tempo(120) 1}, {3})`).objects;
    assert(nearly(upperNote.box.x, lowerNote.box.x),
        "a control event must not steal the parallel track's first note into its own column");
    assert(tempoMark.box.x < upperNote.box.x, "a control event sorts left of the notes at the same time");
});

test("关系语法糖只吞并左侧的一个操作数", () => {
    const sugarKeepsLeft = layoutOf(`1/ 2/ 3 4 | 5 & 6 1 2`).objects;
    assert(sugarKeepsLeft.length === 9, "the & sugar must keep every node parsed before its left operand");
    assert(sugarKeepsLeft[5].track !== sugarKeepsLeft[6].track, "the & sugar must still create a branch lane");
    const upSugarKeepsLeft = layoutOf(`1/ 2/ 3 4 | 5 ^ 6 1 2`).objects;
    assert(upSugarKeepsLeft.length === 8, "the ^ sugar must keep every node parsed before its left operand");
});

test("重复 lowering 同一棵 AST 不会残留上一轮的事件", () => {
    const repeatAst = parse(`@div({1 2}, 1)`);
    for (let i = 0; i < 2; i++) {
        const repeatResult = layoutDocument(createLowering().lowerDocument(repeatAst), layoutContext);
        assert(repeatResult.objects.length === 2, "repeated lowering must not retain temporal objects on AST nodes");
        assert(repeatResult.attachments.length === 1, "repeated lowering must create exactly one fresh auto beam");
    }
});

test("复用 LoweringContext 时每轮重新收集实际 Track", () => {
    const context = createLowering();
    const first = context.lowerDocument(parse(`1`));
    const second = context.lowerDocument(parse(`2`));

    assert(first.tracks.length === 1 && second.tracks.length === 1,
        "each lowering run must collect its own used tracks");
    assert(first.tracks[0] !== second.tracks[0],
        "a reused context must not retain the previous run's track registration");
});

test("all augmenters finish before any finalizer sees their attachments", () => {
    const calls: string[] = [];
    const firstAttachment = { sourceSpan: { start: 0, end: 1 } };
    const secondAttachment = { sourceSpan: { start: 1, end: 2 } };
    class Consumer extends ASTFunctionNode {
        constructor() { super({ start: 0, end: 0 }); }
        static override loweringFinalize(result: LoweringResult) {
            calls.push("finalize:consumer");
            deepStrictEqual(result.attachments, [firstAttachment, secondAttachment]);
        }
    }
    class FirstProducer extends ASTFunctionNode {
        constructor() { super({ start: 0, end: 0 }); }
        static override loweringAugment(result: LoweringResult) {
            calls.push("augment:first");
            deepStrictEqual(result.attachments, []);
            return [firstAttachment];
        }
        static override loweringFinalize() { calls.push("finalize:first"); }
    }
    class SecondProducer extends ASTFunctionNode {
        constructor() { super({ start: 0, end: 0 }); }
        static override loweringAugment(result: LoweringResult) {
            calls.push("augment:second");
            deepStrictEqual(result.attachments, []);
            return [secondAttachment];
        }
        static override loweringFinalize() { calls.push("finalize:second"); }
    }
    const context = new LoweringContext();
    context.registerFunctions([Consumer, FirstProducer, SecondProducer]);
    const result = context.lowerDocument(parse("1"));
    deepStrictEqual(calls, [
        "augment:first", "augment:second",
        "finalize:consumer", "finalize:first", "finalize:second",
    ]);
    assert(result.duration.equals(1), "postprocessing must not advance the time cursor");
});

test("lowering groups observe inside out and resume after isolation", () => {
    const context = new LoweringContext();
    const outer = new ASTNodeBase({ start: 0, end: 3 });
    const inner = new ASTNodeBase({ start: 0, end: 3 });
    const leafAttachment = { sourceSpan: { start: 0, end: 1 } };
    const innerAttachment = { sourceSpan: { start: 0, end: 2 } };
    const outerAttachment = { sourceSpan: { start: 0, end: 3 } };
    const calls: string[] = [];
    context.beginLoweringGroup(outer, {
        attachment: outerAttachment,
        onTemporal(node) {
            calls.push("outer:temporal");
            assert(node.T.equals(1, 2), "outer observers must see inner modifications");
        },
        onAttachment(attachment) { calls.push(`outer:attachment:${attachment.sourceSpan!.end}`); },
    });
    context.beginLoweringGroup(inner, {
        attachment: innerAttachment,
        onTemporal(node) {
            calls.push("inner:temporal");
            assert(context.getTemporalNodes(node.ast).includes(node), "events must be indexed before observers run");
            node.T.divPow2(1);
        },
        onAttachment(attachment) { calls.push(`inner:attachment:${attachment.sourceSpan!.end}`); },
    });
    const track = new Track();
    context.isolateFromLoweringGroups(() => {
        const isolated = context.trackedEvents(parse("3"), new Fraction(), track);
        assert(isolated[0][0].T.equals(1), "isolated events must not receive outer modifiers");
        context.addAttachment(leafAttachment);
    });
    deepStrictEqual(calls, []);

    const cursor = new Fraction();
    const columns = context.trackedEvents(parse("1 2"), cursor, track);
    assert(columns[1][0].t.equals(1, 2) && cursor.equals(1), "modified durations must drive cursor advancement");
    context.addAttachment(leafAttachment);
    context.endLoweringGroup(inner);
    context.endLoweringGroup(outer);
    deepStrictEqual(calls, [
        "inner:temporal", "outer:temporal", "inner:temporal", "outer:temporal",
        "inner:attachment:1", "outer:attachment:1", "outer:attachment:2",
    ]);
});
