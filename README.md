# jpFun —— 函数式简谱脚本
`jpFun` 是一个使用 TypeScript 编写的简谱 DSL 编译器与排版引擎。

它借鉴 Typst 的设计思路：底层能力由函数表达，常用写法则通过语法糖保持简洁。项目遵循一个核心原则：

> **框架实现通用机制，函数定义具体行为，函数之间保持解耦。**

[在线试用](https://madderscientist.github.io/jpFun/)

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
pnpm run dev               # 启动 Playground
pnpm run build:core        # 构建核心包
pnpm run build:playground  # 构建 Playground
pnpm run typecheck         # 只做类型检查（tsx 跑测试时不检查类型）
pnpm run test:update       # 重写测试快照基线
```

## 仓库结构
- `packages/jpfun/`：可独立发布的 `jpfun` npm 包、源码与测试
- `apps/playground/`：通过 `workspace:*` 使用公开包入口的 Vite 网页应用
- `docs/`：架构与实现文档
- `scripts/`：仓库开发脚本

## npm 包
核心包位于 [`packages/jpfun`](./packages/jpfun/README.md)，使用 Apache-2.0 许可证

## 开发文档
- [架构总览](docs/ARCHITECTURE.md)
- [语法解析](docs/parseAST.md)
- [Lowering](docs/lowering.md)
- [布局系统](docs/layout.md)
- [渲染后端](docs/render.md)
- [编辑器集成](docs/editor.md)
- [完整语法规范](packages/jpfun/grammar.md)

## todo
- [x] 节奏型，可以加上校验抛出警告
- [x] 标题、作者等
- [x] VSCode 插件