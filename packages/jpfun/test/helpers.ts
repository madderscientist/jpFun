import { ok } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ErrorDiagnostic } from "../src/diagnostic.js";
import { ASTBraceNode } from "../src/functions/ASTtypes.js";
import { defaultFunctions } from "../src/functions/default.js";
import { createLayoutPrepareContext } from "../src/layout/default.js";
import { layoutDocument, type DocumentLayoutResult } from "../src/layout/engine.js";
import { paintLayout } from "../src/render/paint.js";
import type { LayoutAttachment } from "../src/layout/types.js";
import { LoweringContext } from "../src/lowering/loweringContext.js";
import { ParserContext } from "../src/parser/parserContext.js";
import { preprocessSource } from "../src/parser/preprocess.js";
import { compileScore } from "../src/pipeline.js";
import { RecordingPainter, type RecordedPaintCommand } from "../src/render/recording.js";

export function assert(condition: unknown, message: string): asserts condition {
    ok(condition, message);
}

/** 几何断言统一走这个容差，不要在用例里另写 1e-6 */
export function nearly(a: number, b: number) {
    return Math.abs(a - b) < 1e-6;
}

// ---- 流水线入口 ----
// 需要 parser / lowering 中间结果时直接用 compileScore，下面只是各阶段的短写法

export function createParser(source: string) {
    const parser = new ParserContext({ source });
    parser.registerFunctions(defaultFunctions);
    return parser;
}

export function parse(source: string) {
    const { maskedSource } = preprocessSource(source);
    const nodes = createParser(maskedSource).parse();
    return new ASTBraceNode({ start: 0, end: source.length }, nodes);
}

export function createLowering() {
    const lowering = new LoweringContext();
    lowering.registerFunctions(defaultFunctions);
    return lowering;
}

export function lower(source: string) {
    return createLowering().lowerDocument(parse(source));
}

/** 只有要先改 LoweringResult 再单独布局的用例才需要它，其余一律走 layoutOf */
export const layoutContext = createLayoutPrepareContext(defaultFunctions);

export function layoutOf(source: string, fontSize?: number) {
    return compileScore(source, { fontSize }).layout;
}

// ---- 绘制记录 ----

export function recordCommands(result: DocumentLayoutResult) {
    const recording = new RecordingPainter();
    paintLayout(result, recording);
    return recording.commands;
}

export function commandsOfKind<K extends RecordedPaintCommand["kind"]>(
    source: string,
    kind: K,
    fontSize?: number,
) {
    return recordCommands(layoutOf(source, fontSize)).filter(
        (command): command is Extract<RecordedPaintCommand, { kind: K }> => command.kind === kind,
    );
}

export function attachmentCommands(attachment: LayoutAttachment) {
    const recording = new RecordingPainter();
    attachment.paint(recording);
    return recording.commands;
}

// ---- 断言工具 ----

/** 捕获 run 抛出的 ErrorDiagnostic 并校验它的 code；没抛出就是测试失败 */
export function expectDiagnostic(run: () => unknown, code: string) {
    try {
        run();
    } catch (error) {
        assert(error instanceof ErrorDiagnostic, `Expected ${code} to throw ErrorDiagnostic, got ${String(error)}`);
        assert(error.code === code, `Expected ${code}, got ${error.code}`);
        return error;
    }
    throw new Error(`Expected ${code}`);
}

export function expectLoweringError(source: string, code: string) {
    return expectDiagnostic(() => lower(source), code);
}

export function expectCompileError(source: string, code: string) {
    return expectDiagnostic(() => compileScore(source), code);
}

/** 只在布局期才抛出的错误，必须先单独跑完 lowering */
export function expectLayoutError(source: string, code: string) {
    const lowered = lower(source);
    return expectDiagnostic(() => layoutDocument(lowered, layoutContext), code);
}

const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "__snapshots__");
// pnpm/npm 把当前脚本名写进环境变量，因此 `pnpm test:update` 就是重写基线
const UPDATE_SNAPSHOTS = process.env.UPDATE_SNAPSHOTS === "1"
    || process.env.npm_lifecycle_event === "test:update";

/**
 * 把几何数值等"只能靠肉眼确认一次"的输出固定成基线文件
 * 确认新值正确后用 `pnpm test:update` 重写基线
 */
export function expectSnapshot(name: string, actual: string) {
    const file = join(SNAPSHOT_DIR, `${name}.txt`);
    const write = () => {
        mkdirSync(SNAPSHOT_DIR, { recursive: true });
        writeFileSync(file, `${actual}\n`, "utf8");
    };
    if (UPDATE_SNAPSHOTS) return write();
    if (!existsSync(file)) {
        // 本地缺基线是新增快照，写出来交给人 review；CI 上缺基线只可能是漏提交
        assert(!process.env.CI, `快照 "${name}" 的基线文件缺失，它必须随代码一起提交`);
        return write();
    }
    const expected = readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
    assert(
        actual === expected,
        `快照 "${name}" 不匹配\n实际:\n${actual}\n基线:\n${expected}\n`
        + `确认新值符合预期后运行 pnpm test:update 更新基线`,
    );
}
