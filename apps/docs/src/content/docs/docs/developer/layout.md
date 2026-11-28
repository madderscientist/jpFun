---
title: 简谱布局
description: 时间对齐如何转化为几何约束，以及主体、装饰与附属对象的布局契约。
sidebar: { order: 5 }
---

布局将 `LoweringResult` 中的时间列、轨道和附属关系转换为 `DocumentLayoutResult`：确定对象的尺寸、位置、分页和最终几何，不重新解释语法，也不决定演奏顺序。

布局本质上是约束求解：同列对象横向对齐，同轨对象共用视觉基线，装饰与附属对象申报空间，页面限定可用宽高。音乐时间提供排列依据，不直接等于像素距离。

后文反复用到三种范围：

| 范围 | 含义 |
| --- | --- |
| 正文列 | 参与全局对齐的可见 Temporal；复合体作为整体占一列 |
| 子域 | 复合体内部的一小段乐谱，有自己的列、Track 树和附件，先排成刚性块，对外只是一个主体 |
| 内容作用域 | 函数内容中实际产生的主体和附件，只用于几何包含，不等于轨道占用 |

## 几何模型

每个可见 Temporal 有一个 `LayoutBox`：`x/y/w/h` 是定位矩形，`anchor` 是横向对齐点到左边界的距离，`visualAxis` 是视觉轴到顶边的距离。`prepareLayout` 填写 `w/h/anchor/visualAxis`，布局器写入 `x/y`。

定位矩形不等于完整占用：上方装饰使用负的局部 y，纯留白也不计入 `box.h`。叠放、撑行或求边界时，用 `getLayoutBounds(host)` 读取完整占用，用 `getLayoutBounds(host, true)` 读取不含纯留白的内容边界。

参与布局的对象分三类：
- **主体**：以 `LayoutBox` 参与对齐。
- **装饰**：依附于主体，申报主体上下的空间，也可以扩展宽度或提供端口。
- **附属对象**（attachment）：根据主体位置生成独立几何，可以跨轨、跨行或属于整页。

| 层次 | 输入约束 | 求解结果 |
| --- | --- | --- |
| 横向 | 时间列、主体宽度、时值间距、局部定宽 | 各列对齐点与 `box.x` |
| 纵向 | Track 层级、视觉轴、相对轨道的占用 | 轨道偏移与自然行高 |
| 分页 | 自然行高、页面尺寸和边距 | 页面划分与每行的全局顶部 |

## 布局执行顺序

`layoutDocument` 依次执行：

1. **准备主体**：按 `layoutLine` 切行，调用 `prepareLayout` 生成固有尺寸、端口和装饰（复合体在此排版子域），再排列上下装饰并调用 `finalizeLayout`。
2. **横向准备**：每行补齐弹簧配置并调用主体的 `prepareHorizontal`，再调用正文 attachment 的 `prepareHorizontal`。
3. **横向求解**：每行独立求解，写入 `box.x`。
4. **行间小节线对齐**：`alignHorizontalBars` 把未被挤压的行撑满时的剩余宽度重新分配，使小节数相同或成倍数的相邻行小节线对齐，因此会再次改写多行的 `box.x`。
5. **纵向放置与分页**：沿 Track 树求轴和自然行高，分页后写入 `box.y` 并调用 `onPlaced`。
6. **测量附件**：按登记顺序测量正文 attachment；附件占用超出主体占用时，重新放置一次。
7. **后置平移与收尾**：施加后置平移，按最终坐标生成绘制几何，合并最终边界。

`horizontalOnly: true` 在第 4 步后返回，供 MIDI 导入自动换行时测宽：只保留主体尺寸、横向坐标和行数，`attachments` 与 `pages` 为空，结果不能用于渲染。

### 回调

| 回调 | 时机 |
| --- | --- |
| `prepareLayout` | 计算固有尺寸；复合体在这里准备成员、排版子域 |
| `finalizeLayout` | 装饰已排列，可以发布依赖装饰的端口 |
| `prepareHorizontal` | 横向视图建立后、求解前，只注册约束；attachment 上的这个回调每次文档布局只调用一次 |
| `onPlaced` | 每轮放置后调用；带后置平移的主体平移后再调用一次 |
| `createGeometry` | 每轮测量都会调用，结果可能被丢弃 |
| `paint` | 只读最终几何，可以重复调用 |

`onPlaced` 与 `createGeometry` 都可能被多次调用，必须根据当前坐标重新计算，不能在上一次结果上累加。

### 后置平移

`@adjust` 的 `dw/dh` 改变定位矩形尺寸，参与布局；`dx/dy` 是放置后的平移，不推动邻轨，也不提供避让保证。平移在 Lowering 时通过主体或 attachment 的 `placementOffset` 声明，由引擎统一施加，声明方不应自行平移；已经通过端点跟随移动的附件不应再声明平移。

占用测量（含重排）结束后，引擎按 `foldedInto` 由外到内把平移叠加到 `box.x/y` 并再次调用 `onPlaced`，折叠成员因此继承外层的平移。有平移的测量域分两轮：先在布局位置测占用，平移后再生成绘制几何。

## 纵向布局与分页

每轮布局把主体和已测 attachment 的占用换算为相对轨道视觉轴的 `Extent`，再沿 Track 树递归求解：
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

`measure` 决定组内成员的相对位置；可选的 `place` 等宿主占用完整后再决定整组平移。两者都由分组声明，引擎只负责递归与合并，不识别 stack 或 voices。二者需要共享中间值时，应保存在 Lowering 为本轮创建的策略对象上，不能借 AST 闭包跨轮复用。

### 行距与声部间距

视觉轴以下是音符下半部、减时线、低音点和歌词，构成下沿 `bottom`；连音线、高音点、倚音、`@tuplet`、`@volta` 等凸出在轴上方。间距以**上一单元的 `bottom` 到下一单元主旋律上沿（`axis - size / 2`）**为基准，同时保证完整边界之间至少留出 $\text{minClearance} = \min(\text{gap}, \text{minGap})$：

- **声部间距（`@voices(gap=0.75em, minGap=0.2em)`）**：相邻声部 $i-1$ 与 $i$ 的视觉轴间距为：
  $$\Delta y = \text{ext}_{i-1}.\text{bottom} + \max(\text{gap} + \text{size}/2,\ \text{minClearance} - \text{ext}_i.\text{top})$$
- **谱面行距（`@br(gap=1em, minGap=0.4em)`，由本行之前的换行决定，同列取较大值）**：设第 $i$ 行顶部高出最高主旋律上沿的外扩量为 $\text{headroom}_i = \min(\text{axis} - \text{size}/2)$，则该行与上一行完整盒之间的实际间距为：
  $$\text{gap}_i = \max(\text{gap} - \text{headroom}_i,\ \text{minClearance})$$
  外扩量不超过 $\text{gap} - \text{minClearance}$ 时，上一行下沿到本行主旋律上沿保持为 `gap`。

行高按整行一维区间求解，不利用横向空隙交错压缩。没有主体的行也可以由 attachment 通过 `line + track` 申请高度。

### 分页

`page.ts` 只接收每行高度、强制分页标记和上式算出的行间距，返回页面边界和每行顶部，不读取 Track 或具体对象：
- 首行上沿与末行下沿按完整高度贴合上下边距；排满的非末页把剩余高度均分到各系统下方，末页保留自然行距。
- `@pagebreak(justify=true)`（`@pb`）产生不可见控制事件，复用换行的合列规则；`justify=false` 时上一页不拉伸，同一边界多次声明时 `false` 优先。
- `height <= 0` 表示无限页高：仍遵守强制分页，但不拉伸。
- `@page(numbering=...)` 的页码是一个只计入画布边界、不占行高的 attachment。
- 非法页面配置抛出 `E_INVALID_PAGE_CONFIG`；单行高于内容区时抛出 `E_PAGE_OVERFLOW`。

## 横向准备

主体尺寸准备好后，引擎用 `completeSpringConfig` 补齐 `HorizontalSpringConfig` 的弹簧参数，再调用 `prepareHorizontal`。attachment 的 `prepareHorizontal` 收到各行的只读视图 `HorizontalLineView`：
- `index` 与 `host.layoutLine` 一致；
- `trackRuns` 按列序列出每条 Track 上的主体；
- `columnOf(host)` 返回主体的列下标，不在本行时为 -1；
- `registerHorizontalLayoutHook(from, to, hook)` 为一段列注册局部布局操作。

同一行的 hook 按跨度从小到大执行，共享列坐标 `X` 和固定标记 `fixed`。hook 与整行求解都调用 `layoutHorizontalRegion`：连续的 fixed 列先折叠成刚性虚拟列再求解，固定区域可以嵌套，但不能交叉或对同一段列声明冲突宽度。定宽 `@box` 用这套机制冻结内部间隙，并把 `padding + stroke / 2` 加到首末列的留白上。

复合体内部的局部序列（up/down、grace 的宿主列、子域横排）用 `layoutLocalSequence` 按书写顺序做自然宽度求解，不撑满。弹簧模型、求解方法和行间小节线对齐见[横向排版算法](../layout-algorithm/)。

## 子域

`{@tuplet({1 2 3},2) & 1}>1` 在正文里只有一个 `GraceTemporal`，但倚音内部有自己的列、声部和括线：括线压在下声部上时，上声部必须让开。正文看不到这些内部空隙，所以子域把它们当作一小段乐谱，先按正文规则排完，再作为刚性块交给复合体定位。

复合体在 `prepareLayout` 中调用 `layoutDocument` 注入的 `layoutSubdomain`：

```ts
const block = context.layoutSubdomain!(this, this.graceColumns, this.root, this.attachments);
```

`columns` 外层是先后，内层是同一时刻的不同声部，成员位于 `root` 的 Track 树上。引擎按正文流程完成横排、求轴、附件测量与重排、后置平移，返回块宽、块高和成员的块内位置 `positions`。`positions` 不含后置平移，复合体每次同步坐标都从这里出发。

grace 的私有根轨从宿主轨分出，但不挂进分组，所以正文看不到它，不同倚音也不会共用声部。

### 附件归属

- 内容附件（无 `endPoints`，如 box、声部括号、歌词）跟随声明位置。
- 关系附件（有 `endPoints`）属于同时包含全部端点的最内层子域，与写在哪里无关：`{2@a 3@b}>1 @tie(a,b)` 与把 tie 写进倚音里相同。端点连到子域外的关系交给外层测量。

子域附件只在块内测量，之后随块平移，不再参与正文测量，也不调用 `prepareHorizontal`。

### 对外只是一个主体

- 正文的范围查询把折叠端点沿 `foldedInto` 上溯到复合体，不进入子域内部。
- 私有轨沿 `Track.parent` 归入复合体所在的轨。
- 复合体的盒子包含子域附件的占用，外层的框、叠放和避让因此看到完整的块。

up/down 没有子域，成员直接叠放在复合盒里。

## 命名端口

装饰与关系函数通过命名端口获取几何基准，不需要判断主体类型。端口坐标相对 `LayoutBox` 左上角，读取方需要处理端口缺省的情况：
- `body.left` / `body.right`：主体核心的左右边界，缺省为盒边界
- `decoration.below`：下方装饰的排列起点（只用 y），缺省为盒底；音符取数字基线略下方
- `shoulder`：倚音的纵向定位基准；音符取数字顶边（不含高八度点），缺省为盒顶
- `tie.top`：连音线端点，缺省取 anchor 与内容上沿
- `div.0.left` / `div.0.right`：各级减时线的端点
- `dot`：附点锚点，缺省为右边界与视觉轴
- `lyric`：歌词水平对齐点

## 上下装饰空间

`LayoutDecoration.above` / `below` 用同一个 `LayoutDecorationSpace` 协议，分别申请主体上方、下方的空间：

| 字段 | 含义 |
| --- | --- |
| `order` | 由内向外的顺序，值越小越靠近主体；相同值保持注册顺序 |
| `gap` | 与主体或前一个装饰的间距，默认 `0`，允许负值 |
| `height` | 区域高度，默认 `0` |
| `place(y)` | 可选回调，接收区域顶边相对定位矩形顶部的 y |

两侧分别从正文盒顶部、底部（或 `decoration.below` 端口）向外排列，每项按 `gap + height` 推进，后续装饰自然跟随，不需要知道前一项是什么。例如低八度点不读减时线的状态：没有减时线时贴近数字，有减时线时自然排在最后一条线下方。`place` 只记录局部几何和端口，绘制时再加上主体的最终坐标。

省略 `paint` 表示纯留白：计入完整占用、叠放和行高，但不计入内容边界，也不绘制。下方纯留白至少从已有内容底边开始，外框 padding 因此能完整包围内容：

```ts
host.decorations.push({
    above: { order: Infinity, height: 8 },
    below: { order: Infinity, height: 8 },
});
```

## 附属对象

### 几何与占用

`createGeometry` 返回本轮的 `AttachmentGeometry`。`regions` 使用全局坐标，用于绘制、命中和画布边界；`occupancy` 是向轨道申请的空间，省略时取 `regions`，显式 `[]` 表示不申请。只有带 `line + track` 的区域才计入行高。跨轨连线就用 `occupancy` 只申报靠近某一轨的部分，避免把两轨间的空白重复计入。

可选的 `kind` 字段会原样复制到 `PlacedAttachment`，SVG 后端将其输出为 `<g data-kind>`，取值规则见[渲染后端](../render/#语义分组)。

### 查询占用

附件在自己所属的域里查询：正文附件查正文行，子域附件查子域。

| 接口 | 数据与空结果 |
| --- | --- |
| `getHostExtent(line, track)` | 整行该轨的主体占用，不含附件；没有主体时为 `undefined` |
| `getRangeColumns(line, range?, track?)` | 范围内的主体列，用于字号等统计 |
| `getRangeExtents(line, range?)` | 范围内主体与已测附件的占用，按 Track 分组的 Map |
| `getRangeExtents(line, range, track)` | 同上，只取一条轨；无占用时为 `undefined` |
| `getHorizontalExtents(line, left, right)` | 与全局 x 区间相交的主体与已测附件的占用，按 Track 分组的 Map |
| `getAttachmentBox(attachment)` | 已测附件的几何边界；尚未测量时抛错 |
| `getAttachmentOccupancy(attachment)` | 已测附件的有效占用 `occupancy ?? regions` |
| `getContentBounds(content)` | 内容作用域中主体内容边界与已测附件的并集 |

范围是对象端点 `[from, to]`，省略时为整行，两端都包含在内；端点可以逆序或跨行，折叠成员沿 `foldedInto` 上溯到本域的列。横向查询直接按 x 相交筛选，不限于端点之间的列，只接触边缘不算相交。

占用都以所在轨的视觉轴为原点，跨轨比较前先用 `getVisualAxis(line, track)` 换算。`getHostExtent` 只依赖主体固有尺寸，整个布局中不变；其余查询读取本轮位置，并包含此前已测的附件。

### 避让策略

系统只提供测量事实，各函数自己决定避让什么：

| 函数 | 避让方式 |
| --- | --- |
| tuplet、dyn | 端点范围内本轨的最高或最低点；tuplet 还合并内容边界 |
| volta | 整个系统的记号：开头折钩与编号、横线、末尾折钩分别查询横向相交的所有轨，取最高位置 |
| ottava | 单轨记号：同样按横向相交查询，但只读本轨占用；其他轨由纵向求解按它的占用推开 |
| tie | 只避让主体（`getHostExtent`），连音线之间允许重叠 |
| 歌词 | 按宿主端口水平对齐，避让 voice 内容作用域内的框底 |

### 测量顺序

`measureAttachmentPass` 按 Lowering 登记顺序生成几何并立即登记占用，正文和子域共用这段代码。附件只看得见比自己先登记的附件，因此后声明的排在外层。每个域有自己的占用表，相邻倚音即使横向相交也不会互相抬高括线。首轮占用汇入 `attachmentExtents`，供重新放置时求轴。

### 内容包含

内容包含按声明作用域确定：函数通过 Lowering 分组收集 `LoweringContent`，`getContentBounds` 合并其中可见主体的内容边界和已测附件。`@box({1@a 2@b @tie(a,b)})` 的框包含 tie；`@box({1@a 2@b}) @tie(a,b)` 则不包含，即使两端都在框内。几何是否被包含，与是否申请轨道占用无关。

### 外框与歌词

`@box` 是 background attachment，外接边界在内容边界外扩 `padding + stroke / 2`：
- 只框住一个主体（内部至多还有同一主体上的嵌套框）时，用 `order=Infinity` 的纯留白装饰预留上下空间，框本身返回 `occupancy: []`；
- 多主体或包含关系的框在测量后申报外沿，跨轨时上沿归最上轨、下沿归最下轨。

嵌套框逐层包含，各层 padding 只计一次。padding 收缩到容不下边框时抛出 `E_BOX_PADDING_TOO_SMALL`，跨行抛出 `E_BOX_CROSS_LINE`。

歌词按同一行、同一原始轨共用下沿。`@voice(@box(...), ..., "歌词")` 的歌词排在框外，`@box(@voice(..., ..., "歌词"))` 的歌词属于框内内容。

### 写一个跨行 attachment

1. 按 `layoutLine` 排序端点。
2. 首行从起点画到 `lineRightX(context, line)`，即本行所有主体的最右边界；末行从 `lineEntryX(context, line, track)` 画到终点，即本轨首个占时值主体的左边界，会跳过声部名、括号等行首前缀。两者都在 `layout/range.ts` 中，空行时回退到版心左右沿。
3. 中间行由语义决定：volta、ottava、tie 逐行续画，空行延伸到版心边缘；dyn 只画本轨有内容的行。
4. 每段返回准确的 `line + track` 占用。
5. `createGeometry` 每次返回完整的新结果，不累加上一次结果。

---

单行横向弹簧模型的数学推导、交互演示与跨行小节线水位对齐算法见下一章[横向排版算法](../layout-algorithm/)。