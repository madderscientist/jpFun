# Lowering

Lowering 位于“解析”和“排版”之间：
```text
源码 -> AST -> LoweringResult -> Layout -> Render
```

AST 适合表达嵌套语法，例如“这一组音符被二分”“两个声部并行”；排版器更关心每个对象在什么时间、哪条音轨上，以及哪些对象应排在同一列。Lowering 的任务，就是把前一种表示转换成后一种表示。

简单地说：**把 AST 树展开成带时间的事件列，同时保留排版需要的关系和音轨结构。** 它不计算像素坐标，也不负责绘制。

## 三个核心概念
### Temporal：时间事件
AST 节点可以在 `loweringEnter` 或 `loweringExit` 中产生 `TemporalNodeBase`。核心字段是：
```ts
class TemporalNodeBase {
    t: number;        // 开始时间，单位 QN（四分音符时值）
    T: number;        // 持续时间
    track: Track;     // 所在的纵向音轨
    type: ColType;    // 进入时间列的方式
    ast: ASTNodeBase; // 来源 AST，便于定位和查找关系端点
}
```

函数通常只需给出事件自身的时长和语义；`LoweringContext` 会补齐开始时间、音轨、创建顺序和来源 AST。AST 在解析完成后保持只读，后续信息都写入 Temporal。

### Column：时间列
`columns` 是排版器的横向输入。一个时间列包含应共享横向位置的事件，但“开始时间相同”不一定意味着“放进同一列”。`ColType` 用来区分：
- `DEFAULT`：普通事件；并行音轨上同时发生时可以合列。
- `SINGLE`：必须独占一列；常用于 `set`、`br` 等控制事件，避免遮断相邻主体的对齐。
- `ANCHOR`：对齐锚点，例如小节线；并行分支会在对应锚点处会合。

锚点对齐只发生在当前 `parallel` 子树内。某个分支先到锚点时会等待其他分支，较早分支后面的事件整体后移。这样临时多声部结束后，不会影响文档后面的时间。

### Track：纵向基线
`Track` 表示一条纵向基线及其静态父子关系，不保存最终的 y 坐标。真正的纵向位置由 layout 按谱面行求解。
- `sequence` 子节点沿用当前 Track。
- `parallel` 子节点通过 `track.group(...)` 获取各自的 Track。
- 相同 `laneKey` 会复用一组基线，不同 `laneKey` 会创建独立基线。
- `hostIndex` 指定哪个并行成员继续使用宿主 Track；传 `null` 表示所有成员都使用分支 Track。

具体函数只声明如何分轨和纵向排列；Lowering 不需要知道它是 `stack` 还是 `voices`。

## 实际处理流程
入口是 `LoweringContext.lowerDocument(root)`。它创建根 Track，然后递归调用 `trackedEvents`：
```text
进入节点：调用 loweringEnter
展开子节点：按 timeFlowModel 选择 sequence 或 parallel
离开节点：调用 loweringExit
```

### 1. 产生并追加事件
每个新事件会依次经历：
1. 补齐 `t`、`T`、`track`、`ast`、`order` 和默认 `ColType`。
2. 记录到 `astToTemporal`，供标签、tie、beam 等按 AST 查找端点。
3. 交给当前所有 `LoweringGroup` 观察或修改。
4. 加入时间列，并把时间游标推进到事件结束处。

分组必须在推进游标前修改事件。以 `dot`、`div` 为例，它们会在进入节点时开启分组，在离开时关闭；组内每个事件的时长先被修饰，后续事件才从修饰后的结束时间开始。

### 2. 展开子节点
节点通过 `timeFlowModel()` 声明子节点如何流动：
```ts
type TimeFlowModel =
    | { mode: "sequence"; children: ASTNodeBase[] }
    | { mode: "parallel"; children: ASTNodeBase[]; tracks: TrackArrangement };
```

- `sequence`：依次展开；后一个子节点从前一个的结束时间开始。
- `parallel`：所有分支从同一时间开始，各自在自己的 Track 上展开，再按时间和锚点局部归并；父节点结束时间取最晚的分支。
- 返回 `null`：通用递归器不展开子节点，适合由函数自行折叠内容的复合符号。

### 3. 固化行号和时间状态
递归完成后，`solidifyColumns` 先处理 `br` 请求并写入最终 `layoutLine`，再按列调用 `onTimeState(state)`。

时间状态不能更早固化，因为并行分支的锚点归并仍可能修改事件时间。调性、速度等依赖时间顺序的语义，应在 `onTimeState` 中从共享状态读取并冻结到 Temporal，而不是修改 AST。

### 4. 生成跨事件关系
时间列、Track 和行号全部稳定后，Lowering 才处理需要观察完整结果的关系：

1. 所有 `loweringAugment` 读取同一份结果快照，生成额外 attachment。
2. 新 attachment 统一加入结果。
3. `loweringFinalize` 按函数注册顺序执行最终校验或收尾。

例如自动 beam 需要先看到最终的事件顺序、Track 和谱面行；显式 beam 也要到此时才能检查端点是否相邻。

## Temporal、Attachment 与 Decoration
三者用途不同：
- **Temporal**：占据时间流，进入 `columns`，例如音符、小节线和控制事件。
- **LayoutAttachment**：不推进时间，连接或包围一个或多个主体，例如 tie、beam、box 和歌词。
- **LayoutDecoration**：属于单个主体的局部装饰，例如附点和减时线；Lowering 只把已冻结的语义放进 Temporal 的 `addon`，layout 再据此创建装饰。

`LoweringGroup` 是收集局部范围的通用工具：`onTemporal` 观察事件，`onAttachment` 观察嵌套 attachment，退出时还可以提交自己的 attachment。核心引擎因此不必认识 `dot`、`div`、`box` 等具体函数。

## 输出
```ts
interface LoweringResult {
    diagnostics: Diagnostic[];
    columns: TemporalNodeBase[][];
    attachments: LayoutAttachment[];
    astToTemporal: Map<ASTNodeBase, TemporalNodeBase[]>;
    duration: number;
    rootTrack: Track;
    page?: PageConfig;
}
```
- `diagnostics`：与 parser 及后续 layout 共享的诊断数组。
- `columns`：按时间和对齐规则组织的事件列。
- `attachments`：不推进时间的排版关系。
- `astToTemporal`：AST 到事件的一对多索引。
- `duration`：整份文档的总时长。
- `rootTrack`：纵向音轨树的根。
- `page`：可选的页面配置。

## 如何把函数接入 Lowering
一个函数通常由 AST 类表达语法，必要时再定义一个 Temporal 类表达它在时间流中的实例。函数类列表会依次注册给 parser、lowering 和 layout：parser 用它识别函数，lowering 收集静态后处理 hook，layout 收集装饰处理器。内置函数需要加入 `defaultFunctions`；调用 `compileScore(source, { functions })` 传入自定义列表时，该列表会替换默认列表。

接入前先判断函数属于哪一类：

| 函数行为 | 主要入口 |
| --- | --- |
| 自己产生事件 | `loweringEnter` / `loweringExit` 返回 Temporal |
| 包裹并修饰一段内容 | `timeFlowModel` + `LoweringGroup` |
| 让多个分支同时发生 | `timeFlowModel` 的 `parallel` 模式 |
| 连接已有主体 | `LayoutAttachment` |
| 必须观察最终事件流 | `loweringAugment` / `loweringFinalize` |

下面的代码省略了解析和绘制部分，只展示当前实现中的 lowering 思路。

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
        this.type = ColType.DEFAULT;
    }

    override onTimeState(state: Record<string, any>) {
        // 最终时间确定后，再结合当前调性解析音高
    }
}
```

这里没有手动填写 `t`、`track` 和 `order`，因为它们取决于事件出现的位置，应由 `LoweringContext` 统一补齐。AST 保存源码参数和位置，Temporal 保存时长、已解析音高等可固化信息；这样锚点对齐可以调整事件时间，而不必修改语法树。

### 例二：`div` 修饰整个子树
`div` 自己不产生事件，而是在进入时开启分组，让组内每个事件的时长减半；离开时关闭分组：
```ts
override loweringEnter(ctx: LoweringContext) {
    const count = this.n;
    ctx.beginLoweringGroup(this, {
        onTemporal(node) {
            const addon = node.addon ??= {};
            addon[DIV_ADDON_KEY] = (Number(addon[DIV_ADDON_KEY]) || 0) + count;
            node.T /= 2 ** count;
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

这样设计有三个原因：
- `div` 不是时间主体，不应为了表达修饰而制造一个零时长列。
- 内容可以是一个音符，也可以是整段序列；分组对两者使用同一套逻辑。
- `onTemporal` 在时间游标推进前执行，所以后续事件会从减时后的结束位置开始。

`addon` 保留“有几层减时线”这一排版语义，但核心 Lowering 只负责调用通用分组，并不认识 `div`。

### 例三：`stack` 声明并行，不实现并行算法
`stack` 只把子节点和分轨规则交给引擎：
```ts
const STACK_TRACKS = {
    laneKey: "stack",
    arrange: arrangeAbove,
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

函数只声明“并行”和“怎么纵向排列”，而不自己实现递归与对齐。以后增加另一种并行结构时，只需更换 Track 声明和 `arrange`，无需复制时间算法，也无需让引擎硬编码函数名。

### 何时使用全局后处理
普通 enter/exit 执行时，锚点归并和谱面行号还未完成。像自动 beam 这样依赖最终相邻关系的功能，应注册静态 hook：
```ts
class BeamFunction extends ASTFunctionNode {
    static override loweringAugment = createAutomaticBeamAttachments;
    static override loweringFinalize = validateExplicitBeamAttachments;
}
```

`loweringAugment` 根据完整列生成 attachment；`loweringFinalize` 在所有新增关系就位后做校验。把这一步放到遍历之后，可以避免函数根据尚未稳定的 `t`、`track` 或 `layoutLine` 提前作出错误判断。

### 最小接入步骤
1. 将函数类放入传给 `compileScore` 的函数列表。
2. 若函数产生时间主体，定义 Temporal，并从 `loweringEnter` 或 `loweringExit` 返回。
3. 用 `timeFlowModel` 声明子节点是 `sequence`、`parallel`，还是不由通用引擎展开。
4. 范围修饰使用 `LoweringGroup`，跨主体关系使用 `LayoutAttachment`。
5. 依赖最终时间流的逻辑放入静态 augment/finalize hook。

实现入口见 [`src/lowering/loweringContext.ts`](../src/lowering/loweringContext.ts)，数据结构见 [`src/lowering/types.ts`](../src/lowering/types.ts)，音轨模型见 [`src/lowering/track.ts`](../src/lowering/track.ts)。下一阶段参见 [Layout](layout.md)。