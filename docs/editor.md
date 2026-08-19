# 编辑器集成

[playground](../apps/playground/) 目前是唯一的编辑器前端。这里记录它提供了什么能力、数据从 `jpfun` 的哪个 API 来、以及对应 VS Code 的哪个扩展点，供插件对齐。

## 两条路径

编辑器功能分两层，对应解析器的两个入口（解析器侧見 [解析](parseAST.md)）。任何前端都应该保持这个划分：

| | 词法层 | 语义层 |
| --- | --- | --- |
| 入口 | `analyzeScoreSyntax(source)` | `compileScore(source, options)` |
| 触发 | 每次按键，同步 | 防抖（playground 是 180ms），与渲染共用 |
| 产出 | `{ syntax, diagnostics }` | `{ lineStarts, parser, ast, lowering, layout }` |
| 出错 | 只记诊断，不抛 | 致命错误直接抛出，此时没有 AST |
| 服务 | 高亮、补全、括号、函数名悬浮 | 预览渲染、去糖悬浮、诊断面板 |

语义层的结果是**滞后**的：文档一改它就作废，要等下一次编译。所有依赖它的功能都必须能优雅降级。

## 功能清单

| 功能 | 数据来源 | VS Code 对应 |
| --- | --- | --- |
| 语法着色 | `syntax.tokens` | `DocumentSemanticTokensProvider` |
| 函数名补全 | `defaultFunctions` 的 `def` | `CompletionItemProvider`（触发字符 `@`） |
| 参数名补全 | `syntax.calls` + `resolveArgType` | 同上 |
| 标签补全 | `syntax.tokens` 里的 `label` | 同上 |
| 函数文档悬浮 | `syntax.calls` + `def` | `HoverProvider` |
| 去糖写法悬浮 | `compileScore().ast` | 同上 |
| 去糖替换 | `node.toString(source)` | `CodeActionProvider`（见下） |
| 诊断 | `parser.diagnostics` + 抛出的错误 | `DiagnosticCollection` |
| 谱面预览 | `renderLayoutToSvg` / `renderLayoutToCanvas` | Webview |
| 注释/括号 | `languageData` | `language-configuration.json` |

## 语法着色

`syntax.tokens` 是一组扁平、互不重叠、按起点升序的 `{ kind, span }`——正好满足 VS Code semantic tokens 的要求，可以原样喂给 `DocumentSemanticTokensProvider`。建议映射：

| kind | playground CSS 变量 | VS Code semantic token type |
| --- | --- | --- |
| `comment` | `--syntax-comment`（斜体） | `comment` |
| `string` | `--syntax-string` | `string` |
| `function` | `--syntax-function`（粗） | `function` |
| `label` | `--syntax-variable` | `label` |
| `property` | `--syntax-type` | `property` |
| `number` | `--syntax-number` | `number` |
| `boolean` | `--syntax-keyword` | `keyword` |
| `length` | `--syntax-number` | `number` |
| `atom` | `--syntax-number`（粗） | 需自定义 type，或 `number` 加 modifier |
| `operator` | `--syntax-keyword` | `operator` |
| `punctuation` | `--syntax-comment` | 无标准类型，可省略 |

**offset 一定对齐原始源码**：`preprocessSource` 把注释和续行转义等长替换为空格，span 可以直接当原文位置用，不需要任何映射。

VS Code 的 semantic tokens 是异步的，首次打开会有一瞬没颜色。可以配一份最小 TextMate 语法兜底（只认 `%` 注释和 `@name`），但**不要**用它做完整高亮——那就变成两份语法定义了。

## 补全

playground 的实现在 [jpfun-language.ts](../apps/playground/jpfun-language.ts) 的 `complete()`。三种情况：

1. **光标前是 `@`** → 列出所有函数，插入 `@name()` 并把光标放进括号（`snippetCompletion`）。VS Code 用 `SnippetString("name($0)")` + `triggerCharacters: ["@"]`。
2. **光标在某个调用的括号里、参数名位置** → 列出该函数尚未使用的具名参数，`apply` 是 `name=`。定位靠 `callAt(calls, pos)`：`calls` 按起点升序且同级不重叠，所以从前往后扫、最后一个命中的必然是最内层。
3. **光标在 `label` 类型的参数值位置** → 列出文档里已声明的标签。判断「声明 vs 引用」的依据是源码里该 token 以 `@` 开头（`@x` 是声明，`@tie(x)` 里的 `x` 是引用）。

参数类型一律通过 `resolveArgType(def, name, index)` 查，这是全仓库唯一的「参数名 → 类型」规则，AST 解析也走它。**光标落在 `content` 类型的参数里时返回 null**，否则每敲一个音符都会弹补全。

## 悬浮

两段式，优先级从上到下：

1. **词法层**：光标落在某个 `call.nameSpan` 上 → 显示 `def.description` + `def.example`。这条不依赖 AST，永远是最新的。
2. **语义层**：词法层没命中且 AST 未过期 → 沿 `sourceSpan` + `children` 递归找命中路径上最深的、带 `def` 的 `ASTFunctionNode`，显示 `node.toString(source)`（去糖后的等价写法）再接文档。

```
1/  的 /   ->  @div(@n(1, , 0, #000), 1)
1^3^5 的 ^ ->  @up(@n(1,...), @n(3,...), @n(5,...))     // 扁平化后的真实结果
2>3 的 >   ->  @grace(@n(3,...), @n(2,...), side=pre)
|          ->  @bar(0, 22px)
```

**只有语法糖才显示去糖行**：判断依据是节点 `sourceSpan` 能否在 `syntax.calls` 里找到**起止完全相同**的条目——能找到就是用户写出来的调用，去糖行等于原文。别用「源码切片是否以 `@name` 开头」判，语法糖会撑开 span，`@note(1) ^ @note(3)` 产生的 UpFunction 切片就以 `@note` 开头。

去糖行单独一段，用不同颜色（`--syntax-function`）和等宽字体，行尾挂一个「替换」按钮把 `node.sourceSpan` 区间换成去糖写法。显示超长会截断（上限 200 字符），但**替换用完整文本**。

> 移植差异：VS Code 的 Hover 只接受 `MarkdownString`，放不了真按钮。两种替代：在 Markdown 里放 `command:` 链接（需要 `isTrusted`），或者把「替换为函数调用」做成 `CodeActionProvider` 的 refactor——后者更符合 VS Code 习惯，而且能在选中一段时批量提供。

## 诊断

- **非致命**（警告 + 被显式吞掉的错误）在 `parser.diagnostics` 里，编译照常完成。
- **致命错误**由 `compileScore` 抛出，`catch` 到的 `Diagnostic` 单独展示。注意 `PageLayoutError` 这类不是 `Diagnostic`，没有 `span` 也没法跳转，前端要单独留一条只显示文本的位置。
- `Diagnostic` 有 `code`、`message`、`span`（offset）和 `toLineCol(lineStarts)`。`lineStarts` 只在没有编辑器的场景才需要——playground 直接用 `doc.lineAt(offset)`，VS Code 里用 `document.positionAt(offset)`，两者对致命错误一样有效（那条路径拿不到 `compileScore` 的 `lineStarts`）。
- 空 span（`start === end`）要人为撑成 1 个字符，否则波浪线不可见。

`analyzeScoreSyntax` 也返回 `diagnostics`（未闭合调用、位置参数排在命名参数之后等）。是否把输入过程中的这些错误也报出来是产品选择——playground 目前只展示编译路径的诊断，避免打字时满屏红线。

**只有致命错误才抢占面板**：非致命诊断哪怕是 error 级也只更新标签徽标，谱面照常显示；致命错误才切到诊断面板，并在下一次编译成功时切回预览。`parser.diagnostics` 里的 `ErrorDiagnostic` 全是「已被吞掉、编译得以继续」的，拿它当切换依据会在谱面明明画好时把面板抢走。

## 预览

`compileScore` 的 `layout` 可以直接喂给两个渲染后端：

```ts
renderLayoutToSvg(layout, { padding, background, idPrefix })   // 返回 SVG 字符串
renderLayoutToCanvas(layout, ctx)                              // 画到 2D context
```

`idPrefix` 用于隔离 SVG `<defs>` 的 id，同一页面上有多个谱面时必须给不同前缀。Canvas 后端要自己处理 `devicePixelRatio` 和 `translate(-bounds.x, -bounds.y)`。SVG 内容与缩放无关，缩放时只改 `style.width/height`，不要重新生成。

VS Code 里放 Webview。`jpfun` 是纯 ESM 且不依赖 DOM，所以编译可以放在扩展主进程、只把 SVG 字符串 postMessage 给 webview（这样能复用同一份编译结果做诊断），也可以整个跑在 webview 里。

## 编辑约定

playground 通过 `EditorState.languageData` 声明：

```ts
commentTokens: { line: "%" }
closeBrackets: { brackets: ["(", "{", "[", "\""] }
```

对应 VS Code 的 `language-configuration.json`（`comments.lineComment`、`brackets`、`autoClosingPairs`）。

按键是 VS Code 风格：**Tab 接受补全，回车插入换行**。VS Code 里 Tab 接受是默认行为，但回车默认也接受，需要在语言层配 `editor.acceptSuggestionOnEnter: "off"`（`[jpfun]` 作用域下）才能对齐。

其它 playground 特有、插件里由编辑器本身提供的：行号、括号匹配、多光标、搜索、`Alt+Z` 切换折行、选中空白可视化、`Ctrl+Enter` 手动排版。

## 目前没有的能力

移植时不用找，它们确实不存在：

- **跳转定义 / 查找引用**（标签 → 音符）。`ASTLabelNode.target` 已经指向被标注的节点，做起来不难，但还没做。
- **语义高亮**：标签没绑上、未知函数名等应该标红，现在没有。需要遍历 AST 而不是 token。
- **重命名标签**、**格式化**、**代码折叠**。
- **增量解析**。现在每次按键全文重扫词法层。乐谱规模够用；真要做，先做区间重扫（按行/大括号边界），别一上来就上节点复用——`span` 是绝对 offset，且 AST 会改写 grammar 阶段的 span 对象，这两条都要先解决。

## 已知问题

- `@div(1)/` 这类「语法糖作用在同名显式调用上」的写法，糖没有把节点 span 撑开覆盖尾部字符（span 停在 `[0,7)`），所以悬浮那个 `/` 没有反应。
- 语义层滞后一拍：刚编辑完到下一次编译之间，去糖悬浮不可用。词法层那一半不受影响。
