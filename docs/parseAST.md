# 源码解析
首先进行[源码解析](../packages/jpfun/src/parser/parserContext.ts)，得到函数级别的含义。这一步的主要作用是去糖、固化参数。

基本流程如下：
1. 语法层的解析（`ParserContext.parseGrammar`），即识别 函数调用、标签、大括号，对于不认识的字符，进行语法糖尝试。这一阶段得到的类型在 [grammarType](../packages/jpfun/src/parser/grammarType.ts) 中定义，目标是得到初步的该层 Node 划分，使得下一步去糖能方便地搜索顶层。
2. 基于第一阶段的 `GrammarNode` 进行具体函数节点的创建，并进行第二轮语法糖解析。

以上两个阶段在同一层进行，更深一层一般出现在函数的参数中，在解析参数的时候自动构建了一棵树。

之所以分两阶段：早期直接从字符串创建函数节点，带终止符的语法糖得靠“注入语法糖”拦截才能在当前层级找到终止符；改成在 Node 层级创建函数后这个侵入式手段就不需要了。

职责划分：解析器只管基本语法和调度，函数提供参数定义并自行处理拿到的值；基础语法之外的字符依次交给各函数的去糖函数，都消费不了就当无用字符。

## 语法糖解析
有三类：
1. 消费未来的字符，如 `note`。在第一阶段完成
2. 消费未来的字符和过去的节点，如 `div`。在第一阶段创建锚点，第二阶段消费过去的节点。
3. 消费未来的字符和未来的节点，如 `voice`。在第一阶段创建锚点，第二阶段消费过去的节点；对于未来的节点，在第二阶段搜索终止符（若无终止符则到末尾），进行子区间的 `GrammarNode` 解析（而不是基于字符级别）。

# 面向编辑器的源码视图
高亮、补全、函数文档悬浮只需要“哪一段源码是什么角色”，不需要 AST。这份信息由词法路径在第一阶段产出，类型定义在 [grammarType](../packages/jpfun/src/parser/grammarType.ts)：
```ts
interface SyntaxAnalysis {
    tokens: SyntaxToken[];   // 着色区间
    calls: CallInfo[];       // 调用与参数边界，供补全定位
}
```

`ParserContext.syntax` 只属于词法路径：根上下文创建它，参与 `parseSyntax` 的子上下文共享同一份；AST 路径不填充也不读取它。

## 两条独立路径
- `compileScore(source)` → `parse()`：构造 AST 并继续 lowering/layout，不产生 syntax。
- `analyzeScoreSyntax(source)` → `parseSyntax()`：只扫 GrammarNode 并产出 `{ syntax, diagnostics }`，不构造 AST。

两者共享 `parseGrammar` 这一份语法识别代码，差异全在 `syntaxOnly` 一个开关上，而它只控制两件事：是否调用 `recordSyntax` 记录 token，以及遇到未闭合调用/命名参数顺序错误时记录诊断而不是抛出。**它不得改变 GrammarNode 的识别结果**——测试守的正是同一源码下两种模式的 GrammarNode 形状一致。

## 分词的数据来源
token 不是另外扫一遍文本得到的，而是把已识别的结构翻译一次：

| 来源 | 产出 |
| --- | --- |
| `preprocessSource` 的 `commentSpans` | `comment` |
| `readCall` 的 `CallInfo` | `function`（`@name`）、`punctuation`（括号/等号/逗号）、`property`（参数名）、以及按类型分类的参数值 |
| `readLabel` | `label` |
| 大括号节点 | `punctuation` |
| 语法糖节点与 typed 调用 | `operator`，或节点自己声明的 `syntaxKind` |

`readCall` 是关键：它一次性给出调用名、左右括号、每个参数的 `span`/`nameSpan`/`equalsSpan`/`commaSpan`/`valueSpan`，两条路径共用这一份切分（AST 交给 `parseCallNode`，词法路径转成 `CallInfo` 和 tokens）。未闭合时它返回缺 `closeParenSpan` 的结果，由上层决定记录还是抛出。

预处理把注释等长替换为空格，所以 offset 始终对齐原始源码；tokens 保证扁平、互不重叠、按起点升序（`RangeSetBuilder` 要求有序），空区间不入表。

## 着色角色由函数自己声明
`GrammarNodeBase.syntaxKind` 是可选字段，语法糖节点和 typed 调用缺省算 `operator`；独立成元素的原子语法糖可以声明为 `atom`。解析器核心不认识任何具体函数名。

## 参数值的分类
`FunctionDef` 有两处声明供源码分析读取：
- `args[i].type`：具名/位置参数的类型；
- `extraArgType`：额外**位置**参数的统一类型（`@tie` 是 `label`，`@up` 是 `content`），命名参数不套用。

`resolveArgType(def, name, index)` 是这条查找规则的**唯一实现**，`parseCallNode` 构造 AST、高亮、补全共用。拿到 `content` 就递归，其余直接当 token 类型着色。声明里查不到时（未知函数、`@set(fontsize=30)` 这类动态具名参数）回落到真正的字面量解析器 `Number()` / `parseLength()`，而不是另写正则——否则 `-3`、`.5em` 这类写法会与实际解析行为不一致。

因为 AST 也走这条规则，`extraArgType` 是承重的：它决定额外位置参数在 `parseCallNode` 里被解析成什么，写错会让函数直接拿到错值。未声明的命名参数仍保留 `SourceSpan` 交给函数自己解析，所以 `@tie`、`@voice` 的构造器会同时处理两种形式。

## syntax 的 span 所有权
词法路径独占 syntax，所以 `addSyntax`/`recordSyntax` 直接引用 GrammarNode 的 span，不做拷贝。安全前提是改写 span 的只有 `makeNodes`（如 `UpFunction` 撑开 `^`），而它不在词法路径上——因此**不能对同一个 `ParserContext` 先 `parseSyntax` 再 `parse`**。

同理，GrammarNode 仍可被 AST 改写，所以它们不能跨次解析复用；这是将来做增量时要先拆的一条。
