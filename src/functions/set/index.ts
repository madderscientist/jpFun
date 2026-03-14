import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes";
import { Diagnostic, WarningDiagnostic } from "../../parser/diagnostic";

class SetFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["set"],
        description: "设置局部默认值",
        example: `@set(fontSize=20) 则当前块内默认字体变为20px
可以设置其他函数的默认值: {函数名}.{属性}=值，例:
@set(note.octave=5, note.color=#f00)

注意：@set 作用域仅在其所处 '{}' 内、其出现之后。离开当前作用域会恢复为之前的设置。此设置和时序无关，类似于局部变量。
`,
        allowExtraArgs: true,
        args: []
    };

    args: FunctionArgs = new Map();

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        for (const [key, value] of args) {
            if (typeof key === "string") {
                // 先用string提取出raw text
                const v = ctx.parseArgWithType((value as SourceSpan).start, (value as SourceSpan).end, "string", sourceSpan.start);
                if (v === null) {
                    ctx.diagnostics.push(new WarningDiagnostic(
                        "W_SET_INVALID_VALUE",
                        `函数 @set 的参数值解析失败, 参数[${key}]将被忽略`,
                        value as SourceSpan
                    )); continue;
                }
                let k = key.toLowerCase(); // 统一小写处理
                try {
                    // ctx内置的setter可能报错
                    ctx.variables[k] = v;
                    this.args.set(k, v);
                } catch(e) {
                    if (e instanceof Diagnostic) {
                        e.span = value as SourceSpan;
                        ctx.diagnostics.push(e);
                        if (e.code[0] === "E") throw e;
                    }
                }
            } else {
                ctx.diagnostics.push(new WarningDiagnostic(
                    "W_SET_POSITIONAL_ARG",
                    `函数 @set 不接收位置参数, 位置参数[${key}]将被忽略`,
                    value as SourceSpan
                ));
            }
        }
    }

    toString(source: string): string {
        return `@set(${Array.from(this.args.entries()).map(([k, v]) => `${k}=${v}`).join(", ")})`;
    }
}

export const SetNode: ASTFunctionClass = SetFunction;