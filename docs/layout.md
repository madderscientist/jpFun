# 简谱布局

## 核心对象

每个可见 Temporal 直接拥有一个扁平 `LayoutBox`：`x/y/w/h` 加两个基准——`anchor` 是横向对齐点到左边界的距离，`visualAxis` 是轨道视觉轴到盒顶的距离。`prepareLayout` 写入固有的 `w/h/anchor/visualAxis`，布局器原地写回 `x/y`；全局横向对齐点是 `x + anchor`，全局视觉轴是 `y + visualAxis`。字号在 parse 时冻结为 AST 上的 px 值，布局只读取。

`layoutDocument` 会修改 Temporal 和 spring config，所以一份 `LoweringResult` 只布局一次，重新布局要重新 lowering。

## 布局阶段

`layoutDocument` 的固定顺序是：

1. 按 `layoutLine` 切行，调用 `prepareLayout`，生成固有尺寸、端口和装饰；
2. 排列下方装饰，调用 `finalizeLayout`；
3. 补齐 spring config，调用主体和 attachment 的 `prepareHorizontal`；
4. 每行独立进行横向求解，写回 `box.x`；
5. 汇总主体纵向占用，沿 Track 树求轴和自然行高；
6. 分页，写回 `box.y`，调用 `onPlaced`；
7. 调用 attachment 的 `createGeometry`，原子生成本轮 regions、可选轨道占用与绘制闭包；
8. attachment 扩张轨道占用时，再进行一次纵向放置并重新生成 geometry；
9. 合并页面、主体和 attachment 的最终边界。

`prepareHorizontal` 每个对象只调用一次；`onPlaced` 可能调用两次；`createGeometry` 每次返回独立结果，首轮可被丢弃，第二轮就是最终结果，不再迭代。只有首轮占用参与求解，所以 `createGeometry` 必须是主体坐标的纯函数——相对本轨视觉轴的占用一旦随轮次变化，引擎会静默采用第二轮。

## 纵向布局与分页

每轮把当前已知的主体和 attachment 占用折算为相对轨道视觉轴的 `Extent`，再沿 Track 树递归：
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

`measure` 只决定成员在分组局部坐标里的相对位置，所以所有分组都能先测量完；可选的 `place` 在宿主占用完整后决定整组平移。两者都是分组声明的静态策略，引擎只负责递归与合并占用，不认识 stack、voices。行高取全行占用的并集，不做横向感知的二维压缩。attachment 即使位于空逻辑行，也能通过 `line + track` 引入纵向占用。

`page.ts` 只消费自然行高，产出页面边界和每行全局顶部 `lineTops`，不读取 Track 或具体对象。`@page` 的长度在 parse 时固化为 px，可用内容宽度是页宽减左右边距；`height=0` 表示无限高，有限页面至少容纳一行，完整非末页可拉伸行距。

`@page(numbering=...)` 的页码由 `@page` 自己注册成 foreground attachment，按 `AttachmentLayoutContext.pages` 逐页在下边距带内垂直居中，字体字号颜色写死；regions 不带 `line + track`，所以只进画布边界、不占行高。模式串里的 `1` 是计数符号，最后一个取总页数，其余取当前页，`"1 / 1"` 因此得到 `2 / 5`。

非法页面配置抛出 `E_INVALID_PAGE_CONFIG`。单行高于内容区时，有可见源码内容则抛出 `E_PAGE_OVERFLOW`；无法归因到源码的 attachment-only 空行保留分页器的结构化错误。

## 横向求解前准备

`HorizontalSpringConfig` 保存 `alpha_L/R`、`mu_L/R`、`beta_L/R`。引擎在固有尺寸完成后先用 `completeSpringConfig` 补齐六个字段再运行 hook，所以具体函数不用判断缺省值；hook 改 `alpha` 不会隐式重算已补齐的 `beta`。

`LayoutAttachment.prepareHorizontal` 整篇只调用一次，参数是每条谱面行的只读视图 `HorizontalLineView`：`index` 与 `host.layoutLine` 同坐标系；`trackRuns` 是同一 Track 上按列序排好的主体，相邻两项即视觉上的前后邻居；`columnOf(host)` 给出时间列下标，不在本行返回 -1；`registerHorizontalLayoutHook(from, to, hook)` 注册的 hook 在同一行内按跨度从小到大稳定执行，共享同一组列坐标 `X` 和固定间隙标记 `fixed`。具体函数可以调整弹簧参数或调用区域布局，引擎不解释业务含义。

### 局部横向求解

`layoutHorizontal` 每行只做一次占位补齐，随后创建共享的 `X` 与 `fixed`。局部 hook 和最终整行布局都调用 `layoutHorizontalRegion`：

1. 连续 fixed 列先折叠成刚性虚拟列。虚拟列的左边界参数继承最左元素，右边界参数继承最右元素；普通元素的 `duration_L/R` 相同，虚拟列分别保留首尾时长。
2. 私有自由求解器继续使用原来的预排列、墙力、CG 与阻尼迭代，不理解 hook 或 fixed。
3. 求解后把虚拟列的整体位移展开回原列，fixed 内部坐标差保持不变。

定宽 box 使用这套机制冻结内部间隙；固定区域可以嵌套，但不能部分交叉或对相同列声明冲突宽度。

## 命名端口
关系函数不判断端点类型，只读取相对于 `LayoutBox` 左上角的命名端口：
- `body.left` / `body.right`：主体核心有效范围的左右边界；缺省为盒左右边界
- `shoulder`：要在这个盒上方叠东西的人应该从哪条线开始；缺省为盒顶
- `tie.top`：可选的连音线端点覆盖；缺省使用对象 anchor 顶部
- `div.0.left` / `div.0.right`：各级减时线的左右端点
- `dot`：附点锚点；缺省为目标右边界和视觉轴，目标可同时覆盖 x/y
- `lyric`：歌词水平对齐点

端口是可选覆盖，消费者必须定义缺省行为。装饰 handler 可以在扩张盒子的同时发布依赖最终几何的端口。

## 下方装饰空间
`LayoutDecoration.below` 声明主体下方空间：`order` 决定由近到远的顺序，`gap` 和 `height` 决定占用，`place(y)` 接收相对盒顶的位置，可以保存绘制几何和发布端口，但不应修改 `box.h` 或读取尚未确定的 `box.y`。

below 只向下扩张；主体内部或上方几何由具体 Temporal 的 `prepareLayout` 处理，需要独立纵向占用的对象改用 attachment。所有装饰完成后才调用 `finalizeLayout`。

## 纵向占用
`createGeometry` 返回本轮 `AttachmentGeometry`：全局坐标的 `regions` 始终用于最终外接盒、绘制与命中，缺省也当作轨道占用；无法把完整绘制边界归给单一 Track 的对象另外返回 `occupancy`，例如跨轨 `@tie` 只申报自己到该轨主体上沿那一段，否则两轨之间的空档会被重复计入较高的那条轨（本行没有主体接管下半截时只能申报几何自身）。

引擎从 `LoweringResult.attachments` 中筛出具备 `LayoutAttachment` 能力的对象，再从最终 geometry 生成只读 `PlacedAttachment`；`DocumentLayoutResult.attachments` 只保存最终几何，两者不共享半成品状态。

`getHostExtent(line, track)` 只返回可见主体的稳定占用，不含 attachment。attachment 之间不互相避让；确实要读另一个 attachment 边界的（例如 `@box` 框住写在框内的 `@tie`）用 `getAttachmentBox`——几何按 lowering 注册顺序生成，而分组总在组内对象之后注册，所以只能读到排在自己之前的。归属只按 lowering 作用域判定：写在框外的关系不会因为端点在框内就被框住。

### 写一个跨行 attachment

1. 按 `layoutLine` 排序端点；
2. 首末段连接端点与内容区边界；
3. 为每个中间逻辑行生成一段，即使该行没有可见主体；
4. 每段返回准确的 `line + track` 占用；
5. `createGeometry` 每次返回新的完整结果，不修改或累加上一次结果。

## 一行元素的布局：弹簧模型
基本理念：
1. 简谱中，音符时长越大，边距越大
2. 空间不足时，首先压缩边距。实在没空间了，才让元素重叠

横向排版有一个简单的html实现：[demo](../packages/jpfun/src/layout/layout_demo.html)

每个元素有自己的固有宽度 `W` 和固有时长 `T`，左右连着两根相同长度的弹簧，弹簧的原始长度为 `L`，固有时长越大弹簧越长：$ L = \alpha T $

劲度系数 `k` 为弹簧实际长度和固有时长的函数：
$$ k(l, T)=\left\{
\begin{array}{rcl}
0       &      & {l > L}\\
\beta / T     &      & {0 \leq l \leq L}
\end{array} \right.
$$
特别的，当 $l < 0$ 时，每压缩 1，力 $F$ 增加 $\mu$。

此时弹簧的压缩量 $\Delta l$(拉长为负数) 和力 $F$ 的关系为分段线性单调连续函数：

| $\Delta l$ | $l$ | $F$ | 
|-----------|--|------|
| $-\infty$    | $L$ | $0$ |
| $0$ | $L$ | $0$ |
| $0 < \Delta l < L$ | $L - \Delta l$ | $\beta \Delta l / T$ |
| $L$ | $0$ | $\alpha \beta$ |
| $L < \Delta l$ | $L - \Delta l$ | $\alpha \beta - l\mu$ |

这样设计是为了：空间充足时元素随便排（一般紧挨）；空间不足时弹簧压缩，且 margin 之间的比例保持不变；长度为 0 时力是与元素无关的常数 $\alpha\beta$，所以所有 margin 同时被压到 0，不会有某个元素先变负；再压下去各处增量斜率相同，重叠程度一致。

两个物体之间的弹簧可以串联等价成一根，实际计算走这条路。

## 多行元素的布局
有的元素跨行强行绑定、要求垂直对齐。此时把一列视为整体，每行的受力叠加在该列上，求受力平衡位置。

这时无法再保证不会有某个元素的 margin 先变负，所以 $\mu$ 要大一些以压低穿透程度。实测比 $\alpha\beta$ 大几倍就够，不用远大于。

## 缺点
1. 必须迭代求解。梯度变化极大，通用优化器都不好用（限制最大步长 + 余弦退火才勉强稳定收敛）；因为本质是分段线性凸优化，最终改用共轭梯度法（CG），精度和迭代次数都好得多。
2. 穿墙难以完全避免。目前靠给跨墙弹簧很大的弹性系数缓解（CG 之后不再有数值问题），但穿墙仍会发生。算法上可以根治——初始条件不穿墙、迭代时守住边界即可——只是实现麻烦，所以仍倾向于用远大于 $\alpha\beta$ 的 $\mu$ 把穿透压到最小。

## 实现说明
零时长事件使用最小时长参与弹簧计算，避免刚度公式除零。实际时长会进行幂次变换，使视觉间距不与音乐时值保持生硬的线性比例。