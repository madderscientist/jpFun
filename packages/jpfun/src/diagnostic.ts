import { SourceSpan } from "./parser/types.js";

export interface LineColRange {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

export type DiagnosticParams = Record<string, string>;

const PLACEHOLDER_RE = /\{(\w+)\}/g;

export abstract class Diagnostic {
    /** 诊断代码 */
    code: string;
    /** 诊断消息，描述问题的具体信息 */
    message: string;
    /** 诊断位置，指示问题在源代码中的位置 */
    span: SourceSpan;
    /** 诊断消息中的结构化参数（构造时复制并字符串化，不修改或持有原对象） */
    params?: DiagnosticParams;

    // 多语言支持：仅需要替换此函数
    static format(code: string, message: string, params?: DiagnosticParams): string {
        return params
            ? message.replace(PLACEHOLDER_RE, (match, k: string) => Object.hasOwn(params, k) ? params[k] : match)
            : message;
    }

    constructor(
        code: string,
        message: string,
        span: SourceSpan,
        params?: Record<string, string | number | { toString(): string }>,
    ) {
        this.code = code;
        this.span = span;
        if (params) {
            const dict: DiagnosticParams = {};
            for (const key of Object.keys(params)) dict[key] = String(params[key]);
            this.params = dict;
        }
        this.message = Diagnostic.format(code, message, this.params);
    }

    toLineCol(lineStarts: ArrayLike<number>): LineColRange {
        const start = Diagnostic.offsetToLineCol(this.span.start, lineStarts);
        const end = Diagnostic.offsetToLineCol(this.span.end, lineStarts);
        return {
            startLine: start.line,
            startColumn: start.column,
            endLine: end.line,
            endColumn: end.column,
        };
    }

    static offsetToLineCol(offset: number, lineStarts: ArrayLike<number>): { line: number; column: number } {
        const count = lineStarts.length;
        if (count === 0) {
            return { line: 1, column: Math.max(0, offset) + 1 };
        }
        let target = offset;
        if (target < 0) target = 0;

        let lo = 0;
        let hi = count - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (lineStarts[mid] <= target) lo = mid + 1;
            else hi = mid - 1;
        }
        const lineIndex = Math.max(0, hi);
        const lineStart = lineStarts[lineIndex] ?? 0;
        return {
            line: lineIndex + 1,
            column: target - lineStart + 1,
        };
    }

    static error: any;
    static warning: any;
}

const formatArg = (arg: string | number) => typeof arg === "number" ? `[${arg}]` : `"${arg}"`;

// 两个基类区分 Warning 和 Error
export class ErrorDiagnostic extends Diagnostic {}
export class WarningDiagnostic extends Diagnostic {}

Diagnostic.error = {
    Bug: (message: string, span: SourceSpan) =>
        new ErrorDiagnostic(
            "E_BUG",
            "解析器错误: {message}，请联系开发者修复这个问题", span,
            { message }
        ),
    MissingArg: (functionName: string, argumentName: string | number, span: SourceSpan) =>
        new ErrorDiagnostic(
            "E_MISSING_REQUIRED_ARG",
            "函数@{fn} 缺少必需的参数 {arg}", span,
            { fn: functionName, arg: formatArg(argumentName) }
        ),
    PosAfterNamedArg: (functionName: string, span: SourceSpan) =>
        new ErrorDiagnostic(
            "E_POSARG_AFTER_KWARG",
            "函数 @{fn} 的位置参数出现在命名参数之后，这是不允许的", span,
            { fn: functionName }
        ),
    EmptyContent: (functionName: string, argumentName: string | number, span: SourceSpan) =>
        new ErrorDiagnostic(
            "E_EMPTY_CONTENT",
            "函数 @{fn} 的参数 {arg} 内容为空(或无可用内容)；请提供有效内容", span,
            { fn: functionName, arg: formatArg(argumentName) }
        ),
    UnterminatedCall: (functionName: string, span: SourceSpan) =>
        new ErrorDiagnostic(
            "E_UNTERMINATED_CALL",
            "函数调用未闭合: @{fn}(...)", span,
            { fn: functionName }
        ),
    UnknownFunction: (functionName: string, span: SourceSpan) =>
        new ErrorDiagnostic(
            "E_UNKNOWN_FUNCTION",
            "未知函数: @{fn}，请检查拼写", span,
            { fn: functionName }
        ),
    UnknownLabel: (labelName: string, span: SourceSpan) =>
        new ErrorDiagnostic(
            "E_UNKNOWN_LABEL",
            '未知标签: "{label}"', span,
            { label: labelName }
        ),
    BreakInsideEvent: (span: SourceSpan) =>
        new ErrorDiagnostic(
            "E_BREAK_INSIDE_EVENT",
            "换行或换页切断了一个仍在持续的事件；请把长音写成多个事件，或调整换行、换页的位置", span
        ),
    PageOverflow: (required: number, available: number, span: SourceSpan) =>
        new ErrorDiagnostic(
            "E_PAGE_OVERFLOW",
            "谱面行需要 {required}px 高度，但页面内容区只有 {available}px", span,
            { required, available }
        ),
};

Diagnostic.warning = {
    UnknownFunction: (functionName: string, span: SourceSpan) =>
        new WarningDiagnostic(
            "W_UNKNOWN_FUNCTION",
            "未知函数: @{fn}，将被当作普通文本处理", span,
            { fn: functionName }
        ),
    TooManyPosArgs: (functionName: string, expected: number, actual: number, span: SourceSpan) =>
        new WarningDiagnostic(
            "W_TOO_MANY_POS_ARGS",
            "函数 @{fn} 接收了过多的位置参数，期望 {expected} 个但得到了 {actual} 个", span,
            { fn: functionName, expected, actual }
        ),
    InvalidNumber: (value: string, span: SourceSpan) =>
        new WarningDiagnostic(
            "W_INVALID_NUMBER",
            '无效的数字: "{value}"；将使用默认值(若存在)', span,
            { value }
        ),
    InvalidBoolean: (value: string, span: SourceSpan) =>
        new WarningDiagnostic(
            "W_INVALID_BOOL",
            '无效的布尔值: "{value}": 应为 \'true\' 或 \'false\'；将使用默认值(若存在)', span,
            { value }
        ),
    InvalidLength: (value: string, span: SourceSpan) =>
        new WarningDiagnostic(
            "W_INVALID_LENGTH",
            '无效的长度值: "{value}"；请提供有效的长度值，例如 "10px" 或 "2em"；将使用默认值(若存在)', span,
            { value }
        ),
    InvalidLengthUnit: (unit: string, span: SourceSpan) =>
        new WarningDiagnostic(
            "W_INVALID_LENGTH_UNIT",
            '无效的长度单位: "{unit}"；仅支持 "px" 和 "em"；请检查函数参数或变量定义；将使用默认值(若存在)', span,
            { unit }
        ),
    InvalidContent: (span: SourceSpan) =>
        new WarningDiagnostic(
            "W_INVALID_CONTENT",
            "内容解析失败，错误原因见上；将使用默认值(但往往不存在，极有可能导致错误)", span
        ),
    UnmatchedBrace: (span: SourceSpan) =>
        new WarningDiagnostic(
            "W_UNMATCHED_BRACE",
            "未匹配的大括号: 缺少右大括号'}'；将尝试自动修复", span
        ),
    LabelWithoutTarget: (labelName: string, span: SourceSpan) =>
        new WarningDiagnostic(
            "W_LABEL_WITHOUT_TARGET",
            '标签 "{label}" 没有可绑定的目标；标签将被忽略', span,
            { label: labelName }
        ),
    TargetAlreadyLabeled: (newLabel: string, oldLabel: string, span: SourceSpan) =>
        new WarningDiagnostic(
            "W_TARGET_ALREADY_LABELED",
            '目标已标注为 "{oldLabel}"，"{newLabel}" 将被忽略', span,
            { oldLabel, newLabel }
        ),
    UnresolvedEndpoint: (functionName: string, span: SourceSpan) =>
        new WarningDiagnostic(
            "W_UNRESOLVED_ENDPOINT",
            "@{fn} 有端点找不到对应的谱面对象；该关系将被忽略", span,
            { fn: functionName }
        ),
    ZeroTimeTrack: (span: SourceSpan, trackOrder: number) =>
        new WarningDiagnostic(
            "W_ZERO_TIME_TRACK",
            "第{track}个子轨道的时长为0", span,
            { track: trackOrder }
        ),
};
