import {
    layoutPageBounds,
    renderLayoutPagesToCanvas,
    renderLayoutPagesToSvg,
    type CompileScoreResult,
    type Rect,
} from "jpfun";
import type { SourceRange } from "./editor.js";
import { createDropdown, requiredElement } from "./platform.js";
import {
    createPreviewNavigationMap,
    previewHitAt,
    sourceTargetAt,
    type PreviewNavigationMap,
} from "./preview-navigation.js";

type PreviewBackend = "svg" | "canvas";

export interface PreviewController {
    render(result: CompileScoreResult): void;
    showError(message: string): void;
    invalidateNavigation(): void;
    focusSourcePosition(position: number): void;
    preparePrint(): void;
    clearPrint(): void;
}

interface PreviewControllerOptions {
    onNavigateSource(range: SourceRange, select: boolean): void;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const HIT_TOLERANCE = 6;
const DOUBLE_CLICK_DELAY = 500;
const DOUBLE_CLICK_DISTANCE = 8;

function isPreviewBackend(value: string | undefined): value is PreviewBackend {
    return value === "svg" || value === "canvas";
}

export function createPreviewController(options: PreviewControllerOptions): PreviewController {
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
    let navigation: PreviewNavigationMap | null = null;
    let zoom = 1;
    let fitToWidth = true;
    let canvasZoomFrame: number | undefined;
    let pendingSourceClick: { range: SourceRange; x: number; y: number } | null = null;
    let pendingSourceClickTimer: number | undefined;

    document.head.append(printStyle);

    function createSvgPages(compiled: CompileScoreResult) {
        const container = document.createElement("div");
        container.innerHTML = renderLayoutPagesToSvg(compiled.layout, { background: "#ffffff" }).join("");
        return [...container.querySelectorAll<SVGSVGElement>(":scope > svg")];
    }

    function mountPages(pages: readonly (SVGSVGElement | HTMLCanvasElement)[]) {
        host.replaceChildren(...pages.map(surface => {
            const page = document.createElement("div");
            page.className = "preview-page";
            const overlay = document.createElement("div");
            overlay.className = "preview-overlay";
            page.append(surface, overlay);
            return page;
        }));
    }

    function renderSvg(compiled: CompileScoreResult) {
        const pages = createSvgPages(compiled);
        for (const svg of pages) resizeSvg(svg);
        mountPages(pages);
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
        const pages = layoutPageBounds(compiled.layout).map(page => {
            const width = Math.max(1, Math.ceil(page.w));
            const height = Math.max(1, Math.ceil(page.h));
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
        mountPages(pages);
    }

    function clearFocus() {
        host.querySelector(".preview-focus-ripple")?.remove();
    }

    function clearPendingSourceClick() {
        window.clearTimeout(pendingSourceClickTimer);
        pendingSourceClickTimer = void 0;
        pendingSourceClick = null;
    }

    function invalidateNavigation() {
        clearPendingSourceClick();
        navigation = null;
        clearFocus();
    }

    function surfaceContentBounds(surface: SVGSVGElement | HTMLCanvasElement) {
        const bounds = surface.getBoundingClientRect();
        const styles = getComputedStyle(surface);
        const left = parseFloat(styles.borderLeftWidth) || 0;
        const right = parseFloat(styles.borderRightWidth) || 0;
        const top = parseFloat(styles.borderTopWidth) || 0;
        const bottom = parseFloat(styles.borderBottomWidth) || 0;
        return {
            left: bounds.left + left,
            top: bounds.top + top,
            width: Math.max(1, bounds.width - left - right),
            height: Math.max(1, bounds.height - top - bottom),
        };
    }

    function focusRegion(region: Rect, reveal: boolean) {
        if (!result) return;
        const pages = layoutPageBounds(result.layout);
        const centerY = region.y + region.h / 2;
        const pageIndex = pages.findIndex(page => centerY >= page.y && centerY <= page.y + page.h);
        const pageRect = pages[pageIndex];
        const page = host.children[pageIndex];
        if (!pageRect || !(page instanceof HTMLElement)) return;
        const surface = page.querySelector<SVGSVGElement | HTMLCanvasElement>(":scope > svg, :scope > canvas");
        const overlay = page.querySelector<HTMLElement>(":scope > .preview-overlay");
        if (!surface || !overlay) return;

        if (reveal) {
            const viewportBounds = scroll.getBoundingClientRect();
            if (viewportBounds.top < 0 || viewportBounds.bottom > window.innerHeight) {
                scroll.scrollIntoView({ block: "center", inline: "nearest" });
            }
        }
        clearFocus();
        const surfaceBounds = surfaceContentBounds(surface);
        const pageElementBounds = page.getBoundingClientRect();
        const centerX = region.x + region.w / 2;
        const x = surfaceBounds.left - pageElementBounds.left
            + (centerX - pageRect.x) / pageRect.w * surfaceBounds.width;
        const y = surfaceBounds.top - pageElementBounds.top
            + (centerY - pageRect.y) / pageRect.h * surfaceBounds.height;

        if (reveal) {
            const scrollBounds = scroll.getBoundingClientRect();
            scroll.scrollLeft += pageElementBounds.left + x - scrollBounds.left - scroll.clientWidth / 2;
            scroll.scrollTop += pageElementBounds.top + y - scrollBounds.top - scroll.clientHeight / 2;
        }

        const regionWidth = region.w / pageRect.w * surfaceBounds.width;
        const regionHeight = region.h / pageRect.h * surfaceBounds.height;
        const diameter = Math.min(140, Math.max(48, Math.max(regionWidth, regionHeight) + 32));
        const marker = document.createElement("span");
        marker.className = "preview-focus-ripple";
        marker.style.left = `${x}px`;
        marker.style.top = `${y}px`;
        marker.style.setProperty("--focus-diameter", `${diameter}px`);
        overlay.append(marker);
    }

    function focusSourcePosition(position: number) {
        clearFocus();
        if (!result || !navigation) return;
        const character = result.parser.source[position];
        if (!character || /\s/.test(character)) return;
        const target = sourceTargetAt(navigation, position);
        const region = target?.regions[0];
        if (region) focusRegion(region, true);
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

    function updateZoomLabel() {
        const percent = `${Math.round(zoom * 100)}%`;
        zoomButton.textContent = fitToWidth ? `适合宽度:${percent}` : percent;
    }

    function setZoom(value: number, origin?: { x: number; y: number }) {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
        if (Math.abs(next - zoom) < 0.001) {
            updateZoomLabel();
            return;
        }

        const anchor = origin ?? {
            x: scroll.clientWidth / 2,
            y: scroll.clientHeight / 2,
        };
        const savedAnchor = captureZoomAnchor(anchor);
        zoom = next;
        updateZoomLabel();
        if (activeBackend === "canvas") scheduleCanvasZoom(savedAnchor, anchor);
        else {
            applySvgZoom();
            restoreZoomAnchor(savedAnchor, anchor);
        }
    }

    function fitWidth() {
        fitToWidth = true;
        if (!result || scroll.clientWidth <= 0) {
            updateZoomLabel();
            return;
        }
        const width = Math.max(...layoutPageBounds(result.layout).map(bounds => bounds.w), 1);
        setZoom(scroll.clientWidth / width);
    }

    function preparePrint() {
        clearPrint();
        document.body.classList.add("print-ready");
        if (!result) return;
        const [paper] = layoutPageBounds(result.layout);
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
            if (Number.isFinite(percent)) {
                fitToWidth = false;
                setZoom(percent / 100);
            }
            closeZoomMenu(true);
        });
    }

    fitWidthButton.addEventListener("click", () => {
        fitWidth();
        closeZoomMenu(true);
    });

    new ResizeObserver(() => {
        if (fitToWidth) fitWidth();
    }).observe(scroll);

    scroll.addEventListener("wheel", event => {
        // 普通滚轮翻页，Ctrl+滚轮以指针为中心缩放
        if (!event.ctrlKey) return;
        event.preventDefault();
        const bounds = scroll.getBoundingClientRect();
        fitToWidth = false;
        setZoom(zoom * Math.exp(-event.deltaY * 0.002), {
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
        });
    }, { passive: false });

    document.addEventListener("click", event => {
        if (!pendingSourceClick || event.button !== 0) return;
        const { range, x, y } = pendingSourceClick;
        if (Math.hypot(event.clientX - x, event.clientY - y) > DOUBLE_CLICK_DISTANCE) {
            clearPendingSourceClick();
            return;
        }
        clearPendingSourceClick();
        event.preventDefault();
        event.stopPropagation();
        options.onNavigateSource(range, true);
    }, true);

    host.addEventListener("click", event => {
        clearFocus();
        if (!result || !navigation || event.button !== 0) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const page = target.closest<HTMLElement>(".preview-page");
        if (!page || page.parentElement !== host) return;
        const pageIndex = [...host.children].indexOf(page);
        const bounds = layoutPageBounds(result.layout)[pageIndex];
        const surface = page.querySelector<SVGSVGElement | HTMLCanvasElement>(":scope > svg, :scope > canvas");
        if (!bounds || !surface) return;
        const surfaceBounds = surfaceContentBounds(surface);
        const x = bounds.x + (event.clientX - surfaceBounds.left) / surfaceBounds.width * bounds.w;
        const y = bounds.y + (event.clientY - surfaceBounds.top) / surfaceBounds.height * bounds.h;
        const tolerance = HIT_TOLERANCE * Math.max(
            bounds.w / surfaceBounds.width,
            bounds.h / surfaceBounds.height,
        );
        const hit = previewHitAt(navigation, x, y, tolerance);
        if (!hit) return;
        event.preventDefault();
        focusRegion(hit.region, false);
        const range = {
            from: hit.target.span.start,
            to: hit.target.span.end,
        };
        pendingSourceClick = { range, x: event.clientX, y: event.clientY };
        pendingSourceClickTimer = window.setTimeout(clearPendingSourceClick, DOUBLE_CLICK_DELAY);
        options.onNavigateSource(range, false);
    });

    host.addEventListener("dblclick", event => event.preventDefault());

    return {
        render(compiled) {
            clearPendingSourceClick();
            result = compiled;
            navigation = createPreviewNavigationMap(compiled);
            renderActiveBackend();
            if (fitToWidth) fitWidth();
        },
        showError(message) {
            invalidateNavigation();
            result = null;   // 否则缩放会把过期谱面重新画回来
            window.cancelAnimationFrame(canvasZoomFrame ?? 0);
            canvasZoomFrame = void 0;
            clearPrint();
            const text = document.createElement("pre");
            text.className = "preview-error";
            text.textContent = message;
            host.replaceChildren(text);
        },
        invalidateNavigation,
        focusSourcePosition,
        preparePrint,
        clearPrint,
    };
}