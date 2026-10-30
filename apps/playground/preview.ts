import {
    CanvasPainter,
    RecordingPainter,
    SvgPainter,
    layoutPageBounds,
    paintLayoutPages,
    type CompileScoreResult,
    type Rect,
} from "jpfun";
import type { SourceRange } from "./editor.js";
import { createDropdown, downloadBlob, requiredElement } from "./platform.js";
import { createVirtualPages } from "./preview-pages.js";
import {
    createPreviewNavigationMap,
    playbackRegionAt,
    playbackTimeAt,
    previewHitAt,
    sourceTargetAt,
    type PreviewNavigationMap,
} from "./preview-navigation.js";

type PreviewBackend = "svg" | "canvas";
export type ImageExportFormat = "svg" | "png" | "jpeg";

export interface PreviewController {
    render(result: CompileScoreResult): void;
    showError(message: string): void;
    invalidateNavigation(): void;
    focusSourcePosition(position: number): void;
    showPlaybackPosition(scoreTime: number | null): void;
    download(format: ImageExportFormat, ppi: number): Promise<void>;
    preparePrint(): void;
    clearPrint(): void;
}

interface PreviewControllerOptions {
    onError(error: unknown): void;
    onNavigateSource(range: SourceRange, select: boolean): void;
    onSeekPlayback(scoreTime: number): void;
    isPlaybackActive(): boolean;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const HIT_TOLERANCE = 6;
const DOUBLE_CLICK_DELAY = 500;
const DOUBLE_CLICK_DISTANCE = 8;
const CSS_PIXELS_PER_INCH = 96;

function isPreviewBackend(value: string | undefined): value is PreviewBackend {
    return value === "svg" || value === "canvas";
}

function savePage(blob: Blob, format: ImageExportFormat, page: number, pageCount: number) {
    downloadBlob(blob, `score${pageCount > 1 ? `-${page + 1}` : ""}.${format}`);
}

function canvasBlob(canvas: HTMLCanvasElement, format: "png" | "jpeg"): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error(`无法生成 ${format.toUpperCase()} 文件`));
        }, `image/${format}`, format === "jpeg" ? 0.95 : void 0);
    });
}

interface RecordedPage {
    readonly bounds: Rect;
    readonly recording: RecordingPainter;
}

export function recordLayoutPages(layout: CompileScoreResult["layout"]): RecordedPage[] {
    const pages = layoutPageBounds(layout).map(bounds => ({ bounds, recording: new RecordingPainter() }));
    paintLayoutPages(layout, pages.map(page => page.recording));
    return pages;
}

export function recordedPageToSvg(page: RecordedPage, background?: string): string {
    const painter = new SvgPainter();
    page.recording.replay(painter);
    return painter.toSvg(page.bounds, { background });
}

function drawRecordedPage(
    canvas: HTMLCanvasElement,
    { bounds, recording }: RecordedPage,
    scale: number,
    background?: string,
) {
    canvas.width = Math.max(1, Math.ceil(bounds.w * scale));
    canvas.height = Math.max(1, Math.ceil(bounds.h * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable");
    if (background) {
        context.fillStyle = background;
        context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.scale(scale, scale);
    context.translate(-bounds.x, -bounds.y);
    recording.replay(new CanvasPainter(context));
}

export async function downloadBitmapPages(pages: readonly RecordedPage[], format: "png" | "jpeg", ppi: number) {
    const scale = ppi / CSS_PIXELS_PER_INCH;
    const canvas = document.createElement("canvas");
    for (const [index, page] of pages.entries()) {
        try {
            drawRecordedPage(canvas, page, scale, format === "jpeg" ? "#ffffff" : undefined);
            const blob = await canvasBlob(canvas, format);
            savePage(blob, format, index, pages.length);
        } finally {
            canvas.width = 1;
            canvas.height = 1;
        }
    }
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
    let pageBounds: readonly Rect[] = [];
    let navigation: PreviewNavigationMap | null = null;
    let navigationStale = true;
    let zoom = 1;
    let fitToWidth = true;
    let pendingSourceClick: { range: SourceRange; x: number; y: number } | null = null;
    let pendingSourceClickTimer: number | undefined;
    let playbackScoreTime: number | null = null;
    let playbackRegionKey = "";
    let recordedPages: RecordedPage[] = [];
    const virtualPages = createVirtualPages(host, scroll, {
        renderPage,
        onError: options.onError,
    });

    document.head.append(printStyle);

    function createSvgPage(page: RecordedPage) {
        const container = document.createElement("div");
        container.innerHTML = recordedPageToSvg(page, "#ffffff");
        const svg = container.querySelector("svg");
        if (!svg) throw new Error("无法生成 SVG 页面");
        return svg;
    }

    function renderPage(index: number): SVGSVGElement | HTMLCanvasElement {
        const page = recordedPages[index];
        if (activeBackend === "svg") return createSvgPage(page);
        const canvas = document.createElement("canvas");
        drawRecordedPage(canvas, page, (window.devicePixelRatio || 1) * zoom, "#ffffff");
        return canvas;
    }

    function clearFocus() {
        host.querySelector(".preview-focus-ripple")?.remove();
    }

    function clearPlaybackCursor() {
        host.querySelector(".preview-playback-cursor")?.remove();
        playbackRegionKey = "";
    }

    function getNavigation(): PreviewNavigationMap | null {
        if (!result || navigationStale) return null;
        return navigation ??= createPreviewNavigationMap(result);
    }

    function renderPlaybackCursor(reveal: boolean) {
        if (playbackScoreTime === null) return clearPlaybackCursor();
        const currentNavigation = getNavigation();
        if (!currentNavigation) return clearPlaybackCursor();
        const region = playbackRegionAt(currentNavigation, playbackScoreTime);
        if (!region) return clearPlaybackCursor();
        const centerY = region.y + region.h / 2;
        const pageIndex = pageBounds.findIndex(page => centerY >= page.y && centerY <= page.y + page.h);
        const key = `${pageIndex}:${region.x}:${region.y}:${region.w}:${region.h}`;
        if (key === playbackRegionKey && host.querySelector(".preview-playback-cursor")) return;
        const pageRect = pageBounds[pageIndex];
        const page = host.children[pageIndex];
        if (!pageRect || !(page instanceof HTMLElement)) return clearPlaybackCursor();
        const surface = virtualPages.ensure(pageIndex);
        const overlay = page.querySelector<HTMLElement>(":scope > .preview-overlay");
        if (!surface || !overlay) return clearPlaybackCursor();

        const surfaceBounds = surfaceContentBounds(surface);
        const pageElementBounds = page.getBoundingClientRect();
        const x = surfaceBounds.left - pageElementBounds.left
            + (region.x - pageRect.x) / pageRect.w * surfaceBounds.width;
        const y = surfaceBounds.top - pageElementBounds.top
            + (region.y - pageRect.y) / pageRect.h * surfaceBounds.height;
        const width = Math.max(6, region.w / pageRect.w * surfaceBounds.width);
        const height = Math.max(6, region.h / pageRect.h * surfaceBounds.height);
        playbackRegionKey = key;

        let marker = host.querySelector<HTMLElement>(".preview-playback-cursor");
        if (!marker) {
            marker = document.createElement("span");
            marker.className = "preview-playback-cursor";
        }
        overlay.append(marker);
        marker.style.left = `${x - 3}px`;
        marker.style.top = `${y - 3}px`;
        marker.style.width = `${width + 6}px`;
        marker.style.height = `${height + 6}px`;

        if (reveal) {
            const scrollBounds = scroll.getBoundingClientRect();
            const markerCenterX = pageElementBounds.left + x + width / 2;
            const markerCenterY = pageElementBounds.top + y + height / 2;
            if (markerCenterX < scrollBounds.left || markerCenterX > scrollBounds.right) {
                scroll.scrollLeft += markerCenterX - scrollBounds.left - scroll.clientWidth / 2;
            }
            if (markerCenterY < scrollBounds.top || markerCenterY > scrollBounds.bottom) {
                scroll.scrollTop += markerCenterY - scrollBounds.top - scroll.clientHeight / 2;
            }
        }
    }

    function clearPendingSourceClick() {
        window.clearTimeout(pendingSourceClickTimer);
        pendingSourceClickTimer = void 0;
        pendingSourceClick = null;
    }

    function invalidateNavigation() {
        clearPendingSourceClick();
        navigation = null;
        navigationStale = true;
        clearFocus();
        playbackScoreTime = null;
        clearPlaybackCursor();
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
        const centerY = region.y + region.h / 2;
        const pageIndex = pageBounds.findIndex(page => centerY >= page.y && centerY <= page.y + page.h);
        const pageRect = pageBounds[pageIndex];
        const page = host.children[pageIndex];
        if (!pageRect || !(page instanceof HTMLElement)) return;
        const surface = virtualPages.ensure(pageIndex);
        const overlay = page.querySelector<HTMLElement>(":scope > .preview-overlay");
        if (!surface || !overlay) return;

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
        if (!result || navigationStale) return;
        const character = result.maskedSource[position];
        if (!character || /\s/.test(character)) return;
        const currentNavigation = getNavigation();
        if (!currentNavigation) return;
        const target = sourceTargetAt(currentNavigation, position);
        const region = target?.regions[0];
        if (region) focusRegion(region, true);
    }

    function renderActiveBackend() {
        if (!result) return;
        virtualPages.redraw();
        playbackRegionKey = "";
        renderPlaybackCursor(false);
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
        virtualPages.resize(zoom, activeBackend === "canvas");
        restoreZoomAnchor(savedAnchor, anchor);
        playbackRegionKey = "";
        renderPlaybackCursor(false);
    }

    function fitWidth() {
        fitToWidth = true;
        if (!result || scroll.clientWidth <= 0) {
            updateZoomLabel();
            return;
        }
        const width = Math.max(...pageBounds.map(bounds => bounds.w), 1);
        setZoom(scroll.clientWidth / width);
    }

    function preparePrint() {
        clearPrint();
        document.body.classList.add("print-ready");
        if (!result) return;
        const [paper] = pageBounds;
        printHost.replaceChildren(...recordedPages.map(createSvgPage));
        printStyle.textContent = `@media print { @page { size: ${paper.w}px ${paper.h}px; margin: 0; } }`;
    }

    function clearPrint() {
        document.body.classList.remove("print-ready");
        printStyle.textContent = "";
        printHost.replaceChildren();
    }

    async function download(format: ImageExportFormat, ppi: number) {
        if (!result) throw new Error("当前没有可导出的谱面");
        if (format === "svg") {
            for (const [index, page] of recordedPages.entries()) {
                savePage(
                    new Blob([recordedPageToSvg(page)], { type: "image/svg+xml;charset=utf-8" }),
                    format,
                    index,
                    recordedPages.length,
                );
            }
            return;
        }

        await downloadBitmapPages(recordedPages, format, ppi);
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
        if (!result || navigationStale || event.button !== 0) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const page = target.closest<HTMLElement>(".preview-page");
        if (!page || page.parentElement !== host) return;
        const pageIndex = [...host.children].indexOf(page);
        const bounds = pageBounds[pageIndex];
        const surface = page.querySelector<SVGSVGElement | HTMLCanvasElement>(":scope > svg, :scope > canvas");
        const currentNavigation = getNavigation();
        if (!bounds || !surface || !currentNavigation) return;
        const surfaceBounds = surfaceContentBounds(surface);
        const x = bounds.x + (event.clientX - surfaceBounds.left) / surfaceBounds.width * bounds.w;
        const y = bounds.y + (event.clientY - surfaceBounds.top) / surfaceBounds.height * bounds.h;
        const tolerance = HIT_TOLERANCE * Math.max(
            bounds.w / surfaceBounds.width,
            bounds.h / surfaceBounds.height,
        );
        if (options.isPlaybackActive()) {
            clearPendingSourceClick();
            const scoreTime = playbackTimeAt(currentNavigation, x, y, tolerance);
            if (scoreTime === null) return;
            event.preventDefault();
            options.onSeekPlayback(scoreTime);
            return;
        }
        const hit = previewHitAt(currentNavigation, x, y, tolerance);
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
            recordedPages = recordLayoutPages(compiled.layout);
            pageBounds = recordedPages.map(page => page.bounds);
            navigation = null;
            navigationStale = false;
            virtualPages.reset(pageBounds, zoom);
            playbackRegionKey = "";
            if (fitToWidth) fitWidth();
            renderPlaybackCursor(false);
        },
        showError(message) {
            invalidateNavigation();
            result = null;   // 否则缩放会把过期谱面重新画回来
            pageBounds = [];
            recordedPages = [];
            virtualPages.clear();
            clearPrint();
            const text = document.createElement("pre");
            text.className = "preview-error";
            text.textContent = message;
            host.replaceChildren(text);
        },
        invalidateNavigation,
        focusSourcePosition,
        showPlaybackPosition(scoreTime) {
            playbackScoreTime = scoreTime;
            renderPlaybackCursor(true);
        },
        download,
        preparePrint,
        clearPrint,
    };
}