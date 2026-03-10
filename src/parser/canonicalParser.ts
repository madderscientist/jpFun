import { Diagnostic, ErrorDiagnostic, WarningDiagnostic } from "./diagnostic";
import { ParserContext } from "./parseContext";
import { readCall, CallInfo, trimRange, findTopLevelEquals, removeQuote } from "./parse-utils/call-utils";
import { TokenNode, ASTFunctionNode, ASTBraceNode, FunctionArgs, FunctionArgDef, deSugarFunction, paramType, paramValue, ASTFunctionClass } from "../functions/types";
import { readBrace } from "./parse-utils/brace-utils";
import { readLabel } from "./parse-utils/label-utils";
import { LabelNode } from "./labelNode";

// bool 字面量
const BOOL_RE = /^(true|false)$/i;

export class CanonicalParser {
    context: ParserContext;
    #cursor: number;
    #end: number;

    get cursor() { return this.#cursor; }
    get end() { return this.#end; }

    constructor(ctx: ParserContext | CanonicalParser, start?: number, end?: number) {
        if (ctx instanceof CanonicalParser) {
            // 子域解析
            this.context = new ParserContext(ctx.context);
        } else {
            this.context = ctx;
        }
        this.#cursor = start ?? 0;
        this.#end = end ?? this.context.source.length;
    }

    // 解析content的函数，是基本入口 展现了本脚本的核心语法
    // 返回值为是否成功解析（遇到严重错误时返回false） 具体错误通过诊断信息报告
    // 所有throw都汇集到这一层处理
    parse(): boolean {
        while (
            (this.#cursor = skipSpaces(this.context.source, this.#cursor, this.#end))
            < this.#end // 跳过空白
        ) {
            const ch = this.context.source[this.#cursor];
            if (ch === "@") {
                const callResult = readCall(this.context.source, this.#cursor);
                if (callResult.fatal) {
                    this.context.diagnostics.push(callResult.fatal);
                    if (callResult.fatal instanceof ErrorDiagnostic) return false;
                }
                // readCall没有后边界约束 需要额外判断
                if (callResult.call && callResult.call.end <= this.#end) {
                    try {
                        // 如果存在缺少的必填参数，parseCallNode最后的构造函数内部会抛错 这里捕获并转换为诊断信息
                        const callNode = this.parseCallNode(callResult.call);
                        this.context.pushNewNode(callNode);
                        this.#cursor = callResult.call.end;
                    } catch (e) {
                        const span = {
                            start: callResult.call.start,
                            end: callResult.call.end,
                        };
                        if (e instanceof ErrorDiagnostic) {
                            this.context.diagnostics.push(e);
                            return false;
                        } else if (e instanceof WarningDiagnostic) {
                            this.context.diagnostics.push(e);
                            this.context.pushNewNode(new ASTFunctionNode(span, null));
                            this.#cursor = span.end; // 跳过这个调用继续解析
                        } else if (e instanceof Error) {
                            this.context.diagnostics.push(Diagnostic.error.Bug(e.toString(), span));
                            return false;
                        }
                    } continue;
                }
                // 认为是label
                const labelResult = readLabel(this.context.source, this.#cursor, this.#end);
                if (labelResult) {
                    // 找最近的可标签化节点并设置标签
                    const labelList = this.context.labelableNodes;
                    if (labelList.length > 0) {
                        const tgt = labelList[labelList.length - 1];
                        tgt.label = labelResult.label;
                        // 同时创建一个LabelNode 供编辑器等工具使用
                        const labelNode = new LabelNode(
                            {
                                start: this.#cursor,
                                end: labelResult.next,
                            },
                            labelResult.label,
                            tgt
                        );
                        this.context.toConsume.push(labelNode); // 处理待消费列表只处理没有parent的 而label是有parent的 label其实无所谓parent
                    } else {
                        // 没有可标签化的节点，报错但继续解析
                        this.context.diagnostics.push(
                            Diagnostic.warning.LabelWithoutTarget(
                                labelResult.label, {
                                start: this.#cursor,
                                end: labelResult.next,
                            }
                            )
                        );
                    }
                    this.#cursor = labelResult.next;
                    continue;
                }
                // 既不是调用也不是标签，继续当普通文本处理 比如只有一个@
            }
            if (ch === "{") {
                // 找到结尾
                let braceEnd = readBrace(this.context.source, this.#cursor, this.#end);
                // 大括号不匹配 报警 但继续解析 相当于补了一个右大括号
                if (braceEnd < 0 || braceEnd >= this.#end || braceEnd <= this.#cursor) {
                    this.context.diagnostics.push(
                        Diagnostic.warning.UnmatchedBrace({
                            start: this.#cursor,
                            end: this.#end
                        })
                    );
                    braceEnd = this.#end;
                }
                const subParser = new CanonicalParser(this, this.#cursor + 1, braceEnd);
                if (!subParser.parse()) return false; // 子解析失败 直接返回
                this.context.toConsume.push(
                    new ASTBraceNode(   // 对应大括号
                        { start: this.#cursor, end: braceEnd },
                        subParser.context.toConsume, null
                    )
                );
                this.#cursor = braceEnd + 1;
                continue;
            }
            // 尝试去糖
            try {
                if (this.tryDesugar()) continue;
            } catch (e) {
                return false;   // 去糖过程中如果抛出错误 直接返回 假设去糖函数内部已经生成了相关诊断信息
            }
            // 其他情况视为普通文本，继续往后找直到遇到下一个特殊字符
            const lastUselessNode = this.context.toConsume.at(-1);
            if (lastUselessNode instanceof TokenNode && this.#cursor === lastUselessNode.sourceSpan.end) {
                lastUselessNode.sourceSpan.end = this.#cursor + 1;
            } else this.context.toConsume.push(
                new TokenNode({
                    start: this.#cursor,
                    end: this.#cursor + 1,
                })
            );
            this.#cursor++;
        } return true;
    }

    // ifBestMatch为true时会选择最优的去糖方案 但是目前好像糖之间没有重叠 所以先不启用这个功能 直接找到第一个可用的就执行
    // desugarfn返回null表示不可用，如果throw则认为语法糖异常
    tryDesugar(ifBestMatch: boolean = false): boolean {
        const execAtOnce = !ifBestMatch; // 是否立即执行找到的第一个可用的去糖函数
        let furthest = this.#cursor - 1, maxConsumed = -1;
        let bestMatch: deSugarFunction | null = null;
        for (const desugarfn of this.context.deSugarFns) {
            const r = desugarfn(this, execAtOnce);
            if (!r) continue;
            if (execAtOnce) {
                this.#cursor = r.next;
                return true;
            }
            if (r.next > furthest || (r.next === furthest && r.canConsumeNumber > maxConsumed)) {
                furthest = r.next;
                maxConsumed = r.canConsumeNumber;
                bestMatch = desugarfn;
            }
        }
        if (bestMatch) {
            const execResult = bestMatch(this, true);
            if (execResult) {
                this.#cursor = execResult.next;
                return true;
            }
        } return false;
    }

    // 进一步解析参数构成 通过throw报告错误
    parseCallNode(callInfo: CallInfo): ASTFunctionNode {
        const span = {
            start: callInfo.start,
            end: callInfo.end,
        };
        const callFNClass = this.context.functions.get(callInfo.name.toLowerCase());
        const def = callFNClass?.prototype.def;
        const defArgs: FunctionArgDef[] | undefined = def?.args;
        if (!callFNClass || !defArgs) {
            if (this.context.strict) {
                this.context.diagnostics.push(
                    Diagnostic.error.UnknownFunction(
                        callInfo.name, span
                    )
                );
                this.#cursor = this.context.source.length;
            } else {
                this.context.diagnostics.push(
                    Diagnostic.warning.UnknownFunction(
                        callInfo.name, span
                    )
                );
            }
            // 未知函数，保留位置，但直接跳过
            return new ASTFunctionNode(span, null);
        }
        // 用实际传参查询定义
        const args: FunctionArgs = new Map();
        let positionArgEnd = false; // 位置参数是否已经结束
        for (let i = 0; i < callInfo.argRanges.length; i++) {
            const arg = callInfo.argRanges[i];
            const eq = findTopLevelEquals(this.context.source, arg.start, arg.end);
            const isNamed = eq > arg.start;
            if (isNamed && !positionArgEnd) positionArgEnd = true; // 位置参数结束
            else if (!isNamed && positionArgEnd) {
                // 位置参数不允许出现在命名参数之后
                throw Diagnostic.error.PosAfterNamedArg(
                    callInfo.name, arg
                );
            }
            let key: string | number;
            let value: paramValue | null;
            if (isNamed) {
                key = this.context.source.slice(arg.start, eq).trim().toLowerCase();
                // 检查参数名是否在定义中 不在则警告但继续解析
                const find = defArgs.find(defArg => defArg.name?.toLowerCase() === key);
                if (!find) {
                    if (def.allowExtraArgs) {
                        value = this.parseArgWithType(eq + 1, arg.end, "string"); // 额外参数一律当字符串处理
                    } else {
                        this.context.diagnostics.push(
                            Diagnostic.warning.UnknownNamedArg(callInfo.name, key, { start: arg.start, end: eq })
                        ); continue;
                    }
                } else value = this.parseArgWithType(eq + 1, arg.end, find.type);
            } else {
                // 位置参数超过定义数量则警告并跳过但继续解析
                if (i >= defArgs.length && !def.allowExtraArgs) {
                    this.context.diagnostics.push(
                        Diagnostic.warning.TooManyPosArgs(
                            callInfo.name, defArgs.length, i + 1, arg
                        )
                    ); continue;
                }
                // 为空则跳过
                if (arg.start >= arg.end) continue;
                key = i;
                value = this.parseArgWithType(arg.start, arg.end, defArgs[i]?.type);
            }
            if (value === null) continue; // 解析失败（如类型不匹配）则跳过该参数 相关报错已经在 parseArgWithType 中生成
            args.set(key, value);
        }
        // 构造函数内用定义查询实际传参 报错交给外部处理
        return new callFNClass(span, args, this.context, null);
    }

    // 解析成功返回值 解析失败返回null
    parseArgWithType(argStart: number, argEnd: number, type?: paramType): paramValue | null {
        // 先去空白
        const r = trimRange(this.context.source, argStart, argEnd);
        const start = r.start, end = r.end;
        if (start >= end) return null; // 纯空白参数视为未提供
        // 类型匹配
        const text = this.context.source.slice(start, end);
        switch (type) {
            case "number":
                const num = Number(text);
                if (isNaN(num)) {
                    this.context.diagnostics.push(
                        Diagnostic.warning.InvalidNumber(text, r)
                    ); return null;
                }
                return num;
            case "boolean":
                const boolText = text;
                if (BOOL_RE.test(boolText)) {
                    return boolText === "true";
                } else {
                    this.context.diagnostics.push(
                        Diagnostic.warning.InvalidBoolean(text, r)
                    ); return null;
                }
            case "content":
                // 开启新的局部解析器
                const subParser = new CanonicalParser(this, start, end);
                if (!subParser.parse()) {
                    this.context.diagnostics.push(
                        Diagnostic.warning.InvalidContent(r)
                    ); return null;
                }
                // 如果内容已经被大括号包裹则不再包裹
                const toConsume = subParser.context.toConsume;
                if (toConsume.length === 1 && toConsume[0] instanceof ASTBraceNode) return toConsume[0];
                return new ASTBraceNode(
                    r, subParser.context.toConsume, null
                );
            case "label":
                // label情况下返回对象 从后向前查找以支持标签覆盖
                for (let i = this.context.labelableNodes.length - 1; i >= 0; i--) {
                    const node = this.context.labelableNodes[i];
                    if (node.label == text) return node;   // 标签需要严格匹配
                }
                // 没找到标签，报错
                this.context.diagnostics.push(
                    Diagnostic.error.UnknownLabel(text, r)
                );
                this.#cursor = this.context.source.length;
                return null;
            // 其他类型一律视为string
            default:
                // 去除首尾引号（单引号或双引号），如果存在
                let result: string | null = text;
                return removeQuote(result);
        } return null;
    }
}

export function skipSpaces(s: string, i: number, end: number): number {
    for (; i < end; i++) {
        // 这两个不能作为语法糖
        if (s[i] === ' ' || s[i] === '\t') continue;
        if (s[i] === '\\') {    // 转义换行符视为空格 允许后面有忘了删的空格
            for (let j = i + 1; j < end; j++) {
                if (s[j] === ' ' || s[j] === '\t') continue;
                if (s[j] === '\n') {
                    i = j;
                    break;
                } return i;
            }
        } else break;
    } return i;
}