# jpFun 项目速览
本文档用于帮助新的 AI 对话快速理解当前仓库的真实状态，并在不误判历史设计的前提下继续开发。

## 1. 项目定位

- 项目名：`jpFun`（`package.json` 中当前为 `jpfun`）
- 当前阶段：源码解析/去糖阶段（`CanonicalParser + 函数节点`）
- 设计原则：解析器负责通用语法与调度，函数类负责语义细节与语法糖消费
- 语法入口：`gramma.md`

## 2. 当前执行流程（重要）

现在“注释预处理”不在 parser 内部自动执行，而是在调用端先做：

1. 用 `preprocessSource(source)` 得到：
   - `maskedSource`：把 `%` 到行尾替换为空格（保留长度与换行）
   - `lineStarts`：行起点 offset 数组
2. 用 `maskedSource` 构造 `ParserContext`
3. 用 `CanonicalParser` 解析
4. 诊断输出时用 `diag.toLineCol(lineStarts)` 转成行列

当前示例流程可直接看 `src/test/test.ts` 的 `parseScript()`。

## 3. 目录与职责

- `src/parser/canonicalParser.ts`
  - 核心解析循环：函数调用、`{}`、语法糖、Token 兜底
- `src/parser/preprocess.ts`
  - 注释掩码预处理 + `lineStarts` 生成（高性能单扫描实现）
- `src/parser/diagnostic.ts`
  - 诊断基类、错误码工厂、`toLineCol()` 行列转换
- `src/parser/parseContext.ts`
  - 解析上下文（source/variables/functions/toConsume/diagnostics）
- `src/functions/*`
  - `note/div/dot/bar/voice/set` 等函数节点与去糖逻辑
- `src/test/test.ts`
  - 目前主要是演示与人工观察入口（输出原文、预处理后文本、去糖结果、诊断）

## 4. AST 与参数机制

定义在 `src/functions/types.ts`：

- `ASTNodeBase`
  - 基类；关键字段 `sourceSpan`（左闭右开）、`parent`
  - 默认 `duration=0`
- `TokenNode`
  - 无法识别/无意义文本的占位
- `ASTBraceNode`
  - 对应 `{...}` 容器；`duration` 为子节点时值和
- `ASTFunctionNode`
  - 函数节点基类，包含 `static def` / `static deSugar`
  - `getArgValue()` 参数取值顺序：
    1. 显式传参（命名优先，再位置）
    2. `ctx.variables` 的 `函数前缀.参数名`
    3. 默认值

## 5. CanonicalParser 核心逻辑

入口：`parse()`

- 跳过空白（`skipSpaces`，支持反斜杠续行）
- `@` 开头：
  - 先尝试 `readCall()` 读函数调用
  - 失败再尝试 `readLabel()`
- `{` 开头：
  - 子解析并包装 `ASTBraceNode`
- 其他字符：
  - 尝试所有 `deSugar`
  - 都失败则并入 `TokenNode`

参数解析 `parseArgWithType()`：

- `number`：`Number(text)`，失败告警
- `boolean`：当前严格只接受小写 `true/false`
- `content`：子解析为 `ASTBraceNode`
- `label`：在 `labelableNodes` 中逆序查找
- 默认按字符串并去首尾引号

## 6. 诊断与坐标模型

- `SourceSpan` 仍然是一维 offset（`start/end`）
- `Diagnostic` 新增 `toLineCol(lineStarts)`：
  - 返回 1-based 的 `startLine/startColumn/endLine/endColumn`
  - 内部使用二分查找行号
- 结论：内部保留高效索引模型，展示层按需做行列转换

## 7. 已实现函数节点

`defaultFunctions` 当前注册：

- `SetNode`：写入上下文变量（额外参数允许，按字符串处理）
- `NoteNode`：音符解析与音高固化（`midi`、相对八度等）
- `DivNode`：减时线，支持 `/` 后缀语法糖
- `DotNode`：附点，支持 `.` 后缀语法糖
- `BarNode`：小节线，支持 `|` / `||` / `|:` / `:|` / `:|:`
- `VoiceNode`：声部与歌词，支持 `N(...):` / `L(...):` 行语法糖

## 8. 当前边界与待实现

- 还未进入完整“音乐语义树 / 排版树”阶段
- 关系型函数（如 `beam` / `tie`）尚未落地
- 主流程仍聚焦“去糖 + 参数固化 + 诊断”
- 已取消早期 wrapup/父子层级收束那套思路，不按该方向继续设计

## 9. 当前需要注意的点

- 注释预处理在调用端完成；如果直接把原始源码丢给 parser，`%` 不会自动生效
- `@set` 额外参数统一按字符串进入 `variables`，后续类型使用依赖调用方约定
- `Voice.deSugar` 为了实现 `N:/L:` 写法，内部有子解析与特殊控制流；新增语法糖时要重点回归此模块

## 10. 代码风格（请遵守）

以下风格来自当前仓库代码与作者偏好，新增代码请保持一致：

- 注释语言与密度：
  - 以中文注释为主，且注释要“讲清目的/边界/原因”
  - 复杂逻辑前加块注释，关键分支加行内注释
  - 像 `preprocess.ts` 这种核心模块，需有模块级说明 + 状态变量说明 + 边界条件说明
- 控制流写法：
  - 单行 `if/else/return/continue` 倾向不写大括号
  - 偏好早返回（early return），减少嵌套层级
  - 能简写成一行的语句通常保持紧凑风格
- 类型与命名：
  - TypeScript 类型标注写清楚，尤其函数返回值与核心状态变量
  - 常量使用全大写下划线风格（如 `CHAR_PERCENT`）
  - 语义变量名直接、可读，不追求过短命名
- 数据与性能：
  - parser/preprocess 相关代码优先考虑线性扫描与低分配实现
  - 避免不必要的字符串逐字符拼接，优先分段组装再 `join`
- 结构约定：
  - `SourceSpan` 统一按左闭右开理解
  - 诊断码沿用 `E_*/W_*` 前缀体系

## 11. 新 AI 建议阅读顺序

1. `gramma.md`（语法目标）
2. `src/functions/types.ts`（AST 与参数框架）
3. `src/parser/preprocess.ts` + `src/parser/diagnostic.ts`（注释与定位）
4. `src/parser/canonicalParser.ts`（主解析循环）
5. `src/functions/note`、`div/dot/bar`、`voice`（按复杂度递进）
