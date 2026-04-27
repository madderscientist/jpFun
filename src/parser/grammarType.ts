import { SourceSpan } from "./types.js";
import { FunctionArgs } from "../functions/ASTtypes.js";

// 仅仅是数据传递，所以没用 class

export type GrammarNode =
    | GrammarBraceNode
    | GrammarLabelNode
    | GrammarCallNode
    | GrammarSugarNode;

export interface GrammarNodeBase {
    kind: GrammarNodeKind;
    span: SourceSpan;
}

export type GrammarNodeKind =
    | "brace"
    | "label"
    | "call"
    | "sugar";

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

export interface GrammarCallNodeRaw extends GrammarCallNodeBase {
    typed: false;
    args: Map<string | number, SourceSpan>;
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