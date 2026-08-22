import {
    renderLayoutPagesToCanvas,
    renderLayoutPagesToSvg,
    type CompileScoreResult,
} from "jpfun";
import { createDropdown, requiredElement } from "./platform.js";

type PreviewBackend = "svg" | "canvas";

export interface PreviewController {
    render(result: CompileScoreResult): void;
    showError(message: string): void;
    preparePrint(): void;
    clearPrint(): void;
}

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
    const printHost = requiredElement<HTMLElement>("#printHost");
    const printStyle = document.createElement("style");
    const backendTabs = [...document.querySelectorAll<HTMLButtonElement>(".backend-tab")];
    let activeBackend: PreviewBackend = "svg";
    let result: CompileScoreResult | null = null;
    let zoom = 1;
    let canvasZoomFrame: number | undefined;

    document.head.append(printStyle);

    function pageBounds(compiled: CompileScoreResult) {
        return compiled.layout.pages.length > 0
            ? compiled.layout.pages.map(page => page.bounds)
            : [compiled.layout.bounds];
    }

    function createSvgPages(compiled: CompileScoreResult) {
        const container = document.createElement("div");
        container.innerHTML = renderLayoutPagesToSvg(compiled.layout, { background: "#ffffff" }).join("");
        return [...container.querySelectorAll<SVGSVGElement>(":scope > svg")];
    }

    function renderSvg(compiled: CompileScoreResult) {
        const pages = createSvgPages(compiled);
        for (const svg of pages) resizeSvg(svg);
        host.replaceChildren(...pages);
    }

    function resizeSvg(svg: SVGSVGElement) {
        const width = Number(svg.getAttribute("width")) || 1;
        const height = Number(svg.getAttribute("height")) || 1;
        svg.style.width = `${width * zoom}px`;
        svg.style.height = `${height * zoom}px`;
    }

    function renderCanvas(compiled: CompileScoreResult) {
        const ratio = window.devicePixelRatio || 1;
        const contexts: CanvasRenderingContext2D[] = [];
        const pages = pageBounds(compiled).map(bounds => {
            const width = Math.max(1, Math.ceil(bounds.w));
            const height = Math.max(1, Math.ceil(bounds.h));
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(width * ratio * zoom);
            canvas.height = Math.ceil(height * ratio * zoom);
            canvas.style.width = `${width * zoom}px`;
            canvas.style.height = `${height * zoom}px`;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Canvas 2D context is unavailable");
            context.scale(ratio * zoom, ratio * zoom);
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, width, height);
            contexts.push(context);
            return canvas;
        });
        renderLayoutPagesToCanvas(compiled.layout, contexts);
        host.replaceChildren(...pages);
    }

    function renderActiveBackend() {
        window.cancelAnimationFrame(canvasZoomFrame ?? 0);
        canvasZoomFrame = void 0;
        if (!result) return;
        if (activeBackend === "canvas") renderCanvas(result);
        else renderSvg(result);
    }

    function applySvgZoom() {
        if (!result) return;
        const pages = host.querySelectorAll<SVGSVGElement>("svg");
        if (pages.length === 0) return renderSvg(result);
        for (const svg of pages) resizeSvg(svg);
    }

    function captureZoomAnchor(anchor: { x: number; y: number }) {
        const pages = [...host.children];
        const scrollBounds = scroll.getBoundingClientRect();
        const x = scrollBounds.left + anchor.x;
        const y = scrollBounds.top + anchor.y;
        let nearest = 0;
        let nearestDistance = Infinity;
        for (const [index, page] of pages.entries()) {
            const bounds = page.getBoundingClientRect();
            const dx = Math.max(bounds.left - x, 0, x - bounds.right);
            const dy = Math.max(bounds.top - y, 0, y - bounds.bottom);
            const distance = dx * dx + dy * dy;
            if (distance < nearestDistance) {
                nearest = index;
                nearestDistance = distance;
            }
        }
        const bounds = pages[nearest]?.getBoundingClientRect();
        if (!bounds) return null;
        return {
            page: nearest,
            x: Math.min(1, Math.max(0, (x - bounds.left) / bounds.width)),
            y: Math.min(1, Math.max(0, (y - bounds.top) / bounds.height)),
        };
    }

    function restoreZoomAnchor(
        saved: { page: number; x: number; y: number } | null,
        anchor: { x: number; y: number },
    ) {
        if (!saved) return;
        const page = host.children[saved.page];
        if (!page) return;
        const scrollBounds = scroll.getBoundingClientRect();
        const bounds = page.getBoundingClientRect();
        scroll.scrollLeft += bounds.left + bounds.width * saved.x - scrollBounds.left - anchor.x;
        scroll.scrollTop += bounds.top + bounds.height * saved.y - scrollBounds.top - anchor.y;
    }

    function scheduleCanvasZoom(
        saved: { page: number; x: number; y: number } | null,
        anchor: { x: number; y: number },
    ) {
        window.cancelAnimationFrame(canvasZoomFrame ?? 0);
        canvasZoomFrame = window.requestAnimationFrame(() => {
            canvasZoomFrame = void 0;
            if (!result || activeBackend !== "canvas") return;
            renderCanvas(result);
            restoreZoomAnchor(saved, anchor);
        });
    }

    function setZoom(value: number, origin?: { x: number; y: number }) {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
        if (Math.abs(next - zoom) < 0.001) return;

        const anchor = origin ?? {
            x: scroll.clientWidth / 2,
            y: scroll.clientHeight / 2,
        };
        const savedAnchor = captureZoomAnchor(anchor);
        zoom = next;
        zoomButton.textContent = `${Math.round(zoom * 100)}%`;
        if (activeBackend === "canvas") scheduleCanvasZoom(savedAnchor, anchor);
        else {
            applySvgZoom();
            restoreZoomAnchor(savedAnchor, anchor);
        }
    }

    function fitWidth() {
        if (!result) return;
        const styles = getComputedStyle(scroll);
        const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
        const width = Math.max(...pageBounds(result).map(bounds => bounds.w), 1);
        setZoom((scroll.clientWidth - horizontalPadding) / width);
    }

    function preparePrint() {
        clearPrint();
        document.body.classList.add("print-ready");
        if (!result) return;
        const [paper] = pageBounds(result);
        printHost.replaceChildren(...createSvgPages(result));
        printStyle.textContent = `@media print { @page { size: ${paper.w}px ${paper.h}px; margin: 0; } }`;
    }

    function clearPrint() {
        document.body.classList.remove("print-ready");
        printStyle.textContent = "";
        printHost.replaceChildren();
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
            window.cancelAnimationFrame(canvasZoomFrame ?? 0);
            canvasZoomFrame = void 0;
            clearPrint();
            const text = document.createElement("pre");
            text.className = "preview-error";
            text.textContent = message;
            host.replaceChildren(text);
        },
        preparePrint,
        clearPrint,
    };
}