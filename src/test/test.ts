import { ParserContext } from "../parser/parseContext";
import { CanonicalParser } from "../parser/canonicalParser";
import { defaultFunctions } from "../functions/default";
import { preprocessSource } from "../parser/preprocess";
import { ASTBraceNode } from "../functions/types";

function parseScript(source: string) {
    console.log("原始源码:");
    console.log(source);
    const { maskedSource, lineStarts } = preprocessSource(source);
    console.log("预处理后的源码:");
    console.log(maskedSource);
    const ctx = new ParserContext({ source: maskedSource });
    ctx.registerFunctions(defaultFunctions);
    const parser = new CanonicalParser(ctx);
    const success = parser.parse();
    return { ctx, parser, success, lineStarts };
}

const testInput = `@set(text="100% ok") % 字符串内的%不触发注释
@.(@n(F#,,4,"#00f")) @unknown(C4, 3);
@voice(
    {@note(C4,4)/ #5,,. | {4b4}//},
    男 = ha ha, % 测试
    女 = la la
)
N(测试): A1 A2 D#/ :|| #1 b4
L: 测试voice语法糖
L(歌词2): 测试歌词语法糖
N: 12345
N:3
`;

const legacy = parseScript(testInput);
console.log("解析结果:");
console.log(legacy.success);
const node = new ASTBraceNode({ start: 0, end: testInput.length }, legacy.parser.context.toConsume);
console.log("去糖源码:");
console.log(node.toString(testInput));
console.log("诊断信息：");
for (const diag of legacy.ctx.diagnostics) {
    console.log(diag.toLineCol(legacy.lineStarts), diag.message);
}