/**
 * 字形的排版度量
 *
 * 这里的坐标都位于字形自己的局部坐标系中
 * 不依赖 SVG text 或 Canvas 字体测量结果
 */
export interface GlyphMetrics {
    w: number;          // 字形实际占用宽度
    h: number;          // 字形实际占用高度
    baseline: number;   // 纵向基线到字形上边界的距离
}

/**
 * 通用绘制样式
 *
 * fill 和 stroke 都为空时由具体后端选择默认值
 */
export interface PaintStyle {
    fill?: string;          // 填充颜色，不设置时由命令选择默认值
    stroke?: string;        // 描边颜色，不设置时不描边或使用命令默认值
    strokeWidth?: number;   // 描边宽度，单位为布局坐标像素
    opacity?: number;       // 整体透明度，范围为 0 到 1
}

/**
 * 任意文本的排版样式
 *
 * 固定乐谱符号应优先使用 glyph
 * text 主要用于歌词、标题和用户输入的任意文本
 */
export interface TextStyle {
    fontSize: number;        // 字号，单位为布局坐标像素
    fontFamily?: string;     // Painter 原样使用的字体族列表
    fontWeight?: string | number; // CSS 或 Canvas 可接受的字重
    textAlign?: "left" | "center" | "right"; // x 坐标对应文本的哪一侧
    fill?: string;
    opacity?: number;
}

/**
 * 通用路径命令
 *
 * 使用结构化命令而不是 SVG path 字符串
 * 这样 Canvas 和 SVG 后端都可以直接消费
 */
export type PathCommand =
    | { op: "M" | "L"; x: number; y: number }
    | { op: "Q"; cx: number; cy: number; x: number; y: number }
    | { op: "C"; cx1: number; cy1: number; cx2: number; cy2: number; x: number; y: number }
    | { op: "Z" };

export interface TextMeasurer {
    measureText(text: string, style: TextStyle): GlyphMetrics;
}

/** 把局部路径放置到最终布局坐标；线宽仍使用最终布局像素 */
export interface PathTransform {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
}

/**
 * 所有渲染后端必须实现的最小绘制接口
 *
 * 函数节点只描述要画的 glyph、路径和基础图形
 * 不直接访问 SVGElement 或 CanvasRenderingContext2D
 */
export interface Painter {
    drawText(text: string, x: number, y: number, style: TextStyle): void;
    drawLine(x1: number, y1: number, x2: number, y2: number, style?: PaintStyle): void;
    drawRect(x: number, y: number, w: number, h: number, style?: PaintStyle): void;
    drawCircle(cx: number, cy: number, r: number, style?: PaintStyle): void;
    drawPath(commands: readonly PathCommand[], style?: PaintStyle, transform?: PathTransform): void;
}