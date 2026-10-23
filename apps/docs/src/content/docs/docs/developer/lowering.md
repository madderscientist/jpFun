---
title: Lowering
description: 将语法嵌套转换为音乐时间、事件列、轨道与附属关系。
sidebar:
    order: 4
---

Lowering 将 AST 的语法嵌套树形结构转换为音乐时间上的扁平事件，并得到对齐关系与轨道结构。输出 `LoweringResult` 是布局和播放的共同输入，后续分别用于计算像素坐标和展开演奏顺序。

简单理解：输出时间轴，每个时间点对应一系列在该时刻发生的事件，每个事件有起点、时长和所属音轨。

## 时间模型

时间以四分音符时值（QN）为单位，用分数类 `Fraction` 表达。开始时间 `t` 与持续时间 `T` 描述谱面上的音乐位置，不受播放速度影响；速度决定这些位置如何映射为实际秒数。

时间位置、横向对齐和纵向归属是三个独立维度，分别由 Temporal、Column 和 Track 表达。

### Temporal：时间事件
Temporal 是本轮 Lowering 产生的事件实例。它可以有持续时间，也可以是零时长的控制或边界事件。`TemporalNodeBase` 的核心字段是：
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

可选的语义声明统一放在 `addon?: TemporalAddon`，不再为每种控制函数增加基础节点字段：

```ts
interface TemporalAddon {
    breakBefore?: number;    // 当前列之前的换行偏移，缺省为 0
    pageBreakBefore?: boolean; // 当前行之前换页；布尔值指定上一页是否分配余白
    [key: `@${string}`]: unknown;
}
```

核心读取明确的通用字段；函数私有语义继续使用 `functionAddonKey` 生成的 `@主函数名`，读取时需收窄 `unknown`。`pageBreakBefore=false` 仍表示换页，必须用 `!== undefined` 判断是否存在。换页控制同时声明 `breakBefore=1`，以复用换行、合列和持续事件校验。

复合节点在 Lowering 时接管宿主的语义；布局时通过 `transferFunctionAddons` 只向内部宿主转移 `@` 键，核心边界声明留在全局事件上。不能在折叠内部换行的成员，在清空或转交 addon 之前完成校验。

### Column：时间列
布局根据 `columns` 确定横向对齐关系（简谱上哪些在同一列）。同一列中的事件共享横向位置，但开始时间相同的事件不一定在同一列：跨轨归并时，还要求它们的 `mergeKey` 相等。
- `DEFAULT_KEY`（`Infinity`）：普通事件的公共组；并行音轨上同时发生时合列。
- 缺省值（事件自身的 `order`，自然数）：每个事件的值不同，因此各自独占一列；`key`、`tempo` 等控制事件使用这一规则，不打断相邻主体之间的对齐。
- 手写负常量：需要跨轨合并的事件取相同值，如声部名用 `-2` 合成一条标签列。
- `ANCHOR_KEY`（`-Infinity`）：对齐锚点，例如小节线；并行分支会在对应锚点处会合。归并算法需要先处理锚点列，所以它使用最小值。

`mergeKey` 也决定同一时刻各列的先后顺序，值越小，位置越靠左。

锚点对齐只发生在当前 `parallel` 子树内。某个分支先到锚点时会等待其他分支，较早分支后面的事件整体后移。这样临时多声部结束后，不会影响文档后面的时间。

### Track：纵向基线
`Track` 表示一条纵向基线及其静态父子关系，不保存最终的 y 坐标。真正的纵向位置由 layout 按谱面行求解。Track 的创建和函数节点的类型有关：
- `sequence` 类型的函数，其子节点沿用当前 Track，事件串行。比如 `div` 函数
- `parallel` 类型的函数，其子节点并行展开，落入不同的 Track。比如 `voices` 和 `stack` 函数

## 附属关系与作用域

各类语义按参与时间流的方式组织：

| 对象 | 与时间流的关系 | 用途 |
| --- | --- | --- |
| `Temporal` | 进入 `columns`，占据时间位置，时长可以为零 | 音符、小节线、控制事件 |
| `LoweringAttachment` | 不推进时间，引用事件或其他边界 | 连音线、连梁、反复控制、页码等 |
| `LayoutDecoration` | 不独立进入时间流，属于单个主体 | 附点、减时线；Lowering 只把语义写入 Temporal 的 `addon` |

`LoweringGroup` 提供作用域机制，观察一段子树中的事件与附件，用于减时、附点、包围框等范围行为。嵌套分组由内向外生效，折叠对象可以隔离内部成员，避免外层修饰同时作用于成员和宿主。

## 输出契约

`LoweringResult` 保留音乐时间及其来源索引：

| 字段 | 含义 |
| --- | --- |
| `columns` | 按时间和对齐规则组织的事件列 |
| `attachments` | 按能力接口参与布局或播放的附属对象 |
| `astToTemporal` | AST 到本轮事件的一对多索引 |
| `duration` | 反复展开前的谱面音乐总时长 |
| `rootTrack` / `tracks` | 轨道树根 / 按首次使用顺序收集的实际承载事件的轨道 |
| `page` | 可选的页面配置，供布局阶段消费 |
| `diagnostics` | 与解析及后续布局共享的诊断数组 |

AST 在解析后保持只读。事件、分组和测量策略中的运行状态属于本轮 Lowering；重新布局应创建新的 Lowering 结果，不能复用已经被布局写入状态的对象。

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

`head` 的首边界收集本轮成员，并为三个槽创建测量策略。测量状态也属于本轮，不能在多次 Lowering 之间共享。

### 3. 固化行号和时间状态
递归完成后，`solidifyColumns` 先处理 `addon.breakBefore` 请求并写入最终 `layoutLine`：同列取最大偏移，同轨连续列累加。随后按列调用 `onTimeState(state)`。

这一步需要等到锚点归并完成，因为归并可能调整事件时间。调性、速度等依赖时间顺序的值，在 `onTimeState` 中从共享状态读取，并保存到 Temporal；AST 不参与这次状态更新。

`TimeState` 为速度、力度、调性和音色提供了明确的类型和初值。可选字段 `meter?: Fraction` 表示显式拍号的小节时长（QN），无默认值。其他自定义键由具体函数约定和处理。

其中 `velocity` 和 `program` 按音轨各自流动：一个声部写 `$p` 或 `@program(...)` 不会改变同时发声的其他声部。新分叉的音轨沿 `Track.parent` 继承父轨状态，首次承载事件后独立保存。速度和调性整篇共享，写在任一音轨都影响所有声部。

`onTimeState` 可返回非负 `Fraction`，以同列返回值的最大值推迟所有后续列；零值或不返回值不推进时间。回调须保持同轨事件终点的时序前进。发生偏移后，总时长取各轨尾节点的实际终点最大值，而非原时长加累计偏移。

`up/down`、`grace` 与 `arpeggio` 透传宿主的最终时值、时间偏移和布局行为；非宿主成员不单独推进全局时间。

`TimeState.currentEvent` 指向当前执行的全局 Temporal，折叠成员共用宿主位置。`meter` 据此记录最终拍号和校验区间；`rest` 登记最早同轨休止成员，排除私有倚音。

`head` 在末边界的 `onTimeState` 中校验成员的最终时值，确保延迟确定时值的内容也遵守零时长约束。

`rest` 要求显式拍号，按起点拍号确定时长，并独立于普通音符合列；其偏移使后续所有声部共同后移。在 `loweringEnter` 中通过 `ctx.deferFinalize(RestFunction.loweringFinalize, -10)` 登记收尾回调，为同列最长休止补入 n−1 个普通不可见小节边界，确保先于默认优先级（`0`）的 `meter` 校验，不依赖函数注册数组顺序。

### 4. 按需收尾与派生附属对象
时间列、Track 和行号确定后，执行本轮通过 `ctx.deferFinalize(fn, order)` 登记的收尾回调，严格按显式 `order`（默认 `0`，越小越先执行）升序调度：

- `rest`（`order = -10`）先补入多小节休止内部的虚拟小节边界；
- `div`（`order = -5`）根据完整列与显式 beam 端点生成自动连梁 attachment；
- `meter`、`br`、`beam`、`dyn`、`ottava`、`tuplet`、`tremolo`、`gliss`（默认 `order = 0`）执行最终校验或状态收尾。

所有收尾回调由各函数在 `loweringEnter` / `loweringExit` 中按需登记（相同函数引用自动去重并取最小 `order`）。未在本轮文档中调用的函数不会登记回调，也不会触发全谱扫描。

### 分组观察与隔离

`LoweringGroup.onTemporal` 接收作用域内的事件，`onAttachment` 接收嵌套的附属对象，分组结束时还可以添加自己的 attachment。

分组按栈顺序结束：先移出当前分组，再把它的 attachment 交给外层分组。因此，内部附属对象总是先于外层对象注册。

折叠函数通过 `isolateFromLoweringGroups` 展开内部成员。隔离期间，外层分组只会看到最终的折叠宿主，不会同时修饰成员和宿主；结束后恢复原来的作用域。

## 函数接入
一个函数通常用 AST 类表达语法，需要进入时间流时，再定义 Temporal 类。函数列表会依次注册给 parser 和 layout：parser 读取语法声明，layout 收集装饰处理器；lowering 在遍历 AST 时按需执行各节点的实例方法。

内置函数加入 `defaultFunctions` 即可。也可以通过 `compileScore(source, { functions })` 传入自定义列表，该列表会替换默认列表。扩展内置能力时，应将 `defaultFunctions` 一并包含在自定义列表中。

接入前先判断函数属于哪一类：

| 函数行为 | 主要入口 |
| --- | --- |
| 自己产生事件 | `loweringEnter` / `loweringExit` 返回 Temporal |
| 包裹并修饰一段内容 | `timeFlowModel` + `LoweringGroup` |
| 让多个分支同时发生 | `timeFlowModel` 的 `parallel` 模式 |
| 创建布局附件或声明跨事件语义 | `LoweringAttachment` + 能力接口 |
| 必须观察最终事件流 | `ctx.deferFinalize(fn, order)` |

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
        this.T.set(1);
        this.mergeKey = DEFAULT_KEY;
    }

    override onTimeState(state: TimeState) {
        // 最终时间确定后，再结合当前调性解析音高
    }
}
```

`LoweringContext` 根据事件所在位置补齐 `t`、`track` 和 `order`。AST 保存源码参数和区间，Temporal 保存时长、解析后的音高等结果。锚点对齐直接调整事件时间，AST 保持只读。

### 例二：`div` 修饰整个子树
`div` 在进入时开启分组，让组内每个事件的时长减半；离开时关闭分组：
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

### 何时使用按需收尾
普通 enter/exit 执行时，锚点归并和谱面行号还未完成。像显式 beam 校验这样依赖最终相邻关系的功能，可在 `loweringEnter` 中通过 `ctx.deferFinalize` 登记静态 `loweringFinalize`：
```ts
class BeamFunction extends ASTFunctionNode {
    private static loweringFinalize = validateExplicitBeamAttachments;

    override loweringEnter(ctx: LoweringContext) {
        ...
        ctx.deferFinalize(BeamFunction.loweringFinalize);
        return [];
    }
}
```

收尾回调在时间列、Track 和 `layoutLine` 全部确定后按 `order` 优先级执行，可以据此派生 attachment、判断相邻关系或检查跨行情况。

### 最小接入步骤
1. 将函数类放入传给 `compileScore` 的函数列表。
2. 若函数产生时间主体，定义 Temporal，并从 `loweringEnter` 或 `loweringExit` 返回。
3. 用 `timeFlowModel` 声明子节点是 `sequence`、`parallel`，还是不由通用引擎展开。
4. 范围修饰使用 `LoweringGroup`；附属对象使用 `LoweringAttachment`，并实现需要的 layout/playback 能力接口。
5. 依赖最终时间流的逻辑在 `loweringEnter` / `loweringExit` 中通过 `ctx.deferFinalize` 按需登记。

实现入口见 [`src/lowering/loweringContext.ts`](https://github.com/madderscientist/jpFun/blob/HEAD/packages/jpfun/src/lowering/loweringContext.ts)，数据结构见 [`src/lowering/types.ts`](https://github.com/madderscientist/jpFun/blob/HEAD/packages/jpfun/src/lowering/types.ts)，音轨模型见 [`src/lowering/track.ts`](https://github.com/madderscientist/jpFun/blob/HEAD/packages/jpfun/src/lowering/track.ts)。下一阶段参见 [Layout](../layout/)。