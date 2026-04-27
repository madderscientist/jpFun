import { SourceSpan } from "./types.js";

export interface LineColRange {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

export abstract class Diagnostic {
    /** 诊断代码 */
    code: string;
    /** 诊断消息，描述问题的具体信息 */
    message: string;
    /** 诊断位置，指示问题在源代码中的位置 */
    span: SourceSpan;
    constructor(code: string, message: string, span: SourceSpan) {
        this.code = code;
        this.message = message;
        this.span = span;
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

// 两个基类区分 Warning 和 Error
export class ErrorDiagnostic extends Diagnostic {};
export class WarningDiagnostic extends Diagnostic {};

Diagnostic.error = {
    Bug: (message: string, span: SourceSpan) => {
        return new ErrorDiagnostic(
            "E_BUG",
            `解析器错误: ${message}，请联系开发者修复这个问题`,
            span
        );
    },
    MissingArg: (functionName: string, argumentName: string | number, span: SourceSpan) => {
        const argname = typeof argumentName === "number" ? `[${argumentName}]` : `"${argumentName}"`;
        return new ErrorDiagnostic(
            "E_MISSING_REQUIRED_ARG",
            `函数@${functionName} 缺少必需的参数 ${argname}`,
            span
        );
    },
    InvalidArgType: (
        functionName: string, argumentName: string | number,
        expectedType: string, actualType: string,
        span: SourceSpan
    ) => {
        const argname = typeof argumentName === "number" ? `[${argumentName}]` : `"${argumentName}"`;
        return new ErrorDiagnostic(
            "E_WRONG_ARG_TYPE",
            `函数 @${functionName} 的参数 ${argname} 类型错误: 得到了 ${actualType}，但期望 ${expectedType}`,
            span
        );
    },
    PosAfterNamedArg: (functionName: string, span: SourceSpan) => {
        return new ErrorDiagnostic(
            "E_POSARG_AFTER_KWARG",
            `函数 @${functionName} 的位置参数出现在命名参数之后，这是不允许的`,
            span
        );
    },
    EmptyContent: (functionName: string, argumentName: string | number, span: SourceSpan) => {
        const argname = typeof argumentName === "number" ? `[${argumentName}]` : `"${argumentName}"`;
        return new ErrorDiagnostic(
            "E_EMPTY_CONTENT",
            `函数 @${functionName} 的参数 ${argname} 内容为空(或无可用内容)；请提供有效内容`,
            span
        );
    },
    UnterminatedCall: (functionName: string, span: SourceSpan) => {
        return new ErrorDiagnostic(
            "E_UNTERMINATED_CALL",
            `函数调用未闭合: @${functionName}(...)`,
            span
        );
    },
    UnterminatedString: (span: SourceSpan) => {
        return new ErrorDiagnostic(
            "E_UNTERMINATED_String",
            `引号未闭合`,
            span
        );
    },
    UnknownFunction: (functionName: string, span: SourceSpan) => {
        return new ErrorDiagnostic(
            "E_UNKNOWN_FUNCTION",
            `未知函数: @${functionName}，请检查拼写`,
            span
        );
    },
    UnknownLabel: (labelName: string, span: SourceSpan) => {
        return new ErrorDiagnostic(
            "E_UNKNOWN_LABEL",
            `未知标签: "${labelName}"`,
            span
        );
    },
    InvalidTonality: (tonality: string, span: SourceSpan) => {
        return new ErrorDiagnostic(
            "E_INVALID_TONALITY",
            `无效的调性: "${tonality}"，请提供有效的调性名称，必须 [一个大写字母][变音记号#bn只能一个][绝对八度数字]，后二者可选`,
            span
        );
    }
};

Diagnostic.warning = {
    UnknownFunction: (functionName: string, span: SourceSpan) => {
        return new WarningDiagnostic(
            "W_UNKNOWN_FUNCTION",
            `未知函数: @${functionName}，将被当作普通文本处理`,
            span
        );
    },
    UnknownNamedArg: (functionName: string, argumentName: string, span: SourceSpan) => {
        return new WarningDiagnostic(
            "W_UNKNOWN_NAMED_ARG",
            `函数 @${functionName} 收到未知的命名参数 "${argumentName}"`,
            span
        );
    },
    TooManyPosArgs: (functionName: string, expected: number, actual: number, span: SourceSpan) => {
        return new WarningDiagnostic(
            "W_TOO_MANY_POS_ARGS",
            `函数 @${functionName} 接收了过多的位置参数，期望 ${expected} 个但得到了 ${actual} 个`,
            span
        );
    },
    InvalidNumber: (value: string, span: SourceSpan) => {
        return new WarningDiagnostic(
            "W_INVALID_NUMBER",
            `无效的数字: "${value}"；将使用默认值(若存在)`,
            span
        );
    },
    InvalidBoolean: (value: string, span: SourceSpan) => {
        return new WarningDiagnostic(
            "W_INVALID_BOOL",
            `无效的布尔值: "${value}": 应为 'true' 或 'false'；将使用默认值(若存在)`,
            span
        );
    },
    InvalidLength: (value: string, span: SourceSpan) => {
        return new WarningDiagnostic(
            "W_INVALID_LENGTH",
            `无效的长度值: "${value}"；请提供有效的长度值，例如 "10px" 或 "2em"；将使用默认值(若存在)`,
            span
        );
    },
    InvalidLengthUnit: (unit: string, span: SourceSpan) => {
        return new WarningDiagnostic(
            "W_INVALID_LENGTH_UNIT",
            `无效的长度单位: "${unit}"；仅支持 "px" 和 "em"；请检查函数参数或变量定义；将使用默认值(若存在)`,
            span
        );
    },
    InvalidContent: (span: SourceSpan) => {
        return new WarningDiagnostic(
            "W_INVALID_CONTENT",
            `内容解析失败，错误原因见上；将使用默认值(但往往不存在，极有可能导致错误)`,
            span
        );
    },
    EmptyContent: (functionName: string, argumentName: string, span: SourceSpan) => {
        return new WarningDiagnostic(
            "W_EMPTY_CONTENT",
            `函数 @${functionName} 的参数 "${argumentName}" 内容为空(或无可用内容)`,
            span
        );
    },
    UnmatchedBrace: (span: SourceSpan) => {
        return new WarningDiagnostic(
            "W_UNMATCHED_BRACE",
            `未匹配的大括号: 缺少右大括号'}'；将尝试自动修复`,
            span
        );
    },
    LabelWithoutTarget: (labelName: string, span: SourceSpan) => {
        return new WarningDiagnostic(
            "W_LABEL_WITHOUT_TARGET",
            `标签 "${labelName}" 没有可绑定的目标；标签将被忽略`,
            span
        );
    },
    LabelAlreadyExists: (newLabel: string, oldLabel: string, span: SourceSpan) => {
        return new WarningDiagnostic(
            "W_LABEL_ALREADY_EXISTS",
            `标签 "${newLabel}" 已经存在(为 "${oldLabel}")；新标签将覆盖旧标签`,
            span
        );
    },
};
