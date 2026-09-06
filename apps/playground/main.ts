import {
    CanvasTextMeasurer,
    DEFAULT_FONT_SIZE,
    Diagnostic,
    ErrorDiagnostic,
    compilePlayback,
    compileScore,
    type CompileScoreResult,
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
import { createPlaybackController, type PlaybackController } from "./playback.js";
import { importScoreFile, isSupportedScoreFile } from "./score-import.js";

const POSSIBLE_SCORE_MIME_TYPES = new Set([
    "",
    "application/octet-stream",
    "application/vnd.recordare.musicxml+xml",
    "application/xml",
    "application/x-midi",
    "audio/mid",
    "audio/midi",
    "audio/x-midi",
    "text/plain",
    "text/xml",
]);

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
const dropOverlay = requiredElement<HTMLElement>("#dropOverlay");
const dropTitle = requiredElement<HTMLElement>("#dropTitle");
const dropDetail = requiredElement<HTMLElement>("#dropDetail");

let fatal = false;
let renderTimer: number | undefined;
let dropFeedbackTimer: number | undefined;
let preview: PreviewController;
let documents: ReturnType<typeof createDocumentController>;
let playback: PlaybackController | undefined;
let latestCompiled: CompileScoreResult | null = null;
let latestCompiledSource: string | null = null;
let playbackSource: string | null = null;
let scoreDiagnostics: Diagnostic[] = [];
let playbackDiagnostics: Diagnostic[] = [];
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
        latestCompiled = null;
        latestCompiledSource = null;
        playbackSource = null;
        scoreDiagnostics = [];
        playbackDiagnostics = [];
        playback?.invalidate();
        diagnostics.render([]);
        updateSourceSize();
        scheduleRender();
    },
    onCursorClick(position) {
        preview.focusSourcePosition(position);
    },
});
documents = createDocumentController({
    getSource: source,
    importFile: importScoreFile,
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

function inspectDraggedFiles(dataTransfer: DataTransfer | null) {
    const items = [...(dataTransfer?.items ?? [])].filter(item => item.kind === "file");
    const files = [...(dataTransfer?.files ?? [])];
    if (files.length === 0) {
        for (const item of items) {
            const file = item.getAsFile();
            if (file) files.push(file);
        }
    }
    const count = files.length || items.length;
    return {
        files,
        count,
        name: files[0]?.name ?? items[0]?.webkitGetAsEntry()?.name,
        type: (files[0]?.type ?? items[0]?.type ?? "").toLowerCase(),
        hasFile: count > 0 || dataTransfer?.types.includes("Files") === true,
    };
}

function updateDropOverlay(dataTransfer: DataTransfer | null) {
    window.clearTimeout(dropFeedbackTimer);
    dropFeedbackTimer = void 0;
    const { count, name, type, hasFile } = inspectDraggedFiles(dataTransfer);
    const supported = !!name && isSupportedScoreFile({ name });
    const accepted = hasFile && count <= 1 && supported;
    const rejected = count > 1 || !!name && !supported
        || count === 1 && !name && !POSSIBLE_SCORE_MIME_TYPES.has(type);
    dropOverlay.hidden = !hasFile;
    dropOverlay.dataset.state = accepted ? "accepted" : rejected ? "rejected" : "pending";
    dropTitle.textContent = accepted ? "松开即可导入" : rejected ? "无法导入此文件" : "松开以检查文件";
    dropDetail.textContent = count > 1
        ? "一次只能导入一个曲谱"
        : accepted
        ? name
        : "支持 .jpfun、.mid、.midi 和 .musicxml";
    if (dataTransfer) dataTransfer.dropEffect = rejected ? "none" : "copy";
    return hasFile;
}

document.addEventListener("dragover", event => {
    if (!updateDropOverlay(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
}, { capture: true });
document.addEventListener("dragleave", event => {
    if (event.relatedTarget === null && dropFeedbackTimer === undefined) dropOverlay.hidden = true;
});
document.addEventListener("drop", event => {
    const { files, hasFile } = inspectDraggedFiles(event.dataTransfer);
    if (!hasFile) return;
    event.preventDefault();
    event.stopPropagation();
    const file = files[0];
    if (files.length === 1 && isSupportedScoreFile(file)) {
        dropOverlay.hidden = true;
        void documents.openFile(file);
        return;
    }
    const reason = files.length > 1
        ? "一次只能导入一个曲谱"
        : `不支持的文件类型：${file?.name ?? "未知文件"}`;
    dropOverlay.hidden = false;
    dropOverlay.dataset.state = "rejected";
    dropTitle.textContent = "文件已拒绝";
    dropDetail.textContent = reason;
    dropFeedbackTimer = window.setTimeout(() => {
        dropOverlay.hidden = true;
        dropFeedbackTimer = void 0;
    }, 1500);
    statusMessage.dataset.state = "error";
    statusMessage.textContent = "文件已拒绝";
    statusMessage.title = reason;
}, { capture: true });
const workspace = createWorkspaceController(editor, {
    onSourceTabReselect() {
        void documents.open();
    },
    onSourceTabChanged(tab) {
        playback?.setActive(tab === "playback");
    },
});
preview = createPreviewController({
    onNavigateSource(range, select) {
        if (workspace.getSourceTab() !== "source") return;
        revealSourcePosition(editor, range, select);
    },
    onSeekPlayback(scoreTime) {
        playback?.seekScoreTime(scoreTime);
    },
    isPlaybackActive() {
        return workspace.getSourceTab() === "playback";
    },
});
const diagnostics = createDiagnosticsController({
    editor,
    showSource: workspace.revealSource,
});
playback = createPlaybackController({
    requestPlan: ensurePlaybackPlan,
    showDiagnostics() {
        workspace.showResult("problems");
    },
    getFileName() {
        return sourceName.textContent || "score.jpfun";
    },
    onScorePosition(scoreTime) {
        preview.showPlaybackPosition(scoreTime);
    },
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
    latestCompiled = null;
    latestCompiledSource = null;
    playbackSource = null;
    playbackDiagnostics = [];
    playback?.setScoreError("请先修复排版错误");
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

function renderCombinedDiagnostics() {
    const combined = [...scoreDiagnostics, ...playbackDiagnostics];
    diagnostics.render(combined);
    return combined;
}

function updateDocumentStatus() {
    const combined = renderCombinedDiagnostics();
    const playbackFailed = playbackDiagnostics.some(item => item instanceof ErrorDiagnostic);
    statusMessage.dataset.state = playbackFailed ? "error" : combined.length === 0 ? "ok" : "warning";
    statusMessage.textContent = combined.length === 0 ? "排版完成" : `${combined.length} 条诊断`;
    statusMessage.title = "";
}

function compilePlaybackPlan(compiled: CompileScoreResult, sourceText: string) {
    playbackSource = sourceText;
    playbackDiagnostics = [];
    try {
        const plan = compilePlayback(compiled.lowering);
        playbackDiagnostics = [...plan.diagnostics];
        playback?.setPlan(plan);
        updateDocumentStatus();
        return true;
    } catch (error) {
        const hasDiagnostic = error instanceof Diagnostic;
        if (hasDiagnostic) playbackDiagnostics = [error];
        playback?.setCompileError(`播放编译失败：${formatError(error)}`, hasDiagnostic);
        updateDocumentStatus();
        return false;
    }
}

function ensurePlaybackPlan() {
    window.clearTimeout(renderTimer);
    const sourceText = source();
    if (!latestCompiled || latestCompiledSource !== sourceText) {
        if (!compileAndRender()) return false;
    }
    if (!latestCompiled) return false;
    if (playbackSource !== sourceText) return compilePlaybackPlan(latestCompiled, sourceText);
    return playback?.hasPlan ?? false;
}

function compileAndRender(): boolean {
    const startedAt = performance.now();
    const sourceText = source();
    try {
        const compiled = compileScore(sourceText, {
            fontSize: DEFAULT_FONT_SIZE,
            rowGap: 18,
            textMeasurer,
        });
        latestCompiled = compiled;
        latestCompiledSource = sourceText;
        scoreDiagnostics = [...compiled.diagnostics];
        if (playbackSource !== sourceText) {
            playbackDiagnostics = [];
        }
        preview.render(compiled);
        publishSemanticAst(editor, compiled.ast);
        layoutStats.textContent = `布局 ${compiled.layout.objects.length} 个对象 · `
            + `${compiled.layout.lineCount} 行 · ${compiled.layout.pages.length} 页 · `
            + `${compiled.layout.bounds.w.toFixed(0)} × ${compiled.layout.bounds.h.toFixed(0)}`;
        if (playback?.active && playbackSource !== sourceText) {
            compilePlaybackPlan(compiled, sourceText);
        } else updateDocumentStatus();
        // 非致命诊断靠标签徽标提示，不抢面板；只有从中断恢复时才切回预览
        if (fatal) {
            fatal = false;
            if (!playbackDiagnostics.some(item => item instanceof ErrorDiagnostic)) {
                workspace.showResult("preview");
            }
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
        if (format !== "midi" && !isImageExportFormat(format)) return;

        if (format !== "midi") {
            window.clearTimeout(renderTimer);
            if (!compileAndRender()) {
                closeExportMenu(true);
                return;
            }
        }

        exportButton.disabled = true;
        for (const item of exportFormatButtons) item.disabled = true;
        try {
            if (format === "midi") await playback?.downloadMidi();
            else await preview.download(format, normalizedExportPpi());
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
window.addEventListener("pagehide", () => playback?.destroy());

requiredElement<HTMLButtonElement>("#runLayout").addEventListener("click", compileAndRender);
window.addEventListener("beforeprint", () => {
    compileAndRender();
    preview.preparePrint();
});
window.addEventListener("afterprint", preview.clearPrint);

updateSourceSize();
compileAndRender();
playback.setActive(workspace.getSourceTab() === "playback");