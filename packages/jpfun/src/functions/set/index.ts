import { ASTNodeBase, FunctionArgs, SourceSpan, ASTFunctionNode, ASTFunctionClass, paramType, primaryName, resolveArgType } from "../ASTtypes.js";
import { WarningDiagnostic } from "../../diagnostic.js";
import { quote } from "../../parser/parse-utils/string-utils.js";
import { ParserContext } from "../../parser/parserContext.js";
import type { CallArgumentInfo } from "../../parser/grammarType.js";

class SetFunction extends ASTFunctionNode {
    static override def = {
        name: ["set"],
        description: "设置局部默认值",
        details: `\
~~~jpfun
@set(fontsize=20, strict=true)
{ @set(note.octave=5, note.color=#f00) C D E }
~~~
接受命名参数，可一次设置多项：
- **系统选项**：如 \`fontsize=20\` 将字号设为 20px，\`strict=true\` 开启严格模式
- **函数默认参数**：按 \`函数主名.参数名=值\` 书写，例如 \`note.octave=5\`、\`note.color=#f00\`；显式传参优先

设置从当前位置起生效，限于当前作用域及其子作用域；离开内容块后恢复外层设置。它按源码作用域解析，与演奏时间无关。`,
        allowExtraArgs: true,
        args: []
    };

    /** 值的类型由目标参数决定：`函数名.参数名` 查该函数的声明，无点号的是内置变量 */
    private static resolveTarget(ctx: ParserContext, key: string, nameSpan: SourceSpan): [string, paramType] | null {
        const dot = key.lastIndexOf(".");
        if (dot < 0) return [key, Object.hasOwn(ParserContext.systemVariables, key) ? ParserContext.systemVariables[key].type : "string"];

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
        return `@set(${Array.from(this.args, ([key, value]) => `${key}=${typeof value === "string" ? quote(value) : value}`).join(", ")})`;
    }
}

export const SetNode: ASTFunctionClass = SetFunction;