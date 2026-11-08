import type { EditorView } from "@codemirror/view";
import { readStoredValue, requiredElement, storeValue } from "./platform.js";

type ViewMode = "editor" | "split" | "preview";
export type LeftTab = "source" | "playback" | "visual";
type RightTab = "preview" | "problems";

export interface WorkspaceController {
    revealSource(): void;
    showResult(tab: RightTab): void;
    getSourceTab(): LeftTab;
}

function isViewMode(value: string | null | undefined): value is ViewMode {
    return value === "editor" || value === "split" || value === "preview";
}

function isLeftTab(value: string | null | undefined): value is LeftTab {
    return value === "source" || value === "playback" || value === "visual";
}

export function createWorkspaceController(
    editor: EditorView,
    options?: {
        onSourceTabReselect(): void;
        onSourceTabChanged?(tab: LeftTab): void;
    },
): WorkspaceController {
    const workspace = requiredElement<HTMLElement>("#workspace");
    const divider = requiredElement<HTMLElement>("#workspaceDivider");
    const editorHost = requiredElement<HTMLElement>("#sourceEditor");
    const sourcePane = requiredElement<HTMLElement>("#sourcePane");
    const playbackPane = requiredElement<HTMLElement>("#playbackPane");
    const visualPane = requiredElement<HTMLElement>("#visualPane");
    const previewPane = requiredElement<HTMLElement>("#previewPane");
    const problemsPane = requiredElement<HTMLElement>("#problemsPane");
    const previewTools = requiredElement<HTMLElement>("#previewTools");
    const sourceSize = requiredElement<HTMLElement>("#sourceSize");
    const collapseButton = requiredElement<HTMLButtonElement>("#panelCollapseButton");
    const viewButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-view]")];
    const leftTabs = [...document.querySelectorAll<HTMLButtonElement>("[data-left-tab]")];
    const rightTabs = [...document.querySelectorAll<HTMLButtonElement>("[data-right-tab]")];
    let activeLeftTab: LeftTab = "source";
    let panelCollapsed = false;

    function setPanelCollapsed(collapsed: boolean) {
        panelCollapsed = collapsed;
        workspace.dataset.panelCollapsed = String(collapsed);
        collapseButton.setAttribute("aria-expanded", String(!collapsed));
        collapseButton.textContent = collapsed ? "▴" : "▾";
        collapseButton.title = collapsed ? "展开面板" : "折叠面板";
        collapseButton.setAttribute("aria-label", collapseButton.title);
    }

    function setViewMode(mode: ViewMode) {
        workspace.dataset.view = mode;
        for (const button of viewButtons) button.setAttribute("aria-pressed", String(button.dataset.view === mode));
        storeValue("jpfun-view", mode);
    }

    function showSource(tab: LeftTab, notify = true) {
        if (panelCollapsed) setPanelCollapsed(false);
        const changed = activeLeftTab !== tab;
        activeLeftTab = tab;
        workspace.dataset.leftTab = tab;
        sourcePane.hidden = tab !== "source";
        playbackPane.hidden = tab !== "playback";
        visualPane.hidden = tab !== "visual";
        sourceSize.hidden = tab !== "source";
        for (const button of leftTabs) button.setAttribute("aria-selected", String(button.dataset.leftTab === tab));
        storeValue("jpfun-left-tab", tab);
        if (changed && notify) options?.onSourceTabChanged?.(tab);
    }

    function showResult(tab: RightTab) {
        previewPane.hidden = tab !== "preview";
        problemsPane.hidden = tab !== "problems";
        previewTools.hidden = tab !== "preview";
        for (const button of rightTabs) button.setAttribute("aria-selected", String(button.dataset.rightTab === tab));
    }

    function revealSource() {
        showSource("source");
        if (workspace.dataset.view === "preview") setViewMode("split");
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
        button.addEventListener("click", () => {
            const raw = button.dataset.leftTab;
            const tab: LeftTab = isLeftTab(raw) ? raw : "source";
            if (tab === "source" && button.getAttribute("aria-selected") === "true") {
                options?.onSourceTabReselect();
            } else {
                showSource(tab);
            }
        });
    }
    collapseButton.addEventListener("click", () => {
        setPanelCollapsed(!panelCollapsed);
    });
    for (const button of rightTabs) {
        button.addEventListener("click", () => showResult(button.dataset.rightTab === "problems" ? "problems" : "preview"));
    }

    const storedWidth = Number(readStoredValue("jpfun-editor-width"));
    if (Number.isFinite(storedWidth) && storedWidth > 0) setEditorWidth(storedWidth);
    const storedView = readStoredValue("jpfun-view");
    if (isViewMode(storedView)) setViewMode(storedView);
    const storedLeftTab = readStoredValue("jpfun-left-tab");
    if (isLeftTab(storedLeftTab)) showSource(storedLeftTab, false);
    else workspace.dataset.leftTab = "source";

    // 面板显隐、视图切换、拖分隔条都会改 editorHost 尺寸，重测量统一从这里走
    new ResizeObserver(() => editor.requestMeasure()).observe(editorHost);
    return { revealSource, showResult, getSourceTab: () => activeLeftTab };
}