import type { EditorView } from "@codemirror/view";
import { readStoredValue, requiredElement, storeValue } from "./platform.js";

type ViewMode = "editor" | "split" | "preview";
type LeftTab = "source" | "playback";
type RightTab = "preview" | "problems";

export interface WorkspaceController {
    showSource(tab: LeftTab): void;
    showResult(tab: RightTab): void;
}

function isViewMode(value: string | null | undefined): value is ViewMode {
    return value === "editor" || value === "split" || value === "preview";
}

export function createWorkspaceController(editor: EditorView): WorkspaceController {
    const workspace = requiredElement<HTMLElement>("#workspace");
    const divider = requiredElement<HTMLElement>("#workspaceDivider");
    const editorHost = requiredElement<HTMLElement>("#sourceEditor");
    const sourcePane = requiredElement<HTMLElement>("#sourcePane");
    const playbackPane = requiredElement<HTMLElement>("#playbackPane");
    const previewPane = requiredElement<HTMLElement>("#previewPane");
    const problemsPane = requiredElement<HTMLElement>("#problemsPane");
    const previewTools = requiredElement<HTMLElement>("#previewTools");
    const sourceSize = requiredElement<HTMLElement>("#sourceSize");
    const viewButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-view]")];
    const leftTabs = [...document.querySelectorAll<HTMLButtonElement>("[data-left-tab]")];
    const rightTabs = [...document.querySelectorAll<HTMLButtonElement>("[data-right-tab]")];

    function setViewMode(mode: ViewMode) {
        workspace.dataset.view = mode;
        for (const button of viewButtons) button.setAttribute("aria-pressed", String(button.dataset.view === mode));
        storeValue("jpfun-view", mode);
    }

    function showSource(tab: LeftTab) {
        sourcePane.hidden = tab !== "source";
        playbackPane.hidden = tab !== "playback";
        sourceSize.hidden = tab !== "source";
        for (const button of leftTabs) button.setAttribute("aria-selected", String(button.dataset.leftTab === tab));
        storeValue("jpfun-left-tab", tab);
    }

    function showResult(tab: RightTab) {
        previewPane.hidden = tab !== "preview";
        problemsPane.hidden = tab !== "problems";
        previewTools.hidden = tab !== "preview";
        for (const button of rightTabs) button.setAttribute("aria-selected", String(button.dataset.rightTab === tab));
    }

    function setEditorWidth(percent: number) {
        const value = Math.min(75, Math.max(25, percent));
        workspace.style.setProperty("--editor-width", `${value}%`);
        divider.setAttribute("aria-valuenow", value.toFixed(0));
        storeValue("jpfun-editor-width", String(value));
    }

    divider.addEventListener("pointerdown", event => {
        if (workspace.dataset.view !== "split") return;
        divider.setPointerCapture(event.pointerId);
        document.body.classList.add("resizing");
    });

    divider.addEventListener("pointermove", event => {
        if (!divider.hasPointerCapture(event.pointerId)) return;
        const bounds = workspace.getBoundingClientRect();
        setEditorWidth(((event.clientX - bounds.left) / bounds.width) * 100);
    });

    divider.addEventListener("pointerup", event => {
        if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
        document.body.classList.remove("resizing");
    });

    divider.addEventListener("keydown", event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const current = Number(divider.getAttribute("aria-valuenow")) || 40;
        setEditorWidth(current + (event.key === "ArrowRight" ? 2 : -2));
    });

    for (const button of viewButtons) {
        button.addEventListener("click", () => {
            if (isViewMode(button.dataset.view)) setViewMode(button.dataset.view);
        });
    }
    for (const button of leftTabs) {
        button.addEventListener("click", () => showSource(button.dataset.leftTab === "playback" ? "playback" : "source"));
    }
    for (const button of rightTabs) {
        button.addEventListener("click", () => showResult(button.dataset.rightTab === "problems" ? "problems" : "preview"));
    }

    const storedWidth = Number(readStoredValue("jpfun-editor-width"));
    if (Number.isFinite(storedWidth) && storedWidth > 0) setEditorWidth(storedWidth);
    const storedView = readStoredValue("jpfun-view");
    if (isViewMode(storedView)) setViewMode(storedView);
    if (readStoredValue("jpfun-left-tab") === "playback") showSource("playback");

    // 面板显隐、视图切换、拖分隔条都会改 editorHost 尺寸，重测量统一从这里走
    new ResizeObserver(() => editor.requestMeasure()).observe(editorHost);
    return { showSource, showResult };
}