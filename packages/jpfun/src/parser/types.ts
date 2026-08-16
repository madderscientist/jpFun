import { GrammarNode } from "./grammarType.js";
import { ParserContext } from "./parserContext.js";

/**
 * 源码区间（左闭右开）
 */
export interface SourceSpan {
    start: number;
    end: number;
}

/**
 * 有单位的长度值
 */
export interface LengthValue {
    value: number;
    unit: "em" | "px";
};

/**
 * 原子去糖 只消耗后向的文本 不允许改动ctx
 * 内部一般不报错；实在有就 throw
 * 传 depth 主要是有的语法糖只能在顶层使用
 */
export type deSugarAtomFunction = (source: string, start: number, end: number, depth: number) => {
    next: number;   // 下一个位置 指文本
    node: GrammarNode;
} | null;

/**
 * 传入的列表已经被拆为单字符了 会修改 ctx
 * 返回值是下一个位置 指 nodes 数组；若为null则表示不匹配，需要继续尝试
 * 内部报错需要push到ctx再throw
 */
export type deSugarRelationFunction = (ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) => number | null;