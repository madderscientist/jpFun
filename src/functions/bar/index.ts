import { LengthValue, ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes.js";
import { GrammarCallNodeTyped } from "../../parser/grammarType.js";
import { ColType, TemporalNodeBase } from "../../lowering/types.js";

class BarFunction extends ASTFunctionNode {
    static override def = {
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
            {   // 小节线样式类型，对应普通、终止和反复线
                name: "type",
                type: "number" as const,
                default: 0,
            },
            {
                name: "length",
                type: "length" as const,
                default: {
                    value: 1,
                    unit: "em",
                } as LengthValue,
            },
        ]
    };

    static deSugarAtom(source: string, start: number, _end: number) {
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
    barLength: number;    // 固化值

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [type, barlen] = this.getArgValue(args, ctx) as [number, LengthValue];
        this.type = type;
        this.barLength = ctx.length2px(barlen);
    }

    override loweringEnter(vars: unknown) {
        return [new BarTemporalNode(this)];
    }

    override toString() {
        return `@bar(${this.type}, ${this.barLength}px)`;
    }
}

export const BarNode: ASTFunctionClass = BarFunction;

class BarTemporalNode extends TemporalNodeBase {
    constructor(ast: BarFunction) {
        super();
        this.ast = ast;
        this.T = 0;
        this.type = ColType.ANCHOR;
    }
}