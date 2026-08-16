import { ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass, functionAddonKey } from "../ASTtypes.js";
import { GrammarNode, GrammarSugarNode } from "../../parser/grammarType.js";
import type { LayoutDecorationHandler, LayoutHost, LayoutPoint } from "../../layout/types.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";

const DIV_FUNC_NAME = "div";
export const DIV_ADDON_KEY = functionAddonKey(DIV_FUNC_NAME);

/** div 暴露自己的线段端口，不依赖任何关系函数 */
export function divLinePortName(level: number, edge: "left" | "right"): string {
    return `div.${level}.${edge}`;
}

interface DivLinePort extends LayoutPoint {
    /** 当前 layout 中该级局部线已由 beam 合并绘制 */
    claimed?: boolean;
}

export function claimDivLine(host: LayoutHost, level: number) {
    const port = host.ports[divLinePortName(level, "left")] as DivLinePort | undefined;
    if (port) port.claimed = true;
}

function parseAutoBeamFlag(raw: unknown): boolean {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "number") return raw !== 0;
    if (typeof raw === "string") {
        const normalized = raw.trim().toLowerCase();
        if (normalized === "true" || normalized === "1" || normalized === "on") return true;
        if (normalized === "false" || normalized === "0" || normalized === "off") return false;
    } return true;
}

class DivFunction extends ASTFunctionNode {
    static override def = {
        name: [DIV_FUNC_NAME, "/"],
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

    static override deSugarRelation(ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) {
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

    /**
     * 减时线是目标对象下方的通用装饰
     * 多对象自动连线属于 beam 的关系排版，不在这里猜测相邻元素
     */
    static override layoutDecorationHandler: LayoutDecorationHandler = (host, value) => {
        const count = Math.max(0, Math.floor(Number(value) || 0));
        if (count === 0) return null;

        const lineGap = host.ast.size * 0.14;
        const strokeWidth = Math.max(1, host.ast.size * 0.055);
        const lineBlockHeight = (count - 1) * lineGap + strokeWidth;
        let lineLeft = 0;
        let lineRight = 0;
        let firstLine = 0;

        return {
            // 减时线声明为靠近主体的下方项
            // 引擎只按通用 order 排列，不识别 @div
            below: {
                order: 0,
                gap: -host.ast.size * 0.08,
                height: lineBlockHeight,
                place(y) {
                    lineLeft = host.ports["body.left"]?.x ?? 0;
                    lineRight = host.ports["body.right"]?.x ?? host.box.w;
                    firstLine = y + strokeWidth / 2;

                    // 每一级提供完整局部范围
                    // 关系对象可以据此一次绘制整条连接线
                    for (let i = 0; i < count; i++) {
                        const lineY = firstLine + i * lineGap;
                        host.ports[divLinePortName(i, "left")] = {
                            x: lineLeft,
                            y: lineY,
                        };
                        host.ports[divLinePortName(i, "right")] = {
                            x: lineRight,
                            y: lineY,
                        };
                    }
                },
            },
            paint(painter) {
                // 未被关系对象接管的级别仍由本装饰独立绘制
                for (let i = 0; i < count; i++) {
                    const leftPort = host.ports[divLinePortName(i, "left")] as DivLinePort;
                    if (leftPort.claimed) continue;
                    const y = host.box.y + firstLine + i * lineGap;
                    painter.drawLine(
                        host.box.x + lineLeft,
                        y,
                        host.box.x + lineRight,
                        y,
                        { stroke: "#000", strokeWidth },
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
                addon[DIV_ADDON_KEY] = (Number(addon[DIV_ADDON_KEY]) || 0) + count;
                node.T /= 2 ** count;
            },
        });
        return [];
    }
    override loweringExit(ctx: LoweringContext) {
        ctx.endLoweringGroup(this);
        return [];
    }

    content: ASTNodeBase;
    n: number;

    /** parse 时冻结；只控制不同 div 之间的自动连接，不影响当前 div 内部连接 */
    autoBeamEnabled: boolean;
    override get children() { return [this.content]; }
    override timeFlowModel() {
        return {
            children: [this.content],
            mode: "sequence" as const,
        }
    }

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.content, this.n] = this.getArgValue(args, ctx) as [ASTNodeBase, number];
        // beam loweringAugment 只读取这个快照，不读取之后可能已经变化的 ParserContext
        this.autoBeamEnabled = parseAutoBeamFlag(ctx.variables["autobeam"]);
        // div 允许修饰任意 都会加下划线
        this.content.parent = this;
    }

    override toString(source: string) {
        return `@div(${this.content.toString(source)}, ${this.n})`;
    }
}

export const DivNode = DivFunction satisfies ASTFunctionClass;
