# 架构

**宗旨：框架实现基础机制，具体功能由函数类自己实现。函数之间完全解耦。**

简谱中符号种类繁多，若将符号逻辑耦合到布局算法中，复杂性会剧增且难以扩展。因此本系统将每一步都设计为"引擎调度 + 函数声明"模式：引擎不知道具体符号的含义，函数不知道引擎的内部实现。

## 流水线

```
源码字符串 → [解析] → AST树 → [时间流化] → 时间列 → [布局] → 谱面坐标
```

三个阶段各自独立，通过数据结构传递：

### 1. 解析
将源码解析为 AST 树。解析器只负责基础语法（函数调用、大括号、标签）和调度，函数自行处理参数和语法糖。  
→ 详见 [parseAST.md](parseAST.md) · 代码：`src/parser/` · AST 类型：`src/functions/ASTtypes.ts`

### 2. 时间流化（Lowering）
将 AST 树展开为时间流——一个按时间排序的列列表，每列包含同一时刻的所有元素。这一步处理：时间变换（附点/减时线）、多声部锚点对齐、调性/速度固化。  
→ 详见 [lowering.md](lowering.md) · 代码：`src/lowering/`

### 3. 布局
从时间流计算横纵坐标。采用弹簧模型：元素时长越大边距越大，空间不足时按比例压缩。多行元素通过列对齐联动。  
→ 详见 [layout.md](layout.md) · 代码：`src/layout/`

## 解耦机制

### 函数即声明

每个内置函数继承 `ASTFunctionNode`，通过覆盖 hooks 声明自己的行为：
- **解析阶段**：`deSugarAtom` / `deSugarRelation`（语法糖）、`def`（参数定义）
- **时间流化阶段**：`timeFlowModel`（子节点展开模式）、`loweringEnter`/`loweringExit`（进入/离开回调）、`timeWrapConfig`（时间变换）、`onTimeState`（时间信息固化）

引擎遍历 AST 时调用这些 hooks，但不关心具体函数类型。新增函数只需写子类并注册，引擎零改动。

### 时间流化的两步设计

时间流化不能在遍历时一次性完成，因为存在**锚点对齐**（多声部按小节线同步时间），这会修改时间。因此拆为两步：

1. **trackedEvents**：递归遍历 AST，生成时间事件，局部归并 parallel 分支
2. **onTimeState**：锚点对齐完成后，按时间顺序固化调性/速度等状态

### ColType：列合并策略

时间列合并时，不同元素有不同需求：
- `ANCHOR`（如小节线）：跨轨对齐点，缓冲等待所有轨道汇齐
- `SINGLE`（如设置类）：单独成列，不与同时刻元素合并
- `DEFAULT`（如音符）：同时刻合并为同一列

这解决了零时长元素（如 `@set`）破坏对齐的问题。

## 后续方向

当前时间流层的 `TemporalNodeRecord` 是 interface，下游渲染需回调 AST 方法，耦合未完全消除。计划引入两层继承体系：

- **TemporalNode 继承体系**：每个基础元素类型（note/bar/dash）有自己的子类，携带类型化字段和 `render()` 方法。AST 节点精简为 TemporalNode 的工厂，lowering 后不再被下游引用。
- **Decoration 继承体系**：装饰性函数（div/dot）创建 Decoration 对象，携带 `applyTimeWrap()` 和 `render()` 方法，替代当前的 `addon` 无类型字典和 `timeWrapConfig` 静态注册。
- **关系型函数后处理**：beam/tie 不参与时间流，lowering 后用 AST 引用匹配 endpoint，生成关系元数据。

这两层继承使引擎只需调用 `node.render(ctx)` 和 `decoration.render(ctx, bounds)`，多态自动分发，无需 switch 或字符串查表。


# 架构
宗旨：框架实现基础机制，具体功能由函数类自己实现。函数之间松耦合。

## 1. 语法解析
[语法解析](parseAST.md)

## 2. 时间流化
[时间流化](lowering.md)

之后的两个树是两个相对独立的分支。他们之间通过源码树进行链接。【我在想是不是要引入id、用Map进行索引？还是直接引用对象？感觉前者更好维护】
## 音乐语义树
从源码解析树中创建

## 排版树
从源码解析树中创建