import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass, CanonicalParser } from "../types";

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

    static deSugar(parser: CanonicalParser, exec: boolean) {
        const ctx = parser.context;
        const source = ctx.source;
        let barCnt = 0;
        let pos = parser.cursor;
        while (pos < parser.end && source[pos] === '|') {
            barCnt++;
            pos++;
        }
        // 后面还有内容，不能收割前面的
        if (barCnt === 0) return null;
        return {
            next: pos,
            canConsumeNumber: 0,
        };
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