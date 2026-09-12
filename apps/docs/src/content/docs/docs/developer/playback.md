---
title: 播放
description: 演奏区间、音段连接与最终状态，以及声音展开和设备适配的边界。
sidebar:
    order: 7
---

Playback 从 `LoweringResult` 编译播放计划。它与 Layout 使用相同的输入：Layout 计算页面几何，Playback 生成与设备无关、可转换为 MIDI 的定时事件。

## 三种时间坐标

| 坐标 | 含义 | 典型用途 |
| --- | --- | --- |
| 记谱时间（score） | 对象在原谱中的音乐位置，以 QN 为单位 | 关联 Lowering 事件与谱面位置 |
| 演奏时间（performance） | 按实际演奏顺序展开后的位置，以 QN 为单位 | 编排反复、房子与演奏事件 |
| 秒时间 | 沿演奏时间上的 Tempo 积分得到的实际时间 | 设备调度与播放进度 |

记谱时间与演奏时间均使用精确的 `Fraction` 表示。反复使同一记谱位置对应多次演奏访问；Tempo 决定 QN 到秒的换算，不改变事件的 QN 位置。

`scoreMap` 记录演奏时间到记谱时间的分段映射，供播放进度关联原谱。`secondsToScoreTime(plan, seconds)` 先按速度换算，再映射回记谱位置；输入限制在计划时长内，不向谱面之外外推。

## 计划与设备的边界

`PlaybackPlan` 保存完整编译结果，包括事件、轨道、时间映射与诊断，可以同时服务于实时播放和文件导出。

Web Audio、Web MIDI 和 Standard MIDI File 适配器消费同一事件计划。设备选择、PPQ 量化、实时调度和文件编码属于适配器，不应重新解释反复、房子或装饰音。布局几何也不参与事件生成，只有应用层的播放指示需要把时间映射回谱面。

## 编译入口与输出

使用 `compilePlayback` 编译播放计划：
```ts
compilePlayback(lowering, options?): PlaybackPlan
```

`options.maxFlowSteps` 限制反复、房子等控制流访问时间列的次数，默认 65,536，必须是正安全整数。超过上限时抛出 `E_PLAYBACK_FLOW_LIMIT`，不返回部分计划。

| `PlaybackPlan` 字段 | 内容 |
| --- | --- |
| `events` | 按演奏时间排序的定时事件 |
| `scoreMap` | 演奏位置到原谱位置的映射 |
| `tracks` | 最终实际发声的轨道 |
| `performanceDuration` | 展开后的总演奏时值，单位 QN |
| `durationSeconds` | 结合 Tempo 后的总秒数 |
| `diagnostics` | 播放编译产生的可恢复诊断 |

## 事件与轨道

输出计划中的音符用事件对表示。一个有时长的音符对应两个共享 `noteId` 的事件：
```text
NoteOn(at, noteId, track, midi, velocity, percussion?)
NoteOff(at, noteId, track, midi)
TimeSignature(at, numerator, denominator)
ProgramChange(at, track, program)
```

`PlaybackPlan.events` 当前包含 `tempo`、`time-signature`、`program-change`、`note-on`、`note-off`。同一时刻按 `tempo -> time-signature -> program-change -> note-off -> note-on` 排序，同类事件保持来源顺序。拍号不参与 QN 到秒的积分，只供 MIDI、节拍显示等设备适配器使用。

普通 NoteOn 的 `midi` 保留核心按记谱语义计算出的逻辑音高；`percussion: true` 时则表示打击键号。播放编译器不限制其范围，也不将其整数化；MIDI 适配器负责转换为目标设备接受的表示。

编译期音段及输出前的 NoteOn 引用与布局相同的 Track 对象。`lowering.tracks` 完整描述视觉拓扑，可以包含 head 槽位、只含休止符的声部等无发声轨。

最终音符事件生成后，Playback 按 `lowering.tracks` 的稳定顺序筛选轨道，只保留至少含一个 NoteOn 的 Track。输出的 `tracks` 从 0 开始连续编号，`events[].track` 是该数组的索引。head 等纯布局轨、只含休止符的轨和被控制流完全跳过的轨都不占播放通道。

## 编译流程

```mermaid
flowchart LR
    L[LoweringResult] --> F[linearizeColumns]
    F --> N[区间与音段结构处理]
    N --> R[连接及效果范围]
    R --> S[最终系统状态]
    S --> E[声音展开]
    E --> J[连接处的同音合并]
    J --> V[校验并稳定排序]
    V --> P[PlaybackPlan]
```

编译器按实际访问顺序收集有声与无声区间。每个节点发布完成后执行其结构 hook，此时可以修改此前区间的起止位置。全部结构确定后，`PlaybackRelation` 声明有声音段之间的连接，效果根据自身声明选择本区间范围或沿连接延续的范围。

随后一次性生成最终 Tempo 与状态时间线，各音段在这个状态下执行自己的声音变换链。最后产生 NoteOn/NoteOff，合并连接处时间相接的实际同音，并整理为输出计划。

结构阶段不提供 `stateAt`。声音展开只能修改自身音段的发声内容，必须保持已经确定的外部时间边界。这个单向依赖保证跨声部效果、连接和装饰音使用同一份最终速度。

## 编译期区间与音段

`PlaybackSpan` 保存 `start`、`end`、Track 与来源，承载有声和无声目标的结构边界及速度效果。`PlaybackNote` 在这个区间上增加 `midi`、`velocity` 与可选的调内移调函数。每次发布产生一个独立对象，有声音段同时出现在区间集合中。连接保留两个音段对象，不提前合并它们的时值或装饰。

发布时只需提供区间与发声数据，轨道和来源由编译器补齐：

```ts
interface PlaybackSpanInput {
    start: Fraction;
    end: Fraction;
}

interface PlaybackNoteInput extends PlaybackSpanInput {
    midi: number;
    velocity: number;
    percussion?: true;
    transpose?: (steps: number) => number;
}
```

`start` 与 `end` 位于演奏 QN 轴，发布时复制传入的 `Fraction`。结构完成后的每个区间都必须具有有限的非负起点和正时值。无声区间与有声音段遵循同一套时间约束，结构扩展后的终点也计入 `performanceDuration`。

区间结构完成后，其边界和来源被冻结。只有有声音段执行声音变换，并接收起止时间的独立副本；无声区间不生成 NoteOn/NoteOff 或占用播放通道。最终事件生成后不再保留这层表示，设备端始终只消费 `PlaybackPlan.events`。

`1 ^ $tr -` 的增时线扩展同一个音段，因此颤音覆盖完整两拍。`1 ^ $tr 1 @tie()` 则连接两个独立音段，第二段保留普通持续音。

## 控制流

`linearizeColumns` 输出实际访问的列号序列。反复可能让同一列出现多次，房子可能跳过某些列。每次节点访问都有独立的 origin 对象，同一个 Temporal 在反复中也会生成不同的事件和 `noteId`。

反复结束线回到此前最近的反复开始线。例如 `|: 1 |: 2 :| 3 :|` 展开为 `1 2 2 3 2 3`，与 MuseScore 一致。

`playbackMarks` 只能由进入时间流、拥有列位置的 Temporal 声明。attachment 可以通过 `playbackFlow(columnOf)` 用自身端点声明区间，但不能单独声明标记。

显式 flow 的 `range` 必须是时间列内的升序闭区间，`jump` 目标必须位于 `0..columns.length`，其中 `columns.length` 表示跳到文末。不符合要求时分别抛出 `E_PLAYBACK_FLOW_RANGE` 或 `E_PLAYBACK_FLOW_JUMP`。

`scoreMap` 记录控制流展开后的 performance QN 到原始 score QN 的映射。相邻点之间两者以 1:1 前进；反复和房子只表现为映射点处的 score 跳转。

## PlaybackEmitter

Temporal 通过 `emitPlayback(emitter)` 定义自身的播放行为：

```ts
interface PlaybackEmitter {
    readonly start: Fraction;
    readonly end: Fraction;
    readonly track: Track;

    span(span: PlaybackSpanInput): void;
    note(note: PlaybackNoteInput): void;
    extend(span: PlaybackSpan): void;
    emit(event: PlaybackEventInput): void;
    control(at: Fraction, apply: PlaybackControl): void;
    scaleFollowingBpm(key: object, numerator: number, denominator?: number,
        options?: { followConnections?: boolean }): void;
    affectFollowing(transform: PlaybackTransform): void;
    defer(hook: PlaybackHook): void;
    play(child: TemporalNodeBase, start?: Fraction, duration?: Fraction): void;
}
```

- `span` 为无声目标发布区间，参与结构和速度效果处理
- `note` 为发声目标发布完整音段，NoteOn/NoteOff 与 `noteId` 在声音展开后统一生成
- `extend` 在结构处理中用当前访问接续已有区间，保留目标身份，并从新增部分继承速度效果
- `emit` 发布系统事件，目前支持拍号
- `control` 在指定时刻修改播放系统状态
- `scaleFollowingBpm` 为同一 play frame 的后续有声及无声区间声明速度比例及作用范围
- `affectFollowing` 为同一 play frame 的后续音段登记声音变换
- `defer` 在当前节点发布完成后处理此前区间，dash 使用它选取要延长的区间
- `play` 递归发布折叠成员，未指定区间时继承当前区间

每个 play frame 维护局部 transform 链和速度效果声明。修饰节点先登记声明，后续兄弟目标在各自访问时继承；已经发布的目标保留原有声明。子 frame 继承副本，内部新增修饰不影响父级。每个叶区间保存继承的速度效果，有声音段另行保存声音变换链；复合父节点不会再次展开同一叶音。

## 系统状态与控制事件

速度通过系统状态生成。`onTimeState` 先将记谱位置上的基础 BPM 保存到 `Temporal.playbackState`；每次实际访问 Temporal 时，编译器将这个快照同步到 `PlaybackSystemState`。tempo 函数本身不直接发布速度事件。

控制事件用函数描述状态修改，由系统调度执行：

```ts
type PlaybackControl = (state: PlaybackSystemState) => void;
```

有效速度为：

$$
effectiveBpm = baseBpm \times bpmScale
$$

fermata 用模块私有 key 声明比例，并选择沿音段连接延续作用范围：

```ts
const FERMATA_BPM_SCALE = {};
emitter.scaleFollowingBpm(FERMATA_BPM_SCALE, 1, 2, { followConnections: true });
```

同 key 的重叠、相邻区间取并集，只贡献一次比例；不同 key 的比例相乘。因此多个声部的 fermata 重叠时仍只减半一次。同 key 必须使用固定比例，非法比例或冲突声明抛出带源码位置的 `E_PLAYBACK_BPM_SCALE`。

效果默认覆盖结构确定后的本区间，包括休止符等无声目标。`followConnections: true` 将有声音段的终点延续到连接链尾，起点仍保留标记音段自己的起点。例如 tie 链中第二段的 fermata 从第二段开始，不会向前覆盖第一段。装饰音的子音数量及物理合并结果不参与效果范围计算。

`extend` 继承的效果从当前访问的新增部分开始。起点保存为所属区间内的相对位置，后续整体缩放时随之变换；再次扩展会重新计算这个比例，保持原起点。它保留原区间身份，因此后续延音与逻辑连接仍作用于同一目标。不属于当前计划、时间不相接或扩展时值非正时抛出 `E_PLAYBACK_EXTEND_RANGE`。

系统对控制时刻与效果边界进行一次排序扫描，按 key 的活动区间数维护比例；同刻处理完成后，仅在 effective BPM 改变时生成 `tempo`。每个 `control` 回调只执行一次，`stateAt` 返回与内部时间线隔离的快照。反复访问到的 Temporal 仍按自身 `playbackState` 恢复基础速度。

program 同样先由 `onTimeState` 保存到记谱位置，默认值为 0。它按 Track 流动，不进入全局 `PlaybackSystemState`。编译器按实际访问顺序维护每轨当前 program，只在变化时生成 `program-change`。

反复回跳时，目标音符的快照会恢复对应音色，无需在全局系统状态中增加每轨状态表或跳转快照。目前尚不支持 ControlChange 和 PitchBend。

## Origin 与局部变换

每次调用 `play(node)` 都会创建一个独立的 origin 对象：

```ts
interface PlaybackOrigin {
    node: TemporalNodeBase;
}
```

同一个 Temporal 在反复中的不同访问通过对象身份区分，不使用额外的 occurrence 数字。音段保存自身与复合祖先的 origin lineage；声音展开继承这份来源，连接保留各段身份。最终物理音符合并时才汇总 source spans。

最终状态生成后，局部 transform 接收目标音段及前一层展开结果：

```ts
type PlaybackTransform = (
    context: PlaybackTransformContext,
    notes: PlaybackNote[],
) => PlaybackNote[] | void;
```

accent 原地修改 velocity；ornament 返回多个子音段，下一层 transform 继续处理这些派生音。因此局部修饰只处理自己的输入，无需扫描全篇。

| 阶段与上下文 | 可读取的数据 | 可执行的修改 |
| --- | --- | --- |
| 结构：`PlaybackHookContext` | 此前发布的 `spans` 与有声子集 `notes`，两者共享对象 | 修改区间边界与音段属性，或通过 `extend` 接续已有区间 |
| 关系：`PlaybackRelationContext` | 全部冻结的有声音段 `notes` | 通过 `connect(from, to)` 尝试建立连接 |
| 声音：`PlaybackTransformContext` | 输入音段的副本，以及 `stateAt(time)` 返回的最终状态快照 | 修改或替换自己的音段列表，保留外部起止边界 |

结构与关系上下文中的区间、音段列表只读，诊断数组仍可追加。声音变换共享的来源对象和数组被冻结，`stateAt` 返回的 `bpmScale` 是独立副本；修改该副本不会改变其他音段查询到的速度。

每个音段至多一个前驱和后继，首次连接或重复声明同一连接返回 `true`。候选与既有配对冲突时返回 `false`，原连接保持不变，声明者可以继续尝试其他候选。

声音展开必须保持原音段最早起点和最晚终点，每个子音位于原区间内且时值为正。需要改变时值的功能应在结构阶段完成。

core 只认识音段、连接、区间效果和声音展开协议。具体函数决定匹配规则和发声算法，不定义专用事件 kind，也不向 core 注册函数名称或类型分支。

## 协议诊断

编译错误以带源码位置的诊断抛出，不返回部分计划。除前述控制流诊断外，区间与状态协议使用以下诊断：

| 代码 | 触发条件 |
| --- | --- |
| `E_PLAYBACK_NOTE_RANGE` | 有声或无声区间出现非有限时间、负起点或非正时值 |
| `E_PLAYBACK_EXTEND_RANGE` | 扩展目标不属于当前计划、目标末端不等于当前访问起点，或扩展时值非正 |
| `E_PLAYBACK_CONNECTION` | 连接端点不属于当前计划，或前后区间不相接 |
| `E_PLAYBACK_CONTROL_TIME` | 系统控制的时刻为负或非有限值 |
| `E_PLAYBACK_BPM_SCALE` | 比例的分子或分母不是正安全整数，或同 key 声明不同的比例 |
| `E_PLAYBACK_BPM` | 最终有效 BPM 不是有限正数 |
| `E_PLAYBACK_TRANSFORM_RANGE` | 声音展开越界、移动外边界、生成非正时值子音或返回空结果 |

函数还可以向上下文的 `diagnostics` 添加可恢复问题。例如增时线找不到可接续区间时添加 `W_PLAYBACK_SUSTAIN_WITHOUT_TARGET`，计划仍可生成。应用将这些诊断与编译、排版诊断一起展示。

## 各函数的播放行为

### Note

note 根据已保存的音高、力度和当前演奏区间调用 `emitter.note`。NoteOn/NoteOff 和共享 `noteId` 由 core 在声音展开后统一生成。休止符 `0/Z` 和占位符 `8` 调用 `emitter.span`，保留结构边界与速度效果，并推进 performance QN。

节拍记号 `9/X` 在音段中指定 `midi=37` 和 `percussion: true`，其中 `midi` 表示 GM 打击键。它保留原 Track 和力度，不提供调内移调函数，所以重音生效、颤音和波音不展开。tie 只连接同种类的同键号音段。

浏览器合成和 MIDI 打击通道路由属于设备适配，详见[编辑器集成](../editor/)。它们不改变核心计划中的原声部身份。

力度和 program 在 `TimeState` 中按音轨各自流动（见 lowering 文档），所以 `$p`、`$f`、`@dyn` 和 `@program` 都只影响自己所在的声部，新声部则继承分叉处的状态；速度和调性仍整篇共享。

### Program

`@program(0..127)` 产生不可见的零时值 Temporal。它在 lowering 时修改当前 Track 的 program，后续音符保存各自位置的快照。播放编译同时使用 program 声明和音符快照，使顺序演奏与控制流跳转得到相同的音色结果。

### Meter

meter 发布 TimeSignature。与其他 Temporal 一样，事件按实际控制流访问生成，因此反复段内的拍号每遍都会出现，反复段外的拍号只出现一次。

core 保留任意正整数分母。Standard MIDI File 只能表示以 2 为幂的分母，MIDI 适配器在导出时检查这一限制。

### Up 与 Grace

up 按附属成员到宿主的顺序调用 `play`。grace 在宿主区间内计算借时，再用显式 start/duration 发布倚音和宿主。

### Accent 与 Ornament

accent、tr 和波音使用 `affectFollowing`。结构和最终状态确定后，依次执行目标音段保存的 transform 链：accent 修改 velocity，tr/波音将目标音段展开为多个子音段。

后一个 transform 继续处理前一个 transform 的派生音，包括各自的调内移调位置，因此书写顺序会影响结果。

ornament 用 `stateAt(note.start).effectiveBpm` 决定极端速度下的密度。增时线改变的完整时值以及其他声部的最终速度效果都会参与计算。

### Arpeggio

琶音在结构阶段按方向错开成员起点，成员的内部区间等比压缩到剩余窗口，共同终点保持不变。这样多倚音不会因末端裁切产生非正时值，颤音也会在缩放后的完整窗口内展开。无声成员同样占用延迟槽并缩放区间，其速度效果使用缩放后的边界；系统控制事件保留原时刻。

### Dyn

`@dyn(from, to, dv)` 在 Lowering 阶段计算力度，不生成运行期 relation。所有 `onTimeState` 完成后，Lowering 遍历 `astToTemporal`，为普通音符以及 up/grace 的折叠成员累计力度增量。

区间内，增量按记谱时间从 0 线性变化到 `dv`；区间后保持完整增量，直到下一次原始力度变化。增量叠加在每个音符已保存的力度上，dyn 不识别 `$p`、`$f` 或其他具体函数。因此，区间内的力度记号仍独立生效，多条 dyn 的贡献按数值加法累计。

播放编译只根据 note 的 `playbackState.velocity` 发布 NoteOn。反复访问相同 Temporal 时，会重放同一条记谱力度曲线。

### Dash

dash 用 `defer` 捕获自身的 Track 和 start。发布到 dash 时，它向前查找同轨上一组恰好在 start 结束的区间，再通过 `extend` 延长区间并承接当前位置的速度效果。有声与无声目标遵循同一规则，声音展开此时尚未执行。

dash 本身有正时值，因此会在 lowering 时保存所在位置的 BPM。即使控制流直接跳到 dash，秒数积分仍使用该记谱位置的速度。

- `1 - -` 将同一个音段延长到三拍
- `0 ^ $fermata -` 将无声区间和减速范围一起延长到两拍
- `1 - ^ $fermata -` 持续发声三拍，减速从第二拍开始并覆盖后续延音
- `9 - -` 同样延长音段，但短促打击音的包络自然衰减，不重复敲击
- `1^3 -` 同时延长和弦的全部音段
- `1^$tr -` 在完整两拍内持续颤音，默认速度下生成 16 个子音

### Tie

tie 通过 attachment 的 `PlaybackRelation` 在结构 hook 之后执行。它按同轨、同种类、同逻辑音高且时间相接的规则一对一匹配音段，并声明连接。涉及增时线的端点没有自己的发声音段，因此只绘制连音线。

每段保留自己的时值和修饰，普通持续音不会继承前段的颤音。全部声音展开后，只合并连接处实际同音且时间连续的事件对，保留前音的 `noteId`，并一次性汇总连接链的 source spans。若前段颤音的末音与后段不同音，则保留该次换音。

反复中的各次访问独立匹配。重叠声明复用既有配对，遇到已被其他连接占用的候选时继续尝试剩余成员；已建立的配对不被后续声明改写。交叉声明的连接通过音段对象串联，不依赖此前物理音符是否已经合并。

## 应用集成

应用可以按源码版本缓存播放计划，在源码变化后使旧计划失效。实时播放与 MIDI 导出复用同一计划，分别完成设备调度与文件编码；暂停、跳转、音量和音色覆盖等交互状态由应用管理。

playground 的计划生命周期、tinySynth 调度与 MIDI 编码策略见[编辑器集成](../editor/)。