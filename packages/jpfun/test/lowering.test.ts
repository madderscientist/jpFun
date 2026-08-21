import { test } from "node:test";

import { layoutDocument } from "../src/layout/engine.js";
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
