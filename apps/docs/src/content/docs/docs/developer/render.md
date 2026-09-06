---
title: 渲染后端
sidebar:
  order: 5
---
布局决定每个对象放在哪里，渲染负责把它们画出来。进入这一阶段时，尺寸和位置都已经确定，后端不需要重新测量、修改 `LayoutBox`，也不参与时间计算。

如果只是要输出谱面，直接使用下面的分页 API。需要接入新的绘图库时，再实现 `Painter` 接口。

## 输出谱面
```ts
import {
    compileScore,
    renderLayoutPagesToSvg,
} from "jpfun";

const compiled = compileScore(`
@page(width=794px, height=1123px, gap=1em)
1 2 3 | 4
`, {
    fontSize: 16,
});

const pages = renderLayoutPagesToSvg(compiled.layout, {
    padding: 8,
    background: "#fff",
});
```

`renderLayoutPagesToSvg` 返回 SVG 字符串数组，每个元素对应布局结果中的一页。无限高文档也会生成一个自然高度的页面，因此单页和多页使用同一套 API。

Canvas 对应的入口是 `renderLayoutPagesToCanvas`。调用方准备每页的 canvas，并配置像素尺寸、CSS 尺寸和 `devicePixelRatio`；API 会把全局布局坐标平移到各页原点。

这两个入口都沿用布局阶段的分页结果，不会重新分页。`render/paint.ts` 在 Painter 命令层把绘制命令分配到各页，因此不需要为每页复制整篇绘制结果，跨页 attachment 也走同一条路径。

`compileScore` 同时返回行索引、parser、AST、LoweringResult 和最终布局。编辑器、播放器和渲染后端可以各取所需，不必重新解析。预处理后的源码在 `parser.source` 中，结果顶层不会再存一份。

## 内置后端

### SVG
`SvgPainter` 将路径直接输出为 `<path>`。如果路径带有 transform，会先将局部坐标换算成最终坐标，不保留 SVG transform，也不生成 `<defs>/<use>`。

每个图形实例因此都有独立的 DOM 节点，方便调试，也为以后关联源码位置等交互信息留出空间。数字音符使用等宽 `<text>`，通过 `text-anchor="middle"` 居中。

### Canvas
`CanvasPainter` 在调用方提供的画布上执行绘制命令，支持结构化路径和可选变换。数字同样使用等宽字体，通过 `textAlign="center"` 居中。画布尺寸和 `devicePixelRatio` 由调用方管理，Painter 只负责绘制。

### Recording
`RecordingPainter` 不生成图像，而是记录平移后的最终绘制命令。测试、调试和自定义导出都可以用它；实现新后端时，也可以拿它的输出作对照。

## Painter 接口
所有后端都实现下面这组基本绘图操作：
```ts
interface Painter {
    drawText(text: string, x: number, y: number, style: TextStyle): void;
    drawLine(x1: number, y1: number, x2: number, y2: number, style?: PaintStyle): void;
    drawRect(x: number, y: number, w: number, h: number, style?: PaintStyle): void;
    drawCircle(cx: number, cy: number, r: number, style?: PaintStyle): void;
    drawPath(commands: readonly PathCommand[], style?: PaintStyle, transform?: PathTransform): void;
}
```

具体函数通过这些命令绘制自身，不直接导入某个后端。因此，新增函数时不需要修改 SVG 或 Canvas 后端；新增后端时，也不需要逐个识别 note、up、tie 等函数类。

## 图形与文本测量
文本和固定图形分别处理。数字音符、休止符、歌词、声部名以及 `@text` 都通过 `drawText` 绘制，其中数字音符和休止符使用等宽字体居中显示。

文本尺寸由 `TextMeasurer` 提供，包括宽、高和 baseline。默认实现的结果是确定的，不依赖运行环境中的字体测量。

升降号等固定图形则由所属函数保存尺寸和局部 `PathCommand`，再通过 `drawPath` 绘制。例如，note 的升降号定义在 `packages/jpfun/src/functions/note/accidentals.ts`。

路径有两种坐标用法：
- 带 `PathTransform` 时，使用局部坐标。变换只影响位置和尺寸，`strokeWidth` 始终按最终布局像素计算。
- 不带 transform 时，直接使用绝对布局坐标，适合 tie 这类根据端点生成的动态路径。

## 绘制顺序
`paintLayout` 按以下顺序绘制，后画的内容覆盖在前面的内容之上：
1. `background` attachment，例如 box。
2. Temporal 对象及 dot/div 装饰。
3. `foreground` attachment，例如 tie、beam 和歌词。

`up` 会在自己的 `paint` 中依次绘制堆叠成员及其装饰。这些成员不在 `DocumentLayoutResult.objects` 中，所以引擎不会再画一遍。

## 自定义后端
接入第三方绘图库时，实现 `Painter` 即可。可以先把同一份布局分别交给 `RecordingPainter` 和新后端，对照命令数量、类型和坐标，检查是否有遗漏或坐标转换错误。

后端应当保持布局结果不变。如果需要调整尺寸，请在布局阶段处理，而不是在绘制时改写布局。

## 后续方向：音乐字体
这一部分是尚未实现的设计方向。当前升降号使用 note 内部的手写路径，将来可以改用 Bravura 等 SMuFL 音乐字体提供度量和轮廓。

接入时可以沿用现有的绘图接口，不必新增 Painter 命令或在 render 中建立全局符号注册表：
1. 由 `MusicFont` 根据 SMuFL 名称读取 glyph 的 advance、bounding box、anchors 和轮廓。
2. 具体函数选择 glyph，并决定它在自身布局中的尺寸和位置。
3. prepare 阶段用字体度量生成 `LayoutBox`。
4. paint 阶段将轮廓转换为局部 `PathCommand`，调用通用的 `drawPath`。
5. SVG 将变换换算为最终路径坐标，Canvas 绘制同一份路径。

这样，符号的选择和布局仍由具体函数负责，Painter 和后端不需要了解 SMuFL。可以先替换升降号，验证度量、路径方向和 anchor，再扩展到其他符号。

另一种办法是直接把 SMuFL 私用区字符交给 `drawText`，但它更适合快速原型：目标环境必须安装或嵌入字体，字体加载后还要重新测量，SVG 与 Canvas 的 baseline 和导出可移植性也更难保持一致。需要稳定导出时，优先考虑将字体轮廓转成路径。