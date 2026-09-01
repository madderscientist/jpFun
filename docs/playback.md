# 播放

Playback 与 Layout 并列消费 `LoweringResult`。Layout 生成页面几何，Playback 生成与设备无关、可直接翻译成 MIDI 的时刻事件。

入口只有一个：
```ts
compilePlayback(lowering, options?): PlaybackPlan
```

`options.maxFlowSteps` 限制反复、房子等控制流最多访问多少个时间列，默认 65,536。它必须是正安全整数；超过预算会抛出 `E_PLAYBACK_FLOW_LIMIT`，不会返回残缺计划。

## 事件是唯一事实来源
音符没有另一份 `start + duration` 表示。一个有时长的音符由共享 `noteId` 的两个事件组成：
```text
NoteOn(at, noteId, track, midi, velocity)
NoteOff(at, noteId, track, midi)
TimeSignature(at, numerator, denominator)
```

最终 `PlaybackPlan.events` 当前包含 `tempo`、`time-signature`、`note-on`、`note-off`。同一时刻固定按 `tempo -> time-signature -> note-off -> note-on` 排序，同类保持来源顺序。拍号不参与 QN 到秒的积分，只供 MIDI、节拍显示等设备适配器消费。

NoteOn 的 `midi` 保留核心按记谱语义计算出的逻辑音高，不在这里钳制或整数化；具体 MIDI 适配器负责转换为目标设备接受的音高表示。

NoteOn 在编译期仍引用布局使用的同一个 Track 对象；最终输出按 `lowering.tracks` 的稳定顺序过滤，只保留至少含一个存活 NoteOn 的 Track，并压成从 0 开始的连续 `track` 通道编号。head 等纯布局轨、只含休止符的轨和被控制流彻底跳过的轨都不占播放通道。

## 编译流程

```mermaid
flowchart LR
    L[LoweringResult] --> F[linearizeColumns]
    F --> C[收集事件与控制]
    C --> S[扫描系统状态]
    S --> Q[按生成顺序发布音符与局部处理]
    Q --> R[tie 关系后处理]
    R --> V[校验并稳定排序]
    V --> P[PlaybackPlan]
```

系统状态先完成扫描，Tempo 表因此可供所有局部处理查询。随后按播放生成顺序发布音符：一个 Temporal 完整发布 NoteOn/NoteOff 后立即执行它冻结的 transform，deferred hook 在自身位置执行。这样 ornament 先展开，紧随其后的 dash 才能找到颤音最后一个子音；dash 先移动 NoteOff，tie 才能按最终边界判断连续。

局部 transform 和 deferred hook 可以看到完整 Tempo 表，但音符事件只包含当前位置此前已经发布的前缀。需要观察完整音符计划的功能使用 `PlaybackRelation`。进入 relation 前整理一次事件，所有 relation 完成后再做最终排序。

## 控制流

`linearizeColumns` 输出实际访问的列号序列。反复会让同一列出现多次，房子会让某些列不出现。每次节点访问都有独立 origin 对象，同一个 Temporal 在反复中会生成不同的事件和 `noteId`。

反复结束线回到此前最近的反复开始线。例如 `|: 1 |: 2 :| 3 :|` 展开为 `1 2 2 3 2 3`，与 MuseScore 一致。`playbackMarks` 只属于进入时间流、天然拥有列位置的 Temporal；attachment 可以通过 `playbackFlow(columnOf)` 用自己的端点声明区间，但不能单独贴标记。

显式 flow `range` 必须是时间列内的升序闭区间，`jump` 目标必须位于 `0..columns.length`，其中 `columns.length` 表示跳到文末。违反扩展契约会抛出 `E_PLAYBACK_FLOW_RANGE` 或 `E_PLAYBACK_FLOW_JUMP`。

`scoreMap` 记录控制流展开后的 performance QN 到原始 score QN 的映射。相邻点之间两者以 1:1 前进；反复和房子只表现为映射点处的 score 跳转。

## PlaybackEmitter

具体 Temporal 通过 `emitPlayback(emitter)` 介入：

```ts
interface PlaybackEmitter {
    readonly start: Fraction;
    readonly end: Fraction;
    readonly track: Track;

    nextNoteId(): number;
    emit(event: PlaybackEventInput): void;
    control(at: Fraction, apply: PlaybackControl): void;
    affectFollowing(transform: PlaybackTransform): void;
    defer(hook: PlaybackHook): void;
    play(child: TemporalNodeBase, start?: Fraction, duration?: Fraction): void;
}
```

- `emit` 发布系统定义的输出事件；note 自己发布 NoteOn 和 NoteOff。
- `control` 在指定时刻修改播放系统状态。
- `affectFollowing` 修饰同一 play frame 中排在后面的音符事件。
- `defer` 在当前节点的 transform 完成后、当前位置执行事件 hook，dash 使用它修改前一个音符。
- `play` 递归发布折叠成员；缺省继承当前区间。

每个 play frame 维护自己的局部 transform 链。兄弟共享链；子 frame 继承副本，内部新增的 transform 不会泄漏到父级。

## 系统状态与控制事件

速度不是由 tempo 函数直接发布的事件。`onTimeState` 先把记谱位置上的基础 BPM 固化到 `Temporal.playbackState`；每次 Temporal 被实际访问时，编译器把该快照同步进 `PlaybackSystemState`。

控制事件是一个受系统调度的状态修改函数：

```ts
type PlaybackControl = (state: PlaybackSystemState) => void;
```

有效速度为：

$$
effectiveBpm = baseBpm \times bpmScale
$$

fermata 在附属音符的首尾发布两个控制：

```ts
emitter.control(emitter.start, state => state.bpmScale.div(2));
emitter.control(emitter.end, state => state.bpmScale.mul(2));
```

它不移动 NoteOn/NoteOff，也不冻结谱面进度，只把覆盖区间的实际速度减半。不同声部中部分重叠的音符自然只在重叠部分变慢；多个 fermata 重叠时倍率相乘。

系统按时刻合并基础状态同步与控制函数；发现 effective BPM 改变后自动生成最终 `tempo` 事件。反复回跳后，实际访问到的 Temporal 继续按自身 `playbackState` 更新系统。

将来实际加入 ProgramChange、ControlChange 或 PitchBend 时，再按对应 MIDI 事件扩展系统状态和最终事件类型；当前不预留无人使用的每轨状态表。

## Origin 与局部变换

每次 `play(node)` 创建唯一 origin：

```ts
interface PlaybackOrigin {
    node: TemporalNodeBase;
}
```

对象身份本身区分同一个 Temporal 在反复中的不同访问，不再维护额外的 occurrence 数字。编译期事件保存 origin lineage；ornament 替换事件时继承 lineage，tie 合并事件时取并集。

局部 transform 在目标音完整发布后直接收到这次访问产生的事件：

```ts
type PlaybackTransform = (
    context: PlaybackHookContext,
    events: PlaybackDraftEvent[],
) => PlaybackDraftEvent[] | void
```

accent 原地修改 `events`；ornament 返回替换后的事件数组，下一层 transform 继续处理这份结果。这样局部修饰不需要扫描完整事件计划。`context.stateAt(time)` 仍按时刻查询 BPM 快照；defer 和 relation 需要跨节点时直接观察完整 `context.events`。

没有为 tr、dash、tie 定义专用事件 kind，也没有 Patch、Visitor 或 handler registry。

## 当前函数

### Note

note 从固化音高、力度和 Track 发布一对 NoteOn/NoteOff。休止符、占位符和节拍记号不发声，但仍推进 performance QN。

### Meter

meter 发布 TimeSignature。事件与其它 Temporal 一样按实际控制流访问生成，因此反复段内的拍号每遍都会出现，反复段外的拍号只出现一次。core 保留任意正整数分母；Standard MIDI File 只能表示以 2 为幂的分母，该限制由 MIDI 适配器在导出边界检查。

### Up 与 Grace

up 按附属成员到宿主的顺序调用 `play`。grace 在宿主区间内计算借时，再用显式 start/duration 发布倚音和宿主。

### Accent 与 Ornament

accent、tr 和 mordent 使用 `affectFollowing`。目标 Temporal 完整发布 NoteOn/NoteOff 后立即依次执行冻结的 transform 链：accent 修改 velocity，tr/mordent 把目标事件对替换为多对子音。后一个 transform 继续处理前一个 transform 的派生事件，所以书写顺序有意义。

ornament 用 `stateAt(NoteOn.at).effectiveBpm` 决定极端速度下的密度。

### Dyn

`@dyn(from, to, dv)` 不生成运行期 relation。Lowering 在所有 `onTimeState` 完成后遍历 `astToTemporal`，给普通音符以及 up/grace 的折叠成员累计力度增量；区间内按记谱时间从 0 线性变化到 `dv`，区间后保持完整增量，直到下一次原始力度变化。

增量叠加在每个音符自己的固化力度上，dyn 不识别 `$p`、`$f` 或其它具体函数。因此区间内的力度记号仍独立生效，多条 dyn 的贡献按普通数值加法累计。Event-first playback 只从 note 的 `playbackState.velocity` 发布 NoteOn；反复访问相同 Temporal 时自然重放同一条记谱力度曲线。

### Dash

dash 用 `defer` 捕获自己的 Track、start 和 end。顺序流执行到 dash 时，它从当前位置附近向前找到同轨且恰好在 start 的 NoteOff，并把该事件移动到 end。

dash 自己有正时值，因此会在 lowering 时固化所在位置的 BPM。控制流直接跳到 dash 时，秒数积分仍使用该记谱位置应有的速度。

- `1 - -` 的 NoteOff 逐段移动到最后；
- `1^3 -` 同时移动和弦的全部 NoteOff；
- `1^$tr -` 只移动颤音最后一个子音的 NoteOff。

### Tie

tie 保留 attachment 的 `PlaybackRelation` 能力，在所有节点 hook 之后执行。只有同轨、同音且前 NoteOff 与后 NoteOn 同时的事件才合并。

合并会删除中间 NoteOff/NoteOn，把最终 NoteOff 改成首音的 `noteId`，并联合 source spans 与 origin lineage。反复中的每个 occurrence 独立匹配，交叉声明的 tie 链也能沿 lineage 找到存活事件。

## 时间与轨道

performance 和 score 都以 QN 为单位并使用精确 `Fraction`。Tempo 只决定 QN 到秒的积分，不改变事件的 QN 位置。

`secondsToScoreTime(plan, seconds)` 会把结果钳制在计划的演奏时长内；播放结束后的时钟值始终映射到计划终点，不继续向谱面外推。

Lowering 的 Track 仍完整描述视觉拓扑，`lowering.tracks` 可以包含 head 槽位、只含休止符的声部等无发声轨。Playback 在 ornament、dash、tie 和控制流全部收敛后，从最终 NoteOn 集合派生 `tracks` 并重新连续编号；`events[].track` 是该数组的索引。

`PlaybackPlan` 提供 `events`、`scoreMap`、`tracks`、`performanceDuration`、`durationSeconds` 和 `diagnostics`。

Web Audio、Web MIDI 和 Standard MIDI File 适配器都消费同一份事件计划。设备选择、PPQ 量化、实时调度和文件编码不属于 core playback 编译器。

playground 只在播放标签首次激活、标签保持激活且源码重新排版成功，或用户明确请求 MIDI 导出时调用 `compilePlayback`，相同源码版本复用计划。tinySynth 适配器把 NoteOn/NoteOff 配对后按 Tempo 积分成秒，并用短前瞻窗口调度到 AudioContext；MIDI 适配器固定使用 480 PPQ，在文件边界完成整数化与设备范围检查。两者都不重新解释反复、房子、倚音或装饰音。