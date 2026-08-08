import { ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass, functionAddonKey } from "../ASTtypes.js";
import { ErrorDiagnostic } from "../../diagnostic.js";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import type { LayoutDecorationHandler } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";

const DOT_FUNC_NAME = "dot";
const DOT_ADDON_KEY = functionAddonKey(DOT_FUNC_NAME);

function durationFactor(count: number) {
    return 2 - Math.pow(2, -count);
}

class DotFunction extends ASTFunctionNode {
    static override def = {
        name: [DOT_FUNC_NAME, "."],
        description: "附点",
        example: `@dot(C1, 2): C1右侧创建2个点 仅接收一个可接收元素
语法糖：在音符后加斜杠'.'，可以多个
@dot(C1, 2) === C1..
@dot(C1 C2/ @dash(), 2) 报错 因为点只能接收一个元素
设置命名参数前缀: dot
`,
        allowExtraArgs: false,
        args: [
            {
                type: "content" as const,
                default: null,
            },
            {
                name: "n",
                type: "number" as const,
                default: 1,
            },
        ]
    };

    static override deSugarAtom(source: string, start: number, end: number) {
        // 检查 . 的数量
        let dotCnt = 0;
        let pos = start;
        while (pos < end && source[pos] === '.') {
            dotCnt++;
            pos++;
        }
        if (dotCnt === 0) return null;
        // 对前一个节点的探查放到 deSugarRelation 中
        const node: GrammarSugarNode = {
            kind: "sugar",
            data: {
                class: DotFunction,
                n: dotCnt,
            },
            span: { start, end: pos },
        };
        return { next: pos, node };
    };

    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
        const n = nodes[at++] as GrammarSugarNode;
        if (n.data?.class !== DotFunction) return null;
        // 向前找到第一个有效节点
        const prev = ASTFunctionNode.findLastFuncContentNode(ctx.nodes, ctx.nodes.length - 1);
        if (!prev) return at;   // 没有了 直接当作无效文本跳过
        if (prev instanceof DotFunction) {
            // 已经是dot了 继续加深
            prev.n += n.data.n;
            return at;
        }
        // 参数数量不校验 在构造函数里写
        const argMap: FunctionArgs = new Map();
        argMap.set(0, prev);
        argMap.set("n", n.data.n);
        const spanPrev = prev.sourceSpan;
        const node = new DotFunction({
            start: Math.min(spanPrev.start, n.span.start),
            end: Math.max(spanPrev.end, n.span.end),
        }, argMap, ctx, null);
        ctx.nodes.pop();    // 消耗掉prev
        ctx.pushNode(node);
        return at;
    }

    /**
     * 附点是目标对象右侧的通用装饰
     * 默认从目标右边界、视觉轴开始排列；目标可用 ports["dot"] 覆盖锚点
     */
    static override layoutDecorationHandler: LayoutDecorationHandler = (host, value) => {
        const count = Math.max(0, Math.floor(Number(value) || 0));
        if (count === 0) return null;

        const radius = host.ast.size * 0.075;
        const gap = host.ast.size * 0.12;
        const anchor = host.ports["dot"] ?? {
            x: host.box.w,
            y: host.box.visualAxis,
        };
        const start = anchor.x + gap + radius;
        const step = radius * 2 + gap;
        const right = start + (count - 1) * step + radius;
        // 自定义锚点可能已经位于扩张后的盒内，也可能在盒外
        host.box.w = Math.max(host.box.w, right);

        return {
            paint(painter, currentHost) {
                const centerY = currentHost.box.y + anchor.y;
                for (let i = 0; i < count; i++) {
                    painter.drawCircle(
                        currentHost.box.x + start + i * step,
                        centerY,
                        radius,
                        { fill: "#000" },
                    );
                }
            },
        };
    };
    override loweringEnter(ctx: LoweringContext) {
        const count = this.n;
        ctx.beginLoweringGroup(this, {
            onTemporal(node) {
                if (count === 0) return;
                const addon = node.addon ??= {};
                const current = Number(addon[DOT_ADDON_KEY]) || 0;
                const total = current + count;
                node.T *= durationFactor(total) / durationFactor(current);
                addon[DOT_ADDON_KEY] = total;
            },
        });
        return [];
    }
    override loweringExit(ctx: LoweringContext) {
        ctx.endLoweringGroup(this);
        return [];
    }
    override timeFlowModel() {
        return {
            children: [this.content],
            mode: "sequence" as const,
        }
    }

    content: ASTNodeBase;
    n: number;
    override get children() { return [this.content]; }

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.content, this.n] = this.getArgValue(args, ctx) as [ASTNodeBase, number];
        const contentJudge = DotFunction.leafNum(this.content);
        if (contentJudge !== 1) {
            throw new ErrorDiagnostic(
                "E_DOT_INVALID_CONTENT",
                `函数 @dot 只能接收 1个元素，但找到了 ${contentJudge} 个`,
                sourceSpan
            );
        }
        this.content.parent = this;
    }

    override toString(source: string) {
        return `@dot(${this.content.toString(source)}, ${this.n})`;
    }

    // 判断叶节点数量
    static leafNum(node: ASTNodeBase): number {
        let count = 0;
        const chs = node.children;
        if (chs) {  // 不是叶节点
            for (const child of chs) count += DotFunction.leafNum(child);
        } else count ++;
        return count;
    }
}

export const DotNode: ASTFunctionClass = DotFunction;