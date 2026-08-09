# 架构

**宗旨：框架实现基础机制，具体功能由函数类自己实现。函数之间完全解耦。**

简谱中符号种类繁多，若将符号逻辑耦合到布局算法中，复杂性会剧增且难以扩展。因此本系统将每一步都设计为"引擎调度 + 函数声明"模式：引擎不知道具体符号的含义，函数不知道引擎的内部实现。

## 流水线

```
源码字符串 → [解析] → AST树 → [时间流化] → LoweringResult → [布局] → LayoutBox → [绘制] → 渲染后端
```

三个阶段各自独立，通过数据结构传递：

各阶段共享同一个 `Diagnostic[]`：parser 创建并记录解析诊断，pipeline 将其交给 `LoweringContext`，`LoweringResult` 再传给 `DocumentLayoutResult`。warning 不阻断流水线；`ErrorDiagnostic` 在 parser 或 lowering 的阶段边界确保入队后立即重新抛出，后续阶段不会在错误结果上继续运行。

### 1. 解析
将源码解析为 AST 树。解析器只负责基础语法（函数调用、大括号、标签）和调度，函数自行处理参数和语法糖。  
→ 详见 [parseAST.md](parseAST.md) · 代码：`src/parser/` · AST 类型：`src/functions/ASTtypes.ts`

### 2. 时间流化（Lowering）
将 AST 树展开为时间流——一个按时间排序的列列表，每列包含同一时刻的所有元素。这一步处理：时间变换（附点/减时线）、多声部锚点对齐、调性/速度固化。  
→ 详见 [lowering.md](lowering.md) · 代码：`src/lowering/`

### 3. 布局
从时间流计算横纵坐标。采用弹簧模型：元素时长越大边距越大，空间不足时按比例压缩。多行元素通过列对齐联动。关系对象在横向位置确定后计算几何并向纵向布局申报占用范围。谱面行先在无限高坐标中紧排，再按 PageConfig 分页并重分配完整页行距。
→ 详见 [layout.md](layout.md) · 代码：`src/layout/`

`engine.ts` 负责符号测量、横向求解、attachment 占用合并，以及按 track 得出每条谱面行的自然高度和相对视觉轴。`page.ts` 不理解 Temporal、track extent 或具体 attachment；它只消费已经测好的 `PageLayoutLine`，负责页面参数校验、封页、完整页间距拉伸、页面 bounds 和绝对视觉轴。该边界保证分页策略可以独立演进，而不把音乐排版语义带入页面模块。

### 4. 绘制
函数对象通过统一 `Painter` 接口描述字形、路径和基础图形。布局和函数代码不直接访问 SVG、Canvas 或 DOM API，后端只负责执行已经确定坐标的绘制命令。
→ 详见 [render.md](render.md) · 代码：`src/render/`

## 解耦机制

### 函数即声明

每个内置函数继承 `ASTFunctionNode`，通过覆盖 hooks 声明自己的行为：
- **解析阶段**：`deSugarAtom` / `deSugarRelation`（语法糖）、`def`（参数定义）
- **时间流化阶段**：`timeFlowModel`（子节点展开模式）、`loweringEnter`/`loweringExit`（进入/离开回调）、`LoweringGroup`（作用域内事件与 attachment）、`onTimeState`（时间信息固化）、`loweringAugment`（派生关系生成）、`loweringFinalize`（最终处理）
- **排版阶段**：Temporal 节点的 `prepareLayout` / `onPlaced` / `paint`，装饰函数类的 `layoutDecorationHandler`，关系对象的 `prepareHorizontalLayout`

引擎遍历 AST 时调用这些 hooks，但不关心具体函数类型。新增函数只需写子类并注册，引擎零改动。

### 时间流化的两步设计

时间流化不能在遍历时一次性完成，因为存在**锚点对齐**（多声部按小节线同步时间），这会修改时间。因此拆为两步：

1. **trackedEvents**：递归遍历 AST，生成时间事件，局部归并 parallel 分支
2. **onTimeState**：锚点对齐完成后，按时间顺序固化调性/速度等状态
3. **loweringAugment**：函数根据最终列、轨道和逻辑行生成自动关系对象
4. **loweringFinalize**：所有派生关系追加完成后，按函数注册顺序处理完整结果

### ColType：列合并策略

时间列合并时，不同元素有不同需求：
- `ANCHOR`（如小节线）：跨轨对齐点，缓冲等待所有轨道汇齐
- `SINGLE`（如设置类）：单独成列，不与同时刻元素合并
- `DEFAULT`（如音符）：同时刻合并为同一列

这解决了零时长元素（如 `@set`）破坏对齐的问题。

## 排版对象

需要字号的具体函数在 parse 构造时读取局部 `ParserContext.fontSize`，并立即把 `size` 固化成 px；`@set(fontsize=...)` 只影响当前大括号作用域内后续创建的函数。可见 Temporal 只持有来源 AST，dot/div 从 `host.ast.size` 派生装饰尺寸，tie/beam 从端点 AST 字号派生关系几何，不复制字号字段。没有 box 的 Temporal 只参与时间或状态处理。`LayoutPrepareContext` 只保存 glyph 与装饰 handler 等共享资源，不保存全局 em。

`LayoutBox` 的 `w/h/anchor/visualAxis` 在固有尺寸阶段生成，`x/y` 在布局阶段原地写回。`visualAxis` 是对象参与轨道纵向对齐的轴，不是字体 baseline。`w` 表示完整视觉宽度，可选的 `leftExtent/rightExtent` 表示 anchor 两侧的核心有效范围。横向弹簧模型只读取完整 `LayoutBox` 和独立的 `HorizontalSpringConfig`，不识别 note、bar 等具体函数。

固有尺寸完成后，引擎先补齐每个可见事件的全部 `springConfig` 字段，再按谱面行调用 attachment 的 `prepareHorizontalLayout`。该 hook 获得只读的对象列表与时间列拓扑，但其中的 `LayoutHost` 仍可写；beam 等具体关系可以直接调整 `springConfig` 或执行其他横向求解前准备，引擎不解释其行为。当前核心 anchor 规则把相邻边界两侧相向的 `mu` 放大到 4 倍。

装饰性函数通过 `LoweringGroup.onTemporal` 同步固化事件时长与 `addon`。div 的各层变换可以直接连乘；dot 根据 addon 中此前已应用的级数乘以新旧累计系数之比，因此乱序嵌套和 up 内外叠加都不会重复变换。addon key 统一为 `@主函数名`，其中主函数名是 `def.name` 的第一个名称；别名不产生独立 key。函数类直接用 `layoutDecorationHandler` 注册工厂，布局上下文会按同一约定自动推导 key。`@` 只是 addon 与 handler 的路由约定，不触发引擎行为；新增装饰函数不需要修改布局引擎。

`@page` 在 parse 阶段固化页面尺寸，并通过 `LoweringContext.setPageConfig` 写入 `LoweringResult.page`。layout 据此求内容宽度、谱面行自然高度和分页结果。`DocumentLayoutResult.pages` 使用全局坐标记录页面，现有 Painter 无需分页专用接口。

## 复合与关系对象

### 纵向音轨模型

`Track` 就是谱面上的一条基线。它只描述“谁挂在谁上面/下面”的静态拓扑，不保存任何求解结果，因此是可以安全共享、反复 layout 的不变值；每一行的实际纵向轴由 layout 独立解出并存在自己的表里。同轨判断使用引用相等。

整个纵向拓扑机制只有一个方法：`track.group(laneKey, count, arrange)`。parallel 函数向宿主轨申请一组分支音轨，并给出把它们排进宿主局部坐标系的策略：

- **laneKey** 决定多次出现是否共用同一批音轨（同一条基线）。`stack` 固定用 `"stack"`，让一行里先后出现的多段临时伴奏落在同一条伴奏轨上；`voices` 用 `voices/成员数`，让成员数相同的块共线、成员数不同的块各自围绕宿主居中。
- **hostIndex** 声明哪个成员就地留在宿主轨，缺省为 0。`stack` 靠它保证主旋律不被打断（`1 2 &3` 里 `2` 仍在主轨）；`voices` 传 `null`，因为第一个声部也必须拥有独立轨道。
- **arrange** 是引擎与具体函数关于纵向排版的全部契约：`(host, members, gap) => placements`，参数与返回值只有数字。`stack` 用向上堆叠，`voices` 用“首末基线中点对齐宿主轴”。

因此 lowering 和 layout 都不需要认识 stack、voices 或任何将来新增的排版函数；新函数只要在 `timeFlowModel` 的 parallel 分支里给出这三个字段。因为一次出现就对应一批确定的音轨对象，`(layoutLine, track) -> 唯一纵向轴` 始终成立，歌词分组、beam 断组、tie 端点都不需要额外概念。

`up` 对全局时间流只产生一个 Temporal。每个参数复用普通 lowering hook，但必须恰好产生一个可见 Temporal；多事件子树、状态事件和零事件参数都会抛出 `E_UP_INVALID_CHILD`。成员不建立独立时间列，第一成员提供时长，最强 `ColType` 传播给外层 up，状态固化时所有成员共享 up 的 `t/track/layoutLine`。堆叠在一起的成员共享同一个时值：非零时长的成员一律归一到第一成员的时值，本来就没有时长的成员（标注、小节线）保持 0。因为成员不在全局 `objects` 里，它们的准备、定位和绘制全部由 `UpTemporal` 自己负责：准备直接复用引擎导出的 `prepareLayoutHost`，因此成员的装饰、端口与顶层对象完全一致。

`tie`、`beam`、`box` 和歌词实现 `LayoutAttachment`：它们附着于一个或多个主体对象，但不进入时间列。关系端点在解析期保存 AST 引用，lowering 通过 `astToTemporal: Map<ASTNodeBase, TemporalNodeBase[]>` 转换为本轮 temporal 引用；同一索引也供编辑器从 AST 定位一个或多个布局事件。被复合节点折叠进其他盒子的成员写下 `foldedInto`，查询时沿链上溯到宿主，因此写在成员上的标签等价于写在复合节点上。关系函数只读取可选的 `tie.top`、`div.N.left/right`、`lyric` 等命名端口，不依赖端点的具体 Temporal 类。

tie 直接比较端点固化后的 `layoutLine`。它允许跨轨：只要两端在同一行就直接画一条弧线，只有跨行时才拆成首行、可选中间行和末行，并分别申报纵向占用。

弧线本身是**填充的闭合弧带**：一条三次贝塞尔作外缘、反向一条作内缘，两端收尖、中部最厚，因此比等宽描边更接近乐谱习惯。两个控制点同高时实际弧高恰好是抬高的 3/4，因此控制点取 `height * 4/3` 就能让弧顶精确落在 `height`。默认 `height` 为声明处的 0.5em。

纵向占用按**曲线真实极值**计算，不把贝塞尔控制点直接计入。否则弧顶会被高估约三分之一，把上方的 stack 分支无谓地推开。

div 在 parse 阶段冻结 `autoBeamEnabled`，并只提供减时 addon、端口与局部绘制。beam 的 `loweringAugment` 消费这些协议：单个 div 内始终连接，独立 div 按拍自动分组，`@beam` 提供不受开关影响的手工覆盖。每个 beam attachment 在横向求解前把组内相邻边界两侧的 `alpha` 缩放为 0.8；组外侧不变。显式 beam 再由 `loweringFinalize` 验证端点按时间顺序属于同轨、同谱面行的相邻可见主体。自动分组、校验、弹簧准备和几何代码都位于 `src/functions/beam/`，div 不反向依赖 beam。

`box(width>0)` 仍属于全局时间列，不创建子系统。它在横向准备阶段登记成员覆盖的列跨度，现有求解器精确调整该跨度；其他轨在相同时刻共享同一列坐标。负宽保持自然布局，严格嵌套约束由内向外求解，交叉约束报错。

lowering 只维护通用 `LoweringGroup` 栈，并向作用域广播新 temporal 和 attachment；核心不识别 div、dot、box 或 voice。group 可同步观察或修改事件，也可携带一个退出时注册的 attachment。div/dot 各自固化自己的语义，box 保存成员 `LayoutBox`，voice 保存 temporal 用于歌词对齐。嵌套 attachment 按退出顺序注册，因此内层边界会先于外层边界计算。

显式换行同样在 lowering 中固化，并且是**全局**的：任何一轨的 `@br` 都会把整条时间线切开。br 是独立的 `SINGLE` 控制列，把非负整数参数 `offset`（默认 1）写入事件的 `breakBefore`；`layoutLine` 则是列归并后的输出，两个字段方向明确，不再复用同一个字段。固化时连续的换行列被当作一次换行处理：同一轨的请求累加（`@br @br` 换两行），不同轨的请求取最大（两轨同时 `@br` 只换一行）。因为 `SINGLE` 排在 `DEFAULT` 之前，同刻普通事件会进入新行，但不与 br 合列。br 自己在 `loweringFinalize` 中检测被切断的持续事件并抛出 `E_BREAK_INSIDE_EVENT`（简谱长音本来就写成 `1 - -`，因此真被切断基本都是写法错误）。layout 只按最终行号分组，不参与换行语义计算。

## AST 只读原则

AST 在解析完成后不再写入 lowering 或布局临时状态。每轮 lowering 的映射、辅助对象、分组栈和计数器全部由 `LoweringContext` 持有。同一个 AST 可以被多次 lowering，不会复用上一次产生的 Temporal 节点。