# 文档网站维护

所有网站内容统一放在 `apps/docs`，根目录不再维护 `docs`。

## 写教程

教程目录：`src/content/docs/docs/tutorial/`。

- `index.mdx`：教程入口，当前是第一课。
- `functions.mdx`：函数、语法糖与标签。
- 新课程：复制下面的模板为该目录下的 `.mdx` 文件。侧栏会自动收录，`sidebar.order` 控制顺序。

````mdx
---
title: 课程标题
description: 这一课要解决的问题。
sidebar:
  order: 2
---

import ScoreExample from "../../../../components/ScoreExample.astro";

先写这一课的目标。

## 一个最小例子

<ScoreExample source="1 2 3 4 | 5 - - -" />

解释例子中的新概念，再给读者一个可以修改的练习。
````

纯文字教程可使用 `.md`；需要谱例时使用 `.mdx` 和 `ScoreExample`。新建更深的子目录时，相应调整组件的相对导入路径。站内 Markdown 链接按页面 URL 编写，例如教程子页到速查是 `../../reference/`，不要写 `.md` 文件链接。

## 谱例组件

`ScoreExample` 在构建时完成 jpFun 编译和语法高亮，生成的 HTML 已包含代码与全部页面的 SVG，浏览器不再编译谱例。上方显示源码，右侧按钮复制原始代码，下方显示谱面。标题栏的按钮将这一份源码写入本地草稿后，在新标签页打开编辑器，原文档页保留。

- `title`：自定义标题，默认“jpFun 谱例”。
- `fit="fill"`：默认值，SVG 随容器宽度撑满或缩小。
- `fit="natural"`：保持构建时 SVG 的原始尺寸，不缩放；超出容器时横向滚动。

`fit` 在构建时写入静态页面，不需要浏览器编译或运行期尺寸计算。

```mdx
<ScoreExample title="和弦与延音" fit="natural" source={`1 ^ 3 ^ 5 - | 2 ^ 4 ^ 6 -`} />
<ScoreExample title="铺满容器" fit="fill" source="1 2 3 4 | 5 - - -" />
```

仅需要谱面、不需要代码和按钮时使用 `ScoreSvg`。在 Astro 页面或 MDX 中导入对应相对路径，然后传入源码：

```astro
---
import ScoreSvg from "../components/ScoreSvg.astro";
const source = `H.title: 我的曲谱
1 2 3 4 | 5 - - -`;
---

<ScoreSvg source={source} label="我的曲谱" fit="natural" />
```

这两个组件共享相同的 `fit` 选项与静态 SVG 渲染逻辑。非法源码导致的编译异常会让网站构建失败，便于在发布前发现错误；普通诊断遵循编译器现有规则。

## 三个板块

| 内容 | 文件位置 | 页面 |
| --- | --- | --- |
| Tutorial | `src/content/docs/docs/tutorial/` | `/docs/tutorial/` |
| 函数速查 | `src/content/docs/docs/reference/index.mdx` | `/docs/reference/` |
| 开发者文档 | `src/content/docs/docs/developer/` | `/docs/developer/` |

函数速查的参数表由 `src/components/FunctionReference.astro` 读取核心包的 `defaultFunctions` 生成。函数定义修改后先构建 core，再构建网站，不要手工复制参数列表。

开发文档的源码链接指向 GitHub HEAD；开发者文档之间使用相对站内链接。

Markdown 中的数学公式由 KaTeX 渲染；`mermaid` 代码块会按需转换成图表。两者资源都随网站构建，不依赖外部 CDN。

## 添加示例

在 `src/data/examples.ts` 的数组中添加 `id`、`title`、`description`、`source`。第一项直接引用 Playground 的 `PLAYGROUND_EXAMPLE`，因此只维护一份源码。页面位于 `src/pages/examples.astro`，仅显示标题、简单描述和右侧的“在编辑器中打开”，不显示源码或谱面。

所有编辑器入口都打开新标签页，不跳走当前页面。示例和教程谱例共用 `OpenScoreButton`：当前草稿与源码不同时先确认覆盖，然后写入共享的 `DRAFT_STORAGE_KEY` 并新开编辑器。存储不可用时显示错误，不打开新页。localStorage 按 origin 隔离，因此必须通过同一个站点访问示例与编辑器；两个不同端口不能互通。无需 URL 携带整份源码。

## 首页与截图

首页为 `src/pages/index.astro`，公共页面外框为 `src/components/SitePage.astro`，全站颜色与文档样式为 `src/styles/custom.css`。jpFun 品牌使用系统内置 Trebuchet MS 粗体，不安装或下载品牌字体。logo 右侧的渐隐谱面使用 `ScoreSvg`，当前源码为 `PLAYGROUND_EXAMPLE`；替换它的 `source` 即可更换谱面，无需手工生成 SVG。竖屏时谱面仍在右侧，高度延伸到操作按钮下方，靠近底部才淡出。

未来的真实截图放在 `public/images/`，在首页优势区域之后增加 `<figure>`，图片地址使用 `withBase("images/文件名.webp")`。

## 本地验证

完整开发体验在仓库根目录运行：

```sh
pnpm dev
```

默认访问 `http://127.0.0.1:4321/`，同一地址提供 `/docs/`、`/examples/` 和 `/playground/`。端口被占用时以终端打印的新地址为准。文档服务器代理编辑器的页面、模块和热更新连接，所以 localStorage、新页打开示例及两边的热更新都能一起验证，无需构建整站或手工启动第二个服务。

独立开发仍有各自的命令：

```sh
pnpm dev:docs        # 只启动文档，默认 4321
pnpm dev:playground  # 只启动编辑器，默认 4173
```

三个命令都会先构建核心包；只有 `pnpm dev` 会同时启动两边并持续监听核心源码。文档独立开发时编辑器路由不存在，两个不同端口也不共享 localStorage。

验证生产产物时，根目录构建会自动拼装完整网站，再用已有的 Vite 预览：

```sh
pnpm build
pnpm --dir apps/playground exec vite preview --outDir ../docs/dist --host 127.0.0.1 --port 4322
```

GitHub Pages 构建设置环境变量 `BASE_PATH=/jpFun`；所有页面、资源和编辑器入口必须兼容这个前缀。