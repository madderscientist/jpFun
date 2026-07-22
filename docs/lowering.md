# Lowering
这一步发生在 AST 解析后。AST得到的是树形结构，而乐谱要求的是时间流形式；这一步的目标就是：从AST到事件流。

下一步是 [layout](layout.md)，它的目标是：从事件流到最终的谱面。这一步核心步骤——横向布局算法，接收的是具有以下结构的事件，并得到横坐标：
```ts
interface TimeLineEvent {
    t: number; // 事件发生的时间点
    T: number; // 事件的持续时间
    track: any; // 事件所属轨道的任意标识符
}
```
这一步就是要把这些属性得到。

当前完整输出为：
```ts
interface LoweringResult {
    columns: TemporalNodeBase[][];
    attachments: LayoutAttachment[];
    astToTemporal: Map<ASTNodeBase, TemporalNodeBase[]>;
    duration: number;
    page?: PageConfig;
}
```

- `columns` 是参与时间对齐和横向弹簧布局的时间列
- `attachments` 是 tie、beam、box、歌词等不推进时间、附着于主体的排版对象
- `astToTemporal` 处理标签端点、源码定位和一个 AST 产生多个 temporal 的情况
- `duration` 是整个 lowering 范围的总时长
- `page` 是可选的文档页面配置；没有声明时 layout 使用默认页面

## 时间变换对机制的影响
存在 `dot` `div` 这类变换时间的函数，具体计算过程如下：
```ts
function applyTimeWrap(base: number, dotCnt: number, divCnt: number): number {
    return base * (2 - Math.pow(2, -dotCnt)) / (1 << divCnt);
}
```

这类函数的作用是独立且有先后顺序的。为了解耦，肯定不能用上面的方式实现，所以需要设计一个计算时间的机制。在解析前，每个函数先注册自己的时间变换函数，获取任意节点时长时，就依照优先级以此处理。由于本项目的 `div` 和 `dot` 是可以嵌套的，因此需要维护一个上下文，记录当前 `dot` 和 `div` 的数量，于是上下文需要 `variables: Record<string, any>` 记录这些信息；落实到音符上时，也要将这些信息刻画进去、供后续阶段使用（比如这个音符上有几个附点等），因此还需要给每个事件加上额外的属性，因此在 `TimeLineEvent` 的基础上增加了 `addon` 这个字段，按需使用。这种注册机制延续了函数的解耦性，函数自己决定如何处理时间变换，而不需要引擎去硬编码。

时间变换的注册通过 `ASTNodeBase.timeWrapConfig` 进行，返回函数和优先级，在解析前被 `loweringContext` 收集。

作用域在 `parse` 阶段使用上下文复制，只需要在进入新作用域前复制一次。lowering 还需要在节点进入和离开时分别修改状态或管理排版分组，因此提供 `loweringEnter` 和 `loweringExit` 两个 hook。hook 可以生成时间事件，也可以只操作 `LoweringContext`，例如 box 用它们开始和结束成员收集。

为了保证后续的解耦，需要把装饰上下文固化到对应事件的 `addon`。只有以 `@` 开头的字段会被快照，例如附点数量存储在 `@dot`。layout 使用完整 key 查询函数类注册的 `layoutDecorationConfig`，不判断具体装饰函数。

## 锚点对齐和时间信息固化
时间信息固化指的是根据时间上下文对属性进行固化。比如如果音符是简谱记法，则绝对音高和当前调性有关。固化 hook 位于 Temporal 节点上，AST 保持只读。Temporal 仍保留产生自己的 AST 引用，用于 SourceSpan、标签端点映射和编辑器定位。

这一步能做在遍历时吗？不行，因为还有“锚点对齐”。这一步指的是多声部之间按照小节线（这一类“时间锚点属性”）局部对齐时间。对于 `parallel` 类型的时间流式，不同track之间就依赖小节线同步时间；而对齐的实现最好是在获取了每个track的所有事件后、进行类似归并排序的方式。这一步会修改时间，所以“时间固化”必须在“锚点对齐”之后进行。

锚点对齐不好做。有两个大方向：
1. 自底而上，在扫AST的时候完成，局部归并。
2. 先得到分轨，然后再从头开始归并

第二种很优雅，但是有一个重大问题：假设主声部是A，是不是有临时多声部，且这些临时多声部之间不连续。这就会导致在没有临时多声部的地方如果有对齐锚点，会影响到后面的临时多声部。要用这个方案，要么得在临时多声部结束后加上隐形特殊锚点，要么判断时间是否连续。我感觉都不够优雅。

只能选择第一种了，相当于多次局部进行方法二。

关注一个问题：
```
TrackA: 1  @set()  2
TrackB: 1  2
```
由于 `set` 的时长为0，导致第二列会变为 `[TrackA.set, TrackB.2]`（同一个轨道里起始时间相同不应合并所以不会有 `TrackA.2`），这就破坏了对齐（对齐最重要的目的是进行layout求解）。解决办法是把 `set` 设置为 `SINGLE` 类型，这种类型必须单独成列，就能保证两个 `2` 对齐了。于是 `SINGLE` 和 `ANCHOR` 成为了两个特殊类型，需要 AST 节点告知。

## 轨道管理
由于可以随时插入轨道（临时多声部），因此要对轨道编码。做法是后缀，表示派生分支。
分支应该只有parallel类型可以派生。

## 总结
为了完成这一步，需要给 AST 节点增加：
- `timeWrapConfig`：注册时间变换函数，可选
- `loweringEnter`：进入时的 hook
- `loweringExit`：离开时的 hook
- `loweringFinalize`：时间列、状态和实际行号固化后的关系生成 hook，可选

为了让结构更加清晰，将时间固化的对象变成了一个新的类体系——`TemporalNode`，AST 的 `loweringEnter` 和 `loweringExit` 就返回这个类型的列表。在 AST 成型后，就不应该修改了，之后的所有操作都是对这个类的操作。

为了完成时间分配与固化，这个类需要有以下属性：
- `t` `T` 起始时间和时长
- `type`：类型，普通事件、锚点事件、单独成列事件
- `onTimeState`：时间固化的 hook，可选
- `ast`：引用产生自己的 AST 节点，保证可以溯源到 `span`

下游阶段还会使用：
- `track`：轨道标识符，给 layout 用
- `order`：本轮 lowering 的稳定创建序号，用于同时刻事件和合并列的确定性排序
- `addon`：附加属性，给 render 用

每个子类还有自己的属性，比如音符在时间固化之后的音高、渲染信息等。

## 局部 lowering
`LoweringContext.lowerFragment` 用于 `over` 这类不希望子事件进入全局时间列的复合函数。它复用当前时间变换注册表和 AST 映射，但隔离局部 attachment 与分组栈。局部状态由复合节点在自己的 `onTimeState` 中从外层时间点复制，每一层之间互不污染。

## 分组与关系
`beginLayoutGroup` / `endLayoutGroup` 收集递归范围内生成的 `LayoutBox` 和 Temporal 引用。`box` 用成员盒求总边界，`voice` 用成员端口对齐歌词。

函数类可以注册 `loweringFinalize`，在最终时间列、时间状态和 `layoutLine` 都固化后生成关系对象。完整文档和 `lowerFragment` 都会执行该 hook，因此 over 的局部层也能生成自己的自动关系。beam 模块使用该 hook 扫描 div 事件：同一个 div 内按轨道始终连接；多个独立 div 仅在各自解析时冻结的 `autoBeamEnabled` 都为 true 时自动连接。

自动分组参考 MuseScore 和 LilyPond 的 beat structure 模型。当前语言尚无拍号，因此暂用四分音符作为固定拍单位，并在轨道、逻辑行、拍边界、小节线、时间间隙、普通长事件或显式 beam 处断组。将来加入拍号后，只需替换 beam 模块的拍结构来源，LoweringContext 不需要识别规则。

beam/tie 自身不产生时间事件。它们在 `loweringEnter` 中从 `astToTemporal` 查询端点并注册 `LayoutAttachment`。因此关系对象不会改变时间指针，也不会被塞入横向时间列。

这种分离保证时间求解不理解具体关系函数，关系排版也不会反向修改时间结果。
