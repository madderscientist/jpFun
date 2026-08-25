import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, RangeSetBuilder, StateField } from "@codemirror/state";
import {
    crosshairCursor,
    Decoration,
    type DecorationSet,
    drawSelection,
    dropCursor,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    rectangularSelection,
    ViewPlugin,
} from "@codemirror/view";
import { Diagnostic, ErrorDiagnostic } from "jpfun";
import { jpFunLanguage, labelJumped } from "./jpfun-language.js";

export interface SourceRange {
    from: number;
    to: number;
}

interface SourceEditorOptions {
    parent: HTMLElement;
    doc: string;
    onCompile: () => void;
    onDocChanged: () => void;
    onCursorClick: (position: number) => void;
}

// 默认不折行，Alt+Z 就地重配
const lineWrapping = new Compartment();

// VS Code 风格：只给选中区域里的空白标记，不全局显示
function selectedWhitespace(state: EditorState): DecorationSet {
    const decorations = new RangeSetBuilder<Decoration>();
    for (const range of state.selection.ranges) {
        if (range.empty) continue;
        const text = state.sliceDoc(range.from, range.to);
        for (let index = 0; index < text.length; index++) {
            const character = text[index];
            if (character !== " " && character !== "\t") continue;
            const position = range.from + index;
            decorations.add(position, position + 1, Decoration.mark({
                class: character === " " ? "cm-selected-space" : "cm-selected-tab",
            }));
        }
    }
    return decorations.finish();
}

const selectedWhitespaceField = StateField.define<DecorationSet>({
    create: selectedWhitespace,
    update(value, transaction) {
        return transaction.docChanged || transaction.selection
            ? selectedWhitespace(transaction.state)
            : value;
    },
    provide: field => EditorView.decorations.from(field),
});

function syncSelectionState(view: EditorView) {
    view.dom.dataset.hasSelection = String(view.state.selection.ranges.some(range => !range.empty));
}

// VS Code 在有选中时会隐去当前行高亮
const selectionStatePlugin = ViewPlugin.define(view => {
    syncSelectionState(view);
    return {
        update(update) {
            if (update.selectionSet || update.docChanged) syncSelectionState(update.view);
        },
    };
});

function toggleLineWrapping(view: EditorView) {
    view.dispatch({ effects: lineWrapping.reconfigure(view.lineWrapping ? [] : EditorView.lineWrapping) });
    return true;
}

const editorTheme = EditorView.theme({
    "&": {
        height: "100%",
        color: "var(--editor-ink)",
        backgroundColor: "var(--editor-bg)",
        fontSize: "14px",
    },
    ".cm-content": {
        padding: "14px 0 28px",
        caretColor: "var(--accent)",
        fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
        lineHeight: "1.65",
    },
    ".cm-line": { padding: "0 18px 0 8px" },
    ".cm-gutters": {
        color: "var(--editor-muted)",
        backgroundColor: "var(--editor-bg)",
        borderRight: "1px solid var(--line-subtle)",
    },
    ".cm-activeLine": { backgroundColor: "var(--editor-active)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--editor-active)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: "var(--selection) !important",
    },
    ".cm-scroller": { overflow: "auto" },
    ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--ink)" },
    ".cm-panel.cm-search": {
        padding: "7px 38px 7px 8px",
        borderBottom: "1px solid var(--line)",
        fontFamily: "Bahnschrift, \"Noto Sans SC\", \"Microsoft YaHei UI\", sans-serif",
    },
    ".cm-panel.cm-search .cm-textfield": {
        height: "27px",
        padding: "0 7px",
        border: "1px solid var(--control-border)",
        borderRadius: "3px",
        outline: "none",
        color: "var(--editor-ink)",
        backgroundColor: "var(--editor-bg)",
        font: "inherit",
        fontSize: "11px",
    },
    ".cm-panel.cm-search .cm-textfield:focus": {
        borderColor: "var(--accent)",
        boxShadow: "inset 0 0 0 1px var(--accent)",
    },
    ".cm-panel.cm-search .cm-button": {
        minHeight: "27px",
        padding: "0 8px",
        border: "1px solid color-mix(in srgb, var(--accent) 42%, transparent)",
        borderRadius: "3px",
        color: "var(--accent)",
        backgroundColor: "color-mix(in srgb, var(--accent) 8%, var(--surface))",
        backgroundImage: "none",
        font: "inherit",
        fontSize: "11px",
        cursor: "pointer",
    },
    ".cm-panel.cm-search .cm-button:hover, .cm-panel.cm-search [name=close]:hover": {
        backgroundColor: "color-mix(in srgb, var(--accent) 16%, var(--surface))",
    },
    ".cm-panel.cm-search .cm-button:focus-visible, .cm-panel.cm-search [name=close]:focus-visible": {
        outline: "2px solid var(--accent)",
        outlineOffset: "-2px",
    },
    ".cm-panel.cm-search label": { color: "var(--muted)", fontSize: "10px" },
    ".cm-panel.cm-search input[type=checkbox]": { accentColor: "var(--accent)" },
    ".cm-panel.cm-search [name=close]": {
        top: "7px",
        right: "8px",
        width: "27px",
        height: "27px",
        borderRadius: "3px",
        color: "var(--accent)",
        fontSize: "18px",
        lineHeight: "27px",
        cursor: "pointer",
    },
    ".cm-searchMatch": {
        backgroundColor: "color-mix(in srgb, var(--accent) 20%, transparent)",
    },
    ".cm-searchMatch-selected": {
        backgroundColor: "color-mix(in srgb, var(--accent) 38%, transparent)",
    },
    ".cm-tooltip": { border: "1px solid var(--line)", backgroundColor: "var(--surface)" },
});

export function createSourceEditor(options: SourceEditorOptions): EditorView {
    return new EditorView({
        parent: options.parent,
        state: EditorState.create({
            doc: options.doc,
            extensions: [
                lineNumbers(),
                highlightActiveLineGutter(),
                highlightSpecialChars(),
                history(),
                drawSelection(),
                dropCursor(),
                EditorState.allowMultipleSelections.of(true),
                bracketMatching(),
                closeBrackets(),
                autocompletion({ defaultKeymap: false }),
                // VS Code 风格：Tab 接受补全，回车留给换行；补全未打开时 Tab 会落到 indentWithTab
                Prec.highest(keymap.of([
                    ...completionKeymap.filter(binding => binding.key !== "Enter"),
                    { key: "Tab", run: acceptCompletion },
                ])),
                rectangularSelection(),
                crosshairCursor(),
                highlightActiveLine(),
                highlightSelectionMatches(),
                jpFunLanguage,
                selectedWhitespaceField,
                selectionStatePlugin,
                EditorView.domEventHandlers({
                    click(event, view) {
                        if (event.button !== 0) return false;
                        if (event.ctrlKey || event.metaKey) return false;   // 标签跳转自己发通知
                        const found = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY });
                        if (found) options.onCursorClick(found.pos + Math.min(0, found.assoc));
                        return false;
                    },
                }),
                lintGutter(),
                lineWrapping.of([]),
                keymap.of([
                    { key: "Alt-z", run: toggleLineWrapping },
                    ...closeBracketsKeymap,
                    ...defaultKeymap,
                    ...historyKeymap,
                    ...searchKeymap,
                    indentWithTab,
                    { key: "Mod-Enter", run: () => { options.onCompile(); return true; } },
                ]),
                editorTheme,
                EditorView.updateListener.of(update => {
                    if (update.docChanged) options.onDocChanged();
                    for (const transaction of update.transactions) {
                        // 标签跳转不走 click，所以自己发通知让谱面同步强调
                        for (const effect of transaction.effects) {
                            if (effect.is(labelJumped)) options.onCursorClick(effect.value);
                        }
                    }
                }),
            ],
        }),
    });
}

export function setSourceDiagnostics(editor: EditorView, items: readonly Diagnostic[]): SourceRange[] {
    const length = editor.state.doc.length;
    const ranges = items.map(item => {
        const from = Math.min(length, Math.max(0, item.span.start));
        const to = Math.min(length, Math.max(from, item.span.end));
        // 空区间擑成一个字符，否则波浪线看不见
        return { from, to: to === from && from < length ? from + 1 : to };
    });
    editor.dispatch(setDiagnostics(editor.state, items.map((item, index) => ({
        ...ranges[index],
        severity: item instanceof ErrorDiagnostic ? "error" : "warning",
        message: item.message,
        source: item.code,
    }))));
    return ranges;
}

export function revealSourceRange(editor: EditorView, range: SourceRange) {
    revealSourcePosition(editor, range, true);
}

export function revealSourcePosition(editor: EditorView, range: SourceRange, select: boolean) {
    editor.dispatch({
        selection: select
            ? { anchor: range.from, head: range.to }
            : { anchor: range.from },
        effects: EditorView.scrollIntoView(range.from, { y: "center" }),
    });
    editor.focus();
}