import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType";
import { deSugarRelationFunction } from "../../parser/parserContext";

function parseAutoBeamFlag(raw: unknown, fallback: boolean): boolean {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "number") return raw !== 0;
    if (typeof raw === "string") {
        const normalized = raw.trim().toLowerCase();
        if (normalized === "true" || normalized === "1" || normalized === "on") return true;
        if (normalized === "false" || normalized === "0" || normalized === "off") return false;
    } return fallback;
}

class DivFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["div", "/"],
        description: "减时线",
        example: `@div(C1, 2): C1下方创建2根减时线
@/({C1 C2 @dash()}, 3): C1、C2和增时线下方创建3根减时线并连接
语法糖：在音符后加斜杠'/'，可以多个
@div(C1, 2) === C1//
@div(C1 C2/ @dash(), 2) === {C1 C2/ @dash()}//
设置命名参数前缀: div
`,
        allowExtraArgs: false,
        args: [
            {
                type: "content",
                default: null,
            },
            {
                name: "n",
                type: "number",
                default: 1,
            },
        ]
    };

    static deSugarAtom(source: string, start: number, end: number) {
        // 检查 / 的数量
        let divCnt = 0;
        let pos = start;
        while (pos < end && source[pos] === '/') {
            divCnt++;
            pos++;
        }
        if (divCnt === 0) return null;
        // 对前一个节点的探查放到 deSugarRelation 中
        const node: GrammarSugarNode = {
            kind: "sugar",
            data: {
                class: DivFunction,
                n: divCnt,
            },
            span: { start, end: pos },
        };
        return { next: pos, node };
    };

    static deSugarRelation: deSugarRelationFunction = (ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) => {
        const n = nodes[at++] as GrammarSugarNode;
        if (n.data?.class !== DivFunction) return null;
        // 向前找到第一个有效节点
        const prev = ASTFunctionNode.findLastFuncContentNode(ctx.nodes, ctx.nodes.length - 1);
        if (!prev) return at;   // 没有了 直接当作无效文本跳过
        if (prev instanceof DivFunction) {
            // 已经是div了 继续加深
            prev.n += n.data.n;
            return at;
        }
        const argMap: FunctionArgs = new Map();
        argMap.set(0, prev);
        argMap.set("n", n.data.n);
        const spanPrev = prev.sourceSpan;
        const node = new DivFunction({
            start: Math.min(spanPrev.start, n.span.start),
            end: Math.max(spanPrev.end, n.span.end),
        }, argMap, ctx, null);
        ctx.nodes.pop();    // 消耗掉prev
        ctx.pushNode(node);
        return at;
    }

    content: ASTNodeBase;
    n: number;
    autoBeamEnabled: boolean;   // 是否自动连接减时线
    get children() { return [this.content]; }
    timeFlowMode() { return "transparent" as const; }

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.content, this.n] = this.getArgValue(args, ctx) as [ASTNodeBase, number];
        this.autoBeamEnabled = parseAutoBeamFlag(ctx.variables["autobeam"], true);
        // div 允许修饰任意 都会加下划线
        this.content.parent = this;
    }

    toString(source: string): string {
        return `@div(${this.content.toString(source)}, ${this.n})`;
    }
}

export const DivNode: ASTFunctionClass = DivFunction;
