import { LengthValue, SourceSpan } from "./types";
import { Diagnostic, ErrorDiagnostic } from "./diagnostic";
import { GrammarBraceNode, GrammarCallNode, GrammarCallNodeRaw, GrammarCallNodeTyped, GrammarLabelNode, GrammarNode } from "./grammarType";
import { readCall, trimRange, findTopLevelEquals, removeQuote } from "./parse-utils/call-utils";
import { readBrace } from "./parse-utils/brace-utils";
import { readLabel } from "./parse-utils/label-utils";
import { parseLength } from "./parse-utils/length-utils";
import { ASTBraceNode, ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgDef, FunctionArgs, ASTLabelNode, paramType, paramValue, ASTTextNode } from "../functions/ASTtypes";

// bool 字面量 严格要求小写
const BOOL_RE = /^(true|false)$/;

const DEFAULT_FONT_SIZE = 22;
const DEFAULT_STRICT_MODE = false;
export const DEFAULT_OCTAVE = 4;

// 原子去糖 只消耗后向的文本 不允许改动ctx
interface deSugarAtomFunctionResult {
    next: number;   // 下一个位置 指文本
    node: GrammarNode;
}
// 内部一般不报错；实在有就 throw
export type deSugarAtomFunction = (source: string, start: number, end: number) => deSugarAtomFunctionResult | null;

/**
 * 传入的列表已经被拆为单字符了 会修改 ctx
 * 返回值是下一个位置 指 nodes 数组；若为null则表示不匹配，需要继续尝试
 * 内部报错需要push到ctx再throw
 */
export type deSugarRelationFunction = (ctx: ParserContext, nodes: (GrammarNode | number)[], at: number) => number | null;

// 解析上下文
export class ParserContext {
    /**
     * 源代码
     */
    source: string;
    /**
     * 解析过程中产生的诊断信息，包含错误和警告
     */
    diagnostics: Diagnostic[];
    /**
     * 变量表，存储 `@set` 定义的变量，供解析过程中查询和修改，具有局部作用域
     */
    variables: Record<string, any>;
    /**
     * 函数定义查找表
     */
    functions: Map<string, ASTFunctionClass>;

    /**
     * 语法糖识别函数列表，分为两轮：第一轮原子级去糖：将文本转为函数调用，或特殊标记
     */
    deSugarAtomFns: deSugarAtomFunction[];
    /**
     * 第二轮关系型去糖：得到函数节点。用于依赖 ASTNode 的语法糖。
     */
    deSugarRelationFns: deSugarRelationFunction[];

    /**
     * .labelable() 为 true 的节点会被加入其中，供标签绑定使用
     */
    labelableNodes: ASTFunctionNode[];

    nodes: ASTNodeBase[]; // 解析结果

    constructor(ctx: ParserContext | {
        source: string;
        diagnostics?: Diagnostic[];
        variables?: Map<string, any>;
        functions?: Map<string, ASTFunctionClass>;
        labelableNodes?: ASTFunctionNode[];
        toConsume?: ASTNodeBase[];
    }) {
        if (ctx instanceof ParserContext) {
            // 构建子上下文
            this.source = ctx.source;
            this.diagnostics = ctx.diagnostics; // 诊断信息全局共享
            this.variables = { ...ctx.variables };  // 继承但不修改父上下文的变量
            this.functions = ctx.functions; // 函数定义全局共享
            this.deSugarAtomFns = ctx.deSugarAtomFns; // 去糖方法全局共享
            this.deSugarRelationFns = ctx.deSugarRelationFns; // 去糖方法全局共享
            this.labelableNodes = ctx.labelableNodes;   // 标签是全局属性
            this.nodes = [];    // 待消费节点不共享，每个上下文单独维护
        } else {
            this.source = ctx.source;
            this.diagnostics = ctx.diagnostics ?? [];
            this.variables = ctx.variables ?? {};
            this.functions = ctx.functions ?? new Map();
            this.labelableNodes = ctx.labelableNodes ?? [];
            this.nodes = ctx.toConsume ?? [];
            if (ctx.functions) [this.deSugarAtomFns, this.deSugarRelationFns] = ParserContext.getDeSugarFns(this.functions.values());
            else this.deSugarAtomFns = [], this.deSugarRelationFns = [];
        }
    }

    static getDeSugarFns(classes: Iterable<ASTFunctionClass>): [
        deSugarAtomFunction[], deSugarRelationFunction[]
    ] {
        // 去重 因为一个函数有多个别名
        const cls: Set<ASTFunctionClass> = new Set(classes);
        const deSugarAtomFns: deSugarAtomFunction[] = [];
        const deSugarRelationFns: deSugarRelationFunction[] = [];
        for (const fnClass of cls) {
            const deSugarAtom = (fnClass as unknown as typeof ASTFunctionNode).deSugarAtom;
            if (deSugarAtom && deSugarAtom !== ASTFunctionNode.deSugarAtom) deSugarAtomFns.push(deSugarAtom);
            const deSugarRelation = (fnClass as unknown as typeof ASTFunctionNode).deSugarRelation;
            if (deSugarRelation && deSugarRelation !== ASTFunctionNode.deSugarRelation) deSugarRelationFns.push(deSugarRelation);
        } return [deSugarAtomFns, deSugarRelationFns];
    }

    pushNode(node: ASTNodeBase) {
        this.nodes.push(node);
        if (node instanceof ASTFunctionNode && node.labelable()) {
            this.labelableNodes.push(node);
        }
    }

    get fontSize(): number {
        return this.variables["fontsize"] ?? DEFAULT_FONT_SIZE;
    }
    set fontSize(size: number | string) {
        if (typeof size === "string") {
            const l = parseLength(size);
            if (l instanceof Diagnostic) throw l;
            else this.variables["fontsize"] = this.length2px(l);
        } else this.variables["fontsize"] = size;
    }

    get strict(): boolean {
        return this.variables["strict"] ?? DEFAULT_STRICT_MODE;
    }
    set strict(value: boolean) {
        this.variables["strict"] = value;
    }

    registerFunctions(functionClasses: ASTFunctionClass[]) {
        const map = this.functions;
        for (const funcClass of functionClasses) {
            const def = (funcClass as unknown as typeof ASTFunctionNode).def;
            if (!def) continue; // 没有定义的函数不注册
            const names = Array.isArray(def.name) ? def.name : [def.name];
            for (const name of names) {
                if (map.has(name.toLowerCase())) {
                    throw new Error(`Duplicate function name detected: ${name}`);
                }
                map.set(name.toLowerCase(), funcClass);
            }
        }
        [this.deSugarAtomFns, this.deSugarRelationFns] = ParserContext.getDeSugarFns(this.functions.values());
    }

    //====== 解析相关 ======//
    parse(start: number = 0, end: number = this.source.length) {
        this.makeNodes(this.parseGrammar(start, end));
        return this.nodes;
    }

    /**
     * 第二轮去糖 & 函数节点创建
     * 有副作用 会修改 nodes 和 labelableNodes 等上下文属性
     * 返回值是 this.nodes 的引用
     * 对于需要后面Node的语法糖(没有终止符)，可以调用此函数，具体做法为：
     * 1. 先用构造函数开启子上下文
     * 2. 再用新的上下文解析剩余的nodes
     * 3. 选取需要的，利用老的ctx构建函数节点
     * 4. 将新ctx的有用信息合并回老的ctx
     * 之所以这么麻烦，是因为创建语法糖对应节点时需要保留当前上下文
     * 
     * 对于有终止符的直接搜索后面的终止符即可。扫过的地方普通文本会再次被合并
     */
    makeNodes(nodes: (GrammarNode | number)[], i: number = 0, end: number = nodes.length): number {
        outer: for (; i < end; i++) {
            const node = nodes[i];
            if (typeof node === "number") {
                // 合并多个连续文本为一个
                const prev = this.nodes.at(-1);
                if (prev instanceof ASTTextNode && prev.sourceSpan.end === node) {
                    prev.sourceSpan.end = node + 1;
                } else this.nodes.push(new ASTTextNode({ start: node, end: node + 1 }, null));
                continue;
            }
            switch (node.kind) {
                case "call":
                    this.pushNode(this.parseCallNode(node));
                    break;
                case "brace":
                    // 大括号节点直接转换为 ASTBraceNode
                    const subParser = new ParserContext(this);
                    this.nodes.push(new ASTBraceNode(node.span, subParser.parse(node.span.start + 1, node.span.end - 1), null));
                    break;
                case "label":
                    const labelList = this.labelableNodes;
                    if (labelList.length > 0) {
                        const tgt = labelList[labelList.length - 1];
                        if (tgt.label !== void 0)
                            this.diagnostics.push(Diagnostic.warning.LabelAlreadyExists(node.label, tgt.label, node.span));
                        tgt.label = node.label;
                        // 同时创建一个LabelNode 供编辑器等工具使用
                        const labelNode = new ASTLabelNode(
                            node.span, node.label, tgt
                        );
                        // 处理待消费列表只处理没有parent的 而label是有parent的 label其实无所谓parent
                        this.nodes.push(labelNode);
                    } else {
                        // 没有可标签化的节点，报错但继续解析
                        this.diagnostics.push(Diagnostic.warning.LabelWithoutTarget(node.label, node.span));
                    } break;
                case "sugar":
                    for (const fn of this.deSugarRelationFns) {
                        const r = fn(this, nodes, i);
                        if (r !== null) {
                            i = r - 1; // 循环会+1
                            continue outer;
                        }
                    }
                    // 匹配失败，保留为文本
                    const prev = this.nodes.at(-1);
                    if (prev instanceof ASTTextNode && prev.sourceSpan.end === node.span.start) {
                        prev.sourceSpan.end = node.span.end;
                    } else this.nodes.push(new ASTTextNode(node.span, null));
                    break;
            }
        } return i;
    }

    /**
     * 识别核心语法: 大括号/函数调用/标签，其余尝试语法糖，失败的字符以索引的形式存在于返回值中，供第二轮识别终止符或合并为 TextNode
     * 即使是关系型的语法糖，这一阶段也要将依赖的字符提取为 GrammarSugarNode，供下一阶段处理
     * 必须将第一阶段语法糖识别放到grammar解析中，比如 `@fn()`，引号若作为语法糖会导致后面的 `@` 无效
     */
    parseGrammar(p: number, end: number): (GrammarNode | number)[] {
        const nodes: (GrammarNode | number)[] = [];
        outer: while ((p = skipSpaces(this.source, p, end)) < end) {
            const ch = this.source[p];
            if (ch === "@") {
                const { call, fatal } = readCall(this.source, p);
                if (fatal) {
                    this.diagnostics.push(fatal);
                    if (fatal instanceof ErrorDiagnostic) throw fatal;
                }
                if (call && call.end <= end) {
                    // 获取参数名称或位置
                    const args = new Map<string | number, SourceSpan>();
                    let positionArgEnd = false; // 位置参数是否已经结束
                    for (let i = 0; i < call.argRanges.length; i++) {
                        const argRange = call.argRanges[i];
                        const eq = findTopLevelEquals(this.source, argRange.start, argRange.end);
                        const isNamed = eq > argRange.start;
                        if (isNamed && !positionArgEnd) positionArgEnd = true; // 位置参数结束
                        else if (!isNamed && positionArgEnd) {
                            // 位置参数不允许出现在命名参数之后
                            throw Diagnostic.error.PosAfterNamedArg(
                                call.name, argRange
                            );
                        }
                        let key: string | number;
                        let value: SourceSpan;
                        if (isNamed) {
                            // 一律小写保存
                            key = this.source.slice(argRange.start, eq).trim().toLowerCase();
                            value = trimRange(this.source, eq + 1, argRange.end);
                        } else {
                            key = i;
                            value = trimRange(this.source, argRange.start, argRange.end);
                        }
                        args.set(key, value);
                    }
                    nodes.push({
                        kind: "call",
                        span: { start: call.start, end: call.end },
                        name: call.name,
                        args: args,
                        typed: false
                    } as GrammarCallNodeRaw);
                    p = call.end;
                    continue;
                }
                // 认为是 label
                const labelResult = readLabel(this.source, p, end);
                if (labelResult) {
                    nodes.push({
                        kind: "label",
                        span: { start: p, end: labelResult.next },
                        label: labelResult.label
                    } as GrammarLabelNode);
                    p = labelResult.next;
                    continue;
                }
                // 既不是调用也不是标签，继续当普通文本处理 比如只有一个@
            }
            if (ch === "{") {
                // 找到结尾
                let braceEnd = readBrace(this.source, p, end);
                // 大括号不匹配 报警 但继续解析 相当于补了一个右大括号
                if (braceEnd < 0 || braceEnd >= end || braceEnd <= p) {
                    this.diagnostics.push(
                        Diagnostic.warning.UnmatchedBrace({
                            start: p,
                            end: end
                        })
                    );
                    braceEnd = end;
                }
                nodes.push({
                    kind: "brace",
                    span: { start: p, end: braceEnd + 1 }
                } as GrammarBraceNode);
                p = braceEnd + 1;
                continue;
            }
            // 在当前位置尝试所有原子去糖函数 匹配到就立即停止
            for (const fn of this.deSugarAtomFns) {
                try {
                    const r = fn(this.source, p, end);
                    if (r) {
                        nodes.push(r.node); // 一般是 kind="sugar" 的特殊node
                        p = r.next;
                        continue outer;
                    }
                } catch (e) {
                    // 原子级去糖一般不出错。出错肯定是原则性问题
                    if (e instanceof Diagnostic) {
                        this.diagnostics.push(e);
                    } else this.diagnostics.push(Diagnostic.error.Bug(
                        (e as Error).toString(), { start: p, end }
                    )); throw e;
                }
            } nodes.push(p++);   // 单字符的位置
        } return nodes;
    }

    parseCallNode(callNode: GrammarCallNode): ASTFunctionNode {
        const callFNClass = this.functions.get(callNode.name.toLowerCase());
        const def = callFNClass?.prototype.def;
        const defArgs: FunctionArgDef[] | undefined = def?.args;
        if (!callFNClass || !defArgs) {
            if (this.strict) {
                const e = Diagnostic.error.UnknownFunction(callNode.name, callNode.span);
                this.diagnostics.push(e);
                throw e;
            } else {
                this.diagnostics.push(
                    Diagnostic.warning.UnknownFunction(callNode.name, callNode.span)
                );
            }
            // 未知函数，保留位置，但直接跳过
            return new ASTFunctionNode(callNode.span, null);
        }
        // 用实际传参查询定义
        const args = callNode.args;
        if (!callNode.typed) {
            let i = -1;  // Map遍历顺序严格按照插入顺序
            for (const [key, value] of callNode.args) {
                i++;
                // 校验参数是否在定义中 并获取类型
                let type: paramType | undefined;
                if (typeof key === "number") type = defArgs[key]?.type;
                else type = defArgs.find(defArg => defArg.name?.toLowerCase() === key)?.type ?? defArgs[i]?.type;
                if (type === void 0) {
                    if (!def.allowExtraArgs) {
                        this.diagnostics.push(
                            Diagnostic.warning.TooManyPosArgs(
                                callNode.name, defArgs.length, i + 1, value
                            )
                        );
                        args.delete(key);
                    } continue;
                }
                const v = this.parseArgWithType(value.start, value.end, type, callNode.span.start);
                if (v !== null) (args as FunctionArgs).set(key, v);
                else args.delete(key);
            } (callNode as unknown as GrammarCallNodeTyped).typed = true;
        }   // 完全信任 typed 时的 arg
        // 构造函数内用定义查询实际传参
        return new callFNClass(callNode.span, args, this, null);
    }

    /**
     * 根据参数类型解析参数值，解析过程中会记录诊断信息
     * funcStart 是为了找到该函数之前的label的位置 因为如果content先解析会污染 labelableNodes
     * 解析成功返回值 解析失败返回null
     */
    parseArgWithType(argStart: number, argEnd: number, type?: paramType, funcStart?: number): paramValue | null {
        // 先去空白
        const r = trimRange(this.source, argStart, argEnd);
        const start = r.start, end = r.end;
        if (start >= end) return null; // 纯空白参数视为未提供
        // 类型匹配
        const text = (type === "content") ? '' : this.source.slice(start, end);
        switch (type) {
            case "number":
                const num = Number(text);
                if (isNaN(num)) {
                    this.diagnostics.push(
                        Diagnostic.warning.InvalidNumber(text, r)
                    ); return null;
                } return num;
            case "boolean":
                const boolText = text;
                if (BOOL_RE.test(boolText)) {
                    return boolText === "true";
                } else {
                    this.diagnostics.push(
                        Diagnostic.warning.InvalidBoolean(text, r)
                    ); return null;
                }
            case "content":
                // 开启新的局部解析器
                try {
                    const subParser = new ParserContext(this);
                    const n = subParser.parse(start, end);
                    if (n.length === 1) return n[0];
                    return new ASTBraceNode(r, n, null);
                } catch (e) {
                    // 具体报错信息已经记录了，这里会把该参数跳过
                    this.diagnostics.push(
                        Diagnostic.warning.InvalidContent(r)
                    ); return null;
                }
            case "label":
                // 应对潜在的问题: 如果先解析了content会导致ctx.lavelableNodes被污染
                funcStart ??= argStart;
                // label情况下返回对象 从后向前查找以支持标签覆盖
                for (let i = this.labelableNodes.length - 1; i >= 0; i--) {
                    const node = this.labelableNodes[i];
                    if (node.sourceSpan.start >= funcStart) continue; // 只能绑定在函数定义之前的节点上
                    if (node.label == text) return node;   // 标签需要严格匹配
                }
                // 没找到标签，报错
                const e = Diagnostic.error.UnknownLabel(text, r);
                this.diagnostics.push(e);
                throw e;
            case "length":
                const l = parseLength(text);
                if (l instanceof Diagnostic) {
                    l.span.start += start;
                    l.span.end += start;
                    this.diagnostics.push(l);
                    return null;
                } return l;
            // 其他类型一律视为string
            default:
                // 去除首尾引号（单引号或双引号），如果存在
                let result: string | null = text;
                return removeQuote(result);
        } return null;
    }

    length2px(length: LengthValue): number {
        // 不进行错误判断了: 来自 parseArgWithType 的不会出问题
        if (length.unit === "em") return length.value * this.fontSize;
        else return length.value;
    }
}

// 换行转义已经在预处理解决了，这里不用再跳过了
export function skipSpaces(s: string, i: number, end: number): number {
    while (i < end && (s[i] === ' ' || s[i] === '\t')) i++;
    return i;
}