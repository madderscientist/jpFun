import {
    CanvasTextMeasurer,
    DEFAULT_FONT_SIZE,
    Diagnostic,
    compileScore,
} from "jpfun";
import { createDiagnosticsController } from "./diagnostics.js";
import {
    createDocumentController,
    loadDraftSource,
} from "./document.js";
import { PLAYGROUND_EXAMPLE } from "./example.js";
import { createSourceEditor, revealSourcePosition } from "./editor.js";
import { publishSemanticAst } from "./jpfun-language.js";
import { createDropdown, readStoredValue, requiredElement, storeValue } from "./platform.js";
import {
    createPreviewController,
    type ImageExportFormat,
    type PreviewController,
} from "./preview.js";
import { initializeTheme } from "./theme.js";
import { createWorkspaceController } from "./workspace.js";

const editorHost = requiredElement<HTMLElement>("#sourceEditor");
const statusMessage = requiredElement<HTMLElement>("#statusMessage");
const layoutStats = requiredElement<HTMLElement>("#layoutStats");
const layoutTime = requiredElement<HTMLElement>("#layoutTime");
const sourceSize = requiredElement<HTMLElement>("#sourceSize");
const sourceName = requiredElement<HTMLElement>("#sourceName");
const fileDirty = requiredElement<HTMLElement>("#fileDirty");
const exportButton = requiredElement<HTMLButtonElement>("#exportButton");
const exportMenu = requiredElement<HTMLElement>("#exportMenu");
const exportPpiInput = requiredElement<HTMLInputElement>("#exportPpi");
const exportFormatButtons = [...exportMenu.querySelectorAll<HTMLButtonElement>("[data-export-format]")];

let fatal = false;
let renderTimer: number | undefined;
let preview: PreviewController;
let documents: ReturnType<typeof createDocumentController>;
// 排版必须按最终绘制的字体测量，否则字形宽度会与盒子对不上
const textMeasurer = new CanvasTextMeasurer(document.createElement("canvas").getContext("2d")!);
initializeTheme();
const editor = createSourceEditor({
    parent: editorHost,
    doc: loadDraftSource(PLAYGROUND_EXAMPLE),
    onCompile: compileAndRender,
    onDocChanged() {
        documents.sourceChanged();
        preview.invalidateNavigation();
        updateSourceSize();
        scheduleRender();
    },
    onCursorClick(position) {
        preview.focusSourcePosition(position);
    },
});
documents = createDocumentController({
    getSource: source,
    replaceSource(nextSource) {
        editor.dispatch({
            changes: { from: 0, to: editor.state.doc.length, insert: nextSource },
            selection: { anchor: 0 },
            scrollIntoView: true,
        });
    },
    onStateChanged(fileName, dirty) {
        sourceName.textContent = fileName;
        fileDirty.hidden = !dirty;
    },
    onError(action, error) {
        statusMessage.dataset.state = "error";
        statusMessage.textContent = `${action}失败`;
        statusMessage.title = formatError(error);
    },
});
const workspace = createWorkspaceController(editor, {
    onSourceTabReselect() {
        void documents.open();
    },
});
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

function compileAndRender(): boolean {
    const startedAt = performance.now();
    try {
        const compiled = compileScore(source(), {
            fontSize: DEFAULT_FONT_SIZE,
            rowGap: 18,
            textMeasurer,
        });
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
        return true;
    } catch (error) {
        showError(error);
        return false;
    } finally {
        layoutTime.textContent = `用时 ${(performance.now() - startedAt).toFixed(1)} ms`;
        documents.rendered();
    }
}

function scheduleRender() {
    // 每次编辑都重置防抖窗口，同时立即把“等待中”显示出来
    statusMessage.dataset.state = "pending";
    statusMessage.textContent = "等待排版";
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(compileAndRender, 180);
}

function normalizedExportPpi(): number {
    const value = exportPpiInput.valueAsNumber;
    const ppi = Number.isNaN(value)
        ? Number(exportPpiInput.defaultValue)
        : Math.min(Number(exportPpiInput.max), Math.max(Number(exportPpiInput.min), Math.round(value)));
    exportPpiInput.value = String(ppi);
    storeValue("jpfun-export-ppi", String(ppi));
    return ppi;
}

function isImageExportFormat(value: string | undefined): value is ImageExportFormat {
    return value === "png" || value === "jpeg" || value === "svg";
}

const storedExportPpi = readStoredValue("jpfun-export-ppi");
if (storedExportPpi !== null) exportPpiInput.value = storedExportPpi;
normalizedExportPpi();
exportPpiInput.addEventListener("change", normalizedExportPpi);
const closeExportMenu = createDropdown(exportButton, exportMenu);

for (const button of exportFormatButtons) {
    button.addEventListener("click", async () => {
        const format = button.dataset.exportFormat;
        if (format === "pdf") {
            closeExportMenu();
            window.print();
            return;
        }
        if (!isImageExportFormat(format)) return;

        window.clearTimeout(renderTimer);
        if (!compileAndRender()) {
            closeExportMenu(true);
            return;
        }

        exportButton.disabled = true;
        for (const item of exportFormatButtons) item.disabled = true;
        try {
            await preview.download(format, normalizedExportPpi());
            closeExportMenu(true);
        } catch (error) {
            statusMessage.dataset.state = "error";
            statusMessage.textContent = "导出失败";
            statusMessage.title = formatError(error);
        } finally {
            exportButton.disabled = false;
            for (const item of exportFormatButtons) item.disabled = false;
        }
    });
}

statusMessage.addEventListener("click", () => workspace.showResult("problems"));

window.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    if (event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    void documents.save();
});
window.addEventListener("pagehide", documents.flushDraft);

requiredElement<HTMLButtonElement>("#runLayout").addEventListener("click", compileAndRender);
window.addEventListener("beforeprint", () => {
    compileAndRender();
    preview.preparePrint();
});
window.addEventListener("afterprint", preview.clearPrint);

updateSourceSize();
compileAndRender();