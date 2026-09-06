---
title: 编辑器集成
sidebar:
  order: 8
---

[playground](https://github.com/madderscientist/jpFun/tree/HEAD/apps/playground/) 是目前唯一的编辑器前端。本文说明它如何使用 `jpfun` 的词法分析、编译、渲染和播放 API，并列出集成到 VS Code 时可使用的扩展点。VS Code 部分是接入建议，不代表已有插件实现。

## 两条路径

编辑器功能分为词法层和语义层，分别使用解析器的两个入口，详见 [解析](../parser/)：

| | 词法层 | 语义层 |
| --- | --- | --- |
| 入口 | `analyzeScoreSyntax(source)` | `compileScore(source, options)` |
| 触发 | 每次按键，同步 | 防抖（playground 是 180ms），与渲染共用 |
| 产出 | `{ syntax, diagnostics }` | `{ lineStarts, maskedSource, diagnostics, ast, lowering, layout }` |
| 出错 | 只记诊断，不抛 | 致命错误直接抛出，此时没有 AST |
| 服务 | 高亮、补全、括号、函数名悬浮 | 预览渲染、去糖悬浮、诊断面板 |

词法层随输入同步更新。语义层结果在文档修改后失效，直到下一次编译完成才可用。接入其他前端时，也应区分这两条路径：高亮、补全等功能使用当前词法结果，依赖 AST 的功能则在语义结果过期时暂停或使用词法信息作为替代。

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
| 标签跳转定义 | `syntax.tokens` + `ASTLabelNode.target` | `DefinitionProvider` |
| 标签重命名 | `syntax.tokens` | `RenameProvider` |
| 诊断 | `parser.diagnostics` + 抛出的错误 | `DiagnosticCollection` |
| 谱面预览 | `renderLayoutPagesToSvg` / `renderLayoutPagesToCanvas` | Webview |
| 源码 / 谱面双向定位 | `object.ast.sourceSpan + box`、`attachment.sourceSpan + regions` | Webview 消息 + `TextEditor.selection` |
| 分页、缩放与打印 | `layout.pages` + 前端页面组装 | Webview / Webview 打印 |
| 实际播放 | `compilePlayback(lowering)` + Web Audio 适配器 | Webview |
| MIDI 导出 | `PlaybackPlan.events` + SMF 适配器 | Webview 下载 |
| 注释/括号 | `languageData` | `language-configuration.json` |

## 工作台

桌面端提供「编辑 / 拆分 / 预览」三种布局。拆分视图的分隔条支持拖动，也可在聚焦后用左右方向键每次调整 2%；编辑器宽度限制在 25%～75%。当前布局、编辑器宽度和左侧标签保存在 `localStorage` 中。存储不可用时，这些设置仅在本次会话生效，不显示存储错误。

左侧是「源码 / 播放」标签，右侧是「谱面 / 诊断」标签。播放页提供走带控制、进度、速度倍率滑条、移调和声部混音；没有独立节拍器开关、循环或播放范围控件。谱面中的 `X`（或 `9`）会按记谱位置发出打击音，不会自动给整首乐谱补拍。MIDI 与 PDF/SVG/PNG/JPEG 均位于右上角导出菜单。

状态栏提供：

- `2026 Light` / `Quiet Light` 两套主题，并保存主题选择；
- 等待排版、排版完成、诊断数量或排版失败状态，点击状态文字可打开诊断页；
- 对象数、谱面行数、页数、页面尺寸、编译耗时和源码字符数。

宽度小于 800px 时，编辑器与结果区改为上下排列，隐藏分隔条，两侧始终显示，不受桌面布局选择影响。宽度小于 480px 时，工具栏和诊断行进一步压缩。

## 语法着色

`syntax.tokens` 是扁平的 `{ kind, span }` 数组，条目互不重叠，并按起点升序排列。这些信息可用于实现 VS Code 的 `DocumentSemanticTokensProvider`。建议按下表映射 token 类型：

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

offset 对应原始源码位置。`preprocessSource` 将注释和续行转义等长替换为空格，因此 span 可直接用于原文，无需额外的位置映射。

VS Code 的 semantic tokens 异步提供，首次打开文档时可能短暂没有颜色。可用一份只识别 `%` 注释和 `@name` 的最小 TextMate 语法提供初始高亮。完整高亮仍使用词法结果，以免重复维护语法定义。

## 补全

playground 的补全由 [jpfun-language.ts](https://github.com/madderscientist/jpFun/blob/HEAD/apps/playground/jpfun-language.ts) 中的 `complete()` 实现，分为三种情况：

1. **光标前是 `@`**：列出所有函数，通过 `snippetCompletion` 插入 `@name()`，并将光标放进括号。VS Code 可使用 `SnippetString("name($0)")` 和 `triggerCharacters: ["@"]`。
2. **光标在调用括号内的参数名位置**：列出该函数尚未使用的具名参数，`apply` 为 `name=`。`callAt(calls, pos)` 用于定位调用。由于 `calls` 按起点升序排列，且同级调用不重叠，从前往后扫描时最后一个命中的调用就是最内层调用。
3. **光标在 `label` 类型的参数值位置**：列出文档中已声明的标签。声明与引用通过 token 在源码中是否以 `@` 开头区分：`@x` 是声明，`@tie(x)` 中的 `x` 是引用。

参数类型通过 `resolveArgType(def, name, index)` 查询，与 AST 解析使用相同的参数名到类型解析规则。光标位于 `content` 类型的参数中时，补全返回 `null`，避免在输入音符时反复弹出候选项。

## 悬浮

悬浮内容按以下顺序查找：

1. **词法层**：光标落在 `call.nameSpan` 上时，显示 `def.description` 和 `def.example`。这部分使用当前词法结果，不依赖 AST。
2. **语义层**：词法层未命中且 AST 未过期时，沿 `sourceSpan` 和 `children` 递归查找命中路径上最深的、带 `def` 的 `ASTFunctionNode`，先显示 `node.toString(source)` 生成的去糖等价写法，再显示文档。

```
1/  的 /   ->  @div(@n(1, , 0, #000), 1)
1^3^5 的 ^ ->  @up(@n(1,...), @n(3,...), @n(5,...))     // 扁平化后的真实结果
2>3 的 >   ->  @grace(@n(3,...), @n(2,...), side=pre)
|          ->  @bar(0, 22px)
```

去糖行只用于语法糖。若节点的 `sourceSpan` 与 `syntax.calls` 中某个条目的起止位置完全相同，则它是源码中的显式调用，去糖行与原文相同，无需重复显示。

仅检查源码切片是否以 `@name` 开头无法区分这两种情况：语法糖可能扩展 span，例如 `@note(1) ^ @note(3)` 产生的 UpFunction 切片仍以 `@note` 开头。

去糖行单独显示，使用 `--syntax-function` 颜色和等宽字体。行尾的「替换」按钮将 `node.sourceSpan` 区间替换为去糖写法。等价写法不截断、不折行，超长内容在行内横向滚动。悬浮框整体有最大宽高限制，正文过长时由外层滚动；「替换」按钮在滚动时保持可见。

playground 自行控制 CodeMirror 悬浮框的关闭时机：悬浮框优先放在当前行上方，保留 4px 间距；鼠标离开 token 后延迟 250ms 关闭，进入悬浮框或其外扩 8px 区域时取消关闭。点击编辑器后，在鼠标再次移动前不会原地弹出悬浮框。这些数值属于 playground 的交互设置，不是 core 接口要求。

> VS Code 接入：Hover 使用 `MarkdownString`，不能放置交互式按钮。可在 Markdown 中提供 `command:` 链接（需要 `isTrusted`），也可用 `CodeActionProvider` 提供「替换为函数调用」的 refactor。后者更符合 VS Code 的操作习惯，也可针对选区批量提供替换。

## 标签跳转与重命名

`Ctrl`/`Cmd` + 点击标签引用时，光标跳到被标注对象，而不是声明 `@x`，便于查看引用对应的音符或其他对象。按住修饰键时，可跳转的标签显示下划线和手型。只有引用支持跳转，声明、音符和注释中的同名文字不响应。

光标位于声明或引用上时，按 `F2` 可重命名该组标签。编辑器通过 `EditorState.allowMultipleSelections` 选中该组的所有出现位置，输入时同步修改，不显示额外弹窗。

### 作用域规则

跳转和重命名使用相同的作用域规则，与 `parseArgWithType` 的 `label` 分支一致：

> 一个引用绑定到所属函数调用之前最近的同名声明。

同一个标签名可以重复使用：

```
1@x 2@y @tie(x,y) 3@x 4@y @tie(x,y)
```

第一条延音线的 `x` 指向 `1`，因为 `3@x` 位于该调用之后；第二条的 `x` 指向 `3`，因为两个声明都在调用之前，而 `3@x` 更近。

因此，`F2` 按绑定到同一个声明的引用分组，而不是替换所有同名标签。跳转和重命名可共用声明查找逻辑：跳转查找引用绑定的声明，重命名收集绑定到该声明的全部引用。

词法层比较「声明起点 < 该调用的 `span.start`」，核心比较「被标注对象起点 < `funcStart`」。对有效源码，两者等价。只有函数调用位于对象与其标签之间时才可能产生差异，例如 `1 @tie(x) @x`，而该写法会触发 `E_UNKNOWN_LABEL`。

### 分层与降级

查找声明只使用词法层结果，随输入同步更新。只有从声明定位到被标注对象时，才需要读取 AST 中的 `ASTLabelNode.target`。编译失败或文档刚修改、AST 不可用时，跳转目标改为声明 `@x` 本身。`F2` 不依赖 AST。

定位被标注对象使用 `target`，不使用 `parent`。`ASTLabelNode.parent` 表示 AST 中的容器关系，可能在 `ASTBraceNode` 等容器构造时被改写；`target` 始终指向被标注节点。

### 与谱面的联动

跳转后，右侧谱面对目标音符显示与普通点击相同的波纹强调。playground 在跳转的 transaction 中加入 `labelJumped` effect，由 `updateListener` 识别后通知外层。

通知不依赖 `click` 事件，因为跳转在 `mousedown` 阶段拦截事件并调用 `preventDefault`，以阻止 CodeMirror 默认的「Ctrl+点击添加多光标」行为。此后浏览器不一定再生成 `click`。

> VS Code 接入：`DefinitionProvider` 返回被标注对象的 `Location`，修饰键下划线、`F12` 和悬浮预览由编辑器提供。重命名使用 `RenameProvider`，将同组标签的 range 作为 `WorkspaceEdit` 返回；可通过 `prepareRename` 将范围限定在名字部分，不包含 `@`。

## 诊断

- **非致命诊断**包含警告和已处理、允许继续编译的错误，记录在 `compiled.diagnostics` 中，编译仍会完成。
- **致命错误**由 `compileScore` 抛出，捕获到的 `Diagnostic` 单独展示。单行页面溢出在布局入口转换为带 span 的 `E_PAGE_OVERFLOW`。其他非 `Diagnostic` 异常没有 span，前端用一条「排版中断」文本行表示。
- `Diagnostic` 提供 `code`、`message`、`span`（offset）和 `toLineCol(lineStarts)`。没有编辑器时可用 `lineStarts` 转换行列；playground 直接使用 `doc.lineAt(offset)`，VS Code 使用 `document.positionAt(offset)`。后两种方式也适用于致命错误，此时无法取得 `compileScore` 的 `lineStarts`。
- 空 span（`start === end`）在显示时扩展为 1 个字符，使波浪线可见。

诊断标签显示总数和最高严重级别，面板显示错误与警告计数。带 span 的诊断行显示 `行:列`，点击后切回源码、选中对应区间并滚动到视口中央；无 span 的诊断行只显示文本。

`analyzeScoreSyntax` 也返回 `diagnostics`，例如未闭合调用、位置参数排在命名参数之后等。前端可自行决定是否在输入过程中展示这些诊断。playground 目前只展示编译路径的诊断，减少输入未完成时的错误提示。

只有致命错误会自动切换到诊断面板，下一次编译成功后切回预览。非致命诊断即使是 error 级别，也只更新标签徽标，谱面继续显示。`compiled.diagnostics` 中的 `ErrorDiagnostic` 都允许编译继续，因此不能仅凭错误级别决定是否切换面板。

播放诊断也区分是否阻止继续运行，但不会自动切换右侧谱面。`PlaybackPlan.diagnostics` 与排版诊断合并进入统一列表；warning 同时在播放页显示数量，不阻止播放。`compilePlayback` 抛出的带 span 的 `Diagnostic` 会禁用走带，并同时显示在诊断列表和播放页。只有用户点击播放页摘要时才切到诊断页。

远程脚本、AudioContext 和 MIDI 下载失败没有源码位置，只在播放页显示，不生成源码波浪线。

## 播放与 MIDI 导出

实时播放和 MIDI 导出共用 `PlaybackPlan`，但输出适配器不同：浏览器将事件转成声音，MIDI 将事件编码成文件。事件、增时线和连音的核心语义见 [播放](../playback/)，这里说明前端如何消费这些数据。

### 计划生命周期

首次切到播放标签，或用户点击 MIDI 导出时，playground 使用当前成功编译结果中的 `lowering` 调用 `compilePlayback`，生成 `PlaybackPlan`。同一源码版本复用计划。

播放标签保持打开时，源码变化会立即停止声音并使旧计划失效，下一次 `compileScore` 成功后重建计划。其他情况下，普通编辑和排版不会触发播放编译。

### 浏览器实时播放

[tiny-synth.ts](https://github.com/madderscientist/jpFun/blob/HEAD/apps/playground/tiny-synth.ts) 按需加载远程 tinySynth，打开播放页时提供 128 个 GM 风格的旋律音色，点击播放时才创建并恢复 `AudioContext`。

适配器沿 Tempo 事件将 QN 换算成秒，按 `noteId` 配对 NoteOn/NoteOff，得到待调度的音符。调度器每 100ms 补足约 1 秒的绝对 AudioContext 时间窗口。暂停时停止已排程节点；恢复播放、跳转或播放中调整速度倍率、移调、音色覆盖时，从当前位置重建窗口。

`PlaybackPlan.tracks[index]`、混音设置与 tinySynth 的 `channel[index]` 一一对应。这里的 channel 是浏览器内的混音输出，不是 MIDI 的 16 通道编号。音量、Mute 和 Solo 直接作用于原声部的输出增益，无需重建计划。

播放秒数通过 `scoreMap` 映射回原谱 QN。右侧 SVG/Canvas 共用 overlay，以半透明矩形标示当前时间列，并行声部合并成一个区域。跨行或跨页时，只在列变化时滚动。暂停保留矩形，停止或源码变化时清除矩形。

播放标签激活时，点击右侧有正时值的谱面对象会将进度移到该对象的记谱位置，不跳回源码。

### X：同一事件，两种输出

`X` 与 `9` 等价，谱面均显示 `X`。它们产生真实的 NoteOn/NoteOff：NoteOn 携带 `percussion: true`、`midi: 37` 和原声部身份，NoteOff 通过 `noteId` 配对。`37` 在这里是 GM Side Stick 的打击键号，不是旋律音高；`0/Z` 和 `8` 仍不产生音符事件。

| 项目 | 浏览器播放 | MIDI 导出 |
| --- | --- | --- |
| 声音来源 | tinySynth 额外注册的单一木击近似音色 | 接收端 GM 音源的 Side Stick，实际听感由音源决定 |
| 音色与键号 | 内部音色槽 `128`，固定频率的短促波形；不加入乐器下拉框 | 打击键 `37`，不导出内部音色槽 `128` |
| 通道与归属 | 保留原声部的 tinySynth channel，共用该声部增益 | 所有打击音汇入额外的打击 `MTrk`，使用 MIDI channel 10（零基编号 `9`） |
| 增时线 | `X - -` 只触发一次短包络，调度参数 `last` 固定为 25ms，尾音自然衰减 | 保留延长后的 NoteOff 时刻，不把记谱时值改成 25ms |
| 音色覆盖与移调 | 忽略旋律 program、乐器选择和移调，打击音不变 | 不向鼓通道写入旋律 Program Change，键号保持 `37` |
| 原声部音量 | 通过原声部 gain 控制，Mute/Solo 同样生效 | 音量折算到每个打击 NoteOn 的 velocity；Mute/Solo 不参与导出 |

例如，`X - - 1` 中，`X` 在 `QN=0` 起音，NoteOff 在 `QN=3`，旋律音 `1` 也从 `QN=3` 开始。浏览器只在开头敲击一次，之后仍按三拍推进进度；MIDI 则保存完整的三拍事件对。打击音的物理衰减与记谱占用时值是两件事，增时线不会让短促音效反复响起。

tinySynth 原本没有鼓组，前端只补充一个固定频率、快速衰减的音色，仍调用原来的 `play()`，复用调度、混音和 `stopAll()`。它不是 Side Stick 的精确采样，也没有第二套音频引擎。从 `X` 的延续区间中途 seek 或恢复播放时，不重新触发已经过去的敲击；回到起音位置则正常触发。

### MIDI 文件与设置边界

[midi-export.ts](https://github.com/madderscientist/jpFun/blob/HEAD/apps/playground/midi-export.ts) 使用同一事件计划，按需加载远程 midi.js，导出 format 1 的 Standard MIDI File，固定为 480 PPQ：

- conductor 轨保存 Tempo、拍号和曲末时长标记，因此尾部休止不会丢失；
- 含旋律音的原声部各有一个 `MTrk`，保存旋律音符、Program Change 和音量 CC7；旋律通道在每个 port 中避开 channel 10，超过 15 个旋律通道时沿用 MIDI Port 元事件扩展；
- 按需新增一条打击 `MTrk`，NoteOn/NoteOff 都按 `noteId` 路由到 channel 10。它只是导出文件的轨道，不会增加 `PlaybackPlan.tracks` 或播放页的声部数量。

多个原声部的 `X` 共用 MIDI channel 10，不能分别向这个共享通道写不同的 CC7。导出器将鼓通道的 CC7 固定为 `127`，再按各原声部音量缩放打击力度；音量为零时整对省略 NoteOn/NoteOff，不产生空鼓轨。文件中的 `MTrk` 与 MIDI channel 不是同一个概念，不能用轨道序号推断通道编号。

播放页的设置是否影响导出，取决于设置本身：

| 设置 | 浏览器播放 | MIDI 导出 |
| --- | --- | --- |
| 按谱面 / 乐器覆盖 | 普通音使用谱面 program，或整声部覆盖；`X` 除外 | 同样决定旋律 Program Change；打击轨不写 program |
| 声部音量 | 修改原声部输出增益 | 旋律写 CC7；打击音缩放 velocity |
| Mute / Solo | 决定各声部是否听得到 | 忽略，不因静音或独奏筛除音符 |
| 速度倍率 | 缩放播放时间，`X` 的短包络参数不变 | 忽略，保留计划中的 Tempo 和记谱时值 |
| 移调 | 只改变旋律音高 | 忽略，保留计划中的音符键号 |

SMF 拍号分母只能是 2 的幂，分子必须在 `1..255`，三字节 Tempo 也有范围限制；超出范围时导出失败。音符键号和力度则由适配器整数化并限制到设备可接受的范围，不应把前述限制理解为所有数值都严格原样输出。

当前 MIDI/MusicXML 导入器仍跳过鼓通道，所以导出的 `X` 再导入后不会自动恢复为节拍记号。这次支持的是播放和导出，不是完整的打击乐往返转换。

tinySynth 与 midi.js 均从 `https://madderscientist.github.io/noteDigger/lib/` 按需加载，不进入 npm/Vite bundle。网络加载失败只影响对应播放或 MIDI 操作，源码编辑、排版和图像导出继续可用。

## 预览渲染

`compileScore` 返回的 `layout` 可直接传入两个渲染后端：

```ts
renderLayoutPagesToSvg(layout, { padding, background }) // 返回分页 SVG 字符串数组
renderLayoutPagesToCanvas(layout, contexts)             // 画到每页的 2D context
```

SVG 路径直接使用最终坐标，不生成 `<defs>/<use>`，以简化渲染结构。SVG 内容与缩放无关，缩放时只修改 `style.width/height`，无需重新生成。

`renderLayoutPagesToCanvas` 在内部按页执行 `translate(-bounds.x, -bounds.y)`。前端负责创建数量匹配的 context，并处理画布尺寸、`devicePixelRatio` 和缩放。

VS Code 可使用 Webview 展示预览。`jpfun` 是纯 ESM，不依赖 DOM，因此既可在扩展主进程编译，通过 `postMessage` 将 SVG 字符串发送给 Webview，也可全部放在 Webview 中运行。在扩展主进程编译时，诊断与预览可以复用同一份编译结果。

## 分页与缩放

playground 将每个 `layout.pages[i].bounds` 展示为独立纸张，纵向排列，保留固定页间距。工具栏提供：

- 即时切换 SVG / Canvas 后端；
- 缩放菜单中的「适合宽度」和 50%～200% 常用倍率，内部缩放范围为 25%～300%；
- 默认适宽模式，按钮以 `适合宽度:53%` 的形式显示实时倍率；容器或页面宽度变化时自动调整，手动选择倍率或使用 `Ctrl+滚轮` 后退出适宽模式，只显示百分比；
- 普通滚轮滚动页面，`Ctrl+滚轮` 以指针位置为锚点缩放。

多页缩放锚点保存为「具体页面 + 页面内归一化坐标」，避免将页间距计入缩放比例。SVG 只更新已有根元素的 CSS 尺寸；Canvas 按当前缩放和 `devicePixelRatio` 重绘，连续滚轮事件合并到一个 animation frame。

发生致命错误时，当前编译结果被清空，之后缩放不会重新显示上一次成功的谱面。

## 源码与谱面定位

### 位置映射

源码与谱面共用一份不依赖渲染后端的映射：可见 Temporal 使用 `ast.sourceSpan + box`，最终 `PlacedAttachment` 使用 `sourceSpan + regions`。

除顶层 `layout.objects` 外，前端还从 `lowering.astToTemporal` 收集已完成布局的折叠成员，因此 grace/up 内部音符与各层复合体均可分别命中。`regions` 来自最终 attachment geometry，不包含试测轮的几何结果。自动 beam 的 span 取首末端点及其生效 div 作用域的并集。

函数包装只有在以下条件全部满足时，才会并入对象范围：仅有一个可见后代，且父 AST 本身既没有可见 Temporal，也没有独立 attachment。因此，`1/` 的音符和减时线都对应完整的 `1/`；grace 操作符不会覆盖内部音符各自的 span；`@box` 仍通过自身 attachment 定位。

### 从源码定位谱面

playground 只在鼠标点击源码或标签跳转时同步右侧谱面，键盘移动光标不触发同步。点击注释、空白或没有可见输出的声明时，清除强调，不选择附近对象。

文档修改后立即丢弃上一轮导航映射，防抖编译完成后再恢复，避免旧谱面使用新文档中已失效的 span。命中后只修改 `previewScroll.scrollLeft/scrollTop`，不通过 `scrollIntoView` 移动整个工作台；目标中心显示双层圆形波纹。

### 从谱面定位源码或播放位置

点击右侧谱面时，行为由左侧当前标签决定：

- 源码标签激活时，第一次 click 将光标放到 span 起点；500ms 内同一位置的第二次 click 选中完整 span。第二次点击的选区处理在 document 捕获层完成，因此即使布局变化使点击落在其他 DOM 元素上，也能保留原 range。
- 播放标签激活时，点击改为 seek 到对象的 score time，不改变编辑器选区。

命中测试先扣除纸张元素的 CSS 边框，再根据当前纸张的 `bounds`，将 SVG/Canvas 内容盒像素还原为全局布局坐标。随后在 region 外扩 6px 的范围内，选择面积最小、距离最近的目标。细 beam、tie 等关系图形因此优先于覆盖它们的大盒子，SVG 和 Canvas 无需分别维护 DOM source marker。

## 打印

打印前立即重新编译，并用同一批分页 SVG 建立独立打印树。动态 `@page size` 与布局纸张尺寸一致；工作台在打印媒体中隐藏，每个 SVG 后强制分页。打印结束后，清空临时节点和样式。

若重新编译失败，打印树保持为空，不打印过期谱面。

## 编辑约定

playground 通过 `EditorState.languageData` 声明：

```ts
commentTokens: { line: "%" }
closeBrackets: { brackets: ["(", "{", "[", "\""] }
```

对应 VS Code 的 `language-configuration.json`（`comments.lineComment`、`brackets`、`autoClosingPairs`）。

playground 使用 Tab 接受补全，回车插入换行。VS Code 默认允许 Tab 和回车接受补全；要保持相同交互，可在 `[jpfun]` 作用域下设置 `editor.acceptSuggestionOnEnter: "off"`。

playground 还提供行号、括号匹配、多光标、搜索、`Alt+Z` 切换折行、选中空白可视化和 `Ctrl+Enter` 手动排版。接入 VS Code 时，可复用编辑器已有的通用编辑功能。

## 当前限制

以下功能目前未实现：

- **查找引用**：尚不能从音符列出所有引用它的位置。`F2` 已计算绑定到同一个声明的引用，但没有提供引用列表 UI。
- **语义高亮**：尚未对未绑定标签、未知函数名等进行错误着色。这需要遍历 AST，仅靠 token 不足以判断。
- **格式化**和**代码折叠**。
- **增量解析**：每次按键仍会重新扫描全文词法信息。若需要支持更大规模的乐谱，可先考虑按行或大括号边界进行区间重扫。节点复用还需处理两个问题：`span` 使用绝对 offset，且 AST 会改写 grammar 阶段的 span 对象。

## 已知问题

- `@div(1)/` 这类语法糖作用于同名显式调用的写法，节点 span 没有扩展到尾部字符，仍为 `[0,7)`，因此悬浮在 `/` 上时没有响应。
- 文档修改后到下一次编译完成前，去糖悬浮不可用；词法层的函数文档悬浮不受影响。
