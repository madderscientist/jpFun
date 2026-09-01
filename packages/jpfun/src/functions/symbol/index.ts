import { ErrorDiagnostic } from "../../diagnostic.js";
import type { LayoutBox, LayoutPrepareContext, Rect } from "../../layout/types.js";
import { DEFAULT_KEY, TemporalNodeBase, type TimeState } from "../temporal.js";
import type { GrammarCallNodeTyped } from "../../parser/grammarType.js";
import type {
    PlaybackColumnOf, PlaybackCursor, PlaybackEmitter, PlaybackFlow, PlaybackFlowAction, PlaybackFlowHook,
} from "../../playback/types.js";
import type { Painter, TextStyle } from "../../render/types.js";
import {
    ASTFunctionNode,
    type ASTFunctionClass,
    type ASTNodeBase,
    type FunctionArgs,
    type LengthValue,
    type ParserContext,
    type SourceSpan,
} from "../ASTtypes.js";
import { paintSymbol, symbolBounds, type SymbolShape } from "./shape.js";

import { accentSymbol } from "./symbols/accent.js";
import { dcSymbol } from "./symbols/dc.js";
import { dsSymbol } from "./symbols/ds.js";
import { dynamicSymbols } from "./symbols/dynamics.js";
import { fermataSymbol } from "./symbols/fermata.js";
import { fineSymbol } from "./symbols/fine.js";
import { mordentSymbol } from "./symbols/mordent.js";
import { prallSymbol } from "./symbols/prall.js";
import { segnoSymbol } from "./symbols/segno.js";
import { trSymbol } from "./symbols/tr.js";

/**
 * 一个乐谱符号：固定图形加可选的播放语义
 *
 * 每个符号自成一个文件、彼此没有依赖，新增一个符号就是新增一个对象字面量
 */
export interface SymbolDefinition {
    readonly name: string;
    readonly description: string;

    /** 固定图形；文字记号改用 text */
    readonly shapes?: readonly SymbolShape[];
    /** 交给宿主字体绘制的文字记号，与 shapes 二选一 */
    readonly text?: { readonly content: string; readonly fontFamily: string };

    /** 符号高度 = size × weight，用来修正宽扁字形的视觉重量；默认 1 */
    readonly weight?: number;
    /** 写入本位置之后持续生效的状态，例如力度记号的 velocity */
    readonly onTimeState?: (state: TimeState) => void;
    /** 发布系统控制，或注册对同一折叠序列后续音符的局部变换 */
    readonly emitPlayback?: (emitter: PlaybackEmitter) => void;
    /** 贴在所在列上的标记，供 D.S. 这类跳转回查 */
    readonly playbackMarks?: () => readonly string[];
    /** 播放到达本符号所在列时决定去留；符号恒占一列，所以生效范围不由符号自己声明 */
    readonly onVisit?: (cursor: PlaybackCursor, at: number) => PlaybackFlowAction | undefined;
}

const symbolTable: ReadonlyMap<string, SymbolDefinition> = new Map(
    [trSymbol, fermataSymbol, prallSymbol, mordentSymbol, accentSymbol, ...dynamicSymbols,
        dcSymbol, dsSymbol, segnoSymbol, fineSymbol]
        .map(definition => [definition.name.toLowerCase(), definition]),
);

class SymbolFunction extends ASTFunctionNode {
    static override def = {
        name: ["symbol", "$"],
        description: "创建一个乐谱符号",
        example: [
            "@symbol(name, size)",
            "语法糖: $name",
            "内置:",
            ...[...symbolTable.values()].map(item => `  $${item.name} ${item.description}`),
        ].join("\n"),
        allowExtraArgs: false,
        args: [
            {
                name: "name",
                type: "string" as const,
                default: null
            },
            {
                name: "size",
                type: "length" as const,
                default: { value: 0.5, unit: "em" } as LengthValue,
            },
        ],
    };

    static override deSugarAtom(source: string, start: number, end: number) {
        if (source[start] !== "$" || !/[A-Za-z]/.test(source[start + 1] ?? "")) return null;
        let next = start + 2;
        while (next < end && /[A-Za-z0-9_-]/.test(source[next])) next++;
        const name = source.slice(start + 1, next);
        const node: GrammarCallNodeTyped = {
            kind: "call",
            typed: true,
            name: "symbol",
            args: new Map([[0, name]]),
            span: { start, end: next },
            syntaxKind: "atom",
        };
        return { next, node };
    }

    readonly size: number;
    readonly definition: SymbolDefinition;

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [name, size] = this.getArgValue(args, ctx) as [string, LengthValue];
        this.size = ctx.length2px(size);
        const definition = symbolTable.get(name.toLowerCase());
        if (!definition) {
            throw new ErrorDiagnostic(
                "E_UNKNOWN_SYMBOL",
                `@symbol: 未知符号: $${name}`,
                sourceSpan
            );
        }
        this.definition = definition;
    }

    override loweringEnter() { return [new SymbolTemporal(this)]; }
    override toString() { return `@symbol(${this.definition.name})`; }
}

export const SymbolNode: ASTFunctionClass = SymbolFunction;

class SymbolTemporal extends TemporalNodeBase implements PlaybackFlow {
    declare ast: SymbolFunction;
    declare box: LayoutBox;

    /** 符号自身坐标系里的固有包围盒，与布局轮次无关 */
    private readonly bounds: Rect;
    private readonly height: number;
    /** 文字记号的内容与字号，图形记号为空 */
    private readonly label?: { content: string; style: TextStyle };
    private scale = 1;
    private baseline = 0;

    constructor(ast: SymbolFunction) {
        super();
        this.ast = ast;
        this.mergeKey = DEFAULT_KEY;
        this.onTimeState = ast.definition.onTimeState;
        this.emitPlayback = ast.definition.emitPlayback;
        this.playbackMarks = ast.definition.playbackMarks;
        this.bounds = symbolBounds(ast.definition.shapes ?? []);
        this.height = ast.size * (ast.definition.weight ?? 1);
        const text = ast.definition.text;
        // 文字记号的字号也是 size × weight，所以与图形记号视觉等高
        this.label = text && {
            content: text.content,
            style: { fontSize: this.height, fontFamily: text.fontFamily },
        };
        this.initLayoutBox();
    }

    override prepareLayout(context: LayoutPrepareContext) {
        if (this.label) {
            const metrics = context.textMeasurer.measureText(this.label.content, this.label.style);
            this.box.w = metrics.w;
            this.box.h = metrics.h;
            this.baseline = metrics.baseline;
        } else {
            this.scale = this.height / this.bounds.h;
            this.box.w = this.bounds.w * this.scale;
            this.box.h = this.height;
        }
        this.box.anchor = this.box.w / 2;
        this.box.visualAxis = this.box.h / 2;
    }

    override paint(painter: Painter) {
        if (this.label) painter.drawText(this.label.content, this.box.x, this.box.y + this.baseline, this.label.style);
        else paintSymbol(painter, this.ast.definition.shapes ?? [], this.bounds, this.box, this.scale);
    }

    /** 控制流在生成事件之前展开，emitPlayback 够不到，所以单独接一次 */
    playbackFlow(columnOf: PlaybackColumnOf): PlaybackFlowHook | undefined {
        const onVisit = this.ast.definition.onVisit;
        if (!onVisit) return;
        const at = columnOf(this);
        return at === undefined ? undefined : { range: [at, at], run: cursor => onVisit(cursor, at) };
    }
}