import { ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass, type LengthValue } from "../ASTtypes.js";
import { ParserContext, skipSpaces, skipSpacesBack } from "../../parser/parserContext.js";
import { TemporalNodeBase } from "../temporal.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { LoweringResult } from "../../lowering/types.js";
import { GrammarCallNodeTyped } from "../../parser/grammarType.js";
import { Diagnostic } from "../../diagnostic.js";
import { Fraction } from "../../fraction.js";

class BrFunction extends ASTFunctionNode {
    static override def = {
        name: ["br"],
        description: "换行",
        details: `\
~~~jpfun
@set(br.gap=1.5em)
1 2 @br() 3 4 @br(3em) 5 6
~~~

\`@br()\` 换到下一行，连写 \`@br() @br()\` 叠加两段行距；用 \`@set(br.gap=...)\` 设置后续默认行距

**简写**：仅在顶层，连续至少两个换行表示换行`,
        allowExtraArgs: false,
        args: [
            {
                name: "gap",
                description: "上一行下沿到下一行主旋律上沿的标准间距；下一行顶部外扩记号优先借用这段间距",
                type: "length" as const,
                default: { value: 1, unit: "em" as const },
            },
            {
                name: "minGap",
                description: "顶部外扩记号借用间距后，与上一行保留的最小间距",
                type: "length" as const,
                default: { value: 0.4, unit: "em" as const },
            },
        ],
    };

    static override deSugarAtom(source: string, start: number, end: number, depth: number) {
        if (depth > 0) return null;  // 语法糖只在顶层生效
        if (source[start] !== '\n') return null;
        // 前一个 \n 必须留在 nodes 里，否则顶层 voice 后的 \n\n 会被吸进 voice 的 children
        if (source[skipSpacesBack(source, start - 1)] !== '\n') return null;
        let next = start + 1, p = next;
        while ((p = skipSpaces(source, p, end)) < end && source[p] === '\n') next = ++p;
        const node: GrammarCallNodeTyped = {
            kind: "call",
            typed: true,
            name: "br",
            args: new Map(),
            span: { start, end: next },
        };
        return { next, node };
    }

    readonly lineGap;

    override loweringEnter(ctx: LoweringContext) {
        ctx.deferFinalize(BrFunction.loweringFinalize);
        const br = new TemporalNodeBase();
        br.ast = this;
        br.mergeKey = -1;
        br.addon = { breakBefore: this.lineGap };
        return [br];
    }

    /**
     * 换行与换页共享校验；边界会切开全谱，不能截断持续事件
     */
    static loweringFinalize(result: LoweringResult) {
        const latestEnd = new Fraction();
        const candidateEnd = new Fraction();
        let latestNode: TemporalNodeBase | null = null;

        for (const column of result.columns) {
            if (latestNode && latestEnd.compare(column.t) > 0 && column.some(node => node.addon?.breakBefore)) {
                throw Diagnostic.error.BreakInsideEvent(latestNode.ast.sourceSpan);
            }

            for (const node of column) {
                if (node.T.isZero()) continue;
                candidateEnd.copyFrom(node.t).add(node.T);
                if (!latestNode || candidateEnd.compare(latestEnd) > 0) {
                    latestEnd.copyFrom(candidateEnd);
                    latestNode = node;
                }
            }
        }
    }

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        const [gap, minGap] = (this.getArgValue(args, ctx) as LengthValue[]).map(value => ctx.length2px(value));
        this.lineGap = { gap, minGap };
    }

    override toString() { return `@br(gap=${this.lineGap.gap}px, minGap=${this.lineGap.minGap}px)`; }
}

export const BrNode = BrFunction satisfies ASTFunctionClass;