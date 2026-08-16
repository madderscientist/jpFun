import {
    ASTFunctionNode,
    functionAddonKey,
    type ASTFunctionClass,
} from "../functions/ASTtypes.js";
import { defaultGlyphProvider } from "../render/glyphs.js";
import type { GlyphProvider } from "../render/types.js";
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
        glyphs?: GlyphProvider;
    } = {},
): LayoutPrepareContext {
    const handlers = new Map<string, LayoutDecorationHandler>();
    const uniqueClasses = new Set(functionClasses);

    for (const functionClass of uniqueClasses) {
        const staticClass = functionClass as unknown as typeof ASTFunctionNode;
        const handler = staticClass.layoutDecorationHandler;
        if (!handler) continue;

        const names = staticClass.def?.name;
        if (!names) continue;
        const primaryName = Array.isArray(names) ? names[0] : names;
        handlers.set(functionAddonKey(primaryName), handler);
    }

    return {
        glyphs: options.glyphs ?? defaultGlyphProvider,
        decorationHandlers: handlers,
    };
}