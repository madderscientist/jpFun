import type { Rect } from "jpfun";

type PageSurface = SVGSVGElement | HTMLCanvasElement;

interface VirtualPageOptions {
    renderPage(index: number): PageSurface;
    onError(error: unknown): void;
}

/** 页面占位始终存在；只有视口及其上下缓冲区保留绘图表面 */
export function createVirtualPages(host: HTMLElement, scroll: HTMLElement, options: VirtualPageOptions) {
    let bounds: readonly Rect[] = [];
    let pages: HTMLElement[] = [];
    let zoom = 1;
    let observer: IntersectionObserver | undefined;
    let frame: number | undefined;
    const visible = new Set<number>();
    const mounted = new Map<number, PageSurface>();

    function release(index: number) {
        const surface = mounted.get(index);
        if (!surface) return;
        surface.remove();
        if (surface instanceof HTMLCanvasElement) {
            surface.width = 1;
            surface.height = 1;
        }
        mounted.delete(index);
    }

    function ensure(index: number) {
        const page = pages[index];
        if (!page) return null;
        const existing = mounted.get(index);
        if (existing) return existing;
        const surface = options.renderPage(index);
        surface.style.width = `${bounds[index].w * zoom}px`;
        surface.style.height = `${bounds[index].h * zoom}px`;
        page.prepend(surface);
        mounted.set(index, surface);
        // 源码或播放定位可以临时绘制离屏页；滚动后由 observer 接管其生命周期
        if (!visible.has(index)) schedule();
        return surface;
    }

    function redraw() {
        for (const index of mounted.keys()) release(index);
        schedule();
    }

    function schedule() {
        if (frame !== undefined) return;
        frame = window.requestAnimationFrame(() => {
            frame = undefined;
            try {
                for (const index of mounted.keys()) {
                    if (!visible.has(index)) release(index);
                }
                for (const index of visible) ensure(index);
            } catch (error) {
                options.onError(error);
            }
        });
    }

    function clear() {
        observer?.disconnect();
        observer = undefined;
        window.cancelAnimationFrame(frame ?? 0);
        frame = undefined;
        visible.clear();
        for (const index of mounted.keys()) release(index);
        pages = [];
        bounds = [];
        host.replaceChildren();
    }

    function resize(value: number, repaint = false) {
        zoom = value;
        for (const [index, page] of pages.entries()) {
            page.style.width = `${bounds[index].w * zoom}px`;
            page.style.height = `${bounds[index].h * zoom}px`;
        }
        if (repaint) {
            redraw();
        } else {
            for (const [index, surface] of mounted) {
                surface.style.width = `${bounds[index].w * zoom}px`;
                surface.style.height = `${bounds[index].h * zoom}px`;
            }
        }
    }

    return {
        reset(nextBounds: readonly Rect[], value: number) {
            clear();
            bounds = nextBounds;
            pages = bounds.map(() => {
                const page = document.createElement("div");
                page.className = "preview-page";
                const overlay = document.createElement("div");
                overlay.className = "preview-overlay";
                page.append(overlay);
                return page;
            });
            host.replaceChildren(...pages);
            resize(value);
            const indexes = new Map<Element, number>(pages.map((page, index) => [page, index]));
            const current = new IntersectionObserver(entries => {
                if (observer !== current) return;
                for (const entry of entries) {
                    const index = indexes.get(entry.target);
                    if (index === undefined) continue;
                    if (entry.isIntersecting) visible.add(index);
                    else visible.delete(index);
                }
                schedule();
            }, { root: scroll, rootMargin: "600px 0px" });
            observer = current;
            for (const page of pages) observer.observe(page);
        },
        ensure,
        resize,
        redraw,
        clear,
    };
}
