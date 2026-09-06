# jpFun —— 函数式简谱脚本
`jpFun` 是一个使用 TypeScript 编写的简谱 DSL 编译器与排版引擎。

它借鉴 Typst 的设计思路：底层能力由函数表达，常用写法则通过语法糖保持简洁。项目遵循一个核心原则：

> 框架实现机制，函数定义行为；函数之间解耦，注册到框架中被调用。

[在线编辑器](https://madderscientist.github.io/jpFun/playground)

## 起因
乐谱排版 DSL 并不是一个新鲜玩意。早在 1996 年，LilyPond 就已经实现了一个功能完备的五线谱排版系统（简直是乐谱界的 Latex）。同一时期还有 ABC 记谱法等 DSL 方案。

即使细化到简谱，也已经有了很多优秀的实现：
- `jianpu-ly`：对 LilyPond 的深度拓展，功能和 LilyPond 一样强大；
- [番茄简谱](http://zhipu.lezhi99.com/Zhipu-index.html)：老牌的简谱编辑器，语法简单，谱面美观；
- [`Sparks NMN`](https://github.com/yezhiyi9670/sparks-notation-1)：新兴的开源简谱 DSL，可设置性较强，功能颇为丰富。

那为什么有了本项目呢？主要是因为现有的简谱 DSL 都有一些问题：
- `LilyPond` 功能强大，但过于复杂。这就好比大家对 Latex 的诟病。
- `番茄简谱` 简单，但定制性不强、功能有限，且不更新。这就好比大家对 Markdown 的诟病。
- `Sparks NMN` 像番茄简谱的超级升级版，但是为了支撑更多的功能，用到了各种奇怪的语法。我深入查看了源码，发现这些语法和解析过程深度绑定，要修改也无从下手。此外还有一些很想吐槽的点：
    - 一行的小节数要提前指定，要不同的宽度还得自己分配。排版效果不如番茄简谱
    - 不支持“柱状音符”（即和弦）和“临时多声部”

本项目的目标是：
- 语法简单、易于理解和使用；
- 高度拓展性：新功能可以很容易加上；

于是，本项目的语法设计借鉴了 `Typst`：
- 底层都是“函数调用”，一个功能就是一个函数
- 常用函数提供“语法糖”，以满足“简单语法”的需求

但是“函数式”其实也带来了一些设计的困难，比如“连音线”这种有跨度的多元素关系。具体怎么做的……看看[语法](./packages/jpfun/grammar.md)吧！


## 开发
项目使用 pnpm workspace：
```sh
pnpm install
pnpm run build
pnpm test
```

常用命令：
```sh
pnpm dev                   # 一起启动文档、编辑器及核心编译监听
pnpm dev:playground        # 只启动编辑器，默认 http://127.0.0.1:4173/
pnpm dev:docs              # 只启动文档，默认 http://127.0.0.1:4321/
pnpm run build:core        # 构建核心包
pnpm run build:playground  # 构建 Playground
pnpm run typecheck         # 只做类型检查（tsx 跑测试时不检查类型）
pnpm run test:update       # 重写测试快照基线
```

`pnpm dev` 的统一入口默认是 `http://127.0.0.1:4321/`：

- `/`：首页
- `/docs/`：文档
- `/examples/`：示例列表
- `/playground/`：编辑器

文档与编辑器共享同一来源，示例打开时的 localStorage 能直接互通，两边均支持热更新。编辑器内部端口自动分配，无需单独访问。若 4321 已占用，会自动选择下一个可用端口，以终端输出的地址为准；可用 `PORT`、`HOST` 环境变量指定统一入口的端口和监听地址。Ctrl+C 会一起关闭本次启动的服务和核心监听。

三个命令都会先构建核心包。`dev:docs` 与 `dev:playground` 不启动另一个应用，因此单独使用 `dev:docs` 时 `/playground/` 不可用；需要完整跳转流程时使用 `pnpm dev`。修改核心源码需要持续联动时也使用 `pnpm dev`。

## 仓库结构
- `packages/jpfun/`：可独立发布的 `jpfun` npm 包、源码与测试
- `apps/playground/`：通过 `workspace:*` 使用公开包入口的 Vite 网页应用
- `apps/docs/`：基于 Starlight 的文档网站，包含教程、函数速查和开发者文档
- `scripts/`：仓库开发脚本

## npm 包
核心包位于 [`packages/jpfun`](./packages/jpfun/README.md)，使用 Apache-2.0 许可证

## 开发文档
- [架构总览](apps/docs/src/content/docs/docs/developer/architecture.md)
- [语法解析](apps/docs/src/content/docs/docs/developer/parser.md)
- [Lowering](apps/docs/src/content/docs/docs/developer/lowering.md)
- [布局系统](apps/docs/src/content/docs/docs/developer/layout.md)
- [渲染后端](apps/docs/src/content/docs/docs/developer/render.md)
- [播放](apps/docs/src/content/docs/docs/developer/playback.md)
- [编辑器集成](apps/docs/src/content/docs/docs/developer/editor.md)
- [教程与网站维护](apps/docs/README.md)
- [完整语法规范](packages/jpfun/grammar.md)

## todo
- [ ] VSCode 插件
- [ ] 教程网站，wiki
