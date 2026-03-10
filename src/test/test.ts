import { ParserContext } from "../parser/parseContext";
import { CanonicalParser } from "../parser/canonicalParser";
import { defaultFunctions } from "../functions/default";
import { ASTBraceNode } from "../functions/types";

const testInput = `
@.(@n(F#,,4,"#00f"))
@voice(
    {@note(C4,4)/ #5,,. | {4b4}//},
    男 = ha ha,
    女 = la la
)`;
console.log("源代码:\n",testInput);

const ctx = new ParserContext({
    source: testInput,
});
ctx.registerFunctions(defaultFunctions);

const parser = new CanonicalParser(ctx);
parser.parse();

const node = new ASTBraceNode({ start: 0, end: testInput.length }, parser.context.toConsume);
console.log("去糖源码:\n",node.toString(testInput));
console.log("diagnostics:\n", parser.context.diagnostics);