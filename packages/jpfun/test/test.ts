import { ParserContext } from "../src/parser/parserContext.js";
import { defaultFunctions } from "../src/functions/default.js";
import { preprocessSource } from "../src/parser/preprocess.js";
import { ASTBraceNode } from "../src/functions/ASTtypes.js";
import { LoweringContext } from "../src/lowering/loweringContext.js";

function parseScript(source: string) {
    console.log("原始源码:");
    console.log(source.replace(/ /g, '·'));
    const { maskedSource, lineStarts } = preprocessSource(source);
    console.log("预处理后的源码:");
    console.log(maskedSource.replace(/ /g, '·'));
    const ctx = new ParserContext({ source: maskedSource });
    ctx.registerFunctions(defaultFunctions);
    let success = true;
    try {
        ctx.parse();
    } catch (e) {
        success = false;
    }
    return { ctx, success, lineStarts, maskedSource };
}

function lowering(node: ASTBraceNode) {
    const ctx = new LoweringContext();
    ctx.registerFunctions(defaultFunctions);
    const columns = ctx.lowerDocument(node).columns;
    return { ctx, columns };
}

const testInput = `@set(text="100% ok")   % 字符串内的%不触发注释
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

console.log("========== test parser ==========");
const legacy = parseScript(testInput);
console.log("解析结果:");
console.log(legacy.success);
const node = new ASTBraceNode({ start: 0, end: testInput.length }, legacy.ctx.nodes);
console.log("去糖源码:");
console.log(node.toString(legacy.maskedSource));
console.log("诊断信息：");
for (const diag of legacy.ctx.diagnostics) {
    console.log(diag.toLineCol(legacy.lineStarts), diag.message);
}
console.log("\n========== test time flow ==========");
const timeflow = lowering(node);
console.log("时间流结果:");
console.log(timeflow.columns);