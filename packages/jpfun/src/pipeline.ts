import { ASTBraceNode, type ASTFunctionClass } from "./functions/ASTtypes.js";
import { defaultFunctions } from "./functions/default.js";
import { createLayoutPrepareContext } from "./layout/default.js";
import {
    layoutDocument,
    type DocumentLayoutOptions,
    type DocumentLayoutResult,
} from "./layout/engine.js";
import { LoweringContext } from "./lowering/loweringContext.js";
import type { LoweringResult } from "./lowering/types.js";
import { ParserContext } from "./parser/parserContext.js";
import { preprocessSource } from "./parser/preprocess.js";
import type { TextMeasurer } from "./render/types.js";

export interface CompileScoreOptions extends DocumentLayoutOptions {
    functions?: ASTFunctionClass[];    // 替换默认函数注册表
    textMeasurer?: TextMeasurer;       // 替换默认文本测量来源
    fontSize?: number;                 // 根 parse 作用域的默认字号，单位 px
}

export interface CompileScoreResult {
    lineStarts: number[];       // diagnostics 使用的逻辑行起点
    parser: ParserContext;      // parser.source 同时保留预处理后的源码
    ast: ASTBraceNode;          // 完整 AST 根节点
    lowering: LoweringResult;   // 时间流与关系对象
    layout: DocumentLayoutResult; // 最终几何结果
}

/**
 * 默认的源码到布局流水线
 *
 * 每个中间结果都保留在返回对象中
 * 编辑器可以读取 diagnostics 和 AST（逐次按键的高亮走 analyzeScoreSyntax）
 * 播放器可以读取 lowering
 * 任意 Painter 后端可以直接消费 layout
 */
export function compileScore(
    source: string,
    options: CompileScoreOptions = {},
): CompileScoreResult {
    const {
        functions = defaultFunctions,
        textMeasurer,
        fontSize,
        ...layoutOptions
    } = options;
    const { maskedSource, lineStarts } = preprocessSource(source);
    const parser = new ParserContext({ source: maskedSource });
    if (fontSize) parser.fontSize = fontSize;
    parser.registerFunctions(functions);
    const ast = new ASTBraceNode(
        { start: 0, end: source.length },
        parser.parse(),
    );

    const loweringContext = new LoweringContext(parser.diagnostics);
    loweringContext.registerFunctions(functions);
    const lowering = loweringContext.lowerDocument(ast);
    const layoutContext = createLayoutPrepareContext(functions, { textMeasurer });
    const layout = layoutDocument(lowering, layoutContext, layoutOptions);

    return {
        lineStarts,
        parser,
        ast,
        lowering,
        layout,
    };
}

/**
 * 只分析编辑器所需的源码结构，不构造 AST
 *
 * 输入期间（防抖时）源码经常缺少右括号或完整参数；
 * 该入口会把这些问题记录到 diagnostics，并尽量返回已经识别的 call/token，供高亮和补全继续工作
 */
export function analyzeScoreSyntax(
    source: string,
    functions: ASTFunctionClass[] = defaultFunctions,
) {
    const { maskedSource, commentSpans } = preprocessSource(source);
    const parser = new ParserContext({ source: maskedSource, commentSpans });
    parser.registerFunctions(functions);
    return {
        syntax: parser.parseSyntax(),
        diagnostics: parser.diagnostics,
    };
}
