import {
    functionAddonKey,
    type ASTFunctionClass,
} from "../functions/ASTtypes.js";
import { defaultTextMeasurer } from "../render/text.js";
import type { TextMeasurer } from "../render/types.js";
import type {
    LayoutDecorationHandler,
    LayoutPrepareContext,
} from "./types.js";

/**
 * 从函数类声明创建排版上下文
 *
 * 与 LoweringContext.registerFunctions 使用相同的注册思想
 * 新增装饰函数只修改自己的类，不修改 layout 引擎
 */
export function createLayoutPrepareContext(
    functionClasses: Iterable<ASTFunctionClass>,
    options: {
        textMeasurer?: TextMeasurer;
    } = {},
): LayoutPrepareContext {
    const handlers = new Map<string, LayoutDecorationHandler>();
    const uniqueClasses = new Set(functionClasses);

    for (const functionClass of uniqueClasses) {
        const handler = functionClass.layoutDecorationHandler;
        if (!handler) continue;

        const names = functionClass.def?.name;
        if (!names) continue;
        const primaryName = Array.isArray(names) ? names[0] : names;
        handlers.set(functionAddonKey(primaryName), handler);
    }

    return {
        textMeasurer: options.textMeasurer ?? defaultTextMeasurer,
        decorationHandlers: handlers,
    };
}