import { ErrorDiagnostic } from "../../diagnostic.js";
import type { LayoutBox, Rect } from "../../layout/types.js";
import { DEFAULT_KEY, TemporalNodeBase } from "../../lowering/types.js";
import type { GrammarCallNodeTyped } from "../../parser/grammarType.js";
import type { Painter } from "../../render/types.js";
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
import { fermataSymbol } from "./symbols/fermata.js";
import { fSymbol } from "./symbols/f.js";
import { mordentSymbol } from "./symbols/mordent.js";
import { pSymbol } from "./symbols/p.js";
import { trSymbol } from "./symbols/tr.js";

/**
 * 一个乐谱符号：一组固定图形
 *
 * 每个符号自成一个文件、彼此没有依赖，新增一个符号就是新增一个对象字面量
 */
export interface SymbolDefinition {
    readonly name: string;
    readonly description: string;
    readonly shapes: readonly SymbolShape[];
    /** 符号高度 = size × weight，用来修正宽扁字形的视觉重量；默认 1 */
    readonly weight?: number;
}

const symbolTable: ReadonlyMap<string, SymbolDefinition> = new Map(
    [trSymbol, fSymbol, pSymbol, fermataSymbol, mordentSymbol, accentSymbol]
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

class SymbolTemporal extends TemporalNodeBase {
    declare ast: SymbolFunction;
    declare box: LayoutBox;

    /** 符号自身坐标系里的固有包围盒，与布局轮次无关 */
    private readonly bounds: Rect;
    private scale = 1;

    constructor(ast: SymbolFunction) {
        super();
        this.ast = ast;
        this.mergeKey = DEFAULT_KEY;
        this.bounds = symbolBounds(ast.definition.shapes);
        this.initLayoutBox();
    }

    override prepareLayout() {
        const height = this.ast.size * (this.ast.definition.weight ?? 1);
        this.scale = height / this.bounds.h;
        this.box.w = this.bounds.w * this.scale;
        this.box.h = height;
        this.box.anchor = this.box.w / 2;
        this.box.visualAxis = height / 2;
    }

    override paint(painter: Painter) {
        paintSymbol(painter, this.ast.definition.shapes, this.bounds, this.box, this.scale);
    }
}