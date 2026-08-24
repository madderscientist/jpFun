# 编辑器集成

[playground](../apps/playground/) 目前是唯一的编辑器前端。这里记录它提供了什么能力、数据从 `jpfun` 的哪个 API 来、以及对应 VS Code 的哪个扩展点，供插件对齐。

## 工作台

桌面端有「编辑 / 拆分 / 预览」三种布局。拆分视图的分隔条可拖动，也可聚焦后用左右方向键按 2% 调整；编辑器宽度限制在 25%～75%。当前布局、编辑器宽度和左侧标签会写入 `localStorage`，存储不可用时静默退化为本次会话状态。

左侧是「源码 / 播放」标签，右侧是「谱面 / 诊断」标签。播放页目前只是禁用控件组成的界面占位，还没有播放、节拍器或混音逻辑。状态栏提供：

- `2026 Light` / `Quiet Light` 两套持久化主题；
- 等待排版、排版完成、诊断数量或排版失败状态，点击状态文字会打开诊断页；
- 对象数、谱面行数、页数、页面尺寸、编译耗时和源码字符数。

窄于 800px 时编辑器与结果区改为上下排列、隐藏分隔条，不再由桌面端的三种布局隐藏其中一侧；窄于 480px 时工具栏和诊断行进一步压缩。

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
| 谱面预览 | `renderLayoutPagesToSvg` / `renderLayoutPagesToCanvas` | Webview |
| 源码 / 谱面双向定位 | `object.ast.sourceSpan + box`、`attachment.sourceSpan + regions` | Webview 消息 + `TextEditor.selection` |
| 分页、缩放、页码与打印 | `layout.pages` + 前端页面组装 | Webview / Webview 打印 |
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

去糖行单独一段，用不同颜色（`--syntax-function`）和等宽字体，行尾挂一个「替换」按钮把 `node.sourceSpan` 区间换成去糖写法。等价写法**不截断也不折行**，超长内容在该行内横向滚动；悬浮框整体仍受最大宽高限制，正文过长时由外层滚动。「替换」按钮在悬浮框滚动时保持可见。

playground 接管了 CodeMirror 默认的悬浮关闭时机：悬浮框优先放在当前行上方并留 4px 间距，鼠标离开 token 后延迟 250ms 关闭，进入悬浮框或其外扩 8px 区域会取消关闭。点击编辑器后，在鼠标真正移动前不会原地重新弹出。这些数值是 playground 的交互选择，不是 core 契约。

> 移植差异：VS Code 的 Hover 只接受 `MarkdownString`，放不了真按钮。两种替代：在 Markdown 里放 `command:` 链接（需要 `isTrusted`），或者把「替换为函数调用」做成 `CodeActionProvider` 的 refactor——后者更符合 VS Code 习惯，而且能在选中一段时批量提供。

## 诊断

- **非致命**（警告 + 被显式吞掉的错误）在 `parser.diagnostics` 里，编译照常完成。
- **致命错误**由 `compileScore` 抛出，`catch` 到的 `Diagnostic` 单独展示。正常的单行页面溢出会在布局入口转成带 span 的 `E_PAGE_OVERFLOW`；其它非 `Diagnostic` 异常没有 span，前端保留一条「排版中断」文本行兜底。
- `Diagnostic` 有 `code`、`message`、`span`（offset）和 `toLineCol(lineStarts)`。`lineStarts` 只在没有编辑器的场景才需要——playground 直接用 `doc.lineAt(offset)`，VS Code 里用 `document.positionAt(offset)`，两者对致命错误一样有效（那条路径拿不到 `compileScore` 的 `lineStarts`）。
- 空 span（`start === end`）要人为撑成 1 个字符，否则波浪线不可见。

诊断标签显示总数和最高严重级别，面板显示错误/警告计数。带 span 的诊断行显示 `行:列`，点击后切回源码、选中对应区间并滚动到视口中央；无 span 的兜底行只显示文本。

`analyzeScoreSyntax` 也返回 `diagnostics`（未闭合调用、位置参数排在命名参数之后等）。是否把输入过程中的这些错误也报出来是产品选择——playground 目前只展示编译路径的诊断，避免打字时满屏红线。

**只有致命错误才抢占面板**：非致命诊断哪怕是 error 级也只更新标签徽标，谱面照常显示；致命错误才切到诊断面板，并在下一次编译成功时切回预览。`parser.diagnostics` 里的 `ErrorDiagnostic` 全是「已被吞掉、编译得以继续」的，拿它当切换依据会在谱面明明画好时把面板抢走。

## 预览

`compileScore` 的 `layout` 可以直接喂给两个渲染后端：

```ts
renderLayoutPagesToSvg(layout, { padding, background }) // 返回分页 SVG 字符串数组
renderLayoutPagesToCanvas(layout, contexts)             // 画到每页的 2D context
```

SVG 路径直接使用最终坐标（不生成 `<defs>/<use>` 因为发现徒增复杂度）。`renderLayoutPagesToCanvas` 会在内部按页执行 `translate(-bounds.x, -bounds.y)`；前端只需创建数量匹配的 context，并处理画布尺寸、`devicePixelRatio` 和缩放。SVG 内容与缩放无关，缩放时只改 `style.width/height`，不要重新生成。

playground 把每个 `layout.pages[i].bounds` 展示成独立纸张，纵向排列并保留固定页间距。工具栏提供：

- SVG / Canvas 后端即时切换；
- 缩放菜单内提供「适合宽度」和 50%～200% 的常用倍率；内部缩放范围是 25%～300%；
- 初始采用适宽模式，按钮显示 `适合宽度:53%` 形式的实时倍率；容器或页面宽度变化时继续贴合，手动选择倍率或 `Ctrl+滚轮` 后退出该模式并只显示百分比；
- 普通滚轮滚动页面，`Ctrl+滚轮` 以指针所在位置为缩放锚点。

多页缩放锚点按「具体页面 + 页面内归一化坐标」保存，页间距不会被误算进缩放比例。SVG 只更新已有根元素的 CSS 尺寸；Canvas 按当前缩放和 `devicePixelRatio` 重绘，连续滚轮事件合并到一个 animation frame。发生致命错误时会清空当前编译结果，之后缩放不会把上一次成功的谱面重新画回来。

源码与谱面使用同一份后端无关映射：可见 Temporal 读取 `ast.sourceSpan + box`，最终 `PlacedAttachment` 读取 `sourceSpan + regions`。除了顶层 `layout.objects`，前端还从 `lowering.astToTemporal` 收集已完成布局的折叠成员，因此 grace/up 内部的音符与各层复合体仍可分别命中。`regions` 来自最终 attachment geometry，试测轮不会暴露给消费者；自动 beam 的 span 取首末端点及其生效 div 作用域的并集。只有一个可见后代、且父 AST 本身没有可见 Temporal、也没有独立 attachment 的函数包装才会并入对象范围，因此 `1/` 的音符和减时线都对应完整 `1/`，而 grace 操作符不会吞掉内部音符的 span，`@box` 仍由自己的 attachment 定位。

playground 只在鼠标点击源码时触发右侧同步，键盘移动光标不触发；注释、空白及没有可见输出的声明会清除强调而不猜最近对象。文档一改就立即丢弃上一轮导航映射，等防抖编译完成后再恢复，旧谱面不会把新文档跳到错误 span。命中后预览滚到对应页，并从目标中心播放双层圆形波纹。谱面第一次 click 立即把光标放到 span 起点；500ms 内同一位置的第二次 click 扩展为完整 span 选区，但第一击不等待这个窗口。从「预览」单栏触发时自动恢复拆分视图，第二击即使因布局变化落到别的 DOM 元素，也由 document 捕获层完成原 range 的选中。

右侧命中先去掉纸张元素的 CSS 边框，再把 SVG/Canvas 内容盒像素按当前纸张 `bounds` 还原成全局布局坐标，然后在 region 外扩 6px 范围内选择面积最小、距离最近的目标。由此细 beam、tie 等关系图形优先于覆盖它们的大盒子，SVG 和 Canvas 不需要各自维护 DOM source marker。

每页底部中央由 playground 追加 `当前页/总页数`，单页也显示 `1/1`。页码同时进入 SVG、Canvas 和打印结果，但**不属于 core 布局或 Painter 协议**，不会改变 `@page` 的边距，也不参与谱面行高计算。

打印前会立即重新编译，并用同一批带页码的分页 SVG 建立独立打印树；动态 `@page size` 与布局纸张尺寸一致，工作台本身在打印媒体中隐藏，每个 SVG 后强制分页。打印结束后清空临时节点和样式。若重新编译失败，打印树保持为空，不会打印过期谱面。

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
- **实际播放**。播放标签只有禁用的走带、范围、节拍器和声部混音占位控件。
- **增量解析**。现在每次按键全文重扫词法层。乐谱规模够用；真要做，先做区间重扫（按行/大括号边界），别一上来就上节点复用——`span` 是绝对 offset，且 AST 会改写 grammar 阶段的 span 对象，这两条都要先解决。

## 已知问题

- `@div(1)/` 这类「语法糖作用在同名显式调用上」的写法，糖没有把节点 span 撑开覆盖尾部字符（span 停在 `[0,7)`），所以悬浮那个 `/` 没有反应。
- 语义层滞后一拍：刚编辑完到下一次编译之间，去糖悬浮不可用。词法层那一半不受影响。
