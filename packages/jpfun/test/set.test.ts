import { test } from "node:test";

import { compileScore } from "../src/pipeline.js";
import { assert, commandsOfKind, layoutOf, nearly } from "./helpers.js";

test("默认值按目标参数的声明类型固化", () => {
    // 旧实现把值一律存成 raw text，length 类型的默认值到不了 length2px
    const size = layoutOf(`@set(text.size=2em) @text(A)`).objects[0].ast.size;
    assert(nearly(size, 44), `expected 2em to freeze to 44px, got ${size}`);
});

test("别名写法归一到主名", () => {
    const [digit] = commandsOfKind(`@set(n.color=#f00) 1`, "text");
    assert(digit.style.fill === "#f00", `alias must reach note.color, got ${digit.style.fill}`);
});

test("fontsize 写 em 时相对当前字号", () => {
    const size = layoutOf(`@set(fontsize=2em) @text(A)`).objects[0].ast.size;
    assert(nearly(size, 44), `expected 2em to resolve against 22px, got ${size}`);
});

test("bool 默认值不会被当成非空字符串", () => {
    // 旧实现存字符串 "false"，恒为真，反而打开了 strict
    const { diagnostics } = compileScore(`@set(strict=false) @nosuchfn()`);
    assert(diagnostics.some(item => item.code === "W_UNKNOWN_FUNCTION"),
        "strict=false must keep the unknown function tolerant");
});

test("目标参数不存在时报警而不是静默无效", () => {
    const source = `@set(text.sizee=2em) @text(A)`;
    const item = compileScore(source).diagnostics.find(d => d.code === "W_SET_UNKNOWN_TARGET");
    assert(item !== undefined, "a mistyped target must be reported");
    assert(source.slice(item.span.start, item.span.end) === "text.sizee",
        `the warning must point at the key itself, got ${source.slice(item.span.start, item.span.end)}`);
});
