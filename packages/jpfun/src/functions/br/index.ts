import { ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes.js";
import { ParserContext, skipSpaces, skipSpacesBack } from "../../parser/parserContext.js";
import { ColType, TemporalNodeBase, type LoweringResult } from "../../lowering/types.js";
import { GrammarCallNodeTyped } from "../../parser/grammarType.js";
import { Diagnostic, WarningDiagnostic } from "../../diagnostic.js";

class BrFunction extends ASTFunctionNode {
    static override def = {
        name: ["br"],
        description: "换行",
        example: `@br(offset=1): 在后续事件前偏移指定行数
@br() === @br(1)
@br(2): 空出一行后继续
语法糖: [仅限顶层]至少连续两个换行
`,
        allowExtraArgs: false,
        args: [
            {
                name: "offset",
                type: "number" as const,
                default: 1,
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

    readonly offset: number;

    override loweringEnter() {
        const br = new TemporalNodeBase();
        br.ast = this;
        br.T = 0;
        br.type = ColType.SINGLE;
        br.breakBefore = this.offset;
        return [br];
    }

    /**
     * 检查换行是否切断了持续事件
     * 换行会把整条时间线切开，因此跨越换行点的持续事件无法被完整绘制
     */
    static override loweringFinalize = (result: LoweringResult) => {
        let latestEnd = -Infinity;
        let latestNode: TemporalNodeBase | null = null;

        for (const column of result.columns) {
            const t = column[0].t;

            if (latestEnd > t + 1e-6 && column.some(node => node.breakBefore > 0)) {
                throw Diagnostic.error.BreakInsideEvent(latestNode!.ast.sourceSpan);
            }
    
            for (const node of column) {
                const end = node.t + node.T;
                if (node.T > 1e-6 && end > latestEnd) {
                    latestEnd = end;
                    latestNode = node;
                }
            }
        }
    };

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        const [offset] = this.getArgValue(args, ctx) as [number];
        this.offset = Number.isFinite(offset) ? Math.max(1, Math.floor(offset)) : 1;
        if (this.offset !== offset) {
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_BR_OFFSET",
                `@br 的 offset 必须是大于等于 1 的整数，已被修正为 ${this.offset}`,
                this.sourceSpan
            ));
        }
    }

    override toString() { return `@br(${this.offset})`; }
}

export const BrNode: ASTFunctionClass = BrFunction;