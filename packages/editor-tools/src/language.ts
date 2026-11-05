import {
    ASTFunctionNode,
    ASTLabelNode,
    defaultFunctions,
    resolveArgDef,
    resolveArgType,
    symbols,
    type ASTNodeBase,
    type CallInfo,
    type FunctionArgDef,
    type FunctionDef,
    type SourceSpan,
    type SourceEdit,
    type SyntaxAnalysis,
    type SyntaxToken,
} from "jpfun";

export const functionDefinitions: ReadonlyMap<string, FunctionDef> = new Map(
    defaultFunctions.flatMap(fnClass => {
        const def = fnClass.prototype.def;
        if (!def) return [];
        const names = Array.isArray(def.name) ? def.name : [def.name];
        return names.map(name => [name.toLowerCase(), def] as const);
    }),
);

export function functionNodeAt(node: ASTNodeBase, pos: number): ASTFunctionNode | null {
    if (pos < node.sourceSpan.start || pos >= node.sourceSpan.end) return null;
    for (const child of node.children ?? []) {
        const deeper = functionNodeAt(child, pos);
        if (deeper) return deeper;
    }
    return node instanceof ASTFunctionNode && node.def ? node : null;
}

export function argumentDoc(def: FunctionDef, argument: FunctionArgDef, position?: number): string {
    if (!argument.namedOnly && position === undefined) {
        position = 0;
        for (const item of def.args) {
            if (!item.namedOnly) position++;
            if (item === argument) break;
        }
    }
    const value = argument.default;
    const defaultValue = value !== null && typeof value === "object" && "unit" in value
        ? `${value.value}${value.unit}` : JSON.stringify(value);
    const title = argument.namedOnly
        ? `**${argument.name}** · 仅命名参数`
        : `**${position}. ${argument.name ?? "位置参数"}**`;
    return `${title} · \`${argument.type}\` · ${value === null ? "必填" : `默认 \`${defaultValue}\``}`
        + (argument.description ? `\n\n${argument.description}` : "");
}

export function functionDoc(def: FunctionDef): string {
    const names = Array.isArray(def.name) ? def.name : [def.name];
    let position = 0;
    return [
        `**@${names[0]}** · ${def.description}`,
        names.length > 1 ? `别名：${names.slice(1).map(name => `\`@${name}\``).join("、")}` : "",
        def.details,
        def.args.length ? def.args.map(argument => argumentDoc(def, argument, argument.namedOnly ? undefined : ++position)).join("\n\n") : "无固定参数",
        def.allowExtraArgs ? `支持额外参数${def.extraArgType ? `，额外位置参数类型为 \`${def.extraArgType}\`` : "，由函数解析"}` : "不接受额外参数",
    ].filter(Boolean).join("\n\n");
}

export function callAt(calls: readonly CallInfo[], pos: number): CallInfo | undefined {
    let found: CallInfo | undefined;
    for (const call of calls) {
        if (call.span.start > pos) break;
        if (pos >= call.openParenSpan.end && pos <= (call.closeParenSpan?.start ?? call.span.end)) found = call;
    }
    return found;
}

export function argumentIndexAt(call: CallInfo, pos: number): number {
    return call.args.findIndex(argument => pos <= (argument.commaSpan?.start ?? call.closeParenSpan?.start ?? call.span.end));
}

export function parameterDocAt(
    source: string,
    analysis: SyntaxAnalysis,
    pos: number,
    definitions: ReadonlyMap<string, FunctionDef> = functionDefinitions,
): { pos: number; doc: string } | null {
    const call = callAt(analysis.calls, pos);
    const def = call && definitions.get(call.name.toLowerCase());
    if (!call || !def) return null;
    const suppliedIndex = argumentIndexAt(call, pos);
    const supplied = call.args[suppliedIndex];
    const name = supplied?.nameSpan && source.slice(supplied.nameSpan.start, supplied.nameSpan.end).toLowerCase();
    const position = suppliedIndex < 0 ? call.args.length : suppliedIndex;
    const argument = resolveArgDef(def, name, position);
    if (argument) return { pos, doc: `\`@${call.name}\`\n\n${argumentDoc(def, argument)}` };
    if (!def.allowExtraArgs) return null;
    const type = name ? "动态类型" : def.extraArgType ?? "动态类型";
    return { pos, doc: `\`@${call.name}\`\n\n**${position + 1}. ${name || "额外位置参数"}** · \`${type}\`\n\n此参数由函数处理，具体用法见函数说明` };
}

export interface ScoreCompletion {
    label: string;
    kind: "function" | "symbol" | "parameter" | "label";
    detail?: string;
    sortText?: string;
    definition?: FunctionDef;
    argument?: FunctionArgDef;
}

export interface ScoreCompletions {
    range: SourceSpan;
    candidates: ScoreCompletion[];
    validFor?: RegExp;
}

export function completionsAt(
    source: string,
    analysis: SyntaxAnalysis,
    pos: number,
    definitions: ReadonlyMap<string, FunctionDef> = functionDefinitions,
): ScoreCompletions | null {
    if (pos < 0 || pos > source.length) return null;
    let start = pos;
    while (start > 0 && /[@$\w./-]/.test(source[start - 1])) start--;
    const word = source.slice(start, pos);
    const range = { start, end: pos };
    if (word.startsWith("@")) {
        return { range, candidates: [...definitions].map(([name, definition]) => ({
            label: `@${name}`, kind: "function", detail: definition.description, definition,
        })), validFor: /^@[\w./-]*$/ };
    }
    if (word.startsWith("$")) {
        return { range, candidates: [...symbols.table.values()].map(symbol => ({
            label: `$${symbol.name}`, kind: "symbol", detail: symbol.description,
        })), validFor: /^\$[\w./-]*$/ };
    }
    const { tokens, calls } = analysis;
    const call = callAt(calls, pos);
    const def = call && definitions.get(call.name.toLowerCase());
    if (!call || !def) return null;
    const argIndex = argumentIndexAt(call, pos);
    const arg = call.args[argIndex];
    const named = (span?: SourceSpan) => span && source.slice(span.start, span.end).toLowerCase();
    const inValue = arg?.equalsSpan !== undefined && pos > arg.equalsSpan.start;
    const position = argIndex < 0 ? call.args.length : argIndex;
    const type = resolveArgType(def, inValue ? named(arg?.nameSpan) : undefined, position);
    if (type === "content") {
        const parameterStart = (position > 0 ? call.args[position - 1].commaSpan?.end : undefined) ?? call.openParenSpan.end;
        const atParameterName = !inValue
            && /^\s*$/.test(source.slice(parameterStart, range.start))
            && (!arg || arg.nameSpan !== undefined || pos >= arg.span.end)
            && !tokens.some(token => token.kind === "atom" && token.span.start === range.start && token.span.end === pos);
        if (!atParameterName) return null;
    }
    const used = new Set(call.args.filter(item => item !== arg).map(item => named(item.nameSpan)));
    const candidates: ScoreCompletion[] = inValue ? [] : def.args.flatMap((argument, index) =>
        argument.name && !used.has(argument.name.toLowerCase())
            && (type !== "content" || argument.namedOnly && argument.name.toLowerCase().startsWith(word.toLowerCase())) ? [{
            label: argument.name,
            kind: "parameter" as const,
            detail: argument.type,
            sortText: String(index).padStart(String(def.args.length).length, "0"),
            definition: def,
            argument,
        }] : []);
    if (type === "label" && (inValue || !arg?.nameSpan)) {
        const declared = tokens.filter(token => token.kind === "label" && isLabelDeclaration(source, token));
        for (const name of new Set(declared.map(token => labelName(source, token)))) {
            candidates.push({ label: name, kind: "label" });
        }
    }
    return candidates.length ? { range, candidates, validFor: type === "content" ? undefined : /^[\w.-]*$/ } : null;
}

export function parameterCompletionEdit(
    analysis: SyntaxAnalysis,
    range: SourceSpan,
    name: string,
): SourceEdit {
    const call = callAt(analysis.calls, range.end);
    const existing = call && call.args[argumentIndexAt(call, range.end)]?.nameSpan;
    return { span: existing ?? range, text: name + (existing ? "" : "=") };
}

function isLabelDeclaration(source: string, token: SyntaxToken): boolean {
    return source[token.span.start] === "@";
}

function labelNameRange(source: string, token: SyntaxToken): SourceSpan {
    return { start: token.span.start + (isLabelDeclaration(source, token) ? 1 : 0), end: token.span.end };
}

function labelName(source: string, token: SyntaxToken): string {
    const range = labelNameRange(source, token);
    return source.slice(range.start, range.end);
}

function labelTokenAt(analysis: SyntaxAnalysis, pos: number): SyntaxToken | undefined {
    return analysis.tokens.find(token => token.kind === "label" && pos >= token.span.start && pos <= token.span.end);
}

function declarationFor(source: string, analysis: SyntaxAnalysis, reference: SyntaxToken): SyntaxToken | null {
    const call = callAt(analysis.calls, reference.span.start);
    if (!call) return null;
    const name = labelName(source, reference);
    let found: SyntaxToken | null = null;
    for (const token of analysis.tokens) {
        if (token.span.start >= call.span.start) break;
        if (token.kind === "label" && isLabelDeclaration(source, token) && labelName(source, token) === name) found = token;
    }
    return found;
}

function labelTargetSpan(node: ASTNodeBase, declaration: SourceSpan): SourceSpan | null {
    if (node instanceof ASTLabelNode && node.sourceSpan.start === declaration.start) return node.target.sourceSpan;
    for (const child of node.children ?? []) {
        const found = labelTargetSpan(child, declaration);
        if (found) return found;
    }
    return null;
}

export function labelJumpAt(
    source: string,
    analysis: SyntaxAnalysis,
    pos: number,
    ast: ASTNodeBase | null = null,
): { reference: SourceSpan; target: SourceSpan } | null {
    const reference = labelTokenAt(analysis, pos);
    if (!reference || isLabelDeclaration(source, reference)) return null;
    const declaration = declarationFor(source, analysis, reference);
    if (!declaration) return null;
    const target = (ast && labelTargetSpan(ast, declaration.span)) ?? declaration.span;
    return { reference: reference.span, target };
}

export interface LabelSymbol {
    name: string;
    declaration: SourceSpan;
    references: SourceSpan[];
}

export function labelSymbolAt(source: string, analysis: SyntaxAnalysis, pos: number): LabelSymbol | null {
    const token = labelTokenAt(analysis, pos);
    if (!token) return null;
    const declaration = isLabelDeclaration(source, token) ? token : declarationFor(source, analysis, token);
    if (!declaration) return null;
    const name = labelName(source, declaration);
    const references = analysis.tokens.filter(other => other.kind === "label"
        && !isLabelDeclaration(source, other) && labelName(source, other) === name
        && declarationFor(source, analysis, other) === declaration).map(other => labelNameRange(source, other));
    return { name, declaration: labelNameRange(source, declaration), references };
}