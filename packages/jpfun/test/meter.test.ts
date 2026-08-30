import { test } from "node:test";

import { ErrorDiagnostic } from "../src/diagnostic.js";
import type { Fraction } from "../src/fraction.js";
import { compileScore } from "../src/pipeline.js";
import { assert, layoutOf, lower, nearly, recordCommands } from "./helpers.js";

type MeterAst = {
    numerator: number;
    denominator: number;
    measureDuration: Fraction;
};

test("meter 固化任意正整数拍号且不改变音符时值", () => {
    for (const [source, expected] of [
        ["@meter(3,4)", [3, 4, 3, 1]],
        ["@meter(6,8)", [6, 8, 3, 1]],
        ["@meter(3,3)", [3, 3, 4, 1]],
        ["@meter(5,6)", [5, 6, 10, 3]],
    ] as const) {
        const meter = lower(source).columns[0][0].ast as unknown as MeterAst;
        assert(meter.numerator === expected[0] && meter.denominator === expected[1],
            `${source} must preserve its displayed fraction`);
        assert(meter.measureDuration.equals(expected[2], expected[3]),
            `${source} must freeze its exact measure duration`);
    }

    const events = lower(`@meter(6,8) 1 2/`).columns.flat();
    assert(events[1].T.equals(1) && events[2].T.equals(1, 2),
        "meter must not change bare or divided note durations");
});

test("meter 非法参数回落为 4/4", () => {
    for (const source of ["@meter(0,4)", "@meter(-1,4)", "@meter(3.5,4)", "@meter(4,0)"]) {
        const compiled = compileScore(source);
        const meter = compiled.lowering.columns[0][0].ast as unknown as MeterAst;
        assert(meter.numerator === 4 && meter.denominator === 4 && meter.measureDuration.equals(4),
            `${source} must fall back to 4/4`);
        assert(compiled.parser.diagnostics.some(diagnostic => diagnostic.code === "W_METER_INVALID"),
            `${source} must report W_METER_INVALID`);
    }
});

test("meter 精确校验完整、过长与不足小节", () => {
    assert(lower(`@meter(4,4) 1 | 2 3 4 5 |`).diagnostics.length === 0,
        "content before the first barline must not be validated");
    assert(lower(`@meter(6,8) | 1/ 2/ 3/ 4/ 5/ 6/ |`).diagnostics.length === 0,
        "six eighth notes must fill 6/8 exactly");
    assert(lower(`@meter(3,3) | 1 2 3 4 |`).diagnostics.length === 0,
        "non-power-of-two denominators must compare exactly");

    for (const source of ["@meter(4,4) 1 2 3 4 5 |", "@meter(4,4) | 1 | 2 3 4 5 |", "@meter(2,4) | 1 2 3 |", "@meter(2,4) | 1"]) {
        const diagnostics = lower(source).diagnostics;
        assert(diagnostics.some(diagnostic => diagnostic.code === "W_METER_MISMATCH"),
            `${source} must report W_METER_MISMATCH`);
    }
});

test("meter 失配诊断覆盖整个小节", () => {
    const source = `@meter(2,4) | 1 | 2 |`;
    const diagnostics = lower(source).diagnostics.filter(diagnostic => diagnostic.code === "W_METER_MISMATCH");
    const firstBarEnd = source.indexOf("|") + 1;
    const secondBarEnd = source.lastIndexOf("|") + 1;
    assert(diagnostics.length === 2, "both incomplete measures must be reported");
    assert(diagnostics[0].span.start === firstBarEnd && diagnostics[0].span.end === source.indexOf("|", firstBarEnd) + 1,
        "the first diagnostic must start at the first barline");
    assert(diagnostics[1].span.start === diagnostics[0].span.end && diagnostics[1].span.end === secondBarEnd,
        "the next diagnostic must cover from the previous barline through the closing barline");
});

test("meter 按声明处 strict 决定失配是否中断", () => {
    const source = `@set(strict=true) @meter(2,4) | 1 |`;
    let thrown: unknown = null;
    try {
        lower(source);
    } catch (error) {
        thrown = error;
    }
    assert(thrown instanceof ErrorDiagnostic && thrown.code === "E_METER_MISMATCH",
        "strict meter mismatch must throw E_METER_MISMATCH");
    assert(thrown.span.start === source.indexOf("|") + 1
        && thrown.span.end === source.lastIndexOf("|") + 1,
        "strict mismatch must cover the complete measure source");
});

test("meter 声明与变更建立各自的小节起点", () => {
    assert(lower(`1 @meter(2,4) 2 3 |`).diagnostics.length === 0,
        "content before the first meter must not be validated");
    assert(lower(`@meter(2,4) 1 2 @meter(3,4) 3 4 5 |`).diagnostics.length === 0,
        "a later meter must close the old measure and start a new one");
    assert(lower(`@meter(2,4) 1 2 | @meter(3,4) 3 4 5 |`).diagnostics.length === 0,
        "a meter at a barline must not create an empty measure diagnostic");
});

test("meter 使用紧凑字号绘制真分数", () => {
    const layout = layoutOf(`@meter(4,4)`);
    const meter = layout.objects[0];
    assert(meter.box.w > 0 && meter.box.h > 0 && nearly(meter.box.anchor, meter.box.w / 2),
        "meter must create a centered visible box");
    const commands = recordCommands(layout);
    const texts = commands.filter(command => command.kind === "text");
    const lines = commands.filter(command => command.kind === "rect");
    assert(texts.length === 2 && texts.every(command => command.text === "4"),
        "meter must draw numerator and denominator text");
    assert(lines.length === 1 && lines[0].w === meter.box.w,
        "meter must draw one full-width fraction line");
    assert(texts.every(command => nearly(command.style.fontSize, 22 * 0.7)),
        "meter must default each digit to 0.7em");
});

test("meter 在 strict 模式下直接拒绝非法参数", () => {
    let thrown: unknown = null;
    try {
        compileScore(`@set(strict=true) @meter(0,4)`);
    } catch (error) {
        thrown = error;
    }
    assert(thrown instanceof ErrorDiagnostic && thrown.code === "E_METER_INVALID",
        "strict invalid meter must throw E_METER_INVALID during parsing");
});