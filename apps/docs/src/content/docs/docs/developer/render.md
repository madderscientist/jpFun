---
title: 渲染后端
description: 最终几何的只读绘制、Painter 协议与字体测量边界。
sidebar:
    order: 6
---
渲染将最终布局转换为后端绘制命令，此时输入中的尺寸、坐标和分页均已确定。

SVG 和 Canvas 实现同一绘制协议，共用布局结果。公共调用示例见[在项目中使用](../use/)，本文说明几何、绘制协议和后端之间的契约。

## 几何与绘制协议

绘制分为三个职责层次：

| 层次 | 职责 |
| --- | --- |
| 符号与附属对象 | 根据最终几何发出文本、线段和路径等绘制命令 |
| 绘制调度 | 决定图层顺序，将命令分配到页面并转换页面原点 |
| `Painter` 后端 | 将通用命令写成 SVG、执行 Canvas API，或记录为命令数据 |

坐标以布局 px 为单位。设备像素比、显示缩放和容器尺寸属于宿主；它们不会改变乐谱的布局坐标。因而同一份布局可以多次绘制，也可以在不同后端之间复用。

文本测量虽然与后端和字体有关，但发生在布局之前。需要改变字体度量时必须重新编译，不能由 Painter 在绘制阶段修正尺寸。

## Painter 接口
所有后端都实现下面这组基本绘图操作：
```ts
interface Painter {
    drawText(text: string, x: number, y: number, style: TextStyle): void;
    drawLine(x1: number, y1: number, x2: number, y2: number, style?: PaintStyle): void;
    drawRect(x: number, y: number, w: number, h: number, style?: PaintStyle): void;
    drawCircle(cx: number, cy: number, r: number, style?: PaintStyle): void;
    drawPath(commands: readonly PathCommand[], style?: PaintStyle, transform?: PathTransform): void;
    beginGroup?(group: PaintGroup): void;
    endGroup?(): void;
}

interface PaintGroup {
    readonly kind: string;
}
```

`beginGroup`/`endGroup` 是可选的，用于标出[语义分组](#语义分组)的边界。不需要分组的后端可以不实现，例如 `CanvasPainter`，绘制结果不受影响。

具体函数通过这些命令绘制自身，不直接导入某个后端。因此，新增函数时不需要修改 SVG 或 Canvas 后端；新增后端时，也不需要逐个识别 note、up、tie 等函数类。

## 分页输出与内置后端

`renderLayoutPagesToSvg` 返回 SVG 字符串数组，每个元素对应布局结果中的一页。无限高文档也会生成一个自然高度的页面，单页和多页使用同一套 API。

Canvas 对应的入口是 `renderLayoutPagesToCanvas`。调用方准备每页的 canvas，并配置像素尺寸、CSS 尺寸和 `devicePixelRatio`；API 将全局布局坐标平移到各页原点。

两个入口均沿用布局阶段的分页结果。[`render/paint.ts`](https://github.com/madderscientist/jpFun/blob/HEAD/packages/jpfun/src/render/paint.ts) 在 Painter 命令层将绘制命令分配到各页，不为每页复制整篇绘制结果，跨页 attachment 也使用这一机制。

| 后端 | 输出与实现特点 |
| --- | --- |
| `SvgPainter` | 路径输出为独立的 `<path>`；局部 transform 换算为最终坐标，不生成 `<defs>/<use>`；分组输出为 `<g data-kind>`，并删除空组 |
| `CanvasPainter` | 在调用方提供的画布上执行绘制命令，支持结构化路径和可选变换；忽略分组 |
| `RecordingPainter` | 记录平移后的最终绘制命令和分组边界，用于测试、调试或自定义导出；`replay` 按原顺序转发给另一个 Painter |

`RecordedPaintCommand` 除五种图元外，还包含 `{ kind: "begin-group"; group: PaintGroup }` 和 `{ kind: "end-group" }`，只关心图元时可将其过滤掉。

数字音符默认使用等宽文本居中绘制，SVG 使用 `text-anchor="middle"`，Canvas 使用 `textAlign="center"`。后端不依赖解析器实例，只消费 `compileScore` 返回的 `layout`。

## 图形与文本测量
文本和固定图形分别处理。数字音符、休止符、歌词、声部名以及 `@text` 都通过 `drawText` 绘制，其中数字音符和休止符使用等宽字体居中显示。

文本尺寸由 `TextMeasurer` 提供，包括宽、高和 baseline。默认实现的结果是确定的，不依赖运行环境中的字体测量。

需要匹配宿主字体的真实宽度时，传入 `CanvasTextMeasurer`。具体函数在解析期固化 font/fontSize，在测量和绘制中使用相同 TextStyle；Canvas 测量和绘制共用字体字符串生成规则。默认数字字体可由 numberfont 或函数 font 参数覆盖，普通文字使用 font 类别设置。

Web 字体由宿主通过 CSS/FontFace 加载，不由 jpFun 下载。下面假设宿主已经声明了 ScoreText 字体，并复用同一个测量器：

```ts
await document.fonts.load('16px "ScoreText"');
textMeasurer.clearCache();
const compiled = compileScore(source, { textMeasurer });
```

等待实际使用的字体和字重全部可用后清缓存，再绘制 `compiled.layout`。清缓存使旧的回退字体宽度失效；仅重绘旧 layout 不会重测。SVG 显示端也必须能访问相同字体。测量器仍保留 em 高度与 baseline 约定，不改用平台墨迹包围盒。

升降号等固定图形则由所属函数保存尺寸和局部 `PathCommand`，再通过 `drawPath` 绘制。例如，note 的升降号定义在 `packages/jpfun/src/functions/note/accidentals.ts`。

路径有两种坐标用法：
- 带 `PathTransform` 时，使用局部坐标。变换只影响位置和尺寸，`strokeWidth` 始终按最终布局像素计算。
- 不带 transform 时，直接使用绝对布局坐标，适合 tie 这类根据端点生成的动态路径。

## 绘制顺序
`paintLayout` 按以下顺序绘制，后画的内容覆盖在前面的内容之上：
1. `background` attachment，例如 box。
2. Temporal 对象及其装饰，例如附点、减时线和上下八度点。每个对象由 `paintVisual(painter, node)` 绘制：先开组，再画主体和装饰，最后闭组。
3. `foreground` attachment，例如 tie、beam 和歌词。

装饰按 `decorations` 的注册顺序绘制，不按上下空间的 `order` 重新排序。省略 `paint` 的装饰只预留布局空间，不产生绘制命令；外框留白和实际边框的绘制职责分别由装饰空间与 background attachment 承担。

`up`、`down`、`grace`、`arp` 等容器在自己的 `paint` 中对每个成员调用 `paintVisual`，因此成员连同装饰一起绘制，成员的组嵌套在容器的组内。这些成员不在 `DocumentLayoutResult.objects` 中，所以引擎不会再画一遍。自定义容器绘制成员时也应调用 `paintVisual`，而不是直接调用成员的 `paint`，否则成员的装饰和分组都会丢失。

## 语义分组
每个可见的时值对象、每个 attachment 在绘制时各包一层分组，`SvgPainter` 把它输出为 `<g data-kind="…">`。宿主可以用 CSS 选择器或 DOM 查询按类型选中图形，例如 `g[data-kind="tie"]` 选中所有连音线。

kind 的来源：
- 时值对象读取 `node.kind`。`TemporalNodeBase` 默认返回来源函数的主名（`ASTFunctionNode.callName`），因此语法糖和别名不影响结果：`1 ^ 3` 与 `@up(1, 3)` 都是 `up`，`2>1` 是 `grace`，`@arpeggio` 是 `arp`。同一个函数生成画法不同的对象时，子类可以覆盖这个 getter。返回空串表示不开组。
- attachment 读取 `LayoutAttachment.kind`，由实现可选声明，布局后原样复制到 `PlacedAttachment.kind`；缺省或空串表示不开组。`@adjust` 等包装只改变几何，不改变 kind。

内置函数的取值如下：

| 类别 | kind |
| --- | --- |
| 时值对象（叶子） | `note`、`rest`、`dash`、`bar`、`meter`、`key`、`tempo`、`text`、`symbol`、`voice` |
| 时值对象（容器） | `up`、`down`、`grace`、`arp` |
| attachment | `tie`、`beam`、`box`、`dyn`、`gliss`、`ottava`、`slide`、`tremolo`、`tuplet`、`volta`、`voices`、`lyrics`、`bar-number`、`page-number` |

叶子对象和 attachment 的 kind 各对应一种图形；容器 kind 的组包含成员的组，以及容器自己画的图形。`up`、`down` 组里是各成员的组；`grace` 组里依次是宿主、倚音和钩线；`arp` 组里是波浪线和宿主。例如 `2>1` 输出为：

```xml
<g data-kind="grace">
    <g data-kind="note"><text>1</text></g>          <!-- 宿主 -->
    <g data-kind="note"><text>2</text><line /></g>  <!-- 倚音 -->
    <path />                                         <!-- 钩线 -->
</g>
```

因此 `g[data-kind="note"]` 也会选中容器里的音符；只要顶层对象时可以写 `svg > g[data-kind="note"]`。

分组与分页约定：
- 附点、八度点和未相连的减时线等装饰画在所属对象的组内；相连的减时线由 beam 绘制在 `beam` 组内，装饰自身不单独开组。
- 歌词每个声部一个 `lyrics` 组；小节号和页码各为全文一个 attachment，在有内容的页面各输出一个 `bar-number` 或 `page-number` 组。
- 分组不带 transform，组内图元保持最终布局坐标。
- 跨页对象在每页各输出一个同 kind 的组；`paintLayoutPages` 只在某页实际收到图元时补开分组，`SvgPainter` 也会在 `endGroup` 时剔除空组（如占位音符 `8`）。

## 自定义后端
接入第三方绘图库时，实现 `Painter` 即可。需要保留语义分组时再实现 `beginGroup`/`endGroup`；调用总是成对且正确嵌套，分页时每页各自成对。可以先把同一份布局分别交给 `RecordingPainter` 和新后端，对照命令数量、类型和坐标，检查是否有遗漏或坐标转换错误。

后端只读布局结果。尺寸调整统一在布局阶段处理。
