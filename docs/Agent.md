# jpFun 项目速览
本文档用于帮助新的 AI 对话快速理解当前仓库真实状态。

## 1. 项目定位

- 项目名：`jpFun`
- 定位：函数式简谱脚本系统，用 DSL 描述简谱并排版渲染
- 核心设计原则：**函数完全解耦，声明式，引擎仅调度不参与符号逻辑**
- 语法入口：`grammar.md`

## 2. 三阶段流水线

```
源码字符串 → [1. 解析] → AST树 → [2. 时间流化(lowering)] → 时间列列表 → [3. 布局] → 谱面坐标
```

- 阶段1：源码解析（含语法糖去糖、参数固化），详见 [parseAST.md](parseAST.md)
- 阶段2：AST树 → 时间流（时间求解/锚点对齐/时间固化），详见 [lowering.md](lowering.md)
- 阶段3：时间流 → 横纵坐标（弹簧模型布局），详见 [layout.md](layout.md)

## 3. 目录与职责

```
src/
├── parser/
│   ├── parserContext.ts    解析主入口，两阶段：parseGrammar + makeNodes
│   ├── grammarType.ts      GrammarNode 中间层（call/brace/label/sugar）
│   ├── preprocess.ts      注释掩码 + lineStarts（单扫描、低分配）
│   ├── diagnostic.ts       诊断基类、错误码工厂、offset→行列转换
│   ├── types.ts            SourceSpan（左闭右开）、LengthValue
│   └── parse-utils/        call/brace/label/note 底层读取工具
├── functions/
│   ├── ASTtypes.ts         AST 节点基类与参数框架（核心）
│   ├── default.ts          defaultFunctions 注册表
│   └── */index.ts          各函数节点实现
├── lowering/
│   ├── loweringContext.ts  时间流化引擎（trackedEvents/anchorAlign/onTimeState调度）
│   └── types.ts            TimeLineEvent / TemporalNodeRecord / ColType / TimeFlowMode
├── layout/                 布局算法（弹簧模型 + CG求解器）
└── test/                   演示与人工观察入口
```

## 4. 解析系统

### 执行流程

1. `preprocessSource(source)` → `maskedSource`（注释替换为空格）+ `lineStarts`
2. 用 `maskedSource` 构造 `ParserContext`
3. `ctx.registerFunctions(defaultFunctions)` 注册函数类
4. `ctx.parse()` → `ASTNode[]`

### 两阶段解析

`ParserContext.parse(start, end)`：
1. **parseGrammar()**：识别 `@call(...)`、`@label`、`{...}`；原子语法糖触发；未识别字符以索引保留
2. **makeNodes()**：GrammarNode → AST节点；关系语法糖触发；剩余内容合并为 `ASTTextNode`

### AST 类型体系（`src/functions/ASTtypes.ts`）

| 类 | 职责 |
|---|---|
| `ASTNodeBase` | 基类：`sourceSpan`、`parent`、`children`、lowering hooks |
| `ASTTextNode` | 无语义文本占位 |
| `ASTBraceNode` | `{...}` 容器，children 为 content 数组 |
| `ASTLabelNode` | 语义标记，不参与渲染，用于编辑器高亮和关系型函数引用 |
| `ASTFunctionNode` | 函数节点基类：`def`、`deSugarAtom`、`deSugarRelation`、`getArgValue`、`labelable` |

### 参数取值顺序（`getArgValue`）

1. 显式传参（命名优先，再位置）
2. `ctx.variables` 中的 `函数前缀.参数名`
3. 参数默认值

### 语法糖三类

1. 消费未来字符（如 `note` 的 `A3#`）→ 第一阶段
2. 消费未来字符 + 过去节点（如 `div` 的 `//`）→ 第一阶段锚点 + 第二阶段消费
3. 消费未来字符 + 未来节点（如 `voice` 的 `N:`/`L:`）→ 第一阶段锚点 + 第二阶段搜索终止符

## 5. 时间流化系统（Lowering）

目标：将 AST 树展开为**时间列列表**，每列包含同一时刻的所有元素。

### 核心数据结构（`src/lowering/types.ts`）

```typescript
interface TimeLineEvent { t; T; track }        // 布局层需要的最小接口

interface TemporalNodeRecord extends TimeLineEvent {
    track: string;          // 轨道编码（后缀式）
    ast: ASTNodeBase;      // 回溯到AST节点
    order: number;         // 创建序号（作为唯一ID）
    addon: Record<string, any>;  // 上下文快照（如 dot/div 计数）
    type: ColType;         // ANCHOR | SINGLE | DEFAULT
}

type TimeFlowMode = "sequence" | "parallel";   // 子节点展开方式
```

### AST 节点上的 lowering hooks

| Hook | 作用 | 当前实现者 |
|------|------|-----------|
| `timeFlowModel()` | 返回子节点展开模式（sequence/parallel） | div/box/stack/over |
| `loweringEnter()` | 进入时回调，返回时间事件，可修改 vars | bar/br/dot/div |
| `loweringExit()` | 离开时回调，恢复 vars | dot/div |
| `timeWrapConfig` | 静态注册时间变换函数（优先级排序） | dot(priority 1)/div(priority 2) |
| `onTimeState()` | 时间固化（调性/速度传播） | note/key/tempo |

### 引擎流程（`LoweringContext`）

```
trackedEvents(node, vars, timeOffset, track):
  1. 调用 node.loweringEnter → 得到事件，补全 t/T/track/order/addon/type
  2. 调用 node.timeFlowModel → 按 sequence/parallel 递归子节点
     - parallel: 各子节点从头开始，结束后局部 anchorAlign 归并
  3. 调用 node.loweringExit → 得到事件，同样补全
  4. 返回 { timeOffset, columns }

lowering(node):
  1. trackedEvents → 得到 columns
  2. 遍历 columns，调用 node.ast.onTimeState(state, record) 固化时间状态
```

### 锚点对齐（`anchorAlign`）

多声部按小节线局部对齐。采用**自底向上局部归并**（方案1），而非全局分轨归并（方案2有临时多声部连续性问题）。

归并使用最小堆，按 `t` 排序，`ColType` 作为次序：
- `ANCHOR`：进入缓冲区，等待所有轨道的 anchor 汇齐后合并为一列
- `SINGLE`：直接输出，不合并
- `DEFAULT`：同时刻的合并为同一列

### 轨道编码

后缀式：父轨道 `"A"`，子轨道 `"AB"`、`"AC"`。仅 parallel 可派生。

### ColType 设计动机

```
TrackA: 1  @set()  2       ← set 时长为0，会错误合并到下一列
TrackB: 1  2
```
`SINGLE` 类型强制单独成列，保证两个 `2` 对齐。

## 6. 布局系统

弹簧模型：每个元素有固有宽度 `W` 和时长 `T`，左右弹簧原长 `L = αT`。空间充足时紧排，不足时按比例压缩边距，极端时允许重叠。

- 单行：串联弹簧等价
- 多行：跨行元素垂直对齐，各行受力叠加
- 求解：共轭梯度法（CG），分段线性凸优化
- 详见 [layout.md](layout.md)

## 7. 已实现函数节点

`defaultFunctions` 注册 16 个（`src/functions/default.ts`）：

| 函数 | 别名/语法糖 | 分类 | lowering 参与 |
|------|------------|------|-------------|
| NoteNode | `n` / `A3#` | 实体 | onTimeState |
| DashNode | `-` | 实体 | — |
| BarNode | `\|` `\|\|` `\|:` `:\|` `:\|:` | 实体 | loweringEnter (ANCHOR) |
| DivNode | `/` | 装饰 | timeWrap + Enter/Exit |
| DotNode | `.` | 装饰 | timeWrap + Enter/Exit |
| VoiceNode | `v` / `N:` `L:` | 歌词 | — |
| BrNode | — | 排版 | loweringEnter (SINGLE) |
| StackNode | `&` | 时间同步 | timeFlowModel (parallel) |
| OverNode | `^` | 时间不对齐叠加 | （已实现未注册） |
| TieNode | — | 关系型 | 未接入 lowering |
| BeamNode | — | 关系型 | 未接入 lowering |
| BoxNode | — | 容器 | timeFlowModel (sequence) |
| SetNode | — | 设置 | — |
| KeyNode | `1` | 设置 | onTimeState |
| TempoNode | — | 设置 | onTimeState |
| TextNode | — | 文本 | — |

## 8. 当前面临的问题

### 8.1 TemporalNodeRecord 是 interface，缺乏类型安全

`addon: Record<string, any>` 是无类型逃生舱。`dot` 写 `vars["@dot"]`，`div` 写 `vars["@div"]`，引擎将 `@` 开头的属性拷贝（表示需要被子节点记录的属性；之后用于反查类型，调用该类型的decorate方法）。下游无法类型安全地读取装饰信息。

### 8.2 onTimeState 污染 AST 状态

`NoteFunction.onTimeState` 直接修改 AST 实例字段（`resolvedMidi`、`renderName` 等）。AST 在 lowering 后变为可变状态，不利于缓存、重解析、调试。如果对同一 AST 树以不同调性重新 lowering，上次的状态会残留。

### 8.3 关系型函数未接入

`BeamNode`、`TieNode` 存储了 `endPoints: ASTNodeBase[]` 引用，但未参与 lowering 和后续阶段。需要设计跨元素关系在时间流中的表达方式。

### 8.4 渲染层与 AST 的耦合

当前 `TemporalNodeRecord.ast` 持有 AST 引用，下游若要执行函数特有操作（如渲染），必须回调 AST 子类方法。时间流层未与 AST 层隔离。

## 9. 架构改进计划

### 9.1 TemporalNode 继承体系（替代 interface）

将 `TemporalNodeRecord` 从 interface 改为抽象类，每个基础元素类型（note/bar/dash）有自己的子类，携带类型化字段和 `render()` 方法。

```
TemporalNode (abstract)
├── t, T, track, order, type        // 引擎填充
├── source: ASTNodeBase             // 只读源映射
├── decorations: Decoration[]        // 引擎从栈中附加
├── abstract render(ctx): RenderBounds
├── onTimeState?(state): void      // 从AST迁移到此类
│
├── NoteTemporal { name, acc, octave, midi, renderName, render() }
├── BarTemporal  { barType, render() }
├── DashTemporal { render() }
└── ...
```

关键变化：`onTimeState` 从 AST 节点移到 TemporalNode 上。AST 节点在 lowering 后不再被下游引用（`source` 仅用于调试/高亮/关系匹配）。AST 保持不可变。

### 9.2 Decoration 继承体系

装饰性函数（div/dot）创建 `Decoration` 对象，携带时间变换和渲染行为：

```
Decoration (abstract)
├── priority: number
├── applyTimeWrap?(dt): number    // 替代 timeWrapConfig
├── abstract render(ctx, bounds)  // 装饰渲染
│
├── DivDecoration { count, applyTimeWrap, render() }
└── DotDecoration { count, applyTimeWrap, render() }
```

引擎维护 `decorationStack`：`loweringEnter` 压栈、`loweringExit` 弹出。每个新生成的 TemporalNode 自动附加栈中所有 Decoration。时间变换按 priority 排序后依次应用。

### 9.3 AST 节点职责精简为工厂

AST 节点在 lowering 中的角色变为 TemporalNode/Decoration 的工厂：

```typescript
// NoteFunction.loweringEnter → new NoteTemporal({...})
// DivFunction.loweringEnter  → ctx.pushDecoration(new DivDecoration(this.n))
// BarFunction.loweringEnter  → new BarTemporal({ type: ANCHOR })
```

### 9.4 关系型函数作为后处理 pass

beam/tie 不产生 TemporalNode，不参与 lowering。lowering 完成后单独扫描 AST 中的关系型函数，用 `TemporalNode.source` 匹配 endpoint，生成关系元数据传给渲染层。

```
1. Lowering:    AST → TemporalNode[]
2. 关系解析:     扫描 beam/tie → 匹配 endpoint → Relation[]
3. Layout:      TemporalNode[] + Relation[] → 坐标
4. Render:      TemporalNode[] + Relation[] → 画面
```

## 10. 维护时的关键注意点

- 必须先做 `preprocessSource`，否则 `%` 注释不会生效
- `content` 参数解析会创建子 `ParserContext`，注意作用域与异常传递
- `label` 参数解析依赖 `labelableNodes` 历史顺序，只绑定在函数定义之前
- `VoiceNode` 是最复杂语法糖模块：`N:` 向后扫描到换行或下一个 voice 语法糖；`L:` 依赖最近 VoiceNode
- `SourceSpan` 一律左闭右开
- vars 键名约定：`@` 前缀表示需要快照到 addon 的装饰信息（如 `@dot`、`@div`）

## 11. 代码风格

- 注释：中文为主，说明"目的/边界/原因"
- 控制流：偏好 early return，减少嵌套
- 类型：核心函数与状态变量要写清楚类型
- 性能：parser/preprocess 优先线性扫描、低分配

## 12. 建议阅读顺序

1. `grammar.md`（语法目标）
2. `docs/ARCHITECTURE.md`（架构意图与阶段划分）
3. `src/functions/ASTtypes.ts`（AST 与参数框架、lowering hooks）
4. `src/lowering/types.ts` + `src/lowering/loweringContext.ts`（时间流化引擎）
5. `src/parser/preprocess.ts` + `src/parser/diagnostic.ts`（预处理与定位）
6. `src/parser/parserContext.ts` + `src/parser/grammarType.ts`（解析主链）
7. `src/functions/note`、`div`/`dot`、`bar`、`voice`、`stack`（按复杂度递进）
# jpFun 项目速览
本文档用于帮助新的 AI 对话快速理解当前仓库真实状态

## 1. 项目定位

- 项目名：`jpFun`
- 当前阶段：源码解析/去糖阶段（`ParserContext + GrammarNode + 函数节点`）
- 设计原则：解析器负责基础语法和调度；函数节点负责语义与语法糖细节
- 语法入口：`grammar.md`
- 当前主线目录：仅 `src/`

## 2. 当前执行流程（重要）

注释预处理不在 parser 内部自动执行，调用端必须先做：

1. 调用 `preprocessSource(source)`，得到：
   - `maskedSource`：把 `%` 到行尾替换为空格（长度与换行保持不变）
   - `lineStarts`：行起点 offset 数组
2. 使用 `maskedSource` 构造 `ParserContext`
3. `ctx.registerFunctions(defaultFunctions)` 注册函数
4. `ctx.parse()` 解析为 `ASTNode` 列表
5. 诊断展示时调用 `diag.toLineCol(lineStarts)` 转行列

示例入口见 `src/test/test.ts` 的 `parseScript()`。

## 3. 目录与职责

- `src/parser/parserContext.ts`
  - 当前解析主入口与核心调度
  - 包含两阶段逻辑：语法层识别（`parseGrammar`）+ 节点构建/关系去糖（`makeNodes`）
- `src/parser/grammarType.ts`
  - GrammarNode 中间层类型（`call/brace/label/sugar`）
- `src/parser/preprocess.ts`
  - 注释掩码预处理 + `lineStarts` 生成（单扫描、低分配）
- `src/parser/diagnostic.ts`
  - 诊断基类、错误码/警告码工厂、offset 到行列转换
- `src/parser/parse-utils/*`
  - `call/brace/label/note` 的底层读取工具
- `src/functions/*`
  - `note/div/dot/bar/voice/set` 节点定义、参数固化和语法糖实现
- `src/test/*`
  - 演示与人工观察入口，不是严意义务化断言测试

## 4. 解析架构

`ParserContext.parse(start, end)` 流程：

1. `parseGrammar()`：
   - 识别 `@call(...)`、`@label`、`{...}`
   - 原子语法糖（`deSugarAtomFns`）在此阶段触发
   - 其余无法识别字符以“number索引”形式保留
2. `makeNodes()`：
   - 把 GrammarNode/字符索引转换为 AST 节点
   - 关系语法糖（`deSugarRelationFns`）在此阶段触发
   - 无法消费的内容合并为 `ASTTextNode`

## 5. AST 与参数机制

定义在 `src/functions/types.ts`：

- `ASTNodeBase`
  - 基类，包含 `sourceSpan`（左闭右开）与 `parent`
  - 默认 `duration = 0`
- `ASTTextNode`
  - 无语义文本占位（替代旧思路中的 token 占位）
- `ASTBraceNode`
  - `{...}` 容器节点，`duration` 为子节点时值总和
- `ASTLabelNode`
  - 仅语义标记，不参与渲染
- `ASTFunctionNode`
  - 函数节点基类，提供 `def`、`deSugarAtom`、`deSugarRelation`、`getArgValue`

参数取值顺序（`getArgValue`）：

1. 显式传参（命名优先，再位置）
2. `ctx.variables` 中的 `函数前缀.参数名`
3. 参数默认值

## 6. 已实现函数节点

`defaultFunctions` 当前注册：

- `SetNode`：写入局部变量（允许额外命名参数）
- `NoteNode`：音符名解析与参数固化（`noteNameFSM`）
- `DivNode`：减时线，支持 `/` 后缀语法糖
- `DotNode`：附点，支持 `.` 后缀语法糖
- `BarNode`：小节线，支持 `|`/`||`/`|:`/`:|`/`:|:`
- `VoiceNode`：声部与歌词，支持 `N(...):`/`L(...):` 行语法糖

## 7. 诊断与坐标模型

- 内部定位继续使用 offset 区间（`SourceSpan`）
- 展示层使用 `Diagnostic.toLineCol(lineStarts)` 转 1-based 行列
- 诊断代码体系沿用 `E_*` / `W_*`

## 8. 当前边界与待实现

- 尚未进入完整“音乐语义树 / 排版树”阶段
- 关系型函数（如 `beam` / `tie`）尚未落地
- 主流程仍聚焦：去糖、参数固化、诊断
- 时间语义固化（调性/时序全量传播）仍属后续阶段

## 9. 维护时的关键注意点

- 必须先做 `preprocessSource`，否则 `%` 注释不会生效
- `content` 参数解析会创建子 `ParserContext`，注意作用域与异常传递
- `label` 参数解析依赖 `labelableNodes` 的历史顺序，且只绑定在函数定义之前
- `VoiceNode` 是最复杂语法糖模块：
  - `N:` 会向后扫描到同层换行或下一个 voice 语法糖
  - `L:` 依赖最近 `VoiceNode`，否则抛错
  - 涉及文本清理与 span 合并，新增语法时必须重点回归

## 10. 代码风格（请遵守）

- 注释：中文为主，说明“目的/边界/原因”，少写无信息注释
- 控制流：偏好 early return，减少嵌套
- 类型：核心函数与状态变量要写清楚类型
- 性能：parser/preprocess 相关代码优先线性扫描、低分配
- 约定：`SourceSpan` 一律左闭右开

## 11. 新 AI 建议阅读顺序

1. `grammar.md`（语法目标）
2. `docs/ARCHITECTURE.md`（架构意图与阶段划分）
3. `src/functions/types.ts`（AST 与参数框架）
4. `src/parser/preprocess.ts` + `src/parser/diagnostic.ts`（预处理与定位）
5. `src/parser/parserContext.ts` + `src/parser/grammarType.ts`（解析主链）
6. `src/functions/note`、`div/dot/bar`、`voice`（按复杂度递进）
