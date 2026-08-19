import type { SourceSpan } from "./types.js";
import type { FunctionArgs } from "../functions/ASTtypes.js";

// 仅仅是数据传递，所以没用 class

export type GrammarNode =
    | GrammarBraceNode
    | GrammarLabelNode
    | GrammarCallNode
    | GrammarSugarNode;

export interface GrammarNodeBase {
    kind: "brace" | "label" | "call" | "sugar";
    span: SourceSpan;
    /** 语法高亮类型；缺省为 operator */
    syntaxKind?: SyntaxTokenKind;
}

export interface GrammarBraceNode extends GrammarNodeBase {
    kind: "brace";
}

export interface GrammarLabelNode extends GrammarNodeBase {
    kind: "label";
    label: string;
}

interface GrammarCallNodeBase extends GrammarNodeBase {
    kind: "call";
    name: string;
}

export interface GrammarCallNodeRaw extends GrammarCallNodeBase, CallInfo {
    typed: false;
}

export interface GrammarCallNodeTyped extends GrammarCallNodeBase {
    typed: true;
    args: FunctionArgs;
}

export type GrammarCallNode = GrammarCallNodeRaw | GrammarCallNodeTyped;

/**
 * 语法糖节点，具体数据含义由具体函数去糖函数决定，将在第二轮解析中被处理
 */
export interface GrammarSugarNode extends GrammarNodeBase {
    kind: "sugar";
    data: any;
}

/**
 * 调用的具体源码结构。除语义名称外保留括号、参数名、等号、逗号和值的 span，
 * AST 参数解析与编辑器高亮/补全共同使用这一份数据
 */
export interface CallInfo {
    /** 调用名（不包含 `@` 前缀），例如 `note`、`set` */
    name: string;
    /** 整个调用表达式在源码中的范围 */
    span: SourceSpan;
    /** 调用名在源码中的范围，不包含 `@` 前缀 */
    nameSpan: SourceSpan;
    /** 左括号 `(` 在源码中的范围 */
    openParenSpan: SourceSpan;
    /** 右括号 `)` 在源码中的范围；调用未闭合时不存在 */
    closeParenSpan?: SourceSpan;
    /** 按源码顺序排列的调用参数 */
    args: CallArgumentInfo[];
}

export interface CallArgumentInfo {
    /** 整个调用参数在源码中的范围 */
    span: SourceSpan;
    /** 值的范围 */
    valueSpan: SourceSpan;
    /** 命名参数 name 的范围 */
    nameSpan?: SourceSpan;
    /** 命名参数 等号 的范围 */
    equalsSpan?: SourceSpan;
    /** 尾随逗号的范围 */
    commaSpan?: SourceSpan;
}

/** 编辑器展示所需的词法角色；不参与 AST 或 lowering 语义 */
export type SyntaxTokenKind =
    | "comment"      // 注释
    | "string"       // 字符串字面量
    | "function"     // 函数调用名
    | "label"        // 标签
    | "property"     // 命名参数名
    | "number"       // 数字字面量
    | "boolean"      // 布尔字面量
    | "length"       // 带单位的长度值
    | "atom"         // 独立成元素的原子语法糖，例如音符
    | "operator"     // 操作符形式的语法糖
    | "punctuation"; // 括号、逗号、等号 等标点

/** 指向原始源码的非重叠着色区间 */
export interface SyntaxToken {
    kind: SyntaxTokenKind;
    span: SourceSpan;
}

/**
 * 面向编辑器的源码视图
 * tokens 用于着色，calls 保留调用与参数边界供补全定位；两者都引用原始源码 offset
 */
export interface SyntaxAnalysis {
    tokens: SyntaxToken[];
    calls: CallInfo[];
}