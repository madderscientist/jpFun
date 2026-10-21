import { deepStrictEqual, ok } from "node:assert/strict";

import { ErrorDiagnostic } from "../src/diagnostic.js";
import { ASTBraceNode } from "../src/functions/ASTtypes.js";
import { defaultFunctions } from "../src/functions/default.js";
import { createLayoutPrepareContext } from "../src/layout/default.js";
import { layoutDocument, type DocumentLayoutResult } from "../src/layout/engine.js";
import { paintLayout } from "../src/render/paint.js";
import type { PlacedAttachment } from "../src/layout/types.js";
import { LoweringContext } from "../src/lowering/loweringContext.js";
import { ParserContext } from "../src/parser/parserContext.js";
import { preprocessSource } from "../src/parser/preprocess.js";
import { compileScore, type CompileScoreOptions } from "../src/pipeline.js";
import type {
    PlaybackNoteOffEvent,
    PlaybackNoteOnEvent,
    PlaybackPlan,
} from "../src/playback/types.js";
import { RecordingPainter, type RecordedPaintCommand } from "../src/render/recording.js";

export function assert(condition: unknown, message: string): asserts condition {
    ok(condition, message);
}

/** 几何断言统一走这个容差，不要在用例里另写 1e-6 */
export function nearly(a: number, b: number) {
    return Math.abs(a - b) < 1e-6;
}

// ---- 流水线入口 ----
// 需要完整结果时，无诊断场景用 compileValid，否则直接用 compileScore

/** 成功场景统一检查诊断，避免只验证结果而漏掉警告 */
export function compileValid(source: string, options?: CompileScoreOptions) {
    const result = compileScore(source, options);
    deepStrictEqual(result.diagnostics, [], source);
    return result;
}

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

/** 测试专用的事件配对视图；生产 API 仍只暴露 NoteOn/NoteOff */
export function playedNotes(plan: PlaybackPlan) {
    const noteOffs = new Map<number, PlaybackNoteOffEvent>();
    for (const event of plan.events) {
        if (event.kind === "note-off") noteOffs.set(event.noteId, event);
    }
    return plan.events
        .filter((event): event is PlaybackNoteOnEvent => event.kind === "note-on")
        .map(note => {
            const off = noteOffs.get(note.noteId);
            assert(off, `NoteOn ${note.noteId} 缺少 NoteOff`);
            let bpm = 120;
            for (const event of plan.events) {
                if (event.at.compare(note.at) > 0) break;
                if (event.kind === "tempo") bpm = event.bpm;
            }
            return {
                ...note,
                start: note.at,
                end: off.at,
                duration: off.at.clone().sub(note.at),
                bpm,
            };
        });
}

/** 只有要先改 LoweringResult 再单独布局的用例才需要它，其余一律走 layoutOf */
export const layoutContext = createLayoutPrepareContext(defaultFunctions);

export function layoutOf(source: string, fontSize?: number) {
    return compileScore(source, { variables: fontSize === undefined ? undefined : { fontsize: fontSize } }).layout;
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

export function attachmentCommands(attachment: PlacedAttachment) {
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
