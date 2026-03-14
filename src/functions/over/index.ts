import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass, ASTTextNode } from "../ASTtypes";
import { ParserContext, deSugarRelationFunction } from "../../parser/parserContext";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType";
import { ErrorDiagnostic } from "../../parser/diagnostic";

class OverFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["over"],
        description: "时间对齐的上下层叠",
        example: `@over(content1, content2, ...)
语法糖: &
{content1} & {content2} & ...
表示content1和content2在时间上完全重叠，通常用于和声等需要对齐的场景。可以有任意多个参数，至少需要两个参数。
`,
        allowExtraArgs: true,
        args: [],
    };

    static deSugarAtom(source: string, start: number, end: number) {
        if (source[start] === '&') {
            const node: GrammarSugarNode = {
                kind: "sugar",
                data: OverFunction,
                span: { start, end: start + 1 },
            }; return { next: start + 1, node };
        } return null;
    }

    static deSugarRelation: deSugarRelationFunction = (ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) => {
        const n = nodes[at++] as GrammarSugarNode;
        if (!(n.kind === "sugar" && n.data === OverFunction)) return null;
        // 找上一个非文本节点 实现忽略中间内容的作用
        // 另一个做法是如果上一个不是可用节点就报错
        let i = ctx.nodes.length - 1;
        for (; i >= 0; i--) {
            if (ctx.nodes[i] instanceof ASTTextNode) continue;
            break;
        }
        let overNode: any = ctx.nodes[i];
        if (overNode === null) {
            const e = new ErrorDiagnostic(
                "OVER_NO_TARGET",
                "@over语法糖错误: 左边没有找到可叠加的目标",
                n.span
            );
            ctx.diagnostics.push(e);
            throw e;
        }
        if (!(overNode instanceof OverFunction)) {
            const newNode = new OverFunction(n.span, new Map(), ctx);
            newNode.addContent(overNode);
            overNode = newNode;
        }
        // 找到下一个非文本节点 通过全量后续解析的方式进行 还是有些trick
        const storage = ctx.nodes;
        ctx.nodes = [];
        ctx.makeNodes(nodes, at);
        for (let i = 0; i < ctx.nodes.length; i++) {
            // 后向跳过文本节点 和上面保持一致
            const n = ctx.nodes[i];
            if (n instanceof ASTTextNode) continue;
            (overNode as OverFunction).addContent(n);
            storage.length = i;
            storage.push(overNode);
            while (++i < ctx.nodes.length) storage.push(ctx.nodes[i]);
            ctx.nodes = storage;
            return nodes.length;
        }
        const e = new ErrorDiagnostic(
            "OVER_NO_TARGET",
            "@over语法糖错误: 右边没有找到可叠加的目标",
            n.span
        );
        ctx.diagnostics.push(e);
        throw e;
    }

    contents: ASTNodeBase[] = [];
    get children(): ASTNodeBase[] { return this.contents; }
    timeFlowMode() { return "parallel" as const; }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        for (const [key, value] of args) {
            if (value instanceof ASTNodeBase) {
                this.addContent(value);
                continue;
            }
            const c = ctx.parseArgWithType((value as SourceSpan).start, (value as SourceSpan).end, "content", span.start);
            if (c !== null) {
                this.addContent(c as ASTNodeBase);
            }
        }
    }

    addContent(node: ASTNodeBase) {
        if (node instanceof OverFunction) this.combine(node);
        else {
            this.contents.push(node);
            node.parent = this;
            const s = node.sourceSpan;
            this.sourceSpan.start = Math.min(this.sourceSpan.start, s.start);
            this.sourceSpan.end = Math.max(this.sourceSpan.end, s.end);
        }
    }

    toString(source: string): string {
        return `@over(${this.contents.map(c => c.toString(source)).join(", ")})`;
    }

    combine(ano: OverFunction): OverFunction {
        this.sourceSpan.start = Math.min(this.sourceSpan.start, ano.sourceSpan.start);
        this.sourceSpan.end = Math.max(this.sourceSpan.end, ano.sourceSpan.end);
        for (const c of ano.contents) c.parent = this;
        this.contents.push(...ano.contents);
        ano.contents.length = 0;
        return this;
    }
}

export const OverNode: ASTFunctionClass = OverFunction;