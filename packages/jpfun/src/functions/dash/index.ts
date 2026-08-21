import { ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes.js";
import { GrammarCallNodeTyped } from "../../parser/grammarType.js";
import { DEFAULT_KEY, TemporalNodeBase } from "../../lowering/types.js";
import type { LayoutBox } from "../../layout/types.js";
import type { Painter } from "../../render/types.js";

class DashFunction extends ASTFunctionNode {
    static override def = {
        name: ["dash", "-"],
        description: "增时线",
        example: `@dash() 创建一根增时线
语法糖: 一个 '-' 代表一个 @dash()
`,
        allowExtraArgs: false,
        args: []
    };

    static deSugarAtom(source: string, start: number, _end: number) {
        if (source[start] !== '-') return null;
        const node: GrammarCallNodeTyped = {
            kind: "call",
            typed: true,
            name: "-",
            args: new Map(),
            span: { start, end: start + 1 },
            syntaxKind: "atom",
        };
        return { next: start + 1, node };
    };

    size: number;

    constructor(span: SourceSpan, _args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        this.size = ctx.fontSize;
    }

    override loweringEnter() {
        return [new DashTemporalNode(this)];
    }

    override toString() { return "-"; }
}

export const DashNode: ASTFunctionClass = DashFunction;

class DashTemporalNode extends TemporalNodeBase {
    declare ast: DashFunction;
    declare box: LayoutBox;

    private lineY = 0;

    constructor(ast: DashFunction) {
        super();
        this.ast = ast;
        this.T = 1;
        this.mergeKey = DEFAULT_KEY;
        this.initLayoutBox();
    }

    override prepareLayout() {
        const size = this.ast.size;
        const width = size * 0.5;

        // dash 与数字音符共享视觉中心和完整字号高度
        // 线本身位于数字视觉中心，不使用极小的 glyph 高度作为轨道高度
        this.box.w = width;
        this.box.h = size;
        this.box.anchor = width / 2;
        this.lineY = size * 0.5;
        this.box.visualAxis = this.lineY;
    }

    override paint(painter: Painter) {
        painter.drawLine(
            this.box.x,
            this.box.y + this.lineY,
            this.box.x + this.box.w,
            this.box.y + this.lineY,
            { stroke: "#000", strokeWidth: Math.max(1, this.ast.size * 0.1) },
        );
    }
}