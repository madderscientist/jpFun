---
title: 源码解析
sidebar:
  order: 2
---
[源码解析](https://github.com/madderscientist/jpFun/blob/HEAD/packages/jpfun/src/parser/parserContext.ts) 将文本转换成函数节点组成的 AST。这一步会展开语法糖、解析参数并记录源码位置，但还不计算音乐时间和页面坐标。

## 从文本到 AST

解析分为两步：
1. `ParserContext.parseGrammar` 识别函数调用、标签和大括号，将当前层的文本划分为 `GrammarNode`。基础语法之外的字符会依次交给各函数尝试识别语法糖。这些中间节点的类型定义在 [grammarType](https://github.com/madderscientist/jpFun/blob/HEAD/packages/jpfun/src/parser/grammarType.ts) 中。
2. 根据 `GrammarNode` 创建具体的函数节点，并处理需要引用相邻节点的语法糖。

这两步先处理当前层级。遇到函数中的内容参数时，解析器再递归处理内部内容，逐层构建出 AST。

先划分节点，再创建函数，是为了让语法糖能够在当前层级查找相邻节点或终止符，而不必重新扫描字符串、判断哪些字符属于嵌套内容。

解析器负责基础语法和调用顺序；具体函数声明参数类型，并处理收到的值。基础语法和各函数都无法识别的字符会被忽略。

## 语法糖解析
按识别时需要的信息，可以分成三类：

| 类型 | 例子 | 处理方式 |
| --- | --- | --- |
| 只需要读取后续字符 | `note` | 第一阶段即可完成识别。 |
| 还需要引用前面的节点 | `div` | 第一阶段留下锚点，第二阶段再将修饰应用到前面的节点。 |
| 需要继续处理一段节点 | `voice` | 第一阶段留下锚点，第二阶段在 `GrammarNode` 序列中查找终止符，再解析对应子区间；没有终止符时处理到末尾。 |

## 面向编辑器的源码视图
高亮、补全和函数文档悬浮只需要知道“这段源码是什么”，不必构建完整 AST。词法路径在第一阶段就能提供这些信息，类型同样定义在 [grammarType](https://github.com/madderscientist/jpFun/blob/HEAD/packages/jpfun/src/parser/grammarType.ts)：
```ts
interface SyntaxAnalysis {
    tokens: SyntaxToken[];   // 着色区间
    calls: CallInfo[];       // 调用与参数边界，供补全定位
}
```

`ParserContext.syntax` 由词法路径的根上下文创建，参与 `parseSyntax` 的子上下文共享这份结果。AST 路径不读取或填充它。

### 两个入口，共用一套语法
- `compileScore(source)` → `parse()`：构造 AST 并继续 lowering/layout，不产生 syntax。
- `analyzeScoreSyntax(source)` → `parseSyntax()`：只扫 GrammarNode 并产出 `{ syntax, diagnostics }`，不构造 AST。

两条路径共用 `parseGrammar`，通过 `syntaxOnly` 控制是否记录 token，以及如何处理未闭合调用、命名参数顺序错误。词法模式会记录这些诊断并继续，方便编辑器处理尚未写完的源码。

这个开关不改变语法识别规则。同一份源码在两种模式下应得到相同形状的 `GrammarNode`，测试会检查这一点。

### token 从哪里来
token 直接来自已经识别的语法结构，不需要再扫描一遍文本：

| 来源 | 产出 |
| --- | --- |
| `preprocessSource` 的 `commentSpans` | `comment` |
| `readCall` 的 `CallInfo` | `function`（`@name`）、`punctuation`（括号/等号/逗号）、`property`（参数名）、以及按类型分类的参数值 |
| `readLabel` | `label` |
| 大括号节点 | `punctuation` |
| 语法糖节点与 typed 调用 | `operator`，或节点自己声明的 `syntaxKind` |

其中，`readCall` 一次提供调用名、左右括号，以及每个参数的 `span`/`nameSpan`/`equalsSpan`/`commaSpan`/`valueSpan`。AST 路径把这些区间交给 `parseCallNode`，词法路径用它们生成 `CallInfo` 和 tokens，两者使用相同的参数边界。

调用未闭合时，结果中不含 `closeParenSpan`，由上层决定记录诊断还是抛出错误。

预处理会把注释替换成等长空格，因此 offset 仍与原始源码对齐。tokens 不嵌套、不重叠，按起点升序排列，也不包含空区间，可以直接用于要求有序输入的 `RangeSetBuilder`。

### 声明着色角色
函数可以通过可选的 `GrammarNodeBase.syntaxKind` 指定着色角色。语法糖节点和 typed 调用默认使用 `operator`；独立成元素的原子语法糖可以指定为 `atom`。解析器按这个字段生成 token，不需要判断具体函数名。

## 参数值的分类
`FunctionDef` 有两处声明供源码分析读取：
- `args[i].type`：具名/位置参数的类型；
- `extraArgType`：额外**位置**参数的统一类型（`@tie` 是 `label`，`@up` 是 `content`），命名参数不套用。

AST 构建、高亮和补全都通过 `resolveArgType(def, name, index)` 查找参数类型。`content` 参数递归分析，其余参数按类型着色。

未知函数或 `@set(fontsize=30)` 这类动态命名参数没有对应声明，源码分析会使用 `Number()` / `parseLength()` 判断字面量类型。复用实际的解析函数，可以让 `-3`、`.5em` 等写法的着色与解析行为保持一致。

`extraArgType` 不只是给编辑器看的元数据，它也决定 `parseCallNode` 如何解析额外的位置参数。未声明的命名参数则保留源码区间，交给具体函数处理，因此 `@tie`、`@voice` 等构造器需要区分已经解析的值与仍待解析的参数。

## 复用上下文时的注意事项
`addSyntax`/`recordSyntax` 直接引用 GrammarNode 的 span，不做拷贝。词法路径不会改写这些 span，但 AST 路径中的 `makeNodes` 会，例如展开 `^` 时需要扩展节点的源码范围。

因此，**不要对同一个 `ParserContext` 先调用 `parseSyntax` 再调用 `parse`**，否则 AST 构建可能改动已生成的语法区间。同样，GrammarNode 也不能跨次解析复用；将来实现增量解析时，需要先处理这部分可变状态。
