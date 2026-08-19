import { deSugarAtomFunction, deSugarRelationFunction, LengthValue, SourceSpan } from "./types.js";
import { Diagnostic } from "../diagnostic.js";
import { GrammarBraceNode, GrammarCallNode, GrammarCallNodeRaw, GrammarLabelNode, GrammarNode, type CallArgumentInfo, type SyntaxAnalysis, type SyntaxTokenKind } from "./grammarType.js";
import { readCall, trimRange, removeQuote } from "./parse-utils/call-utils.js";
import { readBrace } from "./parse-utils/brace-utils.js";
import { readLabel } from "./parse-utils/label-utils.js";
import { parseLength } from "./parse-utils/length-utils.js";
import { ASTBraceNode, ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgDef, FunctionArgs, ASTLabelNode, paramType, paramValue, ASTTextNode, resolveArgType } from "../functions/ASTtypes.js";

// bool 字面量 严格要求小写
const BOOL_RE = /^(true|false)$/;

/** 有函数参数契约时直接用声明类型；未知参数回落到真正的字面量解析器，不另写一套正则 */
function classifySyntaxValue(type: paramType | undefined, text: string): SyntaxTokenKind | undefined {
    if (type) return type === "content" ? undefined : type;
    if (BOOL_RE.test(text)) return "boolean";
    if (text.startsWith('"')) return "string";
    if (!isNaN(Number(text))) return "number";
    if (!(parseLength(text) instanceof Diagnostic)) return "length";
    return undefined;
}

export const DEFAULT_FONT_SIZE = 22;
const DEFAULT_STRICT_MODE = false;
export const DEFAULT_OCTAVE = 4;


// 解析上下文
export class ParserContext {
    /** 根解析器为 0，内容参数和大括号子解析器依次加一 */
    readonly scopeDepth: number;

    /** 源代码 */
    readonly source: string;
    /** 词法层产物，只由 parseSyntax 填充；所有子上下文共享 */
    readonly syntax: SyntaxAnalysis;
    /** 解析过程中产生的诊断信息，包含错误和警告 */
    diagnostics: Diagnostic[];
    /** 变量表，存储 `@set` 定义的变量，供解析过程中查询和修改，具有局部作用域 */
    variables: Record<string, any>;
    /** 文档级声明（只准有一个）在所有子解析器之间共享的变量 */
    documentDeclarations: Record<string, any>;
    /** 函数定义查找表 */
    functions: Map<string, ASTFunctionClass>;

    /** 语法糖识别函数列表，分为两轮：第一轮原子级去糖：将文本转为函数调用，或特殊标记 */
    deSugarAtomFns: deSugarAtomFunction[];
    /** 第二轮关系型去糖：得到函数节点。用于依赖 ASTNode 的语法糖 */
    deSugarRelationFns: deSugarRelationFunction[];

    /** .labelable() 返回的承载节点会被加入其中，供标签绑定使用 */
    labelableNodes: ASTFunctionNode[];

    nodes: ASTNodeBase[]; // 解析结果

    constructor(ctx: ParserContext | {
        source: string;
        diagnostics?: Diagnostic[];
        variables?: Map<string, any>;
        functions?: Map<string, ASTFunctionClass>;
        labelableNodes?: ASTFunctionNode[];
        toConsume?: ASTNodeBase[];
        commentSpans?: SourceSpan[];    // 预处理阶段识别的注释区间，供语法分析和编辑器高亮使用
    }) {
        if (ctx instanceof ParserContext) {
            // 构建子上下文
            this.scopeDepth = ctx.scopeDepth + 1;
            this.documentDeclarations = ctx.documentDeclarations;
            this.source = ctx.source;
            this.diagnostics = ctx.diagnostics; // 诊断信息全局共享
            this.syntax = ctx.syntax;
            this.variables = { ...ctx.variables };  // 继承但不修改父上下文的变量
            this.functions = ctx.functions; // 函数定义全局共享
            this.deSugarAtomFns = ctx.deSugarAtomFns; // 去糖方法全局共享
            this.deSugarRelationFns = ctx.deSugarRelationFns; // 去糖方法全局共享
            this.labelableNodes = ctx.labelableNodes;   // 标签是全局属性
            this.nodes = [];    // 待消费节点不共享，每个上下文单独维护
        } else {
            this.scopeDepth = 0;
            this.documentDeclarations = {};
            this.source = ctx.source;
            this.diagnostics = ctx.diagnostics ?? [];
            this.syntax = {
                tokens: (ctx.commentSpans ?? []).map(span => ({ kind: "comment", span })),
                calls: [],
            };
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
        if (node instanceof ASTFunctionNode) {
            // 标签绑到节点自己指定的承载者上
            const target = node.labelable();
            if (target) this.labelableNodes.push(target);
        }
    }

    get fontSize(): number {
        return this.variables["fontsize"] ?? DEFAULT_FONT_SIZE;
    }
    set fontSize(size: number | string) {
        if (typeof size === "string") {
            const l = parseLength(size);
            if (l instanceof Diagnostic) throw l;
            this.variables["fontsize"] = this.length2px(l);
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
    /**
     * 扫描 GrammarNode 并构造 AST；不产出 syntax
     * 用于最终渲染
     */
    parse(start: number = 0, end: number = this.source.length) {
        this.makeNodes(this.parseGrammar(start, end));
        return this.nodes;
    }

    /**
     * 词法层：容错扫描 GrammarNode 并收集 syntax
     * 用于防抖时的编辑器高亮和补全
     */
    parseSyntax(start: number = 0, end: number = this.source.length): SyntaxAnalysis {
        this.parseGrammar(start, end, true);
        if (this.scopeDepth === 0) {
            const cmp = (a: {span: SourceSpan}, b: {span: SourceSpan}) => a.span.start - b.span.start || a.span.end - b.span.end;
            this.syntax.tokens.sort(cmp);
            this.syntax.calls.sort(cmp);
        } return this.syntax;
    }

    // syntax 路径独占这些 span，AST 路径不会读取或改写它们
    private addSyntax(kind: SyntaxTokenKind, span: SourceSpan | undefined) {
        if (span && span.start < span.end) {
            this.syntax.tokens.push({ kind, span });
        }
    }

    /** 把已识别的 GrammarNode 映射为源码 token；content/brace 在这里继续递归 */
    private recordSyntax(node: GrammarNode) {
        if (node.kind === "brace") {
            this.addSyntax("punctuation", { start: node.span.start, end: node.span.start + 1 });
            const close = Math.min(this.source.length, node.span.end - 1);
            if (this.source[close] === "}") this.addSyntax("punctuation", { start: close, end: close + 1 });
            new ParserContext(this).parseSyntax(node.span.start + 1, close);
            return;
        }
        if (node.kind === "label") {
            this.addSyntax("label", node.span);
            return;
        }
        if (node.kind === "sugar" || node.typed) {
            this.addSyntax(node.syntaxKind ?? "operator", node.span);
            return;
        }

        // syntax.calls 只暴露源码结构，不带 grammar 阶段的字段
        const { kind, typed, syntaxKind, ...call } = node;
        this.syntax.calls.push(call);
        this.addSyntax("function", call.nameSpan);
        this.addSyntax("punctuation", call.openParenSpan);
        this.addSyntax("punctuation", call.closeParenSpan);
        const def = this.functions.get(call.name.toLowerCase())?.prototype.def;
        for (let index = 0; index < call.args.length; index++) {
            const arg = call.args[index];
            this.addSyntax("property", arg.nameSpan);
            this.addSyntax("punctuation", arg.equalsSpan);
            this.addSyntax("punctuation", arg.commaSpan);
            const name = arg.nameSpan
                ? this.source.slice(arg.nameSpan.start, arg.nameSpan.end).toLowerCase()
                : void 0;
            const type = def && resolveArgType(def, name, index);
            if (type === "content") {
                new ParserContext(this).parseSyntax(arg.valueSpan.start, arg.valueSpan.end);
            } else {
                const text = this.source.slice(arg.valueSpan.start, arg.valueSpan.end);
                const kind = classifySyntaxValue(type, text);
                if (kind) this.addSyntax(kind, arg.valueSpan);
            }
        }
    }

    /**
     * 第二轮去糖 & 函数节点创建
     * 有副作用 会修改 nodes 和 labelableNodes 等上下文属性
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
     * syntaxOnly 是词法层模式：用户语法错误只记录诊断不抛出（保留 partial call），并顺带记录 syntax；
     * 它不得改变“识别出什么结构”，否则两条路径会认不同的语言
     */
    parseGrammar(p: number, end: number, syntaxOnly: boolean = false): (GrammarNode | number)[] {
        const nodes: (GrammarNode | number)[] = [];
        const emit = (node: GrammarNode) => {
            nodes.push(node);
            if (syntaxOnly) this.recordSyntax(node);
        };
        outer: while ((p = skipSpaces(this.source, p, end)) < end) {
            const ch = this.source[p];
            if (ch === "@") {
                const call = readCall(this.source, p, end);
                if (call) {
                    // 先落 syntax 再校验，抛错时编辑器仍拿得到已识别的结构
                    emit(Object.assign(call, {
                        kind: "call",
                        typed: false
                    } as const) as GrammarCallNodeRaw);
                    // 校验位置参数和命名参数的顺序
                    let positionArgEnd = false; // 位置参数是否已经结束
                    for (const arg of call.args) {
                        const isNamed = arg.nameSpan !== undefined;
                        if (isNamed && !positionArgEnd) positionArgEnd = true; // 位置参数结束
                        else if (!isNamed && positionArgEnd) {
                            // 位置参数不允许出现在命名参数之后
                            const error = Diagnostic.error.PosAfterNamedArg(call.name, arg.span);
                            if (!syntaxOnly) throw error;
                            this.diagnostics.push(error);
                        }
                    }
                    // 括号未闭合
                    if (!call.closeParenSpan) {
                        const fatal = Diagnostic.error.UnterminatedCall(call.name, call.span);
                        if (!syntaxOnly) throw fatal;
                        this.diagnostics.push(fatal);
                    }
                    p = call.span.end;
                    continue;
                }
                // 认为是 label
                const labelResult = readLabel(this.source, p, end);
                if (labelResult) {
                    emit({
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
                emit({
                    kind: "brace",
                    span: { start: p, end: braceEnd + 1 }
                } as GrammarBraceNode);
                p = braceEnd + 1;
                continue;
            }
            // 在当前位置尝试所有原子去糖函数 匹配到就立即停止
            for (const fn of this.deSugarAtomFns) {
                try {
                    const r = fn(this.source, p, end, this.scopeDepth);
                    if (r) {
                        emit(r.node); // 一般是 kind="sugar" 的特殊node
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
                throw Diagnostic.error.UnknownFunction(callNode.name, callNode.span);
            } else {
                this.diagnostics.push(
                    Diagnostic.warning.UnknownFunction(callNode.name, callNode.span)
                );
            }
            // 未知函数，保留位置，但直接跳过
            return new ASTFunctionNode(callNode.span, null);
        }
        // 用实际传参查询定义
        if (!callNode.typed) {
            const args: FunctionArgs = new Map();
            for (let i = 0; i < callNode.args.length; i++) {
                const arg: CallArgumentInfo = callNode.args[i];
                const name = arg.nameSpan
                    ? this.source.slice(arg.nameSpan.start, arg.nameSpan.end).toLowerCase()
                    : void 0;
                const type = resolveArgType(def, name, i);
                const key = name ?? i;
                if (type === void 0) {
                    if (!def.allowExtraArgs) {
                        this.diagnostics.push(
                            Diagnostic.warning.TooManyPosArgs(
                                callNode.name, defArgs.length, i + 1, arg.valueSpan
                            )
                        );
                    } else args.set(key, arg.valueSpan);
                    continue;
                }
                const value = this.parseArgWithType(arg.valueSpan.start, arg.valueSpan.end, type, callNode.span.start);
                if (value !== null) args.set(key, value);
            }
            return new callFNClass(callNode.span, args, this, null);
        }   // 完全信任 typed 时的 arg
        // 构造函数内用定义查询实际传参
        return new callFNClass(callNode.span, callNode.args, this, null);
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
                    if (this.strict) throw e;
                    // 当前参数会被跳过，因此在恢复点记录被吞掉的具体错误
                    if (e instanceof Diagnostic) this.diagnostics.push(e);
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
                throw Diagnostic.error.UnknownLabel(text, r);
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
    while (i < end && isWhitespaceButNotNewline(s[i])) i++;
    return i;
}
/** 反向跳过非换行空白，越界返回 -1 */
export function skipSpacesBack(s: string, i: number, start: number = 0): number {
    while (i >= start && isWhitespaceButNotNewline(s[i])) i--;
    return i;
}
function isWhitespaceButNotNewline(ch: string): boolean {
    switch (ch) {
        case ' ':
        case '\t':
        case '\v':  // 垂直制表符
        case '\f':  // 换页符
        case '\u00A0':  // 不间断空格
        case '\uFEFF':  // 零宽不连字空格
        case '\u3000':  // 中文全角空格
            return true;
        default:
            return false;
        // \n 和 \r 不算
    }
}