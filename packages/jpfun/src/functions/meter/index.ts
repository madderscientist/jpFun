import { ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
import { Fraction } from "../../fraction.js";
import type { LayoutBox, LayoutPrepareContext } from "../../layout/types.js";
import { ANCHOR_KEY, TemporalNodeBase, type LoweringResult } from "../../lowering/types.js";
import type { Painter, TextStyle } from "../../render/types.js";
import type { PlaybackEmitter } from "../../playback/types.js";
import {
    ASTFunctionNode,
    type ASTFunctionClass,
    type ASTNodeBase,
    type FunctionArgs,
    type LengthValue,
    type ParserContext,
    type SourceSpan,
} from "../ASTtypes.js";
import { JIANPU_NUMBER_FONT } from "../../render/text.js";

class MeterFunction extends ASTFunctionNode {
    static override def = {
        name: ["meter"],
        description: "设置拍号",
        example: `@meter(6, 8) 设置 6/8 拍号`,
        allowExtraArgs: false,
        args: [
            {
                name: "num",
                type: "number" as const,
                default: null
            },
            {
                name: "den",
                type: "number" as const,
                default: null
            },
            {
                name: "size",
                type: "length" as const,
                default: { value: 0.7, unit: "em" } as LengthValue,
            },
        ],
    };

    readonly numerator: number;
    readonly denominator: number;
    readonly measureDuration: Fraction;
    readonly size: number;
    readonly strict: boolean;

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        let [num, den, size] = this.getArgValue(args, ctx) as [number, number, LengthValue];
        if (!Number.isSafeInteger(num) || !Number.isSafeInteger(num * 4) || num <= 0
            || !Number.isSafeInteger(den) || den <= 0) {
            const message = `@meter 的分子和分母必须是正整数`;
            if (ctx.strict) throw new ErrorDiagnostic("E_METER_INVALID", message, span);
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_METER_INVALID",
                `${message}，已回落为 4/4`,
                span,
            ));
            num = den = 4;
        }
        this.numerator = num;
        this.denominator = den;
        // QN 以四分音符为 1；拍号不修改音符自身时值
        this.measureDuration = new Fraction(num * 4, den);
        this.size = ctx.length2px(size);
        this.strict = ctx.strict;
    }

    override loweringEnter() {
        return [new MeterTemporal(this)];
    }

    static override loweringFinalize = (result: LoweringResult) => {
        const measureStart = new Fraction();
        const measureLength = new Fraction();
        let active: MeterFunction | null = null;
        // 诊断范围从上一边界之后延伸到当前关闭边界
        let sourceStart = 0;

        const closeMeasure = (end: Fraction, sourceEnd: number) => {
            if (!active || end.equals(measureStart)) return;
            // Fraction 运算会原地修改接收者，不能直接对时间线字段做减法
            measureLength.copyFrom(end).sub(measureStart);
            if (!measureLength.equals(active.measureDuration)) {
                const message = `小节时长为 ${measureLength} QN，不满足 ${active.numerator}/${active.denominator} 拍号`;
                const span = { start: sourceStart, end: sourceEnd };
                if (active.strict) throw new ErrorDiagnostic("E_METER_MISMATCH", message, span);
                result.diagnostics.push(new WarningDiagnostic("W_METER_MISMATCH", message, span));
            }
            measureStart.copyFrom(end);
        };

        for (const column of result.columns) {
            const time = column[0].t;
            const meter = column.find(node => node instanceof MeterTemporal);
            if (meter) {
                closeMeasure(time, meter.ast.sourceSpan.start);
                active = meter.ast;
                measureStart.copyFrom(time);
                sourceStart = meter.ast.sourceSpan.end;
            }
            const anchor = column.find(node => node.mergeKey === ANCHOR_KEY);
            if (anchor) {
                closeMeasure(time, anchor.ast.sourceSpan.end);
                sourceStart = anchor.ast.sourceSpan.end;
            }
        }

        if (active) {
            const span = result.columns.at(-1)?.at(-1)?.ast.sourceSpan ?? active.sourceSpan;
            closeMeasure(result.duration, span.end);
        }
    };

    override toString() {
        return `@meter(${this.numerator}, ${this.denominator})`;
    }
}

export const MeterNode: ASTFunctionClass = MeterFunction;

class MeterTemporal extends TemporalNodeBase {
    declare ast: MeterFunction;
    declare box: LayoutBox;

    private readonly style: TextStyle;
    private numeratorBaseline = 0;
    private denominatorBaseline = 0;
    private lineY = 0;
    private lineHeight = 0;

    constructor(ast: MeterFunction) {
        super();
        this.ast = ast;
        this.style = {
            fontSize: ast.size,
            fontFamily: JIANPU_NUMBER_FONT,
            textAlign: "center",
            fill: "#000",
        };
        this.initLayoutBox();
    }

    override emitPlayback(emitter: PlaybackEmitter) {
        emitter.emit({
            kind: "time-signature",
            at: emitter.start,
            numerator: this.ast.numerator,
            denominator: this.ast.denominator,
        });
    }

    override prepareLayout(context: LayoutPrepareContext) {
        const num = context.textMeasurer.measureText(String(this.ast.numerator), this.style);
        const den = context.textMeasurer.measureText(String(this.ast.denominator), this.style);
        const gap = this.ast.size * 0.08;
        const padding = this.ast.size * 0.08;
        this.lineHeight = Math.max(1, this.ast.size * 0.06);
        this.numeratorBaseline = num.baseline;
        this.lineY = num.h + gap;
        this.denominatorBaseline = this.lineY + this.lineHeight + gap + den.baseline;
        this.box.w = Math.max(num.w, den.w) + padding * 2;
        this.box.h = this.lineY + this.lineHeight + gap + den.h;
        this.box.anchor = this.box.w / 2;
        // 分数线是拍号的视觉中心
        this.box.visualAxis = this.lineY + this.lineHeight / 2;
    }

    override paint(painter: Painter) {
        const center = this.box.x + this.box.anchor;
        painter.drawText(String(this.ast.numerator), center, this.box.y + this.numeratorBaseline, this.style);
        painter.drawRect(this.box.x, this.box.y + this.lineY, this.box.w, this.lineHeight, { fill: "#000" });
        painter.drawText(String(this.ast.denominator), center, this.box.y + this.denominatorBaseline, this.style);
    }
}