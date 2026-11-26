import { deSugarAtomFunction, LengthValue, SourceSpan } from "./types.js";
import { Diagnostic } from "../diagnostic.js";
import { DEFAULT_TEXT_FONT, JIANPU_NUMBER_FONT } from "../render/text.js";
import { GrammarBraceNode, GrammarCallNode, GrammarCallNodeRaw, GrammarLabelNode, GrammarNode, type CallArgumentInfo } from "./grammarType.js";
import { isNonLineWhitespace } from "./preprocess.js";
import { callArgName, readCall, trimRange } from "./parse-utils/call-utils.js";
import { parseString } from "./parse-utils/string-utils.js";
import { readBrace } from "./parse-utils/brace-utils.js";
import { readLabel } from "./parse-utils/label-utils.js";
import { parseLength } from "./parse-utils/length-utils.js";
import { ASTBraceNode, ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgDef, FunctionArgs, ASTLabelNode, paramType, paramValue, ASTTextNode, resolveArgDef, resolveArgType } from "../functions/ASTtypes.js";

// bool 字面量 严格要求小写
export const BOOL_RE = /^(true|false)$/;

export const DEFAULT_FONT_SIZE = 18;
export const DEFAULT_NUMBER_WEIGHT = 700;

// 解析上下文
export class ParserContext {
    /** 系统变量，供 `@set` 读取 */
    static systemVariables: Record<string, { type: paramType; default: paramValue; description: string }> = {
        fontsize: {
            type: "length",
            default: DEFAULT_FONT_SIZE,
            description: "基准字号，也是 `em` 长度的换算基准"
        },
        font: {
            type: "string",
            default: DEFAULT_TEXT_FONT,
            description: "普通文字字体"
        },
        numberfont: {
            type: "string",
            default: JIANPU_NUMBER_FONT,
            description: "音符及同类谱面数字字体"
        },
        numberweight: {
            type: "number",
            default: DEFAULT_NUMBER_WEIGHT,
            description: "主谱面数字字重，仅控制 `note`、`meter`、`rest`"
        },
        strict: {
            type: "boolean",
            default: false,
            description: "开启严格的语法检查"
        }
    };

    /**
     * 根解析器为 0，内容参数和大括号子解析器依次加一
     * 分组只存在于 AST 路径，导致语法糖并不会和函数调用一样开辟新的层级，因此只有 0（顶层）是可信的，非零的具体数值不可依赖
     */
    readonly scopeDepth: number;

    /** 源代码 */
    readonly source: string;
    /** 解析过程中产生的诊断信息，包含错误和警告 */
    diagnostics: Diagnostic[];
    /** 变量表，存储 `@set` 定义的变量，供解析过程中查询和修改，具有局部作用域 */
    variables: Record<string, any>;
    /** 文档级声明（只准有一个）在所有子解析器之间共享的变量 */
    documentDeclarations: Record<string, any>;
    /** 函数定义查找表 */
    functions: Map<string, ASTFunctionClass>;

    /** 第一轮原子去糖：将文本转为函数调用，或 sugar 标记；第二轮由 sugar 节点自带的 relation 处理 */
    deSugarAtomFns: deSugarAtomFunction[];

    /** .labelable() 返回的承载节点；null 是边界标记，标签绑定不能越过它 */
    labelableNodes: (ASTFunctionNode | null)[];

    /** 当前正在实例化的显式函数调用节点，供构造函数按需读取原始参数区间 */
    callNode?: GrammarCallNodeRaw;
    nodes: ASTNodeBase[]; // 解析结果
    /** 等待右操作数的中缀语法糖，见 deferRightOperand */
    private readonly pendingRight: { left: ASTNodeBase[]; combine: (right?: ASTNodeBase) => ASTNodeBase; chain?: unknown }[] = [];

    constructor(ctx: ParserContext | {
        source: string;
        diagnostics?: Diagnostic[];
        variables?: Record<string, any>;
        functions?: Map<string, ASTFunctionClass>;
        labelableNodes?: (ASTFunctionNode | null)[];
        toConsume?: ASTNodeBase[];
    }) {
        if (ctx instanceof ParserContext) {
            // 构建子上下文
            this.scopeDepth = ctx.scopeDepth + 1;
            this.documentDeclarations = ctx.documentDeclarations;
            this.source = ctx.source;
            this.diagnostics = ctx.diagnostics; // 诊断信息全局共享
            this.variables = { ...ctx.variables };  // 继承但不修改父上下文的变量
            this.functions = ctx.functions; // 函数定义全局共享
            this.deSugarAtomFns = ctx.deSugarAtomFns; // 去糖方法全局共享
            this.labelableNodes = ctx.labelableNodes;   // 标签是全局属性
            this.nodes = [];    // 待消费节点不共享，每个上下文单独维护
        } else {
            this.scopeDepth = 0;
            this.documentDeclarations = {};
            this.source = ctx.source;
            this.diagnostics = ctx.diagnostics ?? [];
            this.variables = Object.fromEntries(Object.entries(ParserContext.systemVariables).map(([name, definition]) => [name, definition.default]));
            Object.assign(this.variables, ctx.variables);
            this.functions = ctx.functions ?? new Map();
            this.labelableNodes = ctx.labelableNodes ?? [];
            this.nodes = ctx.toConsume ?? [];
            this.deSugarAtomFns = ParserContext.getDeSugarFns(this.functions.values());
        }
    }

    static getDeSugarFns(classes: Iterable<ASTFunctionClass>): deSugarAtomFunction[] {
        // 按函数去重：一个类有多个别名
        const fns = new Set<deSugarAtomFunction>();
        for (const fnClass of classes) fns.add(fnClass.deSugarAtom);
        fns.delete(ASTFunctionNode.deSugarAtom);
        return [...fns];
    }

    pushNode(node: ASTNodeBase) {
        this.nodes.push(node);
        // 未实现的对标签透明不入表，null 入表成为边界
        const target = (node as ASTFunctionNode).labelable?.();
        if (target !== undefined) this.labelableNodes.push(target);
    }

    // 统一管理系统变量和函数私有变量
    setVariable(name: string, value: paramValue | undefined) {
        if (Object.hasOwn(ParserContext.systemVariables, name)) {
            if (name === "fontsize" && value) value = this.length2px(value as LengthValue);
            if (value === undefined || value === "" || value === 0) value = ParserContext.systemVariables[name].default;
        }
        this.variables[name] = value;
    }

    registerFunctions(functionClasses: ASTFunctionClass[]) {
        const map = this.functions;
        for (const funcClass of functionClasses) {
            const def = funcClass.def;
            if (!def) continue; // 没有定义的函数不注册
            const names = Array.isArray(def.name) ? def.name : [def.name];
            for (const name of names) {
                if (map.has(name.toLowerCase())) {
                    throw new Error(`Duplicate function name detected: ${name}`);
                }
                map.set(name.toLowerCase(), funcClass);
            }
        }
        this.deSugarAtomFns = ParserContext.getDeSugarFns(this.functions.values());
    }

    //====== 解析相关 ======//
    /**
     * 扫描 GrammarNode 并构造 AST，用于最终渲染
     * 编辑器语法视图不构造 AST，见 syntax.ts 的 collectSyntax
     */
    parse(start: number = 0, end: number = this.source.length) {
        this.makeNodes(this.parseGrammar(start, end));
        return this.nodes;
    }

    /**
     * 向前寻找最后一个非文本节点下标；
     * 若末尾是标签，则将“被标注节点..标签”原位打包为 ASTBraceNode
     */
    findLastOperandIndex(): number {
        let left = this.nodes.length - 1;
        while (left >= 0 && this.nodes[left] instanceof ASTTextNode) left--;
        if (left < 0) return -1;
        const node = this.nodes[left];
        if (node instanceof ASTLabelNode) {
            let tgt: ASTNodeBase = node.target;
            while (tgt.parent) tgt = tgt.parent;
            const j = this.nodes.lastIndexOf(tgt, left - 1);
            if (j < 0) return -1;
            this.nodes.splice(j, left - j + 1, new ASTBraceNode(
                { start: tgt.sourceSpan.start, end: node.sourceSpan.end },
                this.nodes.slice(j, left + 1),
                null,
            ));
            return j;
        } return left;
    }

    /**
     * 摘出末尾最后一个操作数（含其后置标签）
     * 传入 chain 时，若该操作数恰是同一 chain 挂起合成的唯一右操作数，先合成再返回：同类中缀由此左结合
     */
    takeLeftOperand(chain?: unknown): ASTNodeBase | null {
        const index = this.findLastOperandIndex();
        if (index < 0) return null;
        const node = this.nodes[index];
        this.nodes.length = index;
        const top = this.pendingRight.at(-1);
        if (chain === undefined || top?.chain !== chain || this.nodes.some(n => !(n instanceof ASTTextNode))) return node;
        this.pendingRight.pop();
        this.nodes = top.left;
        return top.combine(node);
    }

    /**
     * 中缀语法糖的右操作数是本层剩余部分的首个非文本节点，要等本层解析完才能确定。
     * 这里只挂起：已有节点留作左侧，后续节点解析到新数组，由 makeNodes 收尾时交给 combine；没有右操作数时 combine 收到 undefined
     * 默认右结合；登记 chain 后，下一个同 chain 的中缀可经 takeLeftOperand 提前合成本帧。提前合成的结果不会进入 nodes，combine 不应有登记之类的副作用
     */
    deferRightOperand(combine: (right?: ASTNodeBase) => ASTNodeBase, chain?: unknown) {
        this.pendingRight.push({ left: this.nodes, combine, chain });
        this.nodes = [];
    }

    /**
     * 第二轮去糖 & 函数节点创建
     * 有副作用 会修改 nodes 和 labelableNodes 等上下文属性
     */
    makeNodes(nodes: (GrammarNode | number)[]) {
        const base = this.pendingRight.length;  // 只收尾本次登记的合成，同一上下文可重入
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (typeof node === "number") {
                this.pushText(node, node + 1);
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
                    // 透明节点不入表，所以表尾就是绑定终点：null 是边界，已被占用的承载者同样到此为止
                    const tgt = this.labelableNodes.at(-1);
                    if (!tgt) {
                        this.diagnostics.push(Diagnostic.warning.LabelWithoutTarget(node.label, node.span));
                    } else if (tgt.label !== void 0) {
                        this.diagnostics.push(Diagnostic.warning.TargetAlreadyLabeled(node.label, tgt.label, node.span));
                    } else {
                        tgt.label = node.label;
                        // 同时创建一个LabelNode 供编辑器等工具使用
                        this.nodes.push(new ASTLabelNode(node.span, node.label, tgt));
                    } break;
                case "sugar":
                    const next = node.relation(this, nodes, i);
                    if (next === null) this.pushText(node.span.start, node.span.end);  // 发出者放弃，保留为文本
                    else i = next - 1; // 循环会+1
                    break;
            }
        }
        // 由内向外合成，最外层的左侧就是原输出数组；各层剩余节点倒序暂存、最后接回，整体线性
        const tail: ASTNodeBase[] = [];
        while (this.pendingRight.length > base) {
            const { left, combine } = this.pendingRight.pop()!;
            const right = this.nodes;
            let i = 0;
            while (right[i] instanceof ASTTextNode) i++;
            left.push(combine(right[i]));
            for (let k = right.length - 1; k > i; k--) tail.push(right[k]);
            this.nodes = left;
        }
        while (tail.length) this.nodes.push(tail.pop()!);
    }

    /** 追加文本，与紧邻的上一个文本节点合并；新建区间对象，避免改写语法节点的 span */
    private pushText(start: number, end: number) {
        const prev = this.nodes.at(-1);
        if (prev instanceof ASTTextNode && prev.sourceSpan.end === start) prev.sourceSpan.end = end;
        else this.nodes.push(new ASTTextNode({ start, end }, null));
    }

    /**
     * 识别核心语法: 大括号/函数调用/标签，其余尝试语法糖，失败的字符以索引的形式存在于返回值中，供第二轮识别终止符或合并为 TextNode
     * 即使是关系型的语法糖，这一阶段也要将依赖的字符提取为 GrammarSugarNode，供下一阶段处理
     * 必须将第一阶段语法糖识别放到grammar解析中，比如 `@fn()`，引号若作为语法糖会导致后面的 `@` 无效
     * observe 在每个节点识别后、校验前收到该节点及当前上下文；返回 true 即接管该节点：其语法错误只记录诊断不抛出（保留 partial call），
     * 供编辑器在输入途中继续工作。不传或返回 false 时照常抛出。observe 不得改变“识别出什么结构”，否则两条路径会认不同的语言
     */
    parseGrammar(p: number, end: number, observe?: (node: GrammarNode, ctx: ParserContext) => boolean): (GrammarNode | number)[] {
        const nodes: (GrammarNode | number)[] = [];
        /** 返回观察者是否接管该节点 */
        const emit = (node: GrammarNode) => {
            nodes.push(node);
            return observe?.(node, this) ?? false;
        };
        outer: while ((p = skipSpaces(this.source, p, end)) < end) {
            const ch = this.source[p];
            if (ch === "@") {
                const call = readCall(this.source, p, end);
                if (call) {
                    // 先交给观察者再校验：抛错时编辑器仍拿得到已识别的结构
                    const tolerant = emit(Object.assign(call, {
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
                            if (!tolerant) throw error;
                            this.diagnostics.push(error);
                        }
                    }
                    // 括号未闭合
                    if (!call.closeParenSpan) {
                        const fatal = Diagnostic.error.UnterminatedCall(call.name, call.span);
                        if (!tolerant) throw fatal;
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
                if (braceEnd < 0) {
                    this.diagnostics.push(
                        Diagnostic.warning.UnmatchedBrace({ start: p, end })
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
                    // 原子级去糖一般不出错。Diagnostic 交给捕获方记录，避免内容参数恢复时重复
                    if (!(e instanceof Diagnostic)) this.diagnostics.push(
                        Diagnostic.error.Bug((e as Error).toString(), { start: p, end })
                    );
                    throw e;
                }
            } nodes.push(p++);   // 单字符的位置
        } return nodes;
    }

    parseCallNode(callNode: GrammarCallNode): ASTFunctionNode {
        const callFNClass = this.functions.get(callNode.name.toLowerCase());
        const def = callFNClass?.def;
        if (!callFNClass || !def) {
            if (this.variables.strict) {
                throw Diagnostic.error.UnknownFunction(callNode.name, callNode.span);
            } else {
                this.diagnostics.push(
                    Diagnostic.warning.UnknownFunction(callNode.name, callNode.span)
                );
            }
            // 未知函数，保留位置，但直接跳过
            return new ASTFunctionNode(callNode.span, null);
        }
        const defArgs: FunctionArgDef[] = def.args;
        // 用实际传参查询定义
        if (!callNode.typed) {
            const args: FunctionArgs = new Map();
            for (let i = 0; i < callNode.args.length; i++) {
                const arg: CallArgumentInfo = callNode.args[i];
                const name = callArgName(this.source, arg);
                const type = resolveArgType(def, name, i);
                const key = name ?? i;
                if (type === void 0) {
                    if (!def.allowExtraArgs) {
                        this.diagnostics.push(name ?
                            Diagnostic.warning.UnknownArg(
                                callNode.name, this.source.slice(arg.nameSpan!.start, arg.nameSpan!.end), arg.span
                            ) :
                            Diagnostic.warning.TooManyPosArgs(
                                callNode.name, defArgs.filter(arg => !arg.namedOnly).length, i + 1, arg.valueSpan
                            )
                        );
                    } else args.set(key, arg);
                    continue;
                }
                const required = resolveArgDef(def, name, i)?.default === null;
                const value = this.parseArgWithType(arg.valueSpan, type, callNode.span.start, required);
                if (value !== null) args.set(key, value);
            }
            this.callNode = callNode;
            return new callFNClass(callNode.span, args, this, null);
        }   // 完全信任 typed 时的 arg
        this.callNode = undefined;
        // 构造函数内用定义查询实际传参
        return new callFNClass(callNode.span, callNode.args, this, null);
    }

    /**
     * 根据参数类型解析参数值，解析过程中会记录诊断信息
     * funcStart 是为了找到该函数之前的label的位置 因为如果content先解析会污染 labelableNodes
     * 解析成功返回值 解析失败返回null
     * required 的 content 解析失败时直接抛出内部错误：返回 null 只会换来掩盖真因的缺参错误
     */
    parseArgWithType(span: SourceSpan, type?: paramType, funcStart?: number, required = false): paramValue | null {
        // 先去空白
        const r = trimRange(this.source, span.start, span.end);
        const start = r.start, end = r.end;
        if (start >= end) return null; // 纯空白参数视为未提供
        // 类型匹配
        const text = (type === "content") ? '' : this.source.slice(start, end);
        switch (type) {
            case "number":
                const num = Number(text);
                if (!Number.isFinite(num)) {    // NaN or Infinity 的判断
                    this.diagnostics.push(
                        Diagnostic.warning.InvalidNumber(text, r)
                    ); return null;
                } return num;
            case "boolean":
                if (BOOL_RE.test(text)) {
                    return text === "true";
                } else {
                    this.diagnostics.push(
                        Diagnostic.warning.InvalidBoolean(text, r)
                    ); return null;
                }
            case "content": {
                // 用于失败后恢复（撤销改动）
                const candidates = this.labelableNodes;
                const length = candidates.length;
                const target = candidates.at(-1);
                const label = target?.label;
                const hadLabel = target && Object.hasOwn(target, "label");
                // 开启新的局部解析器
                try {
                    const subParser = new ParserContext(this);
                    const n = subParser.parse(start, end);
                    if (n.length === 1) return n[0];
                    return new ASTBraceNode(r, n, null);
                } catch (e) {
                    candidates.length = length;
                    if (target) {
                        if (hadLabel) target.label = label;
                        else delete target.label;
                    }
                    if (required || this.variables.strict || !(e instanceof Diagnostic)) throw e;
                    // 当前参数会被跳过，因此在恢复点记录被吞掉的具体错误
                    this.diagnostics.push(e, Diagnostic.warning.InvalidContent(r));
                    return null;
                }
            }
            case "label":
                // 应对潜在的问题: 如果先解析了content会导致ctx.lavelableNodes被污染
                funcStart ??= span.start;
                // label情况下返回对象 从后向前查找以支持标签覆盖
                for (let i = this.labelableNodes.length - 1; i >= 0; i--) {
                    const node = this.labelableNodes[i];
                    if (!node) continue;    // 边界标记不参与按名查找
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
                const s = parseString(text);
                if (s instanceof Diagnostic) {
                    s.span.start += start;
                    s.span.end += start;
                    this.diagnostics.push(s);
                    return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
                } return s;
        }
    }

    length2px(length: LengthValue): number {
        // 不进行错误判断了: 来自 parseArgWithType 的不会出问题
        if (length.unit === "em") return length.value * this.variables.fontsize;
        else return length.value;
    }
}

// 换行转义已经在预处理解决了，这里不用再跳过了
export function skipSpaces(s: string, i: number, end: number): number {
    while (i < end && isNonLineWhitespace(s.charCodeAt(i))) i++;
    return i;
}
/** 反向跳过非换行空白，越界返回 -1 */
export function skipSpacesBack(s: string, i: number, start: number = 0): number {
    while (i >= start && isNonLineWhitespace(s.charCodeAt(i))) i--;
    return i;
}