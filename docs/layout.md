# 简谱布局

## 核心对象

每个可见 Temporal 直接拥有一个扁平 `LayoutBox`：
```ts
interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}
interface LayoutBox extends Rect {
	anchor: number;      // 横向对齐点到左边界
	visualAxis: number;  // 轨道视觉轴到盒顶
}
```

`prepareLayout` 写入固有的 `w/h/anchor/visualAxis`，布局器原地写回 `x/y`。全局横向对齐点是 `x + anchor`，全局视觉轴是 `y + visualAxis`。字号在 parse 时冻结为 AST 上的 px 值，布局只读取它。

`layoutDocument` 会修改 Temporal、attachment 和 spring config，因此一份 `LoweringResult` 只布局一次；重新布局应重新 lowering。

## 布局阶段

`layoutDocument` 的固定顺序是：

1. 按 `layoutLine` 切行，调用 `prepareLayout`，生成固有尺寸、端口和装饰；
2. 排列下方装饰，调用 `finalizeLayout`；
3. 补齐 spring config，调用主体和 attachment 的 `prepareHorizontal`；
4. 每行独立进行横向求解，写回 `box.x`；
5. 汇总主体纵向占用，沿 Track 树求轴和自然行高；
6. 分页，写回 `box.y`，调用 `onPlaced`；
7. 调用 attachment 的 `layout`，收集外接盒和轨道占用；
8. attachment 扩张轨道占用时，再进行一次纵向放置和 attachment 布局；
9. 合并页面、主体和 attachment 的最终边界。

`prepareHorizontal` 每个对象只调用一次；`onPlaced` 和 `LayoutAttachment.layout` 必须幂等。第二次 attachment 布局只更新最终几何，不继续触发迭代。

## 纵向布局与分页

每轮把当前已知的主体和 attachment 占用折算为相对轨道视觉轴的 `Extent`，再沿 Track 树递归：
```
solve(track):
	ext = 本轨占用
	for group of track.groups:
		members = group.members.map(solve)
		if members 全为空: continue
		placements = group.arrange(ext, members, gap)
		把返回的偏移并回 ext
place(root, -ext.top)
```

引擎只负责递归、调用 `arrange` 和合并占用；stack、voices 等具体排列策略由函数提供。行高取全行占用的并集，不做横向感知的二维压缩。attachment 即使位于空逻辑行，也可通过 `line + track` 引入纵向占用。

`page.ts` 只消费自然行高，产出页面边界和每行全局顶部 `lineTops`；它不读取 Track 或具体对象。`@page` 的长度在 parse 时固化为 px，可用内容宽度是页宽减左右边距。`height=0` 表示无限高；有限页面至少容纳一行，完整非末页可拉伸行距。

非法页面配置抛出 `E_INVALID_PAGE_CONFIG`。单行高于内容区时，有可见源码内容则抛出 `E_PAGE_OVERFLOW`；无法归因到源码的 attachment-only 空行保留分页器的结构化错误。

## 横向求解前准备

`HorizontalSpringConfig` 保存 `alpha_L/R`、`mu_L/R` 和 `beta_L/R`。引擎在固有尺寸完成后先通过 `completeSpringConfig` 补齐六个字段，然后才运行 hook，因此具体函数不需要判断缺省值。hook 修改 `alpha` 不会隐式重算已经补齐的 `beta`。

`LayoutAttachment.prepareHorizontal` 接收 `HorizontalLineView[]`，整篇只调用一次，每个元素是每条谱面行的只读视图：
- `index` 是谱面行号，与 `host.layoutLine` 同一坐标系；
- `trackRuns` 是同一 Track 上按列序排好的主体，相邻两项即视觉上的前后邻居；
- `columnOf(host)` 给出时间列下标，不在本行返回 -1；
- `registerHorizontalLayoutHook(from, to, hook)` 注册横向布局 hook；同一行内按跨度从小到大执行。

引擎随后创建归一化的 `LayoutElement` 矩阵。hook 按跨度从小到大稳定执行，共享同一组列坐标 `X` 和固定间隙标记 `fixed`。具体函数可以调整弹簧参数或调用区域布局，引擎不解释其业务含义。

### 局部横向求解

`layoutHorizontal` 每行只做一次占位补齐，随后创建共享的列坐标 `X` 和 gap 标记 `fixed`。局部 hook 和最终整行布局都调用 `layoutHorizontalRegion`：

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

端口是可选覆盖：消费者必须定义缺省行为。装饰 handler 可以在扩张盒子的同时发布依赖最终几何的端口。

## 下方装饰空间
`LayoutDecoration.below` 声明主体下方空间：`order` 决定由近到远的顺序，`gap` 和 `height` 决定占用，`place(y)` 接收相对盒顶的位置。`place` 可以保存绘制几何和发布端口，但不应修改 `box.h` 或读取尚未确定的 `box.y`。

below 只向下扩张；主体内部或上方几何由具体 Temporal 的 `prepareLayout` 处理，需要独立纵向占用的对象使用 attachment。所有装饰完成后才调用 `finalizeLayout`。

## 纵向占用
`LayoutAttachment.layout` 返回全局坐标中的 `LayoutRegion[]`。所有区域都计入 attachment 外接盒；同时提供 `line + track` 的区域还会折算为该轨道相对视觉轴的占用。

`getHostExtent(line, track)` 只返回可见主体的稳定占用，不包含 attachment。当前 attachment 之间不互相避让，因此实现不应依赖注册顺序。

### 写一个跨行 attachment

1. 按 `layoutLine` 排序端点；
2. 首末段连接端点与内容区边界；
3. 为每个中间逻辑行生成一段，即使该行没有可见主体；
4. 每段返回准确的 `line + track` 占用；
5. `layout` 每次从主体几何重新计算，不累加上一次结果。

## 一行元素的布局：弹簧模型
基本理念：
1. 简谱中，音符时长越大，边距越大
2. 空间不足时，首先压缩边距。实在没空间了，才让元素重叠

横向排版有一个简单的html实现：[demo](../src/layout/layout_demo.html)

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

这样设计的理由：当多个元素并排时，若空间充足，则随便排（一般紧挨）；若空间不足，则弹簧压缩，压缩的过程中能保证 margin 之间的比例不变。由于长度为0时力为与元素无关的常数，因此所有元素的 margin 会同时被压缩到0长度，保证不会出现某个元素首先 margin 为负的情况。继续压缩，此时增量斜率全部相同，各处重叠的程度相同。

实际处理时，两个物体之间的弹簧可以用串联等价为一根弹簧，就好计算很多了。

## 多行元素的布局
即有的元素是跨行强行绑定的，要求垂直对齐。此时将一列视为一个整体，每行的受力叠加在该列上，最终求受力平衡位置。

此时应该是无法保证不会先出现某个元素margin为负的情况了，所以 $\mu$ 应该比较大，保证穿透的程度较小。实测稍微比 $\alpha\beta$ 大几倍就足够了，不用远大于。

## 缺点
1. 需要迭代求解。调了很多种优化算法，发现都不怎么适用：梯度变化极大。最后还是限制了每次的最大步长，并用余弦退火调整学习率，才勉强能稳定收敛。考虑到这是分段线性的凸优化，后来直接用了共轭梯度法（CG），效果非常好，不仅精度提升大幅减少了迭代次数。
2. 穿墙有些难避免。当前的做法是给跨墙很大的弹性系数，但这又会导致数据不稳定（使用CG后倒是不存在数值问题了），穿墙仍然会存在。当然算法上是可以实现的，只要设置好初始条件不会穿墙，后面迭代注意边界就行了，但实现起来比较麻烦。还是倾向于用更大的 $\mu$ 来减少穿墙程度（这里要远大于）。

## 实现说明
零时长事件使用最小时长参与弹簧计算，避免刚度公式除零。实际时长会进行幂次变换，使视觉间距不与音乐时值保持生硬的线性比例。