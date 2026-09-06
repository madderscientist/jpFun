---
title: Lowering
sidebar:
  order: 3
---

Lowering 将 AST 转换为带时间的事件列，供布局和播放使用。在绘制流程中，它位于解析与布局之间：
```text
源码 -> AST -> LoweringResult -> Layout -> Render
```

AST 适合表达嵌套语法，例如“这一组音符被二分”“两个声部并行”；排版器更关心每个对象在什么时间、哪条音轨上，以及哪些对象应排在同一列。Lowering 的任务，就是把前一种表示转换成后一种表示。

转换时会保留对象间的关系和音轨结构，但不会计算像素坐标或执行绘制。理解这一阶段，先看 Temporal、Column 和 Track 三个概念即可。

## 三个核心概念
### Temporal：时间事件
AST 节点可以在 `loweringEnter` 或 `loweringExit` 中产生 `TemporalNodeBase`。核心字段是：
```ts
class TemporalNodeBase {
    t: Fraction;      // 开始时间，单位 QN（四分音符时值）
    T: Fraction;      // 持续时间
    track: Track;     // 所在的纵向音轨
    mergeKey: number; // 合并组；相等才进同一个时间列。其中 -inf 有时间对齐锚点的含义
    ast: ASTNodeBase; // 来源 AST，便于定位和查找关系端点
}
```

函数通常只需给出事件自身的时长和行为。开始时间、音轨、创建顺序和来源 AST 由 `LoweringContext` 补齐。解析后的 AST 保持只读，这些本轮编译信息都保存在 Temporal 中。

### Column：时间列
布局根据 `columns` 确定横向对齐关系。同一列中的事件共享横向位置，但开始时间相同的事件不一定在同一列：跨轨归并时，还要求它们的 `mergeKey` 相等。
- `DEFAULT_KEY`（`Infinity`）：普通事件的公共组；并行音轨上同时发生时合列。
- 缺省值（事件自身的 `order`）：每个事件的值不同，因此各自独占一列；`key`、`tempo` 等控制事件使用这一规则，不打断相邻主体之间的对齐。
- 手写负常量：需要跨轨合并的事件取相同值，如声部名用 `-2` 合成一条标签列。
- `ANCHOR_KEY`（`-Infinity`）：对齐锚点，例如小节线；并行分支会在对应锚点处会合。归并算法需要先处理锚点列，所以它使用最小值。

`mergeKey` 也决定同一时刻各列的先后顺序，值越小，位置越靠左。

锚点对齐只发生在当前 `parallel` 子树内。某个分支先到锚点时会等待其他分支，较早分支后面的事件整体后移。这样临时多声部结束后，不会影响文档后面的时间。

### Track：纵向基线
`Track` 表示一条纵向基线及其静态父子关系，不保存最终的 y 坐标。真正的纵向位置由 layout 按谱面行求解。
- `sequence` 子节点沿用当前 Track。
- `parallel` 子节点通过 `track.group(...)` 获取各自的 Track。
- 相同 `laneKey` 会复用一组基线，不同 `laneKey` 会创建独立基线。
- `hostIndex` 指定哪个并行成员继续使用宿主 Track；传 `null` 表示所有成员都使用分支 Track。

具体函数通过 `measure` 声明组内成员的排列方式。如果整组位置还依赖宿主的完整占用，再提供 `place`。引擎按这些规则处理即可，不需要区分 `stack` 和 `voices`。

## 处理流程
入口是 `LoweringContext.lowerDocument(root)`。它创建根 Track，然后递归调用 `trackedEvents`：
```text
进入节点：调用 loweringEnter
展开子节点：按 timeFlowModel(ctx) 选择 sequence 或 parallel
离开节点：调用 loweringExit
```

### 1. 产生并追加事件
每个新事件会依次经历：
1. 补齐 `t`、`T`、`track`、`ast`、`order` 和默认 `mergeKey`。
2. 记录到 `astToTemporal`，供标签、tie、beam 等按 AST 查找端点。
3. 交给当前所有 `LoweringGroup` 观察或修改。
4. 加入时间列，并把时间游标推进到事件结束处。

分组通常在时间游标推进前修改事件。例如，`dot`、`div` 在进入节点时开启分组，在离开时关闭。组内事件先调整时长，后续事件便会从调整后的结束时间开始。

有些函数需要看完整段内容才能决定缩放比例，`tuplet` 就属于这一类。它先通过 `LoweringGroup` 收集事件，再在 `loweringExit(ctx, track, timeOffset)` 中统一调整。

使用这种方式时，需要同时修改事件的 `t/T` 和时间游标 `timeOffset`。只改事件，后续内容仍会从旧的组尾开始；只改游标，组内事件的时间又会保持不变。

### 2. 展开子节点
节点通过 `timeFlowModel(ctx)` 声明子节点如何流动：
```ts
type TimeFlowModel =
    | { mode: "sequence"; children: ASTNodeBase[] }
    | { mode: "parallel"; children: ASTNodeBase[]; tracks: TrackArrangement };
```

- `sequence`：依次展开；后一个子节点从前一个的结束时间开始。
- `parallel`：所有分支从同一时间开始，各自在自己的 Track 上展开，再按时间和锚点局部归并；父节点结束时间取最晚的分支。
- 返回 `null`：通用递归器不展开子节点，适合由函数自行折叠内容的复合符号。

调用 `timeFlowModel(ctx)` 时，当前节点在 `loweringEnter` 中返回的事件已经加入索引，子节点尚未展开。此时可以用 `ctx.getTemporalNodes(ast)` 查询本轮事件，不必把事件暂存在 AST 上。

`head` 就在这里为三个槽创建测量策略，并引用本轮的首边界 Temporal。策略中捕获的可变状态也属于本轮，不能在多次 Lowering 之间共享。

### 3. 固化行号和时间状态
递归完成后，`solidifyColumns` 先处理 `br` 请求并写入最终 `layoutLine`，再按列调用 `onTimeState(state)`。

这一步需要等到锚点归并完成，因为归并可能调整事件时间。调性、速度等依赖时间顺序的值，在 `onTimeState` 中从共享状态读取，并保存到 Temporal；AST 不参与这次状态更新。

`TimeState` 为速度、力度和调性提供了明确的类型和初值，函数可以直接读取。其他键由具体函数约定和处理。

其中只有 `velocity` 按音轨各自流动：力度属于声部，一个声部写 `$p` 不会压低同时发声的其它声部。新分叉出来的音轨沿 `Track.parent` 继承分叉处的力度，自己有了事件之后就不再跟随父轨。速度和调性整篇共享，写在任一音轨都影响所有声部。

### 4. 生成附属对象
时间列、Track 和行号确定后，就可以生成依赖完整结果的附属对象（attachment）：

1. 所有 `loweringAugment` 读取统一追加前的结果，返回额外 attachment，不直接修改结果。
2. 新 attachment 统一加入结果。
3. `loweringFinalize` 按函数注册顺序执行最终校验或收尾。

所有 `loweringAugment` 都读取追加前的结果，这里不会创建深拷贝。它们返回的附属对象收集完毕后统一追加，再进入 `loweringFinalize`。

因此，无论函数在注册列表中的位置如何，它的 `loweringFinalize` 都能看到全部派生对象。各个 finalizer 仍按注册顺序执行，后执行的回调可以看到前面回调的修改。

例如自动 beam 需要先看到最终的事件顺序、Track 和谱面行；显式 beam 也要到此时才能检查端点是否相邻。

## Temporal、Attachment 与 Decoration
新增功能时，可以按它与时间流、视觉主体的关系选择：
- **Temporal**：占据时间流，进入 `columns`，例如音符、小节线和控制事件。
- **LoweringAttachment**：不推进时间，连接或包围一个或多个主体，例如 tie、beam、box 和歌词。
- **LayoutDecoration**：属于单个主体的局部装饰，例如附点和减时线；Lowering 只把已冻结的语义放进 Temporal 的 `addon`，layout 再据此创建装饰。

`LoweringGroup` 用来观察一段内容：`onTemporal` 接收其中的事件，`onAttachment` 接收嵌套的附属对象，分组结束时还可以添加自己的 attachment。`dot`、`div`、`box` 等函数通过它实现各自的行为，引擎只需管理分组。

分组按栈顺序结束：先移出当前分组，再把它的 attachment 交给外层分组。因此，内部附属对象总是先于外层对象注册。

折叠函数通过 `isolateFromLoweringGroups` 展开内部成员。隔离期间，外层分组只会看到最终的折叠宿主，不会同时修饰成员和宿主；结束后恢复原来的作用域。

## 输出
```ts
interface LoweringResult {
    diagnostics: Diagnostic[];
    columns: TemporalNodeBase[][];
    attachments: LoweringAttachment[];
    astToTemporal: Map<ASTNodeBase, TemporalNodeBase[]>;
    duration: Fraction;
    rootTrack: Track;
    tracks: readonly Track[];
    page?: PageConfig;
}
```
- `diagnostics`：与 parser 及后续 layout 共享的诊断数组。
- `columns`：按时间和对齐规则组织的事件列。
- `attachments`：不推进时间的附属对象，按各自实现的接口参与布局或播放。
- `astToTemporal`：AST 到事件的一对多索引。
- `duration`：整份文档的总时长。
- `rootTrack`：纵向音轨树的根。
- `tracks`：实际承载 Temporal 的轨道；按首次使用顺序收集，空轨不进入。
- `page`：可选的页面配置。

## 如何把函数接入 Lowering
一个函数通常用 AST 类表达语法，需要进入时间流时，再定义 Temporal 类。函数列表会依次注册给 parser、lowering 和 layout：parser 读取语法声明，lowering 收集静态后处理 hook，layout 收集装饰处理器。

内置函数加入 `defaultFunctions` 即可。也可以通过 `compileScore(source, { functions })` 传入自定义列表；注意，这会替换默认列表，而不是追加到默认列表之后。

接入前先判断函数属于哪一类：

| 函数行为 | 主要入口 |
| --- | --- |
| 自己产生事件 | `loweringEnter` / `loweringExit` 返回 Temporal |
| 包裹并修饰一段内容 | `timeFlowModel` + `LoweringGroup` |
| 让多个分支同时发生 | `timeFlowModel` 的 `parallel` 模式 |
| 创建布局附件或声明跨事件语义 | `LoweringAttachment` + 能力接口 |
| 必须观察最终事件流 | `loweringAugment` / `loweringFinalize` |

下面用简化代码说明三种常见接入方式，省略了解析和绘制部分。

### 例一：`note` 直接产生事件

`note` 是叶子节点，进入时返回一个时长为 1 的 Temporal：

```ts
class NoteFunction extends ASTFunctionNode {
    override loweringEnter() {
        return [new NoteTemporalNode(this)];
    }
}

class NoteTemporalNode extends TemporalNodeBase {
    constructor(ast: NoteFunction) {
        super();
        this.ast = ast;
        this.T = 1;
        this.mergeKey = DEFAULT_KEY;
    }

    override onTimeState(state: Record<string, any>) {
        // 最终时间确定后，再结合当前调性解析音高
    }
}
```

这里不需要手动填写 `t`、`track` 和 `order`，`LoweringContext` 会根据事件所在位置补齐。AST 保存源码参数和区间，Temporal 保存时长、解析后的音高等结果。锚点对齐时可以直接调整事件时间，不必改动语法树。

### 例二：`div` 修饰整个子树
`div` 自己不产生事件，而是在进入时开启分组，让组内每个事件的时长减半；离开时关闭分组：
```ts
override loweringEnter(ctx: LoweringContext) {
    const count = this.n;
    ctx.beginLoweringGroup(this, {
        onTemporal(node) {
            const addon = node.addon ??= {};
            addon[DIV_ADDON_KEY] = (Number(addon[DIV_ADDON_KEY]) || 0) + count;
            node.T.divPow2(count);
        },
    }); return [];
}

override timeFlowModel() {
    return { mode: "sequence" as const, children: [this.content] };
}

override loweringExit(ctx: LoweringContext) {
    ctx.endLoweringGroup(this);
    return [];
}
```

这个分组既可以包住一个音符，也可以包住整段序列，处理方式相同。`div` 本身不必创建事件或额外的零时长列。

`onTemporal` 在时间游标推进前执行，所以后续事件会从减时后的结束位置开始。`addon` 则记下减时线的层数，供布局阶段使用；Lowering 引擎不需要了解这个值的具体含义。

### 例三：`stack` 展开并行分支
`stack` 只把子节点和分轨规则交给引擎：
```ts
const STACK_TRACKS = {
    laneKey: "stack",
    measure: measureAbove,
    place: placeAbove,
};

override timeFlowModel() {
    return {
        mode: "parallel" as const,
        children: this.contents,
        tracks: STACK_TRACKS,
    };
}
```

LoweringContext 会让所有分支从同一时间开始、分配 Track、归并锚点，并取最晚的分支作为结束时间。`stack` 固定使用 `laneKey: "stack"`，因此同一宿主上先后出现的临时伴奏可以复用基线；默认 `hostIndex: 0` 又让第一个成员延续主旋律的 Track。

`stack` 只声明并行关系、组内排列方式，以及可选的整组定位方式。递归、时间对齐和列归并都由引擎完成。新增另一种并行结构时，可以提供不同的 Track 声明，复用同一套时间算法。

### 何时使用全局后处理
普通 enter/exit 执行时，锚点归并和谱面行号还未完成。像自动 beam 这样依赖最终相邻关系的功能，应注册静态 hook：
```ts
class BeamFunction extends ASTFunctionNode {
    static override loweringAugment = createAutomaticBeamAttachments;
    static override loweringFinalize = validateExplicitBeamAttachments;
}
```

`loweringAugment` 根据完整列生成 attachment，`loweringFinalize` 则在全部追加完成后做校验。此时 `t`、`track` 和 `layoutLine` 已经确定，可以据此判断相邻关系和跨行情况。

### 最小接入步骤
1. 将函数类放入传给 `compileScore` 的函数列表。
2. 若函数产生时间主体，定义 Temporal，并从 `loweringEnter` 或 `loweringExit` 返回。
3. 用 `timeFlowModel` 声明子节点是 `sequence`、`parallel`，还是不由通用引擎展开。
4. 范围修饰使用 `LoweringGroup`；附属对象使用 `LoweringAttachment`，并实现需要的 layout/playback 能力接口。
5. 依赖最终时间流的逻辑放入静态 augment/finalize hook。

实现入口见 [`src/lowering/loweringContext.ts`](https://github.com/madderscientist/jpFun/blob/HEAD/packages/jpfun/src/lowering/loweringContext.ts)，数据结构见 [`src/lowering/types.ts`](https://github.com/madderscientist/jpFun/blob/HEAD/packages/jpfun/src/lowering/types.ts)，音轨模型见 [`src/lowering/track.ts`](https://github.com/madderscientist/jpFun/blob/HEAD/packages/jpfun/src/lowering/track.ts)。下一阶段参见 [Layout](../layout/)。