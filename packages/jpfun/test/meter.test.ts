import { test } from "node:test";

import type { Fraction } from "../src/fraction.js";
import { compileScore } from "../src/pipeline.js";
import { compilePlayback } from "../src/playback/compile.js";
import { pathBounds } from "../src/layout/path.js";
import { assert, expectCompileError, layoutOf, lower, nearly, recordCommands } from "./helpers.js";

type MeterAst = {
    numerator: number;
    denominator: number;
    measureDuration?: Fraction;
};

test("folded meters validate global measures", () => {
    for (const content of ["@up(1,@meter(3,4))", "@down(1,@meter(3,4))", "@up(1,{@up(@meter(3,4))})"]) {
        expectCompileError(`@set(strict=true) ${content} | 2 |`, "E_METER_MISMATCH");
        assert(compileScore(`${content} | 2 3 4 |`).diagnostics.length === 0, "complete folded-meter measures must pass");
    }
    assert(compileScore("@set(strict=true) @up(1,{@up(@meter(0,0))}) | 2 | 3 4 5 6 7 |").diagnostics.length === 0,
        "folded free meters must suspend global measure validation");
});

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
        assert(meter.measureDuration?.equals(expected[2], expected[3]),
            `${source} must freeze its exact measure duration`);
    }

    const events = lower(`@meter(6,8) 1 2/`).columns.flat();
    assert(events[1].T.equals(1) && events[2].T.equals(1, 2),
        "meter must not change bare or divided note durations");
});

test("meter 非法参数默认回落为 4/4，strict 模式报错", () => {
    for (const source of ["@meter(-1,4)", "@meter(3.5,4)", "@meter(4,-1)", "@meter(0,-1)", "@meter(3.5,0)"]) {
        const compiled = compileScore(source);
        const meter = compiled.lowering.columns[0][0].ast as unknown as MeterAst;
        assert(meter.numerator === 4 && meter.denominator === 4 && meter.measureDuration?.equals(4),
            `${source} must fall back to 4/4`);
        assert(compiled.diagnostics.some(diagnostic => diagnostic.code === "W_METER_INVALID"),
            `${source} must report W_METER_INVALID`);
        expectCompileError(`@set(strict=true) ${source}`, "E_METER_INVALID");
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
    const diagnostic = expectCompileError(source, "E_METER_MISMATCH");
    assert(diagnostic.span.start === source.indexOf("|") + 1
        && diagnostic.span.end === source.lastIndexOf("|") + 1,
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

test("meter 零分子或零分母表示散板，不限制小节时长", () => {
    for (const [num, den] of [[0, 4], [4, 0], [0, 0]]) {
        const source = `@set(strict=true) @meter(${num},${den}) | 1 | 2 3 4 5 6 | 7/`;
        const result = compileScore(source);
        assert(result.diagnostics.length === 0, "free meter must not report invalid or mismatched measures");
        const meter = result.lowering.columns[0][0].ast as unknown as MeterAst;
        assert(meter.numerator === num && meter.denominator === den && meter.measureDuration === undefined,
            "free meter must preserve its arguments without creating a fractional measure duration");
        assert(result.lowering.duration.equals(13, 2), "free meter must preserve note durations");
        const playback = compilePlayback(result.lowering);
        assert(!playback.events.some(event => event.kind === "time-signature"),
            "free meter must not emit an invalid numeric time signature for MIDI");
        assert(playback.performanceDuration.equals(13, 2), "free meter must preserve playback duration");
    }
});

test("meter 散板与固定拍号之间切换校验与连续休止状态", () => {
    const prefix = "@set(strict=true) @meter(2,4) | 1 2 | @meter(0,0) 3 | 4 5 6 7 1 |";
    const result = compileScore(`${prefix} @meter(3,4) 1 2 3 |`);
    assert(result.diagnostics.length === 0,
        "switching to free meter must suspend validation until a fixed meter is restored");
    expectCompileError(`${prefix} @meter(3,4) 1 |`, "E_METER_MISMATCH");
    expectCompileError("@set(strict=true) @meter(2,4) | 1 @meter(0,4)", "E_METER_MISMATCH");
    expectCompileError("@meter(4,4) @meter(0,4) @rest()", "E_REST_METER");
    assert(compileScore("@meter(0,4) @meter(3,4) @rest()").lowering.duration.equals(3),
        "a fixed meter after free meter must restore measure-rest duration");
});

test("meter 散板只绘制路径，墨迹与布局盒按 size 缩放", () => {
    for (const size of [12, 24]) {
        const layout = layoutOf(`@meter(0,0,size=${size}px)`);
        const box = layout.objects[0].box;
        const commands = recordCommands(layout);
        const paths = commands.filter(command => command.kind === "path");
        assert(paths.length > 0 && paths.length === commands.length,
            "free meter must paint paths instead of digits or a fraction bar");
        assert(nearly(box.h, size) && nearly(box.anchor, box.w / 2) && nearly(box.visualAxis, box.h / 2),
            "free meter height must equal size and remain centered");
        const bounds = paths.map(path => pathBounds(path.commands));
        assert(nearly(Math.min(...bounds.map(rect => rect.x)), box.x)
            && nearly(Math.min(...bounds.map(rect => rect.y)), box.y)
            && nearly(Math.max(...bounds.map(rect => rect.x + rect.w)), box.x + box.w)
            && nearly(Math.max(...bounds.map(rect => rect.y + rect.h)), box.y + box.h),
        "painted ink must match the layout box");
    }
});