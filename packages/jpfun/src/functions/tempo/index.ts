import { TemporalNodeBase } from "../../lowering/types.js";
import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, LengthValue, ParserContext, SourceSpan } from "../ASTtypes.js";
import type { LayoutBox, LayoutPrepareContext } from "../../layout/types.js";
import type { Painter, TextStyle } from "../../render/types.js";
import { prepareQuarterNote, type PreparedQuarterNote } from "./glyph.js";

class TempoFunction extends ASTFunctionNode {
    static override def = {
        name: ["tempo"],
        description: "设置时间线上的速度",
        example: `@tempo(96) 将其后的时间状态速度设置为 96 BPM`,
        allowExtraArgs: false,
        args: [
            {
                name: "bpm",
                type: "number" as const,
                default: null,
            },
            {
                name: "size",
                type: "length" as const,
                default: {
                    value: 1,
                    unit: "em",
                } as LengthValue,
            },
        ],
    };

    bpm: number;
    size: number;

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [bpm, size] = this.getArgValue(args, ctx) as [number, LengthValue];
        this.bpm = bpm;
        this.size = ctx.length2px(size);
    }

    override loweringEnter() {
        return [new TempoTemporalNode(this)];
    }

    override toString() { return `@tempo(${this.bpm})`; }
}

export const TempoNode: ASTFunctionClass = TempoFunction;

class TempoTemporalNode extends TemporalNodeBase {
    declare ast: TempoFunction;
    declare box: LayoutBox;

    /** 字号和 bpm 在解析时已经固化，字形、文本、样式随之不再变 */
    private readonly glyph: PreparedQuarterNote;
    private readonly text: string;
    private readonly style: TextStyle;

    private glyphY = 0;
    private textX = 0;
    private textBaselineY = 0;

    constructor(ast: TempoFunction) {
        super();
        this.ast = ast;
        this.glyph = prepareQuarterNote(ast.size);
        this.text = `= ${ast.bpm}`;
        this.style = { fontSize: ast.size, fill: "#000" };
        this.initLayoutBox();
    }

    override onTimeState(state: Record<string, any>) {
        state.bpm = this.ast.bpm;
    }

    override prepareLayout(context: LayoutPrepareContext) {
        const glyph = this.glyph;
        const metrics = context.textMeasurer.measureText(this.text, this.style);

        // 符头底端坐在文字基线上；符干比文字高时整块文字下移
        const textTop = Math.max(0, glyph.h - metrics.baseline);
        this.textX = glyph.w + this.ast.size * 0.26;
        this.textBaselineY = textTop + metrics.baseline;
        this.glyphY = this.textBaselineY - glyph.h;

        this.box.w = this.textX + metrics.w;
        this.box.h = textTop + metrics.h;
        this.box.anchor = glyph.stemCenterX;
        // Tempo 与同轨文字按等号所在的文字行对齐；符干只向上扩展占用，不参与对齐轴。
        this.box.visualAxis = textTop + metrics.h / 2;
    }

    override paint(painter: Painter) {
        painter.drawPath(
            this.glyph.commands,
            { fill: "#000" },
            {
                x: this.box.x,
                y: this.box.y + this.glyphY,
                scaleX: this.glyph.scale,
                scaleY: this.glyph.scale,
            },
        );
        painter.drawText(
            this.text,
            this.box.x + this.textX,
            this.box.y + this.textBaselineY,
            this.style,
        );
    }
}
