---
title: 在自己的项目里使用 jpFun
sidebar:
  order: 7
---

jpFun 的本质是一个通用的解析、布局引擎。“通用”意味着你可以在任何支持 JavaScript 的环境中使用 jpFun，而不必依赖特定的框架或平台。

因此，你可以在自己的项目中直接引入 jpFun：
```bash
npm install jpFun
```

```ts
import { compileScore, renderLayoutPagesToSvg } from "jpfun";

const source = `1,/ 2/ 3//`;
const result = compileScore(source);
const pages = renderLayoutPagesToSvg(result.layout);
```

或者直接在 html 中导入：
```html
<script src="https://unpkg.com/jpfun/dist/jpfun.min.js"></script>
<script>
    const { compileScore, renderLayoutPagesToSvg } = jpfun; // 暴露的全局变量
    document.body.innerHTML = renderLayoutPagesToSvg(compileScore("1 2 3 | 4 -").layout)[0];
</script>
```

不过“通用”也有代价——具体怎么呈现、如何播放，需要开发者根据运行环境自行实现。

两个生动的例子就是配套的文档和[编辑器](/playground)。还记得教程中时不时插入的“示例”吗？这就是通过 jpFun 渲染出来的（构建时执行）。而编辑器是最完整的使用 jpFun 的示例，具体实现了什么功能，请参考 [编辑器集成](/docs/editor/)。

下面将介绍 jpFun 的接口层级与调用方法。

## `compileScore` 的输入与输出

```ts
compileScore(source, options?): CompileScoreResult
```

`source` 是完整的 jpFun 源码。`compileScore` 会依次完成预处理、解析、时间固化和布局，并保留每个阶段对外有用的结果：

| 字段 | 内容 | 常见用途 |
| --- | --- | --- |
| `lineStarts` | 每个逻辑行在源码中的起始偏移 | 把诊断位置换算成行列号 |
| `maskedSource` | 注释和续行符经等长空格替换后的源码 | 按原始偏移检查有效源码字符 |
| `diagnostics` | 解析、固化和布局阶段共享的诊断 | 展示语法、参数和排版问题 |
| `ast` | 完整 AST 根节点 | 源码工具、自定义分析 |
| `lowering` | 音乐时间、轨道和关系对象 | 播放、MIDI 或时间分析 |
| `layout` | 页面、对象位置和最终几何 | SVG、Canvas 或自定义渲染 |

`maskedSource` 与输入源码等长，所有字符偏移仍对应原始源码。它不是另一种可保存的 jpFun 文本，而是预处理阶段的中间结果。例如，预览可以借它判断一次源码点击是否落在已被掩码的注释内。

常用选项可以在一次编译中一起传入：

```ts
const compiled = compileScore(source, {
  fontSize: 16,
  rowGap: 18,
  textMeasurer,
  functions,
});
```

- `fontSize` 设置根解析作用域的默认字号，单位为 CSS 像素。
- `rowGap` 强制设置每行轨道之间的间距；缺省时按该行最大字号推导。
- `textMeasurer` 替换默认文本测量器，适合需要匹配特定字体度量的应用。
- `functions` 替换内置函数注册表，并非在默认函数后追加。扩展默认能力时需要自行包含 `defaultFunctions`。
- `damping`、`maxIter`、`eps`、`crossPunish` 和 `globalC` 用于调整横向布局求解器，通常不需要设置。

页面尺寸、边距和页码属于乐谱内容，应通过源码中的 `@page(...)` 设置，而不是通过 `compileScore` 选项设置。

## 处理诊断

能够恢复的问题会进入 `compiled.diagnostics`，编译仍然返回可用的 AST 和布局。每条诊断都包含稳定的 `code`、说明文字 `message` 和源码偏移 `span`：

```ts
import { ErrorDiagnostic, compileScore } from "jpfun";

const compiled = compileScore(source);

for (const diagnostic of compiled.diagnostics) {
  const range = diagnostic.toLineCol(compiled.lineStarts);
  console.log({
    severity: diagnostic instanceof ErrorDiagnostic ? "error" : "warning",
    code: diagnostic.code,
    message: diagnostic.message,
    range,
  });
}
```

`toLineCol` 返回从 1 开始的行号和列号，适合没有文本编辑器模型的环境。CodeMirror 可以直接使用 `doc.lineAt(diagnostic.span.start)`，VS Code 则可使用 `document.positionAt(...)`，不必再做一次行起点查找。

无法恢复的解析错误或非法编译选项会由 `compileScore` 抛出，因此处理用户输入时还应包住调用。抛出的值若是 `Diagnostic`，其 `span` 仍可用于定位；其他异常应当作为内部错误展示，而不要假定它带有源码位置。

```ts
try {
  const compiled = compileScore(source);
  showScore(compiled.layout);
  showDiagnostics(compiled.diagnostics);
} catch (error) {
  showCompileError(error);
}
```

## 渲染结果

SVG 接口直接返回每页对应的字符串，适合服务端生成、静态站点构建和浏览器预览：

```ts
import { compileScore, renderLayoutPagesToSvg } from "jpfun";

const { layout } = compileScore(source);
const pages = renderLayoutPagesToSvg(layout, { background: "#fff" });
```

Canvas 接口消费同一份 `layout`。调用方负责为每页创建画布，并设置 CSS 尺寸和设备像素比：

```ts
import {
  compileScore,
  layoutPageBounds,
  renderLayoutPagesToCanvas,
} from "jpfun";

const compiled = compileScore(source);
const pixelRatio = window.devicePixelRatio || 1;
const canvases = layoutPageBounds(compiled.layout).map(page => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(page.w * pixelRatio);
  canvas.height = Math.ceil(page.h * pixelRatio);
  canvas.style.width = `${page.w}px`;
  canvas.style.height = `${page.h}px`;

  const context = canvas.getContext("2d")!;
  context.scale(pixelRatio, pixelRatio);
  return { canvas, context };
});

renderLayoutPagesToCanvas(
  compiled.layout,
  canvases.map(item => item.context),
);
```

传入的 context 数量必须与布局页数一致。SVG 和 Canvas 不会重新解析源码；切换后端时可以复用原来的编译结果。更详细的分页、绘制顺序和自定义 `Painter` 接口见[渲染后端](./render/)。

## 生成播放计划

布局和播放并列消费 `lowering`。`compileScore` 不会主动展开反复或生成播放事件；只有需要播放、导出 MIDI 或分析实际演奏顺序时，才调用 `compilePlayback`：

```ts
import { compilePlayback, compileScore } from "jpfun";

const compiled = compileScore(source);
const plan = compilePlayback(compiled.lowering);

console.log(plan.events);
console.log(plan.durationSeconds);
```

`PlaybackPlan` 包含按演奏时间排序的速度、拍号、音色、NoteOn 和 NoteOff 事件，但不会自行发声。应用需要使用 Web Audio、Web MIDI 或其他音频后端调度这些事件。异常庞大的反复结构可以通过 `{ maxFlowSteps }` 显式提高默认的 65,536 列访问预算；超过预算会抛出错误，而不会返回截断的计划。时间映射、反复展开和事件结构见[播放](./playback/)。

## 导入 MIDI

`midiJsonToJpFun` 接收 [midi.js](https://madderscientist.github.io/noteDigger/lib/midi.js) 的 `JSON()` 结果并生成可继续编辑的 jpFun 源码。MIDI 字节解析属于应用边界，jpFun 不会替你读取 `.mid` 文件：

```ts
import { midiJsonToJpFun } from "jpfun/converter/midi";

const source = midiJsonToJpFun(parsedMidiJson, {
  title: "My Score",
  pitchMode: "absolute",
  alignRate: 4,
  barsPerLine: 0,
});
```

- `pitchMode` 默认为 `"absolute"`；使用 `"relative"` 可生成以 C 为基准的数字谱。
- `alignRate` 控制二进制时值的自适应量化精度。
- `barsPerLine` 默认为 `0`，表示依据真实排版宽度自动换行；正整数表示每行固定小节数。
- `title` 覆盖 MIDI 文件头中的名称。

转换器会保留音符、和弦、重叠声部、轨道名、速度、拍号和 MIDI program，并识别常见的 3:2 四分、八分与十六分三连音。鼓通道以及控制器、弯音等目前不会进入生成的源码。

## 导入 MusicXML

`musicXmlToJpFun` 接收已经解析好的 XML 根元素。浏览器可以直接使用原生 `DOMParser`：

```ts
import { musicXmlToJpFun } from "jpfun/converter/musicxml";

const xml = await file.text();
const document = new DOMParser().parseFromString(xml, "application/xml");
const parseError = document.querySelector("parsererror");
if (parseError) throw new SyntaxError(parseError.textContent || "Invalid MusicXML");

const source = musicXmlToJpFun(document.documentElement, {
  pitchMode: "absolute",
  barsPerLine: 4,
});
```

在 Node.js 中可使用任意兼容 DOM 实现，并传入满足 `MusicXmlElement` 接口的根元素。转换器支持 partwise/timewise、part/staff/voice、休止与和弦、倚音、连音、连音组、歌词、速度、调号、拍号、力度、反复与房子，以及基本的分页和谱头信息。

压缩的 `.mxl` 不在支持范围内；应先解压，或者从制谱软件导出 `.musicxml`。

### 让转换器按需分包

两个转换器既可以从 `jpfun` 根入口导入，也各自提供独立子路径。应用始终需要某个转换器时，优先静态导入对应子路径；这样入口依赖更明确，也避免把另一个转换器带进同一模块图。

对于“点击导入后才需要”的功能，使用动态 `import()` 可以让 Vite、Rollup、webpack 等构建工具把转换器生成独立 chunk：

```ts
async function importScore(file: File) {
  if (/\.musicxml$/i.test(file.name)) {
    const { musicXmlToJpFun } = await import("jpfun/converter/musicxml");
    const document = new DOMParser().parseFromString(
      await file.text(),
      "application/xml",
    );
    return musicXmlToJpFun(document.documentElement);
  }

  if (/\.midi?$/i.test(file.name)) {
    const { midiJsonToJpFun } = await import("jpfun/converter/midi");
    const parsedMidiJson = await parseMidiFile(file);
    return midiJsonToJpFun(parsedMidiJson);
  }

  return file.text();
}
```

这里的分包由应用构建工具完成，不是 jpFun 在运行时自行下载模块。`import("jpfun")` 会以整个根入口作为异步边界；若目标是分别延迟加载 MIDI 和 MusicXML，应使用上面的两个子路径。未配置打包器的原生 ESM 环境仍会按模块加载，但不会自动生成可部署的 chunk 文件。

## 只分析编辑器语法

编辑器不必在每次按键后都执行完整布局。`analyzeScoreSyntax` 只识别函数调用和 token，并尽量容忍尚未输入完整的代码：

```ts
import { analyzeScoreSyntax } from "jpfun";

const { syntax, diagnostics } = analyzeScoreSyntax(source);
```

它适合语法高亮、函数名悬浮、补全和输入过程中的轻量诊断；需要 AST、播放或渲染时仍应使用 `compileScore`。两条路径共享同一套语法定义，但承担不同的容错边界，具体配合方式见[编辑器集成](./editor/)。

## 选择合适的层级

多数应用只需要以下组合：

| 目标 | 使用的入口 |
| --- | --- |
| 显示或导出谱面 | `compileScore` + `renderLayoutPagesToSvg` |
| 绘制到浏览器画布 | `compileScore` + `renderLayoutPagesToCanvas` |
| 播放或导出事件 | `compileScore` + `compilePlayback` |
| MIDI 转为 jpFun | `jpfun/converter/midi` |
| MusicXML 转为 jpFun | `jpfun/converter/musicxml` |
| 编辑器即时语法反馈 | `analyzeScoreSyntax` |
| 自定义绘制后端 | `compileScore` + `paintLayoutPages` / `Painter` |

只有在实现自定义函数、编译阶段或渲染后端时，才需要直接操作 AST、Lowering 和 Layout 的低层类型。

仓库中的文档网站会在构建时调用核心库生成教程谱例；[在线编辑器](/playground)则展示了浏览器中编译、诊断、预览、播放和导出的完整集成。
