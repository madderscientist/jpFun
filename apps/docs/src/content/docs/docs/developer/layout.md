---
title: 简谱布局
sidebar:
  order: 4
---

布局将 Lowering 生成的时间列和音轨结构转换成页面坐标。它先测量对象，再求解横向间距和纵向位置，最后分页，并生成附属对象的几何。

本文前半部分介绍布局流程和扩展接口，后半部分说明横向间距使用的弹簧模型。

## LayoutBox 与对齐基准

每个可见 Temporal 都有一个 `LayoutBox`，其中 `x/y/w/h` 表示位置和尺寸，另外两个字段用于对齐：
- `anchor`：横向对齐点到盒子左边界的距离，全局对齐点为 `x + anchor`。
- `visualAxis`：轨道视觉轴到盒子顶部的距离，全局视觉轴为 `y + visualAxis`。

`prepareLayout` 填写固有尺寸和对齐基准，即 `w/h/anchor/visualAxis`；布局器随后写入 `x/y`。字号在解析时已经换算为 AST 上的 px 值，布局阶段直接读取。

`layoutDocument` 会修改 Temporal 和弹簧配置，所以一份 `LoweringResult` 只支持布局一次。需要重新布局时，请从 AST 重新执行 Lowering。

## 布局阶段

`layoutDocument` 按以下顺序执行：

1. 按 `layoutLine` 切行，调用 `prepareLayout`，生成固有尺寸、端口和装饰；
2. 排列下方装饰，调用 `finalizeLayout`；
3. 补齐 spring config，调用主体和 attachment 的 `prepareHorizontal`；
4. 每行独立进行横向求解，写回 `box.x`；
5. 汇总主体纵向占用，沿 Track 树求轴和自然行高；
6. 分页，写回 `box.y`，调用 `onPlaced`；
7. 调用 attachment 的 `createGeometry`，一次返回本轮 regions、可选轨道占用与绘制闭包；
8. attachment 扩张轨道占用时，再进行一次纵向放置并重新生成 geometry；
9. 合并页面、主体和 attachment 的最终边界。

### 回调在什么时候执行

| 回调 | 可用的信息与调用次数 |
| --- | --- |
| `finalizeLayout` | 装饰已经完成，可以读取完整尺寸，例如计算 note 的歌词端口。 |
| `prepareHorizontal` | 主体尺寸已准备好，每个对象只调用一次。 |
| `onPlaced` | 本轮坐标已经写入，每轮纵向放置后都会调用。 |
| `createGeometry` | 根据主体坐标生成独立的几何结果，最多调用两轮。 |
| `paint` | 只读取最终几何，不重新测量或定位，可以重复调用。 |

`head` 等复合对象还可能在局部平移后再次调用成员的 `onPlaced`。因此，这个回调应根据当前坐标同步内部位置，不能在上一次结果上累加偏移。

`createGeometry` 的首轮结果可能被丢弃，第二轮则直接作为最终结果，不会继续迭代。只有首轮占用参与重新求解，因此它应当根据主体坐标计算几何，而不是依赖调用次数。特别要注意：如果第二轮相对本轨视觉轴的占用又发生变化，引擎不会再调整行高。

## 纵向布局与分页

每轮布局先将主体和已知 attachment 的占用换算为相对轨道视觉轴的 `Extent`，再沿 Track 树递归求解：
```
solve(track):
	ext = 本轨占用
	for group of track.groups:
		members = group.members.map(solve)
		if members 全为空: continue
		placements = group.measure(members, gap)
		缓存组内偏移和分组占用
	把无需宿主定位的分组并回 ext
	用完整 ext 调用其余分组的 place，再把整体平移后的占用并回 ext
place(root, -ext.top)
```

`measure` 决定组内成员的相对位置，可以先对所有分组完成测量。可选的 `place` 则等到宿主占用完整后，再决定整组平移多少。两者都由分组声明，引擎只负责递归和合并，不需要识别 stack 或 voices。

行高取全行纵向占用的并集，不会根据对象在横向上是否错开来进一步压缩。即使某个逻辑行没有主体，attachment 也可以通过 `line + track` 为它申请纵向空间。

如果 `measure` 和 `place` 需要共享测量中间值，应在 Lowering 时为本轮创建策略，并把状态保存在本轮对象上，不能通过 AST 中的闭包跨轮复用。`head` 的两侧底边对齐就采用这种方式。

### 分页

`page.ts` 接收自然行高，返回页面边界和每行的全局顶部 `lineTops`，不读取 Track 或具体对象。

`@page` 的长度在解析时换算为 px。内容宽度等于页宽减去左右边距；`height=0` 表示无限高，有限页面则至少需要容纳一行。排满的非末页保持首行贴上边距，扣除最小行距后，将剩余高度均分到每个系统下方。末页保留自然行距。

### 页码与错误

`@page(numbering=...)` 自己注册一个 foreground attachment 来绘制页码。它读取 `AttachmentLayoutContext.pages`，在每页下边距内垂直居中，使用固定的字体、字号和颜色。页码的 regions 不带 `line + track`，因此只计入画布边界，不占行高。

页码模式串中的 `1` 是计数符号：最后一个表示总页数，其余表示当前页。例如，第 2 页、共 5 页时，`"1 / 1"` 显示为 `2 / 5`。

非法页面配置抛出 `E_INVALID_PAGE_CONFIG`。单行高于内容区时，有可见源码内容则抛出 `E_PAGE_OVERFLOW`；无法归因到源码的 attachment-only 空行保留分页器的结构化错误。

## 横向求解前准备

`HorizontalSpringConfig` 保存 `alpha_L/R`、`mu_L/R`、`beta_L/R` 六个弹簧参数。主体尺寸准备好后，引擎先用 `completeSpringConfig` 补齐默认值，再运行 hook，函数此时可以直接使用这些字段。修改 `alpha` 不会自动重算已经补齐的 `beta`。

每个 attachment 的 `LayoutAttachment.prepareHorizontal` 在整篇布局中只调用一次，收到各谱面行的只读视图 `HorizontalLineView`：
- `index` 使用与 `host.layoutLine` 相同的行号。
- `trackRuns` 按列顺序列出同一 Track 上的主体，相邻项就是视觉上的前后邻居。
- `columnOf(host)` 返回主体的时间列下标，不在本行时返回 -1。
- `registerHorizontalLayoutHook(from, to, hook)` 为一段列注册局部布局操作。

同一行的局部 hook 按跨度从小到大稳定执行，共享列坐标 `X` 和固定间隙标记 `fixed`。具体函数可以调整弹簧参数或调用区域布局，引擎负责执行顺序，不解释函数的具体意图。

### 局部横向求解

`layoutHorizontal` 每行只做一次占位补齐，随后创建共享的 `X` 与 `fixed`。局部 hook 和最终整行布局都调用 `layoutHorizontalRegion`：

1. 连续 fixed 列先折叠成刚性虚拟列。虚拟列的左边界参数继承最左元素，右边界参数继承最右元素；普通元素的 `duration_L/R` 相同，虚拟列分别保留首尾时长。
2. 内部自由求解器进行预排列，并通过墙力、CG 和阻尼迭代求解，不需要处理 hook 或 fixed。
3. 求解后把虚拟列的整体位移展开回原列，fixed 内部坐标差保持不变。

定宽 box 使用这套机制冻结内部间隙；固定区域可以嵌套，但不能部分交叉或对相同列声明冲突宽度。

## 命名端口
关系函数通过命名端口获取连接位置，不必判断端点是什么类型。端口坐标相对于 `LayoutBox` 左上角：
- `body.left` / `body.right`：主体核心有效范围的左右边界；缺省为盒左右边界
- `shoulder`：在主体上方堆叠内容时的起始线；缺省为盒顶
- `tie.top`：可选的连音线端点覆盖；缺省使用对象 anchor 顶部
- `div.0.left` / `div.0.right`：各级减时线的左右端点
- `dot`：附点锚点；缺省为目标右边界和视觉轴，目标可同时覆盖 x/y
- `lyric`：歌词水平对齐点

端口用于覆盖默认连接位置，读取端口的代码需要处理未提供的情况。装饰 handler 可以在扩展盒子时一并提供相应端口。

## 下方装饰空间
`LayoutDecoration.below` 用于申请主体下方的空间。`order` 决定从近到远的排列顺序，`gap` 和 `height` 决定间距与高度。

`place(y)` 收到相对盒顶的位置，可以保存绘制几何并提供端口。此时 `box.y` 尚未确定，因此不要读取它，也不要在回调中修改 `box.h`。

below 只向下扩展。主体内部或上方的几何由 Temporal 的 `prepareLayout` 处理；需要独立纵向占用的对象则使用 attachment。全部装饰处理完成后，引擎才调用 `finalizeLayout`。

## 附属对象的几何与占用
`createGeometry` 返回本轮的 `AttachmentGeometry`。其中 `regions` 使用全局坐标，用于最终外接盒、绘制和命中，也默认作为轨道占用。

如果绘制边界不能全部算到一条 Track 上，可以另行返回 `occupancy`。例如，跨轨 `@tie` 只向某条轨申报自身到该轨主体上沿的那段占用，避免把两轨间的空白重复计入较高的轨道。本行没有主体时，则按几何本身申报。

引擎只对 `LoweringResult.attachments` 中实现了 `LayoutAttachment` 的对象执行布局，再根据最终 geometry 生成只读的 `PlacedAttachment`。`DocumentLayoutResult.attachments` 保存的是最终结果，不包含中间测量状态。

### 查询占用与避让

根据需要避让的范围，可以选择两个查询接口：
- `getHostExtent(line, track)`：返回指定轨道整行的主体占用，不含 attachment。
- `getRangeExtents(line, columns?)`：返回指定列区间内主体及已生成 attachment 的占用；省略 columns 时查询整行。

区间查询按闭区间时间列筛选主体，并用 `onPlaced` 后的最终 `box.y` 换算高度。已经生成的 attachment 则按它们是否与这些列的最终横向范围相交来筛选。

`measureAttachments` 按 Lowering 注册顺序生成几何并登记占用，因此当前对象只能看到先注册的 attachment，后声明的对象会排在外层。tuplet、volta 和 dyn 属于这种**避让型**对象，根据范围内的最高点或最低点定位。tie 和歌词则属于**对齐型**对象，位置取决于宿主端口，不会自动避让中间对象。

dyn 的插值与绘制使用同一闭区间，楔形线从起点完整宿主盒的左边界画到终点完整宿主盒的右边界；折叠成员参与播放，但布局只读取其可见宿主，端点里的 `$p`、`$f` 也计入主体占用。

需要读取某个 attachment 的完整边界时，使用 `getAttachmentBox`，例如让 `@box` 包住写在框内的 `@tie`。分组在内部对象之后注册，因此读取时内部几何已经可用。

是否属于框内只由 Lowering 作用域决定：写在框外的关系，即使端点都在框内，也不会被这个框包住。

### 写一个跨行 attachment

1. 按 `layoutLine` 排序端点；
2. 首末段连接端点与内容区边界；
3. 是否跨越没有可见主体的中间行由具体语义决定：volta 连到页边，dyn 只连接本轨有内容的行；
4. 每段返回准确的 `line + track` 占用；
5. `createGeometry` 每次返回新的完整结果，不修改或累加上一次结果。

## 横向间距：弹簧模型
横向间距遵循两个原则：音符时值越长，通常需要更大的间距；空间不足时先压缩间距，压缩到零后才允许元素重叠。

可以通过这个独立的 [HTML 示例](https://github.com/madderscientist/jpFun/blob/HEAD/packages/jpfun/src/layout/layout_demo.html) 查看横向求解效果。

每个元素有自己的固有宽度 `W` 和固有时长 `T`，左右连着两根相同长度的弹簧，弹簧的原始长度为 `L`，固有时长越大弹簧越长：$ L = \alpha T $

劲度系数 `k` 为弹簧实际长度和固有时长的函数：
$$ k(l, T)=\left\{
\begin{array}{rcl}
0       &      & {l > L}\\
\beta / T     &      & {0 \leq l \leq L}
\end{array} \right.
$$
当 $l < 0$ 时，表示元素已经重叠。此后每继续压缩 1，力 $F$ 增加 $\mu$。

压缩量 $\Delta l$（拉长时为负数）与力 $F$ 的关系是分段线性、单调连续的：

| $\Delta l$ | $l$ | $F$ | 
|-----------|--|------|
| $-\infty$    | $L$ | $0$ |
| $0$ | $L$ | $0$ |
| $0 < \Delta l < L$ | $L - \Delta l$ | $\beta \Delta l / T$ |
| $L$ | $0$ | $\alpha \beta$ |
| $L < \Delta l$ | $L - \Delta l$ | $\alpha \beta - l\mu$ |

空间充足时，元素可以保留自然间距。空间不足时，弹簧按比例压缩；长度降到 0 时，力达到与元素无关的常数 $\alpha\beta$，因此各处 margin 同时归零。继续压缩后，各处力的增量斜率相同，重叠程度也保持一致。

相邻两个元素之间的弹簧可以串联成一根等效弹簧，实现中使用这一形式计算。

### 多轨共享时间列
多个轨道上的元素需要按列对齐时，求解器把整列看作一个整体，叠加各轨道的受力，再求平衡位置。

此时，各轨道的 margin 不一定同时归零，需要增大 $\mu$ 来限制重叠程度。现有测试中，取 $\alpha\beta$ 的几倍即可，不需要再提高很多。

### 求解限制
这套模型需要迭代求解。由于不同区间的梯度变化较大，早期通用优化器即使限制最大步长并配合余弦退火，收敛效果也不够理想。目前使用共轭梯度法（CG），提高了精度并减少了迭代次数。

边界约束仍是近似的：增大跨墙弹簧的系数可以减轻元素越过边界的程度，但不能完全消除。严格限制边界需要在初始条件和每次迭代中都保证不越界，目前没有采用这种实现，而是用远大于 $\alpha\beta$ 的 $\mu$ 限制穿透。

### 时长与边界处理
零时长事件使用最小时长参与弹簧计算，避免刚度公式除零。实际时长会进行幂次变换，使视觉间距不与音乐时值保持生硬的线性比例。

只靠弹簧不能精确对齐左右边界：轻微压缩时，内容两端仍有空隙；过度压缩时，又可能越过边界。多行放在一起时，这种差异很明显，尤其是行末的小节线。

需要两端对齐时，布局会进一步调整自由间隙：忽略两端弹簧，计算内容实际边界与容器边界之间的差值，再平均分配到各个自由间隙。剩余空间为正时增大间隙，溢出时则减小间隙。