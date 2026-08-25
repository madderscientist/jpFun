import { ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass, paramType, primaryName, resolveArgType } from "../ASTtypes.js";
import { WarningDiagnostic } from "../../diagnostic.js";
import { SYSTEM_VARIABLE_TYPES } from "../../parser/parserContext.js";
import type { CallArgumentInfo } from "../../parser/grammarType.js";

class SetFunction extends ASTFunctionNode {
    static override def = {
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

    /** 值的类型由目标参数决定：`函数名.参数名` 查该函数的声明，无点号的是内置变量 */
    private static resolveTarget(ctx: ParserContext, key: string, nameSpan: SourceSpan): [string, paramType] | null {
        const dot = key.lastIndexOf(".");
        if (dot < 0) return [key, SYSTEM_VARIABLE_TYPES[key] ?? "string"];

        const argName = key.slice(dot + 1);
        const def = ctx.functions.get(key.slice(0, dot))?.prototype.def;
        const type = def && resolveArgType(def, argName, -1);
        if (!def || !type) {
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_SET_UNKNOWN_TARGET",
                `@set 的参数 [${key}] 没有对应的函数或其参数，将被忽略`,
                nameSpan
            )); return null;
        }
        if (type === "content" || type === "label") {
            ctx.diagnostics.push(new WarningDiagnostic(
                "W_SET_INVALID_VALUE_TYPE",
                `@set 的参数 [${key}] 内容和标签不能作为默认值，将被忽略`,
                nameSpan
            )); return null;
        }
        // 别名统一成主名，否则 getArgValue 按主名查不到
        return [`${primaryName(def)}.${argName}`.toLowerCase(), type];
    }

    args: FunctionArgs = new Map();

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        for (const [key, value] of args) {
            const arg = value as CallArgumentInfo;
            if (typeof key !== "string") {
                ctx.diagnostics.push(new WarningDiagnostic(
                    "W_SET_POSITIONAL_ARG",
                    `函数 @set 不接收位置参数, 位置参数[${key}]将被忽略`,
                    arg.span
                )); continue;
            }
            const target = SetFunction.resolveTarget(ctx, key.toLowerCase(), arg.nameSpan ?? arg.span);
            if (target === null) continue;
            const [k, type] = target;
            // 按目标参数的声明类型固化，否则消费者只能拿到 raw text 各自再解析一遍
            const v = ctx.parseArgWithType(arg.valueSpan, type, sourceSpan.start);
            if (v === null) {
                ctx.diagnostics.push(new WarningDiagnostic(
                    "W_SET_INVALID_VALUE",
                    `函数 @set 的参数值解析失败, 参数[${key}]将被忽略`,
                    arg.valueSpan
                )); continue;
            }
            ctx.setVariable(k, v);
            this.args.set(k, v);
        }
    }

    override toString() {
        return `@set(${Array.from(this.args.entries()).map(([k, v]) => `${k}=${v}`).join(", ")})`;
    }
}

export const SetNode: ASTFunctionClass = SetFunction;