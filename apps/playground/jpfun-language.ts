import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { activateHover, closeHoverTooltips, Decoration, EditorView, hoverTooltip, keymap, ViewPlugin, type DecorationSet, type Tooltip } from "@codemirror/view";
import { analyzeScoreSyntax, ASTFunctionNode, ASTLabelNode, ASTNodeBase, defaultFunctions, resolveArgType, type CallInfo, type FunctionDef, type SourceSpan, type SyntaxAnalysis, type SyntaxToken, type SyntaxTokenKind } from "jpfun";

const syntaxClasses: Record<SyntaxTokenKind, string> = {
    comment: "cm-jpfun-comment",
    string: "cm-jpfun-string",
    function: "cm-jpfun-function",
    label: "cm-jpfun-label",
    property: "cm-jpfun-property",
    number: "cm-jpfun-number",
    boolean: "cm-jpfun-boolean",
    length: "cm-jpfun-number",
    atom: "cm-jpfun-atom",
    operator: "cm-jpfun-operator",
    punctuation: "cm-jpfun-punctuation",
};

function analyze(state: EditorState) {
    const analysis = analyzeScoreSyntax(state.doc.toString()).syntax;
    const builder = new RangeSetBuilder<Decoration>();
    for (const token of analysis.tokens) {
        builder.add(token.span.start, token.span.end, Decoration.mark({ class: syntaxClasses[token.kind] }));
    }
    return { analysis, decorations: builder.finish() };
}

const syntaxField = StateField.define({
    create: analyze,
    update: (value, transaction) => transaction.docChanged ? analyze(transaction.state) : value,
    provide: field => EditorView.decorations.from(field, value => value.decorations),
});

//====== 语义层（防抖产物） ======//

const setSemanticAst = StateEffect.define<ASTNodeBase | null>();

/** AST 来自防抖后的编译，文档一变就作废，否则会用过期 span 定位 */
const semanticField = StateField.define<ASTNodeBase | null>({
    create: () => null,
    update(value, transaction) {
        for (const effect of transaction.effects) if (effect.is(setSemanticAst)) return effect.value;
        return transaction.docChanged ? null : value;
    },
});

export function publishSemanticAst(view: EditorView, ast: ASTNodeBase | null) {
    view.dispatch({ effects: setSemanticAst.of(ast) });
}

/** 沿命中路径取最深的具名函数节点；text/label 节点没有可展示的信息 */
function functionNodeAt(node: ASTNodeBase, pos: number): ASTFunctionNode | null {
    if (pos < node.sourceSpan.start || pos >= node.sourceSpan.end) return null;
    for (const child of node.children ?? []) {
        const deeper = functionNodeAt(child, pos);
        if (deeper) return deeper;
    }
    return node instanceof ASTFunctionNode && node.def ? node : null;
}

//====== 补全与文档 ======//

const defByName = new Map<string, FunctionDef>();
for (const fnClass of defaultFunctions) {
    const def = fnClass.prototype.def;
    if (!def) continue;
    for (const name of Array.isArray(def.name) ? def.name : [def.name]) defByName.set(name.toLowerCase(), def);
}

const functionCompletions: Completion[] = [...defByName].map(([name, def]) => snippetCompletion(`@${name}(\${})`, {
    label: "@" + name,
    type: "function",
    detail: def.description,
    info: def.example,
}));

/** 悬浮框与行框之间留的缝，免得压住光标 */
const TOOLTIP_GAP = 4;
/** 鼠标离开 token 后，留给它走进悬浮框的时间 */
const HOVER_HIDE_DELAY = 250;
/** 判定「鼠标还在悬浮框上」时向外放宽的距离 */
const HOVER_KEEP_MARGIN = 8;

/** 去糖行：左边是等价写法，右边一个按钮把原文换成它 */
function desugarRow(view: EditorView, desugared: string, from: number, to: number) {
    const row = document.createElement("div");
    row.className = "cm-jpfun-desugar";
    const text = document.createElement("span");
    text.className = "cm-jpfun-desugar-text";
    text.textContent = desugared;
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "cm-jpfun-desugar-apply";
    apply.textContent = "替换";
    apply.title = "用去糖后的写法替换原文";
    apply.addEventListener("click", () => {
        view.dispatch({ changes: { from, to, insert: desugared } });
        view.focus();
    });
    row.append(text, apply);
    return row;
}

/** 悬浮框统一结构：可选的去糖行 + 函数文档 */
function docTooltip(from: number, to: number, doc: string, desugared?: string): Tooltip {
    return {
        pos: from,
        end: to,
        above: true,   // 和 VS Code 一样浮在上方
        create: (view: EditorView) => {
            const dom = document.createElement("div");
            dom.className = "cm-jpfun-doc";
            if (desugared !== undefined) dom.append(desugarRow(view, desugared, from, to));
            const body = document.createElement("div");
            body.className = "cm-jpfun-doc-body";
            body.textContent = doc;
            dom.append(body);
            return { dom, offset: { x: 0, y: TOOLTIP_GAP } };
        },
    };
}

function hoverAt(view: EditorView, pos: number): Tooltip | null {
    const calls = view.state.field(syntaxField).analysis.calls;
    const call = calls.find(item => pos >= item.nameSpan.start && pos < item.nameSpan.end);
    const def = call && defByName.get(call.name.toLowerCase());
    if (call && def) return docTooltip(call.nameSpan.start, call.nameSpan.end, `${def.description}\n${def.example}`);

    // 写出来的调用已经由上面那条路径服务；这里只管语法糖展开出来的节点
    const ast = view.state.field(semanticField);
    const node = ast && functionNodeAt(ast, pos);
    if (!node?.def) return null;
    const span = node.sourceSpan;
    // span 与某个显式调用完全重合，说明是写出来的，去糖行等于原文
    if (calls.some(item => item.span.start === span.start && item.span.end === span.end)) return null;
    return docTooltip(
        span.start,
        span.end,
        `${node.def.description}\n${node.def.example}`,
        node.toString(view.state.doc.toString()),
    );
}

let locking = false;

const functionHover = hoverTooltip((view, pos, side) => {
    if (view.plugin(hoverControl)?.suppressed) return null;
    if (locking) return hoverAt(view, pos);
    // 借 CM 的触发时机与定位，但必须开成 locked 悬浮框：否则鼠标一离开 token 就被 CM 关掉，根本走不进去
    locking = true;
    try { activateHover(view, pos, side, { tooltip: functionHover }); } finally { locking = false; }
    return null;
}, { hideOnChange: true });

function staysOnHover(view: EditorView, event: MouseEvent) {
    const rect = view.dom.querySelector(".cm-tooltip-hover")?.getBoundingClientRect();
    if (rect && event.x >= rect.left - HOVER_KEEP_MARGIN && event.x <= rect.right + HOVER_KEEP_MARGIN
        && event.y >= rect.top - HOVER_KEEP_MARGIN && event.y <= rect.bottom + HOVER_KEEP_MARGIN) return true;
    const pos = view.posAtCoords(event, false);
    return view.state.field(functionHover.active).some(tip => pos >= tip.pos && pos <= (tip.end ?? tip.pos));
}

/** 悬浮框的开关时机：点击后不再唤起，离开 token 后延时关闭，好让鼠标有机会走进去 */
const hoverControl = ViewPlugin.define(view => {
    const listeners = new AbortController();
    const signal = listeners.signal;
    let suppressed = false;
    let last = { x: 0, y: 0 };
    let hideTimer = -1;

    const cancelHide = () => { window.clearTimeout(hideTimer); hideTimer = -1; };
    const hide = () => {
        cancelHide();
        if (view.state.field(functionHover.active).length) view.dispatch({ effects: closeHoverTooltips });
    };

    view.dom.addEventListener("mousedown", () => { suppressed = true; }, { signal });
    view.dom.addEventListener("mouseleave", hide, { signal });
    view.dom.addEventListener("mousemove", event => {
        if (event.x !== last.x || event.y !== last.y) suppressed = false;   // 鼠标真的挪了窝
        last = { x: event.x, y: event.y };
        if (!view.state.field(functionHover.active).length || staysOnHover(view, event)) return cancelHide();
        if (hideTimer < 0) hideTimer = window.setTimeout(() => {
            hide();
            // CM 在悬浮框开着时不重算 hover，关掉后得自己补一次，否则停在相邻函数上不出新的
            const pos = view.posAtCoords(last);
            if (pos !== null) activateHover(view, pos, 1, { tooltip: functionHover });
        }, HOVER_HIDE_DELAY);
    }, { signal });

    return {
        get suppressed() { return suppressed; },
        destroy() { cancelHide(); listeners.abort(); },
    };
});

/** calls 按起点升序且同级不重叠，所以最后一个命中的必然是最内层 */
function callAt(calls: readonly CallInfo[], pos: number): CallInfo | undefined {
    let found: CallInfo | undefined;
    for (const call of calls) {
        if (call.span.start > pos) break;
        if (pos >= call.openParenSpan.end && pos <= (call.closeParenSpan?.start ?? call.span.end)) found = call;
    }
    return found;
}

function complete(context: CompletionContext): CompletionResult | null {
    const word = context.matchBefore(/[@\w./-]*/)!;
    const source = context.state.doc.toString();
    if (source.slice(word.from, context.pos).startsWith("@")) {
        return { from: word.from, options: functionCompletions, validFor: /^@[\w./-]*$/ };
    }

    const { tokens, calls } = context.state.field(syntaxField).analysis;
    const call = callAt(calls, context.pos);
    const def = call && defByName.get(call.name.toLowerCase());
    if (!call || !def) return null;

    const argIndex = call.args.findIndex(item => context.pos >= item.span.start && context.pos <= item.span.end);
    const arg = argIndex < 0 ? undefined : call.args[argIndex];
    const named = (span?: SourceSpan) => span && source.slice(span.start, span.end).toLowerCase();
    const inValue = arg?.equalsSpan !== undefined && context.pos > arg.equalsSpan.start;
    const type = resolveArgType(def, inValue ? named(arg?.nameSpan) : undefined, argIndex < 0 ? call.args.length : argIndex);
    if (type === "content") return null; // 光标在内容里，该由内容自己的语法补全

    const used = new Set(call.args.filter(item => item !== arg).map(item => named(item.nameSpan)));
    const options: Completion[] = inValue ? [] : def.args
        .filter(item => item.name && !used.has(item.name.toLowerCase()))
        .map(item => ({ label: item.name!, type: "property", detail: item.type, apply: item.name + "=" }));
    if (type === "label") {
        // `@x` 形式的才是声明，函数参数里的裸标签是引用
        const declared = tokens.filter(token => token.kind === "label" && source[token.span.start] === "@");
        for (const name of new Set(declared.map(token => source.slice(token.span.start + 1, token.span.end)))) {
            options.push({ label: name, type: "variable" });
        }
    }
    return options.length ? { from: word.from, options, validFor: /^[\w.-]*$/ } : null;
}

//====== 标签导航与重命名 ======//

/** 跳转修饰键：Windows/Linux 用 Ctrl，macOS 用 Cmd */
function jumpModifier(event: MouseEvent | KeyboardEvent) {
    return event.ctrlKey || event.metaKey;
}

/** 声明写作 `@x`，引用是关系函数参数里的裸名字 */
function isDeclaration(state: EditorState, token: SyntaxToken) {
    return state.doc.sliceString(token.span.start, token.span.start + 1) === "@";
}

/** 名字本身占的区间，声明要跳过开头的 `@`；重命名直接把它变成选区 */
function labelNameRange(state: EditorState, token: SyntaxToken) {
    return {
        from: token.span.start + (isDeclaration(state, token) ? 1 : 0),
        to: token.span.end,
    };
}

function labelName(state: EditorState, token: SyntaxToken) {
    const range = labelNameRange(state, token);
    return state.doc.sliceString(range.from, range.to);
}

function labelTokenAt(analysis: SyntaxAnalysis, pos: number): SyntaxToken | null {
    return analysis.tokens.find(token =>
        token.kind === "label" && pos >= token.span.start && pos <= token.span.end) ?? null;
}

/**
 * 引用绑定到哪个声明。规则抄自 parserContext 的 label 参数解析：
 * 在引用所属调用之前，从后往前第一个同名声明。同一个名字因此可以被反复使用
 */
function declarationFor(state: EditorState, analysis: SyntaxAnalysis, reference: SyntaxToken): SyntaxToken | null {
    const call = callAt(analysis.calls, reference.span.start);
    if (!call) return null;
    const name = labelName(state, reference);
    let found: SyntaxToken | null = null;
    for (const token of analysis.tokens) {
        if (token.span.start >= call.span.start) break;   // tokens 已按起点升序
        if (token.kind === "label" && isDeclaration(state, token) && labelName(state, token) === name) found = token;
    }
    return found;
}

/** target 指向被标注对象；parent 是树结构、会被容器改写，不能拿来问这个 */
function labelTargetSpan(node: ASTNodeBase, declaration: SourceSpan): SourceSpan | null {
    if (node instanceof ASTLabelNode && node.sourceSpan.start === declaration.start) {
        return node.target.sourceSpan;
    }
    for (const child of node.children ?? []) {
        const found = labelTargetSpan(child, declaration);
        if (found) return found;
    }
    return null;
}

/** 光标落在标签引用上时，算出它指的谱面对象写在源码哪里 */
function labelJumpAt(state: EditorState, pos: number) {
    const { analysis } = state.field(syntaxField);
    const reference = labelTokenAt(analysis, pos);
    if (!reference || isDeclaration(state, reference)) return null;
    const declaration = declarationFor(state, analysis, reference);
    if (!declaration) return null;
    const ast = state.field(semanticField);
    // 编译失败或刚改过文档时没有 AST，退到声明自身，只差几个字符
    const target = (ast && labelTargetSpan(ast, declaration.span)) ?? declaration.span;
    return { reference: reference.span, target };
}

const setLabelLink = StateEffect.define<SourceSpan | null>();
const labelLinkMark = Decoration.mark({ class: "cm-jpfun-label-link" });

const labelLinkField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
        for (const effect of transaction.effects) {
            if (effect.is(setLabelLink)) {
                return effect.value
                    ? Decoration.set([labelLinkMark.range(effect.value.start, effect.value.end)])
                    : Decoration.none;
            }
        }
        return transaction.docChanged ? Decoration.none : value;
    },
    provide: field => EditorView.decorations.from(field),
});

/** 按住 Ctrl 时给鼠标下的可跳转标签加下划线，松开或移开就撤掉 */
const labelLinkControl = ViewPlugin.define(view => {
    const listeners = new AbortController();
    const signal = listeners.signal;
    let point: { x: number; y: number } | null = null;
    let shown: SourceSpan | null = null;

    const refresh = (held: boolean) => {
        const pos = held && point ? view.posAtCoords(point) : null;
        const next = pos === null ? null : labelJumpAt(view.state, pos)?.reference ?? null;
        if (next?.start === shown?.start && next?.end === shown?.end) return;
        shown = next;
        view.dispatch({ effects: setLabelLink.of(next) });
    };

    view.dom.addEventListener("mousemove", event => {
        point = { x: event.clientX, y: event.clientY };
        refresh(jumpModifier(event));
    }, { signal });
    view.dom.addEventListener("mouseleave", () => { point = null; refresh(false); }, { signal });
    const onModifier = (event: KeyboardEvent) => refresh(jumpModifier(event));
    window.addEventListener("keydown", onModifier, { signal });
    window.addEventListener("keyup", onModifier, { signal });
    window.addEventListener("blur", () => refresh(false), { signal });   // 切走窗口收不到 keyup

    return { destroy() { listeners.abort(); } };
});

/** 跳转后的光标位置。不能靠 click 事件通知：mousedown 里 preventDefault 后它未必派发 */
export const labelJumped = StateEffect.define<number>();

/** CodeMirror 默认 Ctrl+点击是加多光标，必须在 mousedown 就截断 */
const labelLinkClick = EditorView.domEventHandlers({
    mousedown(event, view) {
        if (event.button !== 0 || !jumpModifier(event)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const jump = pos === null ? null : labelJumpAt(view.state, pos);
        if (!jump) return false;
        view.dispatch({
            selection: { anchor: jump.target.start },
            effects: [
                setLabelLink.of(null),
                labelJumped.of(jump.target.start),
                EditorView.scrollIntoView(jump.target.start, { y: "center" }),
            ],
        });
        view.focus();   // 截断后浏览器不会自己转移焦点
        return true;
    },
});

/** 一个声明连同它管辖的引用。同名标签可以属于不同的组，所以不能按名字全改 */
function labelSymbolAt(state: EditorState, pos: number) {
    const { analysis } = state.field(syntaxField);
    const token = labelTokenAt(analysis, pos);
    if (!token) return null;
    const declaration = isDeclaration(state, token) ? token : declarationFor(state, analysis, token);
    if (!declaration) return null;
    const name = labelName(state, declaration);
    const ranges = [labelNameRange(state, declaration)];
    for (const other of analysis.tokens) {
        if (other.kind !== "label" || isDeclaration(state, other) || labelName(state, other) !== name) continue;
        if (declarationFor(state, analysis, other) !== declaration) continue;
        ranges.push(labelNameRange(state, other));
    }
    return ranges;
}

/** 重命名不弹输入框：把这一组变成多光标，直接打字就同步改 */
function renameLabel(view: EditorView) {
    const head = view.state.selection.main.head;
    const ranges = labelSymbolAt(view.state, head);
    if (!ranges) return false;
    // 光标停在声明的 `@` 上时不落在任何名字区间内，退回第一个
    const main = ranges.findIndex(range => head >= range.from && head <= range.to);
    view.dispatch({
        selection: EditorSelection.create(
            ranges.map(range => EditorSelection.range(range.from, range.to)),
            Math.max(0, main),
        ),
    });
    return true;
}

export const jpFunLanguage = [
    EditorState.languageData.of(() => [{
        commentTokens: { line: "%" },
        closeBrackets: { brackets: ["(", "{", "[", "\""] },
        autocomplete: complete,
    }]),
    syntaxField,
    semanticField,
    functionHover,
    hoverControl,
    labelLinkField,
    labelLinkControl,
    labelLinkClick,
    keymap.of([{ key: "F2", run: renameLabel }]),
    EditorView.baseTheme({
        ".cm-jpfun-comment": { color: "var(--syntax-comment)", fontStyle: "italic" },
        ".cm-jpfun-string": { color: "var(--syntax-string)" },
        ".cm-jpfun-function": { color: "var(--syntax-function)", fontWeight: "600" },
        ".cm-jpfun-label": { color: "var(--syntax-variable)" },
        ".cm-jpfun-property": { color: "var(--syntax-type)" },
        ".cm-jpfun-number": { color: "var(--syntax-number)" },
        ".cm-jpfun-boolean": { color: "var(--syntax-keyword)" },
        ".cm-jpfun-atom": { color: "var(--syntax-number)", fontWeight: "600" },
        ".cm-jpfun-operator": { color: "var(--syntax-keyword)" },
        ".cm-jpfun-punctuation": { color: "var(--syntax-comment)" },
        ".cm-jpfun-label-link": { textDecoration: "underline", cursor: "pointer" },
        ".cm-jpfun-doc": { maxWidth: "420px", maxHeight: "260px", overflow: "auto", whiteSpace: "pre-wrap" },
        ".cm-jpfun-desugar": {
            display: "flex",
            alignItems: "flex-start",
            gap: "8px",
            position: "sticky",   // 内容滚动时替换按钮也要留在视野内
            top: "0",
            padding: "8px 10px",
            background: "var(--surface)",
            borderBottom: "1px solid var(--line-subtle)",
        },
        ".cm-jpfun-desugar-text": {
            flex: "1",
            minWidth: "0",
            color: "var(--syntax-function)",
            fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
            whiteSpace: "pre",     // 等价写法是代码，宁可横向滚动也不折行
            overflowX: "auto",
            lineHeight: "1.5",     // 横向滚动使它成为裁剪容器，行高不够中文字形会被切掉
        },
        ".cm-jpfun-desugar-apply": {
            flexShrink: "0",
            padding: "1px 8px",
            border: "1px solid var(--line)",
            borderRadius: "4px",
            background: "transparent",
            color: "var(--ink)",
            font: "inherit",
            fontSize: "11px",
            whiteSpace: "nowrap",
            cursor: "pointer",
        },
        ".cm-jpfun-desugar-apply:hover": { background: "var(--editor-active)" },
        ".cm-jpfun-doc-body": { padding: "8px 10px", color: "var(--editor-muted)" },
    }),
];