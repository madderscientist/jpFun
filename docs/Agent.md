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
