import {
    DEFAULT_FONT_SIZE,
    Diagnostic,
    compileScore,
} from "jpfun";
import { createDiagnosticsController } from "./diagnostics.js";
import { PLAYGROUND_EXAMPLE } from "./example.js";
import { createSourceEditor, revealSourcePosition } from "./editor.js";
import { publishSemanticAst } from "./jpfun-language.js";
import { requiredElement } from "./platform.js";
import { createPreviewController, type PreviewController } from "./preview.js";
import { initializeTheme } from "./theme.js";
import { createWorkspaceController } from "./workspace.js";

const editorHost = requiredElement<HTMLElement>("#sourceEditor");
const statusMessage = requiredElement<HTMLElement>("#statusMessage");
const layoutStats = requiredElement<HTMLElement>("#layoutStats");
const layoutTime = requiredElement<HTMLElement>("#layoutTime");
const sourceSize = requiredElement<HTMLElement>("#sourceSize");

let fatal = false;
let renderTimer: number | undefined;
let preview: PreviewController;
initializeTheme();
const editor = createSourceEditor({
    parent: editorHost,
    doc: PLAYGROUND_EXAMPLE,
    onCompile: compileAndRender,
    onDocChanged() {
        preview.invalidateNavigation();
        updateSourceSize();
        scheduleRender();
    },
    onCursorClick(position) {
        preview.focusSourcePosition(position);
    },
});
const workspace = createWorkspaceController(editor);
preview = createPreviewController({
    onNavigateSource(range, select) {
        workspace.revealSource();
        revealSourcePosition(editor, range, select);
    },
});
const diagnostics = createDiagnosticsController({
    editor,
    showSource: workspace.revealSource,
});

function source(): string {
    return editor.state.doc.toString();
}

function updateSourceSize() {
    sourceSize.textContent = `${editor.state.doc.length} 字符`;
}

function formatError(error: unknown): string {
    if (error instanceof Diagnostic) return `${error.code}: ${error.message}`;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
}

function showError(error: unknown) {
    fatal = true;
    const text = formatError(error);
    preview.showError(text);
    publishSemanticAst(editor, null);
    // 带 span 的诊断走正常列表，才能点击跳转
    if (error instanceof Diagnostic) diagnostics.render([error]);
    else diagnostics.render([], text);
    statusMessage.dataset.state = "error";
    statusMessage.textContent = "排版失败";
    layoutStats.textContent = "布局 0 个对象";
    workspace.showResult("problems");
}

function compileAndRender() {
    const startedAt = performance.now();
    try {
        const compiled = compileScore(source(), { fontSize: DEFAULT_FONT_SIZE, rowGap: 18 });
        diagnostics.render(compiled.parser.diagnostics);
        preview.render(compiled);
        publishSemanticAst(editor, compiled.ast);
        const count = compiled.parser.diagnostics.length;
        statusMessage.dataset.state = count === 0 ? "ok" : "warning";
        statusMessage.textContent = count === 0 ? "排版完成" : `${count} 条诊断`;
        layoutStats.textContent = `布局 ${compiled.layout.objects.length} 个对象 · `
            + `${compiled.layout.lineCount} 行 · ${compiled.layout.pages.length} 页 · `
            + `${compiled.layout.bounds.w.toFixed(0)} × ${compiled.layout.bounds.h.toFixed(0)}`;
        // 非致命诊断靠标签徽标提示，不抢面板；只有从中断恢复时才切回预览
        if (fatal) {
            fatal = false;
            workspace.showResult("preview");
        }
    } catch (error) {
        showError(error);
    } finally {
        layoutTime.textContent = `用时 ${(performance.now() - startedAt).toFixed(1)} ms`;
    }
}

function scheduleRender() {
    // 每次编辑都重置防抖窗口，同时立即把“等待中”显示出来
    statusMessage.dataset.state = "pending";
    statusMessage.textContent = "等待排版";
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(compileAndRender, 180);
}

statusMessage.addEventListener("click", () => workspace.showResult("problems"));

requiredElement<HTMLButtonElement>("#runLayout").addEventListener("click", compileAndRender);
window.addEventListener("beforeprint", () => {
    compileAndRender();
    preview.preparePrint();
});
window.addEventListener("afterprint", preview.clearPrint);

updateSourceSize();
compileAndRender();