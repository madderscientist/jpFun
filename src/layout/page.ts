import type { Rect, PageConfig } from "./types.js";

/** 全局坐标中的页面边界与所含谱面行范围 */
export interface DocumentLayoutPage {
    bounds: Rect;
    lineStart: number;  // 包含
    lineEnd: number;    // 不包含
}

/** 单条谱面行高于页面内容区时传给 engine 的结构化信号 */
export class PageLayoutError extends Error {
    readonly line: number;
    readonly requiredHeight: number;
    readonly availableHeight: number;

    constructor(line: number, requiredHeight: number, availableHeight: number) {
        super(`Page cannot fit layout line ${line}: requires ${requiredHeight}px, available ${availableHeight}px`);
        this.name = "PageLayoutError";
        this.line = line;
        this.requiredHeight = requiredHeight;
        this.availableHeight = availableHeight;
    }
}

/** 没有 page 函数时使用的默认 A4 近似页面配置 */
export const DEFAULT_PAGE_CONFIG: Readonly<PageConfig> = {
    width: 794,
    height: Infinity,
    marginTop: 45,
    marginBottom: 48,
    marginLeft: 40,
    marginRight: 40,
    lineGap: 22,
};

/**
 * 补齐页面配置并保证返回值可直接用于布局
 */
export function normalizePageConfig(source: Partial<PageConfig> = {}): PageConfig {
    const height = source.height ?? DEFAULT_PAGE_CONFIG.height;
    const page = {
        width: source.width ?? DEFAULT_PAGE_CONFIG.width,
        height: height <= 0 ? Infinity : height,
        marginTop: Math.max(0, source.marginTop ?? DEFAULT_PAGE_CONFIG.marginTop),
        marginBottom: Math.max(0, source.marginBottom ?? DEFAULT_PAGE_CONFIG.marginBottom),
        marginLeft: Math.max(0, source.marginLeft ?? DEFAULT_PAGE_CONFIG.marginLeft),
        marginRight: Math.max(0, source.marginRight ?? DEFAULT_PAGE_CONFIG.marginRight),
        lineGap: Math.max(0, source.lineGap ?? DEFAULT_PAGE_CONFIG.lineGap),
    };

    if (!Number.isFinite(page.width) || page.width <= 0) {
        throw new Error(`Page width must be a positive finite number, got ${page.width}`);
    }
    if (page.height !== Infinity && (!Number.isFinite(page.height) || page.height <= 0)) {
        throw new Error(`Page height must be positive or Infinity, got ${page.height}`);
    }

    const values = [
        page.marginTop,
        page.marginBottom,
        page.marginLeft,
        page.marginRight,
        page.lineGap,
    ];
    if (values.some(value => !Number.isFinite(value) || value < 0)) {
        throw new Error("Page margins and line gap must be finite non-negative numbers");
    }

    const contentWidth = page.width - page.marginLeft - page.marginRight;
    if (contentWidth <= 0) {
        throw new Error(`Page horizontal margins leave no content width: ${contentWidth}px`);
    }

    const contentHeight = page.height - page.marginTop - page.marginBottom;
    if (Number.isFinite(page.height) && contentHeight <= 0) {
        throw new Error(`Page vertical margins leave no content height: ${contentHeight}px`);
    }
    return page;
}

/**
 * 把已经测好自然高度的谱面行分页，并给出每行的全局顶部坐标
 */
export function paginateLayoutLines(
    heights: readonly number[],
    page: PageConfig,
): { pages: DocumentLayoutPage[]; lineTops: number[] } {
    const availableHeight = page.height - page.marginTop - page.marginBottom;
    const pages: DocumentLayoutPage[] = [];
    const lineTops = new Array<number>(heights.length).fill(0);
    let pageTop = 0;
    let start = 0;
    // used 含最小行距，用于判断下一行能否装入；contentHeight 不含行距，用于封页后拉伸
    let used = 0;
    let contentHeight = 0;

    /** 写出 [start, end) 这一页；完整页拉伸行距，末页保留最小行距 */
    const closePage = (end: number, justify: boolean) => {
        const count = end - start;
        const gap = justify && count > 1
            ? (availableHeight - contentHeight) / (count - 1)
            : page.lineGap;
        let lineTop = pageTop + page.marginTop;

        for (let i = start; i < end; i++) {
            lineTops[i] = lineTop;
            lineTop += heights[i] + (i + 1 < end ? gap : 0);
        }

        const height = Number.isFinite(page.height)
            ? page.height
            // 无限高配置只生成自然高度页面，不把 Infinity 写入布局结果
            : lineTop - pageTop + page.marginBottom;
        pages.push({
            bounds: {
                x: 0,
                y: pageTop,
                w: page.width,
                h: height,
            },
            lineStart: start,
            lineEnd: end,
        });
        pageTop += height;
        start = end;
        used = 0;
        contentHeight = 0;
    };

    for (let i = 0; i < heights.length; i++) {
        const height = heights[i];
        if (Number.isFinite(page.height) && height > availableHeight + 1e-6) {
            throw new PageLayoutError(i, height, availableHeight);
        }

        // 当前行放不下时先封口已有内容；每页因此至少包含一行
        if (Number.isFinite(page.height) && i > start && used + page.lineGap + height > availableHeight + 1e-6) {
            closePage(i, true);
        }
        used += (i > start ? page.lineGap : 0) + height;
        contentHeight += height;
    }

    if (heights.length > start) closePage(heights.length, false);
    return { pages, lineTops };
}