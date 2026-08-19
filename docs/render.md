# 渲染后端
渲染阶段只消费已经完成布局的对象。它不重新测量、不改变 `LayoutBox`，也不参与时间计算。

## Painter 接口
所有后端实现同一个扁平接口：
```ts
interface Painter {
    drawText(text: string, x: number, y: number, style: TextStyle): void;
    drawLine(x1: number, y1: number, x2: number, y2: number, style?: PaintStyle): void;
    drawRect(x: number, y: number, w: number, h: number, style?: PaintStyle): void;
    drawCircle(cx: number, cy: number, r: number, style?: PaintStyle): void;
    drawPath(commands: readonly PathCommand[], style?: PaintStyle, transform?: PathTransform): void;
}
```

函数只调用这些命令，不导入任何具体后端。新增函数不需要修改 SVG 或 Canvas renderer；新增 renderer 也不需要识别 note、up、tie 等函数类。

## 图形与文本测量
固定图形和任意文本采用不同路径：
- 数字音符和休止符通过 `drawText` 使用正常的等宽字体居中绘制
- 升降号等固定轮廓由所属函数保存局部 `PathCommand`，通过 `drawPath` 绘制
- 歌词、声部名和 `@text` 同样通过 `drawText` 绘制
- `TextMeasurer` 只负责文本的宽、高和 baseline；默认实现保持确定性
- 固定图形的尺寸和路径放在所属函数目录，例如 note 的升降号位于 `packages/jpfun/src/functions/note/accidentals.ts`

带 `PathTransform` 的路径使用局部坐标；transform 只改变几何位置和尺寸，`strokeWidth` 始终是最终布局像素。无 transform 的路径使用绝对布局坐标，适合 tie 等动态几何。

## 未来：音乐字体
当前升降号使用 note 私有的手写路径。未来可以引入 Bravura 等 SMuFL 音乐字体，但音乐字体应作为**度量与轮廓资源**接入，而不是成为新的 Painter 命令或 render 全局符号注册表。

推荐流程：
1. `MusicFont` 根据 SMuFL 名称读取 glyph 的 advance、bounding box、anchors 和轮廓
2. 具体函数决定使用哪个 glyph，以及它在自身布局中的尺寸和位置
3. prepare 阶段使用字体度量生成 `LayoutBox`
4. paint 阶段把字体轮廓转换为局部 `PathCommand`，继续调用通用 `drawPath`
5. SVG 把变换烘焙为最终坐标并直接输出路径，Canvas 绘制同一份路径

这样 Painter 和后端仍不理解 SMuFL 或具体音乐符号，图形所有权仍在函数中。可以先用 Bravura 替换升降号验证度量、路径方向和 anchor，再逐步扩展其他符号。

直接把 SMuFL 私用区字符交给 `drawText` 只适合快速原型：它依赖目标环境安装或嵌入字体，还要求字体加载完成后重新测量，并且 SVG/Canvas 的 baseline 与导出可移植性更难保证。稳定导出优先采用“字体轮廓转路径”。本方向目前尚未实现。

## 内置后端

### SVG
`renderLayoutToSvg` 返回完整 SVG 字符串。所有路径都直接输出 `<path>`；带 transform 的局部路径会先换算成最终坐标，不保留 SVG transform，也不生成 `<defs>/<use>`。这让每个实例具有稳定、独立的 DOM 节点，便于调试以及未来挂载源码位置等交互信息。数字音符使用带 `text-anchor="middle"` 的等宽 `<text>`。

### Canvas
`CanvasPainter` 直接执行结构化路径和可选变换，数字使用 `textAlign="center"` 的等宽文本。调用方负责配置 canvas 像素尺寸、CSS 尺寸和 devicePixelRatio，Painter 只执行绘制。

### Recording
`RecordingPainter` 不产生图像，只记录应用平移后的最终绘制命令。它用于测试、自定义导出、调试和第三方后端的契约验证。

## 绘制顺序
`paintLayout` 使用固定层级：
1. 绘制 `background` attachment，例如 box
2. 绘制 Temporal 对象及 dot/div 装饰
3. 绘制 `foreground` attachment，例如 tie、beam 和歌词

`up` 在 `paint` 中依次绘制自己的每个堆叠成员及其装饰；成员不在 `DocumentLayoutResult.objects` 中，因此不会被引擎重复绘制。

## 默认流水线
```ts
import {
    compileScore,
    renderLayoutToSvg,
} from "jpfun";

const compiled = compileScore(`
@page(width=794px, height=1123px, gap=1em)
1 2 3 | 4
`, {
    fontSize: 16,
});

const svg = renderLayoutToSvg(compiled.layout, {
    padding: 8,
    background: "#fff",
});
```

`compileScore` 返回行索引、parser、AST、LoweringResult 和最终布局。预处理源码已经保存在 `parser.source`，不重复出现在结果顶层。编辑器、播放器和 renderer 可以各取所需阶段，不必重新解析。

## 自定义后端
第三方后端只需要实现 `Painter`。推荐先把同一份布局同时交给 `RecordingPainter` 和自定义 Painter，比较命令数量、类型和坐标是否一致。自定义后端不得在绘制阶段改变布局尺寸。