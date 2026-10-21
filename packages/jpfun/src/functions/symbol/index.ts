import { ErrorDiagnostic, WarningDiagnostic } from "../../diagnostic.js";
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
import { ornament } from "./ornament.js";
import { paintSymbol, symbolBounds, type SymbolShape } from "./shape.js";
import { accentSymbol } from "./symbols/accent.js";
import { dcSymbol } from "./symbols/dc.js";
import { dsSymbol } from "./symbols/ds.js";
import { dynamicSymbols } from "./symbols/dynamics.js";
import { fermataSymbol } from "./symbols/fermata.js";
import { fineSymbol } from "./symbols/fine.js";
import { harmonicSymbol } from "./symbols/harmonic.js";
import { marcatoSymbol } from "./symbols/marcato.js";
import { mordentSymbol } from "./symbols/mordent.js";
import { prallSymbol } from "./symbols/prall.js";
import { segnoSymbol } from "./symbols/segno.js";
import { staccatoSymbol } from "./symbols/staccato.js";
import { tenutoSymbol } from "./symbols/tenuto.js";
import { trSymbol } from "./symbols/tr.js";
import { tremoloSymbol } from "./symbols/tremolo.js";
import { iturnSymbol, turnSymbol } from "./symbols/turn.js";

export type { OrnamentPattern } from "./ornament.js";
export type { SymbolShape };

/**
 * 一个乐谱符号：固定图形加可选的播放语义
 *
 * 每个符号或符号族自成一个文件，新增符号就是新增对象字面量，可复用已有图形和播放能力
 */
export interface SymbolDefinition {
    readonly name: string;
    readonly description: string;
    /** 查表未命中时使用；忽略大小写，从名称开头匹配，不允许 g/y */
    readonly pattern?: {
        readonly regex: RegExp;
        readonly resolve: (match: RegExpExecArray) => SymbolDefinition;
    };

    /** 固定图形；文字记号改用 text */
    readonly shapes?: readonly SymbolShape[];
    /** 交给宿主字体绘制的文字记号，与 shapes 二选一 */
    readonly text?: {
        readonly content: string;
        readonly fontFamily: string;
        readonly fontStyle?: TextStyle["fontStyle"];
    };

    /** 符号高度 = size × weight，用来修正宽扁字形的视觉重量；默认 1 */
    readonly weight?: number;
    /** 图形下方留白，使用符号自身坐标并随 scale 缩放；默认 0 */
    readonly paddingBottom?: number;
    /** 横向对齐点，使用符号自身坐标；默认采用完整图形的中心 */
    readonly anchor?: number;
    /** 写入本位置之后持续生效的状态，例如力度记号的 velocity */
    readonly onTimeState?: (state: TimeState) => void;
    /** 发布系统控制，或注册对同一折叠序列后续音符的局部变换 */
    readonly emitPlayback?: (emitter: PlaybackEmitter) => void;
    /** 贴在所在列上的标记，供 D.S. 这类跳转回查 */
    readonly playbackMarks?: () => readonly string[];
    /** 播放到达本符号所在列时决定去留；符号恒占一列，所以生效范围不由符号自己声明 */
    readonly onVisit?: (cursor: PlaybackCursor, at: number) => PlaybackFlowAction | undefined;
}

type SymbolPattern = NonNullable<SymbolDefinition["pattern"]>;
const coreSymbols: readonly SymbolDefinition[] = Object.freeze([
    trSymbol, fermataSymbol, prallSymbol, mordentSymbol, accentSymbol, tremoloSymbol, harmonicSymbol,
    tenutoSymbol, marcatoSymbol, staccatoSymbol, turnSymbol, iturnSymbol,
    ...dynamicSymbols, dcSymbol, dsSymbol, segnoSymbol, fineSymbol,
]);
const symbolTable = new Map<string, SymbolDefinition>();
const symbolPatterns = new Map<string, SymbolPattern>();

export const symbols = Object.freeze({
    /** 内置符号的只读备份列表 */
    core: coreSymbols,
    /** 注册或同名覆盖一个或多个符号定义 */
    register: (...definitions: readonly SymbolDefinition[]): void => {
        const entries = definitions.map(definition => {
            const name = definition.name.toLowerCase();
            let pattern = definition.pattern;
            if (pattern) {
                const { regex } = pattern;
                if (regex.global || regex.sticky) {
                    throw new Error(`Symbol pattern must not use g or y flags: ${name}`);
                }
                if (!regex.ignoreCase) pattern = { ...pattern, regex: new RegExp(regex.source, `${regex.flags}i`) };
            }
            return { name, definition, pattern };
        });
        for (const { name, definition, pattern } of entries) {
            symbolTable.set(name, definition);
            if (pattern) symbolPatterns.set(name, pattern);
            else symbolPatterns.delete(name);
        }
    },
    /** 清空所有已注册符号（含内置符号） */
    clear: (): void => {
        symbolTable.clear();
        symbolPatterns.clear();
    },
    /** 清空并恢复到最初的 symbols.core 状态 */
    reset: (): void => {
        symbols.clear();
        symbols.register(...symbols.core);
    },
    /** 装饰音播放展开工具 */
    ornament,
    /** 计算符号图元在自身坐标系中的固有包围盒 */
    bounds: symbolBounds,
});

symbols.reset();

class SymbolFunction extends ASTFunctionNode {
    static override def = {
        name: ["symbol", "$"],
        description: "创建一个乐谱符号",
        get details() {
            return `\
~~~jpfun
1 ^ @symbol(p, size=0.5em)
~~~
**简写**：\`$name\`，如 \`1 ^ $p\`。名称读取到下一个空白或当前内容区间末尾，连续的标点也属于名称。

**已注册记号**
${[...symbolTable.values()].map(item => `- \`$${item.name}\`：${item.description}`).join("\n")}`;
        },
        allowExtraArgs: false,
        args: [
            {
                name: "name",
                description: "已注册记号名称，见函数说明中的记号列表",
                type: "string" as const,
                default: null
            },
            {
                name: "size",
                description: "记号尺寸",
                type: "length" as const,
                default: { value: 0.5, unit: "em" } as LengthValue,
            },
        ],
    };

    static override deSugarAtom(source: string, start: number, end: number) {
        if (source[start] !== "$") return null;
        const name = /^\S+/.exec(source.slice(start + 1, end))?.[0];
        if (!name) return null;
        const next = start + 1 + name.length;
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
    readonly definition?: SymbolDefinition;

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [name, size] = this.getArgValue(args, ctx) as [string, LengthValue];
        this.size = ctx.length2px(size);
        const normalized = name.toLowerCase();
        let definition = symbolTable.get(normalized);
        if (!definition) {
            let matched: { pattern: SymbolPattern; match: RegExpExecArray } | undefined;
            for (const pattern of symbolPatterns.values()) {
                const match = pattern.regex.exec(normalized);
                if (!match || match.index !== 0 || match[0] !== normalized) continue;
                if (matched) throw new Error(`Ambiguous symbol patterns: ${normalized}`);
                matched = { pattern, match };
            }
            definition = matched?.pattern.resolve(matched.match);
        }
        if (!definition) {
            const message = "@symbol: 未知符号: ${name}";
            const params = { name };
            if (ctx.variables.strict) throw new ErrorDiagnostic("E_UNKNOWN_SYMBOL", message, sourceSpan, params);
            ctx.diagnostics.push(new WarningDiagnostic("W_UNKNOWN_SYMBOL", message, sourceSpan, params));
            return;
        }
        this.definition = definition;
    }

    override loweringEnter(): TemporalNodeBase[] {
        return [this.definition
            ? new SymbolTemporal(this as ResolvedSymbolFunction)
            : new TemporalNodeBase()];
    }
    override toString(source: string) {
        return this.definition ? `@symbol(${this.definition.name})` : super.toString(source);
    }
}

export const SymbolNode: ASTFunctionClass = SymbolFunction;

type ResolvedSymbolFunction = SymbolFunction & { readonly definition: SymbolDefinition };

class SymbolTemporal extends TemporalNodeBase implements PlaybackFlow {
    declare ast: ResolvedSymbolFunction;
    declare box: LayoutBox;

    /** 符号自身坐标系里的固有包围盒，与布局轮次无关 */
    private readonly bounds: Rect;
    private readonly height: number;
    /** 文字记号的内容与字号，图形记号为空 */
    private readonly label?: { content: string; style: TextStyle };
    private scale = 1;
    private baseline = 0;

    constructor(ast: ResolvedSymbolFunction) {
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
            style: { fontSize: this.height, fontFamily: text.fontFamily, fontStyle: text.fontStyle },
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
            this.box.h = this.height + (this.ast.definition.paddingBottom ?? 0) * this.scale;
        }
        this.box.anchor = !this.label && this.ast.definition.anchor !== undefined
            ? (this.ast.definition.anchor - this.bounds.x) * this.scale
            : this.box.w / 2;
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