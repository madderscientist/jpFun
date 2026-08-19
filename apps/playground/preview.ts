import { renderLayoutToCanvas, renderLayoutToSvg, type CompileScoreResult } from "jpfun";
import { createDropdown, requiredElement } from "./platform.js";

type PreviewBackend = "svg" | "canvas";

export interface PreviewController {
    render(result: CompileScoreResult): void;
    showError(message: string): void;
}

const PREVIEW_PADDING = 22;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;

function isPreviewBackend(value: string | undefined): value is PreviewBackend {
    return value === "svg" || value === "canvas";
}

export function createPreviewController(): PreviewController {
    const host = requiredElement<HTMLElement>("#previewHost");
    const scroll = requiredElement<HTMLElement>("#previewScroll");
    const zoomButton = requiredElement<HTMLButtonElement>("#zoomButton");
    const zoomMenu = requiredElement<HTMLElement>("#zoomMenu");
    const fitWidthButton = requiredElement<HTMLButtonElement>("#fitWidth");
    const backendTabs = [...document.querySelectorAll<HTMLButtonElement>(".backend-tab")];
    let activeBackend: PreviewBackend = "svg";
    let result: CompileScoreResult | null = null;
    let zoom = 1;

    function size(compiled: CompileScoreResult) {
        return {
            width: Math.max(1, Math.ceil(compiled.layout.bounds.w + PREVIEW_PADDING * 2)),
            height: Math.max(1, Math.ceil(compiled.layout.bounds.h + PREVIEW_PADDING * 2)),
        };
    }

    function renderSvg(compiled: CompileScoreResult) {
        host.innerHTML = renderLayoutToSvg(compiled.layout, {
            padding: PREVIEW_PADDING,
            background: "#ffffff",
        });
        const svg = host.querySelector<SVGSVGElement>("svg");
        if (!svg) throw new Error("SVG preview was not created");
        resizeSvg(svg, compiled);
    }

    function resizeSvg(svg: SVGSVGElement, compiled: CompileScoreResult) {
        const preview = size(compiled);
        svg.style.width = `${preview.width * zoom}px`;
        svg.style.height = `${preview.height * zoom}px`;
    }

    function renderCanvas(compiled: CompileScoreResult) {
        const preview = size(compiled);
        const bounds = compiled.layout.bounds;
        const ratio = window.devicePixelRatio || 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(preview.width * ratio * zoom);
        canvas.height = Math.ceil(preview.height * ratio * zoom);
        canvas.style.width = `${preview.width * zoom}px`;
        canvas.style.height = `${preview.height * zoom}px`;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context is unavailable");
        context.scale(ratio * zoom, ratio * zoom);
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, preview.width, preview.height);
        context.translate(PREVIEW_PADDING - bounds.x, PREVIEW_PADDING - bounds.y);
        renderLayoutToCanvas(compiled.layout, context);
        host.replaceChildren(canvas);
    }

    function renderActiveBackend() {
        if (!result) return;
        if (activeBackend === "canvas") renderCanvas(result);
        else renderSvg(result);
    }

    // SVG 内容与缩放无关，只改尺寸；Canvas 必须重画
    function applyZoom() {
        if (!result) return;
        if (activeBackend === "canvas") return renderCanvas(result);
        const svg = host.querySelector<SVGSVGElement>("svg");
        if (svg) resizeSvg(svg, result);
        else renderSvg(result);
    }

    function setZoom(value: number, origin?: { x: number; y: number }) {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
        if (Math.abs(next - zoom) < 0.001) return;

        const previous = zoom;
        const anchor = origin ?? {
            x: scroll.clientWidth / 2,
            y: scroll.clientHeight / 2,
        };
        const contentX = scroll.scrollLeft + anchor.x;
        const contentY = scroll.scrollTop + anchor.y;
        zoom = next;
        zoomButton.textContent = `${Math.round(zoom * 100)}%`;
        applyZoom();

        // Preserve the content point under the cursor (or viewport center) after rerendering.
        requestAnimationFrame(() => {
            const factor = zoom / previous;
            scroll.scrollLeft = contentX * factor - anchor.x;
            scroll.scrollTop = contentY * factor - anchor.y;
        });
    }

    function fitWidth() {
        if (!result) return;
        const preview = size(result);
        const styles = getComputedStyle(scroll);
        const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
        setZoom((scroll.clientWidth - horizontalPadding) / preview.width);
    }

    const closeZoomMenu = createDropdown(zoomButton, zoomMenu);

    for (const tab of backendTabs) {
        tab.addEventListener("click", () => {
            const backend = tab.dataset.backend;
            if (!isPreviewBackend(backend)) return;
            activeBackend = backend;
            for (const item of backendTabs) item.setAttribute("aria-selected", String(item === tab));
            renderActiveBackend();
        });
    }

    for (const item of zoomMenu.querySelectorAll<HTMLButtonElement>("[data-zoom]")) {
        item.addEventListener("click", () => {
            const percent = Number(item.dataset.zoom);
            if (Number.isFinite(percent)) setZoom(percent / 100);
            closeZoomMenu(true);
        });
    }

    fitWidthButton.addEventListener("click", fitWidth);

    scroll.addEventListener("wheel", event => {
        // 普通滚轮翻页，Ctrl+滚轮以指针为中心缩放
        if (!event.ctrlKey) return;
        event.preventDefault();
        const bounds = scroll.getBoundingClientRect();
        setZoom(zoom * Math.exp(-event.deltaY * 0.002), {
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
        });
    }, { passive: false });

    return {
        render(compiled) {
            result = compiled;
            renderActiveBackend();
        },
        showError(message) {
            result = null;   // 否则缩放会把过期谱面重新画回来
            const text = document.createElement("pre");
            text.className = "preview-error";
            text.textContent = message;
            host.replaceChildren(text);
        },
    };
}