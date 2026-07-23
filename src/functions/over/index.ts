import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass, ASTTextNode, ASTLabelNode, ASTBraceNode } from "../ASTtypes.js";
import { ParserContext } from "../../parser/parserContext.js";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import { ErrorDiagnostic } from "../../parser/diagnostic.js";
import {
    ColType,
    TemporalNodeBase,
    type LoweringResult,
} from "../../lowering/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import { layoutFragment, paintLayout, unionLayoutBoxes, type DocumentLayoutResult } from "../../layout/engine.js";
import type { LayoutBox, LayoutPassContext, LayoutPrepareContext } from "../../layout/types.js";
import type { Painter } from "../../render/types.js";

class OverFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["over"],
        description: "时间不对齐的上下层叠，总时长以第一个元素为准",
        example: `@over(content1, content2, ...)
语法糖: ^
{content1} ^ {content2} ^ ...
表示content1和content2在时间上完全重叠，通常用于和声等需要对齐的场景。可以有任意多个参数，至少需要两个参数。
`,
        allowExtraArgs: true,
        args: [],
    };

    static override deSugarAtom(source: string, start: number, _end: number) {
        if (source[start] === '^') {
            const node: GrammarSugarNode = {
                kind: "sugar",
                data: OverFunction,
                span: { start, end: start + 1 },
            }; return { next: start + 1, node };
        } return null;
    }

    // 这段代码同 stack
    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
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
        // 对 label 的特判: 目标变为label到被标记的节点范围内的所有节点
        if (overNode instanceof ASTLabelNode) {
            const tgt = overNode.parent;
            for (let j = i - 1; j >= 0; j--) {
                if (ctx.nodes[j] === tgt) {
                    overNode = new ASTBraceNode({
                        start: tgt.sourceSpan.start,
                        end: overNode.sourceSpan.end,
                    }, ctx.nodes.slice(j, i + 1), null);
                    break;
                }
            }
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
    override get children(): ASTNodeBase[] { return this.contents; }

    /**
     * over 对全局 lowering 表现为一个叶节点
     *
     * 每个参数在隔离作用域中独立 lowering
     * 子事件不会进入全局横向弹簧模型
     */
    override loweringEnter(vars: Record<string, any>, ctx?: LoweringContext) {
        if (!ctx) return [];

        // 外层 dot 和 div 应修饰 over 合并后的整体
        // 其他非装饰状态继续传入局部 lowering
        const localVars: Record<string, any> = {};
        for (const [key, value] of Object.entries(vars)) {
            if (key.startsWith("@")) continue;
            localVars[key] = value;
        }

        const layers = this.contents.map(content => ctx.lowerFragment(content, { ...localVars }));
        return [new OverNodeTemporal(this, layers)];
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        for (const [, value] of args) {
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

    override toString(source: string) {
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

// 到底应该当成一个节点、隐藏内部，还是暴露？
// 暴露的话 layout model 是有机制的，但是在 lowering 的接口中返回不能是 columns，要这么做得修改机制
// 隐藏的话在什么时候进行暴露？
class OverNodeTemporal extends TemporalNodeBase {
    constructor(ast: OverFunction) {
        super();
        this.ast = ast;
        this.T = 1;
        this.t = 0;
        this.type = ColType.DEFAULT;
    }
}