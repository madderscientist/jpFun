import { test } from "node:test";

import { ASTBraceNode } from "../src/functions/ASTtypes.js";
import { preprocessSource } from "../src/parser/preprocess.js";
import { compileScore } from "../src/pipeline.js";
import { assert, createLowering, createParser, expectSnapshot, recordCommands } from "./helpers.js";

const SAMPLE_SCORE = `@set(text="100% ok")   % 字符串内的%不触发注释
@.(@n(F#,,4,"#00f"))@1 @unknown(C4, 3)C3/@2 ; @tie(1,2) C4 . /
@voice(
    {@note(C4,,4)/ #5,,. | {4b4}//},
    男 = ha-ha, % 测试
    女 = la la
)

N(测试): A1& B2 &{D#/F} :| #1\\
b4
L: 测试voice语法糖
L(歌词2): 测试\\
歌词语\\
法糖 \\\\
@set(note.color=#f00)
@stack(
    N: 1-.23-@tie(),
    N:3
) @br()
@over({#4', | Eb//}, F#5..)
`;

const { maskedSource, lineStarts } = preprocessSource(SAMPLE_SCORE);
const parser = createParser(maskedSource);
let parseError: unknown = null;
try {
    parser.parse();
} catch (error) {
    parseError = error;
}
const document = new ASTBraceNode({ start: 0, end: SAMPLE_SCORE.length }, parser.nodes);

test("综合示例乐谱可以完整解析", () => {
    assert(parseError === null, `示例乐谱必须能解析完成，实际抛出 ${parseError}`);
    assert(maskedSource.length === SAMPLE_SCORE.length, "预处理不能改变源码长度");
    expectSnapshot("pipeline-desugared", document.toString(maskedSource));
    expectSnapshot("pipeline-diagnostics", parser.diagnostics
        .map(diagnostic => {
            const range = diagnostic.toLineCol(lineStarts);
            return `${diagnostic.code} `
                + `${range.startLine}:${range.startColumn}-${range.endLine}:${range.endColumn} `
                + diagnostic.message;
        })
        .join("\n"));
});

test("综合示例乐谱可以完成时间固化", () => {
    const columns = createLowering().lowerDocument(document).columns;
    assert(columns.length > 0, "时间固化必须产生时间列");
    expectSnapshot("pipeline-timeflow", columns
        .map((column, index) => `${index}: ` + column
            .map(event => `${event.constructor.name}(t=${event.t},T=${event.T})`)
            .join(" "))
        .join("\n"));
});

test("compileScore 一次性返回可直接渲染的完整结果", () => {
    const source = "1 % comment\n2 | 3";
    const compiled = compileScore(source);
    assert(compiled.layout.objects.length === 4, "compileScore must return a directly renderable layout");
    assert(compiled.lowering.columns.length === 4, "compileScore must preserve the complete lowering result");
    assert(compiled.diagnostics.length === 0, "valid default pipeline input must not create diagnostics");
    assert(compiled.maskedSource === preprocessSource(source).maskedSource,
        "compileScore must expose the offset-preserving preprocessing result");
});

test("多声部跨行乐谱的轨道、歌词与连音线", () => {
    const compiled = compileScore(`@voices(
    @voice({1@a}, A),
    @voice({2}, B),
    @voice({3}, C, "春")
)
@br()
@voices(
    @voice({4@b}, A),
    @voice({5}, B),
    @voice({@stack({6},{7})}, C)
)
@tie(a,b)`);
    assert(compiled.layout.lineCount === 2, "the integration score must contain two systems");
    assert(
        new Set(compiled.layout.objects.map(object => object.track)).size === 4,
        "the integration score must contain three voice lanes plus one temporary stack lane",
    );
    assert(
        !compiled.layout.objects.some(object => object.track === compiled.lowering.rootTrack),
        "no voice may reuse the empty host track of a voices block",
    );
    const commands = recordCommands(compiled.layout);
    assert(
        commands.some(command => command.kind === "text" && command.text === "春"),
        "the integration score must render lyrics",
    );
    assert(
        commands.filter(command => command.kind === "path").length >= 2,
        "the integration score must render a cross-system tie",
    );
});
