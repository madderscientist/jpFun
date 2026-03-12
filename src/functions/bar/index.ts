import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../types";
import { GrammarCallNodeTyped } from "../../parser/grammarType";

class BarFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["bar", "|"],
        description: "小节线",
        example: `@bar(type, lengthEM) 创建一个小节线
语法糖: 
- type0: '|' 普通小节线
- type1: '||' 终止小节线 左细右粗
- type2: '|:' 重复小节线 左粗右细
- type3: ':|'
- type4: ':|:' 左右反复
`,
        allowExtraArgs: false,
        args: [
            {   // 末尾小节线的样式类型 预留参数 目前无实际效果
                name: "type",
                type: "number",
                default: 0,
            },
            {
                name: "lengthEM",
                type: "number",
                default: 1,
            },
        ]
    };

    static deSugarAtom(source: string, start: number, end: number) {
        let pos = start;
        let type = 0;
        const slice2 = source.slice(pos, pos + 2);
        if (slice2 === "||") type = 1, pos += 2;
        else if (slice2 === "|:") type = 2, pos += 2;
        else if (slice2 === ":|") {
            if (source[pos + 2] === ":") type = 4, pos += 3;
            else type = 3, pos += 2;
        } else if (source[pos] === "|") type = 0, pos += 1;
        else return null;

        const argMap = new Map();
        argMap.set("type", type);
        const node: GrammarCallNodeTyped = {
            kind: "call",
            typed: true,
            name: "bar",
            args: argMap,
            span: { start, end: pos },
        };
        return { next: pos, node };
    };

    type: number;
    barLength: number; // 固化为像素

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.type, this.barLength] = this.getArgValue(args, ctx) as [number, number];
        this.barLength = this.barLength * ctx.fontSize;
    }

    toString(source: string): string {
        return `@bar(${this.type}, ${this.barLength})`;
    }
}

export const BarNode: ASTFunctionClass = BarFunction;