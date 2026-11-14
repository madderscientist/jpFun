/**
 * 所见即所得（WYSIWYG）交互制谱控制器
 *
 * 职责边界：
 * - 管理交互制谱面板（ScorePad）的双模游标状态机：`select`（选中已有谱面元素）与 `insert`（`[+]` 插入槽）
 * - 管理待输入预设状态（减时线 `div`、附点 `dot`、升降号 `pendingAcc`、八度 `pendingOctave`、满拍自动补小节线 `autoBar`）
 * - 管理两阶段多音关系拾取会话（`relationSession`）
 * - 将面板点击、全局键盘快捷键与预览谱面点击转化为 `@jpfun/editor-tools/edit` 的纯函数调用，
 *   并在源码补丁落盘前后维护 `undoSnapshots` / `redoSnapshots` 选区快照栈。
 */
import {
    ErrorDiagnostic,
    type CompileScoreResult,
    type Rect,
    type SourceEdit,
    type SourceSpan,
    type TextMeasurer,
} from "jpfun";
import {
    adjacentEditTarget,
    applyRelationCommand,
    applyScoreEditAction,
    createScoreEditIndex,
    editHitAt,
    editTargetAt,
    formatNoteWithRhythm,
    insertSlotAfter,
    MAX_EDIT_OCTAVE,
    stepOctave,
    type RelationCommandSpec,
    type RhythmSpec,
    type ScoreEditAction,
    type ScoreEditIndex,
    type ScoreEditResult,
    type ScoreEditTarget,
    type ScoreInsertSlot,
} from "@jpfun/editor-tools/edit";
import type { PreviewNavigationMap } from "@jpfun/editor-tools/navigation";
import { requiredElement } from "./platform.js";
import {
    RELATION_COMMANDS,
    formatBeatProgress,
    renderOctaveGlyph,
    renderRelationOptionsMarkup,
    renderScorePadMarkup,
    type ActiveRelationSession,
} from "./scorepad-template.js";

/** 预览层 `.preview-overlay` 绘制的交互高亮框描述 */
export interface VisualHighlight {
    readonly region: Rect;
    /** `selected` 为实线选中框，`insert` 为虚线 `[+]` 插入槽，`picked` 为多音关系拾取序号框 */
    readonly kind: "selected" | "insert" | "picked";
    readonly badge?: string;
}

/** 源码变更的位置映射（与 CodeMirror `ChangeSet.mapPos` 结构兼容） */
export interface PositionMapping {
    mapPos(pos: number, assoc?: number): number;
}

export interface VisualEditController {
    setActive(active: boolean): void;
    readonly active: boolean;
    reflowLines(barsPerLine?: number): boolean;
    onCompiled(source: string, compiled: CompileScoreResult): void;
    /** 源码已变更；非本控制器发起的变更会按 `changes` 映射游标并清空选区快照栈 */
    onInvalidated(changes: PositionMapping): void;
    /** `navigation` 须与最近一次 `onCompiled` 的编译结果对应 */
    handlePreviewClick(navigation: PreviewNavigationMap, x: number, y: number, tolerance: number): void;
}

interface VisualEditOptions {
    getSource(): string;
    getCompiled(): CompileScoreResult | null;
    ensureCompiled(): boolean;
    textMeasurer?: TextMeasurer;
    /** 干跑校验通过后将 SourceEdit[] 写入编辑器并同步重编译；失败返回 false */
    applyEdits(source: string, edits: readonly SourceEdit[]): boolean;
    onUndo?(): boolean;
    onRedo?(): boolean;
    onHighlightsChanged(highlights: readonly VisualHighlight[], reveal: boolean): void;
    onRevealInSource(span: SourceSpan): void;
    onStatusError(message: string, detail?: string): void;
}

/** 每次编辑动作前后的游标状态快照，用于配合 Ctrl+Z / Ctrl+Y 恢复选区或插入槽位置 */
interface SelectionSnapshot {
    mode: "select" | "insert";
    selectedSpan: SourceSpan | null;
    insertAfterSpan: SourceSpan | null;
}

interface SnapshotPair {
    before: SelectionSnapshot;
    after: SelectionSnapshot;
}

function mapSpan(span: SourceSpan | null, changes: PositionMapping): SourceSpan | null {
    if (!span) return null;
    const start = changes.mapPos(span.start, 1);
    const end = changes.mapPos(span.end, -1);
    return start < end ? { start, end } : null;
}

export function createVisualEditController(options: VisualEditOptions): VisualEditController {
    const pane = requiredElement<HTMLElement>("#visualPane");
    pane.innerHTML = renderScorePadMarkup();

    const scorepadRoot = pane.querySelector<HTMLElement>(".scorepad")!;
    const normalView = requiredElement<HTMLElement>("#scorepadNormalView");
    const relationView = requiredElement<HTMLElement>("#scorepadRelationView");
    const beatPill = requiredElement<HTMLElement>("#scorepadBeatPill");
    const snippetEl = requiredElement<HTMLElement>("#scorepadSnippet");
    const octaveStateBtn = requiredElement<HTMLButtonElement>("#padOctaveState");
    const autoBarBtn = requiredElement<HTMLButtonElement>("#padAutoBarBtn");
    const commandTitle = requiredElement<HTMLElement>("#commandTitle");
    const commandHint = requiredElement<HTMLElement>("#commandHint");
    const commandOptions = requiredElement<HTMLElement>("#commandOptions");
    const commandPickedList = requiredElement<HTMLElement>("#commandPickedList");
    const commandConfirm = requiredElement<HTMLButtonElement>("#commandConfirm");

    // 编译器产出的最新源码与可编辑索引
    let isActive = false;
    let currentSource = "";
    let currentCompiled: CompileScoreResult | null = null;
    let editIndex: ScoreEditIndex | null = null;

    // 游标模式与选区状态机：
    // - select 模式：selectedSpan 指向当前选中的目标；insertAfterSpan 跟随该目标以备随时切回插入
    // - insert 模式：selectedSpan 为 null；insertAfterSpan 指向插入槽前方的锚点（null 表示末尾默认槽）
    let mode: "select" | "insert" = "insert";
    let selectedSpan: SourceSpan | null = null;
    let insertAfterSpan: SourceSpan | null = null;
    const undoSnapshots: SnapshotPair[] = [];
    const redoSnapshots: SnapshotPair[] = [];
    // 本控制器发起的源码变更已预置好游标，onInvalidated 不得再映射或清栈
    let ownEdit = false;

    // 旋律连续输入预设状态：时值与八度跨音符保持，变音记号仅对下一个输入音符单次生效
    let rhythmPreset: RhythmSpec = { div: 0, dot: 0 };
    let pendingAcc: "" | "#" | "b" | "n" = "";
    let pendingOctave = 0;
    let autoBar = true;

    // 多音关系命令拾取会话（非空时独占面板视图）
    let relationSession: ActiveRelationSession | null = null;

    /** 解析当前选中的可编辑目标；若未处于 select 模式或源码区间已失效则返回 null */
    function getActiveTarget(): ScoreEditTarget | null {
        return editIndex && mode === "select" && selectedSpan ? editTargetAt(editIndex, selectedSpan) : null;
    }

    /** 计算当前锚点之后的 `[+]` 插入槽及其所在小节的拍号进度 */
    function getActiveInsertSlot(): ScoreInsertSlot | null {
        if (!editIndex || !currentCompiled) return null;
        return insertSlotAfter(currentSource, currentCompiled, editIndex, mode === "select" && selectedSpan ? selectedSpan : insertAfterSpan);
    }

    /** 当前生效的时值：选中音符/延长线时反映其自身时值，否则反映输入预设时值 */
    function activeRhythm(): RhythmSpec {
        const target = getActiveTarget();
        return target?.kind === "note" || target?.kind === "dash" ? target.rhythm : rhythmPreset;
    }

    /** 从选中态退回 `[+]` 插入态，并将插入锚点锚定在刚选中的元素之后 */
    function enterInsertMode(reveal = true) {
        if (mode === "select" && selectedSpan) insertAfterSpan = selectedSpan;
        mode = "insert";
        selectedSpan = null;
        syncUI(reveal);
    }

    /** 批量同步一组按钮的 `aria-pressed` 选中态 */
    function syncPressed(selector: string, predicate: (btn: HTMLButtonElement) => boolean) {
        for (const btn of pane.querySelectorAll<HTMLButtonElement>(selector)) {
            btn.setAttribute("aria-pressed", String(predicate(btn)));
        }
    }

    /** 渲染多音关系拾取模式下的已选音符列表 */
    function renderPickedList(session: ActiveRelationSession) {
        commandPickedList.replaceChildren();
        if (session.picked.length === 0) {
            const empty = document.createElement("div");
            empty.className = "picked-empty";
            empty.textContent = "点击谱面上的音符加入列表";
            commandPickedList.append(empty);
            return;
        }
        session.picked.forEach((item, idx) => {
            const row = document.createElement("div");
            row.className = "picked-item";
            row.setAttribute("role", "listitem");

            const badge = document.createElement("span");
            badge.className = "picked-index";
            badge.textContent = String(idx + 1);

            const token = document.createElement("code");
            token.className = "picked-token";
            token.textContent = currentSource.slice(item.span.start, item.span.end);

            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.className = "picked-remove";
            removeBtn.dataset.removePicked = String(idx);
            removeBtn.title = "移除";
            removeBtn.setAttribute("aria-label", `移除第 ${idx + 1} 项`);
            removeBtn.textContent = "×";

            row.append(badge, token, removeBtn);
            commandPickedList.append(row);
        });
    }

    /**
     * 同步 ScorePad 面板按钮状态与右侧谱面 Overlay 高亮框
     * @param reveal 是否将右侧预览视口滚动到当前高亮框处
     */
    function syncUI(reveal = false) {
        if (!isActive || !editIndex || !currentCompiled) {
            options.onHighlightsChanged([], false);
            return;
        }
        const target = getActiveTarget();
        // 若源码变更后原选中目标已不存在，自动退回插入模式
        if (mode === "select" && !target) mode = "insert";
        const slot = getActiveInsertSlot();
        const currentRhythm = activeRhythm();

        // 1. 切换常规制谱视图 vs. 多音关系拾取独占视图
        if (relationSession) {
            normalView.hidden = true;
            relationView.hidden = false;
            const meta = RELATION_COMMANDS.find(c => c.kind === relationSession!.kind)!;
            const count = relationSession.picked.length;
            commandTitle.textContent = `${meta.icon} ${meta.label}`;
            commandHint.textContent = `${count} / ${meta.minTargets}`;
            commandConfirm.disabled = count < meta.minTargets;
            commandOptions.innerHTML = renderRelationOptionsMarkup(relationSession);
            renderPickedList(relationSession);
        } else {
            normalView.hidden = false;
            relationView.hidden = true;
            const beatStr = formatBeatProgress(slot);
            beatPill.hidden = !beatStr;
            beatPill.textContent = beatStr;
            snippetEl.textContent = target
                ? currentSource.slice(target.unitSpan.start, target.unitSpan.end)
                : formatNoteWithRhythm("X", pendingAcc, pendingOctave, rhythmPreset);
            snippetEl.dataset.mode = mode;
            requiredElement<HTMLButtonElement>("#padInsertMode").setAttribute("aria-pressed", String(mode === "insert"));
            autoBarBtn.setAttribute("aria-pressed", String(autoBar));
        }

        // 2. 同步时值、音高、八度、变音、符号、拍号与调号按钮的激活态
        const activePitch = target?.kind === "note" ? target.pitch : target?.kind === "dash" ? "-" : "";
        const activeOctave = target?.kind === "note" ? target.octave : pendingOctave;
        const activeAcc = target?.kind === "note" ? target.acc : mode === "insert" ? pendingAcc : "";
        const activeSymbols = new Set(target?.kind === "note" ? target.symbols.map(s => s.toLowerCase()) : []);
        const activeMeterStr = target?.kind === "meter"
            ? `${target.numerator}/${target.denominator}`
            : slot?.meter ? `${slot.meter.numerator}/${slot.meter.denominator}` : "";
        const activeKeyStr = target?.kind === "key" ? `${target.displayName}${target.displayAcc}` : "";

        octaveStateBtn.innerHTML = renderOctaveGlyph(Math.max(-MAX_EDIT_OCTAVE, Math.min(MAX_EDIT_OCTAVE, activeOctave)));
        octaveStateBtn.setAttribute("aria-pressed", String(activeOctave !== 0));

        syncPressed("[data-div]", btn => currentRhythm.div === Number(btn.dataset.div));
        syncPressed("[data-dot]", btn => currentRhythm.dot === Number(btn.dataset.dot));
        syncPressed("[data-pitch]", btn => btn.dataset.pitch === activePitch);
        syncPressed("[data-acc]", btn => btn.dataset.acc === activeAcc);
        syncPressed("[data-symbol]", btn => activeSymbols.has((btn.dataset.symbol ?? "").toLowerCase()));
        syncPressed("[data-bar-type]", btn => target?.kind === "bar" && target.barType === Number(btn.dataset.barType));
        syncPressed("[data-meter]", btn => btn.dataset.meter === activeMeterStr);
        syncPressed("[data-key]", btn => btn.dataset.key === activeKeyStr);
        syncPressed("[data-relation-cmd]", btn => relationSession?.kind === btn.dataset.relationCmd);

        // 3. 生成右侧谱面 Overlay 高亮框（实线选框 / 虚线 [+] 插入槽 / 关系拾取序号框）
        const highlights: VisualHighlight[] = [];
        if (relationSession) {
            relationSession.picked.forEach((item, index) => {
                highlights.push({ region: item.region, kind: "picked", badge: String(index + 1) });
            });
        } else if (mode === "select" && target) {
            for (const reg of target.kind === "relation" ? target.regions : [target.region]) {
                highlights.push({ region: reg, kind: "selected" });
            }
        } else if (slot) {
            highlights.push({ region: slot.region, kind: "insert", badge: "+" });
        }
        options.onHighlightsChanged(highlights, reveal);
    }

    /** 执行本控制器发起的源码变更；宿主会在其中同步回调 onInvalidated 与 onCompiled */
    function own(run: () => boolean): boolean {
        ownEdit = true;
        try {
            return run();
        } finally {
            ownEdit = false;
        }
    }

    /**
     * 事务化执行一次编辑计算并提交到源码编辑器：
     * - 先更新游标状态机，以便 `options.applyEdits` 触发同步重编译时 `onCompiled -> syncUI` 直接读取新游标
     * - 若干跑编译失败或抛出异常，立即回滚游标与关系会话状态并通知状态栏
     */
    function commitResult(source: string, compute: () => ScoreEditResult, errorTitle: string): boolean {
        const before: SelectionSnapshot = { mode, selectedSpan, insertAfterSpan };
        const prevSession = relationSession;
        try {
            const result = compute();
            relationSession = null;
            mode = result.nextMode;
            selectedSpan = result.nextMode === "select" ? result.nextSpan : null;
            insertAfterSpan = result.nextSpan;
            if (result.edits.length === 0) {
                syncUI(true);
                return true;
            }
            const after: SelectionSnapshot = { mode, selectedSpan, insertAfterSpan };
            if (!own(() => options.applyEdits(source, result.edits))) {
                ({ mode, selectedSpan, insertAfterSpan } = before);
                relationSession = prevSession;
                return false;
            }
            undoSnapshots.push({ before, after });
            redoSnapshots.length = 0;
            return true;
        } catch (error) {
            ({ mode, selectedSpan, insertAfterSpan } = before);
            relationSession = prevSession;
            options.onStatusError(errorTitle, error instanceof ErrorDiagnostic ? error.message : String(error));
            return false;
        }
    }

    /**
     * 执行单步谱面编辑动作（音高、时值、八度、变音、符号、小节线、拍号、换行、删除等）
     * @param targetSpan 作用目标，默认取选中目标
     * @param stayInsert 编辑后保持插入态（以结果锚点为插入位置）
     */
    function executeAction(action: ScoreEditAction, targetSpan = mode === "select" ? selectedSpan : null, stayInsert = false): boolean {
        if (!options.ensureCompiled()) return false;
        const compiled = options.getCompiled();
        const source = options.getSource();
        if (!compiled) return false;
        const index = editIndex ?? createScoreEditIndex(source, compiled);
        const target = targetSpan ? editTargetAt(index, targetSpan) : null;
        return commitResult(source, () => {
            const result = applyScoreEditAction(source, compiled, index, target, action);
            return stayInsert ? { ...result, nextMode: "insert" } : result;
        }, "编辑操作未生效");
    }

    function adoptCompiled(source: string, compiled: CompileScoreResult) {
        currentSource = source;
        currentCompiled = compiled;
        // 未激活时不建索引，激活时再按需补建
        editIndex = isActive ? createScoreEditIndex(source, compiled) : null;
    }

    /** 插入槽紧前方的流元素 */
    function targetBeforeCursor(): ScoreEditTarget | null {
        if (!editIndex) return null;
        return insertAfterSpan ? editTargetAt(editIndex, insertAfterSpan) : editIndex.streamTargets.at(-1) ?? null;
    }

    /** 确认提交当前多音关系命令（@tie / @gliss / @tuplet / @dyn / @ottava / @volta / @beam） */
    function commitRelationSession() {
        if (!relationSession || !options.ensureCompiled()) return;
        const s = relationSession;
        const spec: RelationCommandSpec = s.kind === "tuplet" ? { kind: "tuplet", targets: s.picked, normal: s.tupletNormal }
            : s.kind === "dyn" ? { kind: "dyn", targets: s.picked, dv: s.dynDelta }
            : s.kind === "ottava" ? { kind: "ottava", targets: s.picked, shift: s.ottavaShift }
            : s.kind === "volta" ? { kind: "volta", targets: s.picked, pass: s.voltaPass }
            : { kind: s.kind, targets: s.picked };
        commitResult(options.getSource(), () => applyRelationCommand(options.getSource(), spec), "关系创建失败");
    }

    /** 输入音高（1-7、占位 8、节奏音 9/X、休止符 0/Z、延长线 -）：选中音符时原地替换并步进，插入态时在槽位追加 */
    function handlePitchInput(pitch: string) {
        if (relationSession) return;
        const target = getActiveTarget();
        if (mode === "select" && (target?.kind === "note" || target?.kind === "dash")) {
            executeAction({ type: "set-pitch", pitch, advance: true });
            return;
        }
        const slot = getActiveInsertSlot();
        if (!slot) return;
        const isUnpitched = pitch === "0" || pitch === "8" || pitch === "9" || pitch === "-";
        const acc = isUnpitched ? "" : pendingAcc;
        const octave = isUnpitched ? 0 : pendingOctave;
        pendingAcc = "";
        executeAction({ type: "insert-note", slot, pitch, acc, octave, rhythm: rhythmPreset, autoBar });
    }

    /** 切换减时线或附点：同时更新预设，若当前选中了音符/延长线则立即改写其时值 */
    function handleRhythmChange(nextSpec: Partial<RhythmSpec>) {
        if (relationSession) return;
        const base = activeRhythm();
        rhythmPreset = { div: nextSpec.div ?? base.div, dot: nextSpec.dot ?? base.dot };
        const target = getActiveTarget();
        if (mode === "select" && (target?.kind === "note" || target?.kind === "dash")) {
            executeAction({ type: "set-rhythm", rhythm: rhythmPreset });
        } else {
            syncUI(false);
        }
    }

    /** 升降八度：选中音符时原地调整其八度并同步预设，插入态时调整待输入八度状态机 */
    function adjustOctave(delta: number) {
        const target = getActiveTarget();
        if (mode === "select" && target?.kind === "note") {
            pendingOctave = stepOctave(target.octave, delta);
            executeAction({ type: "adjust-octave", delta });
        } else {
            pendingOctave = stepOctave(pendingOctave, delta);
            syncUI(false);
        }
    }

    /** 切换升降还原号：选中音符时原地切换其变音记号，插入态时切换单次待输入变音记号 */
    function toggleAccidental(acc: "#" | "b" | "n") {
        const target = getActiveTarget();
        if (mode === "select" && target?.kind === "note") {
            executeAction({ type: "set-accidental", acc });
        } else {
            pendingAcc = pendingAcc === acc ? "" : acc;
            syncUI(false);
        }
    }

    /** 左右方向键/按钮在流元素与末尾 `[+]` 插入槽之间移动游标 */
    function stepSelection(direction: -1 | 1) {
        if (!editIndex) return;
        if (mode === "insert") {
            const next = direction === -1
                ? targetBeforeCursor()
                : (insertAfterSpan ? adjacentEditTarget(editIndex, insertAfterSpan, 1) : null);
            if (next) {
                mode = "select";
                selectedSpan = next.span;
                syncUI(true);
            }
            return;
        }
        if (!selectedSpan) return;
        const neighbor = adjacentEditTarget(editIndex, selectedSpan, direction);
        if (neighbor) {
            selectedSpan = neighbor.span;
            insertAfterSpan = neighbor.span;
            syncUI(true);
        } else if (direction === 1) {
            enterInsertMode(true);
        }
    }

    /** 撤销：关系拾取模式下优先回退刚拾取的音符，常规模式下联动 CodeMirror 历史并恢复选区快照 */
    function handleUndo() {
        if (relationSession) {
            if (relationSession.picked.length > 0) relationSession.picked.pop();
            else relationSession = null;
            syncUI(false);
            return;
        }
        stepHistory(undoSnapshots, redoSnapshots, "before", options.onUndo);
    }

    /** 重做：联动 CodeMirror 重做历史并恢复选区快照 */
    function handleRedo() {
        if (!relationSession) stepHistory(redoSnapshots, undoSnapshots, "after", options.onRedo);
    }

    /** 有快照时先恢复游标再撤销/重做，供宿主同步重编译读取；无快照时由 onInvalidated 按变更映射游标 */
    function stepHistory(from: SnapshotPair[], to: SnapshotPair[], restore: keyof SnapshotPair, run?: () => boolean) {
        const snap = from.pop();
        if (!snap) {
            run?.();
            return;
        }
        const current: SelectionSnapshot = { mode, selectedSpan, insertAfterSpan };
        ({ mode, selectedSpan, insertAfterSpan } = snap[restore]);
        if (own(() => run?.() ?? false)) {
            to.push(snap);
        } else {
            ({ mode, selectedSpan, insertAfterSpan } = current);
            from.push(snap);
        }
    }

    /** 删除/退格：选中态下删除目标；插入态下退格删除游标紧邻的换行或前一个流元素 */
    function handleDelete() {
        if (relationSession) {
            relationSession.picked.pop();
            syncUI(false);
            return;
        }
        if (mode === "select" && getActiveTarget()) {
            executeAction({ type: "delete" });
            return;
        }
        if (mode === "insert" && editIndex) {
            const slot = getActiveInsertSlot();
            if (slot?.afterSpan && !editTargetAt(editIndex, slot.afterSpan)) {
                executeAction({ type: "delete", slot });
                return;
            }
            const before = targetBeforeCursor();
            if (before) executeAction({ type: "delete" }, before.span, true);
        }
    }

    // 委托监听 ScorePad 面板上的所有按钮点击
    pane.addEventListener("click", event => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button");
        if (!button || button.disabled) return;
        const ds = button.dataset;

        // 1. 顶部导航与工具按钮
        switch (button.id) {
            case "padUndo": handleUndo(); return;
            case "padRedo": handleRedo(); return;
            case "padPrev": stepSelection(-1); return;
            case "padNext": stepSelection(1); return;
            case "padInsertMode": enterInsertMode(true); return;
            case "padRevealSource": options.onRevealInSource(getActiveTarget()?.span ?? insertAfterSpan ?? { start: 0, end: 0 }); return;
            case "padDelete": handleDelete(); return;
            case "commandConfirm": commitRelationSession(); return;
            case "commandCancel": relationSession = null; syncUI(false); return;
            case "padLineBreakBtn": executeAction({ type: "insert-line-break", slot: getActiveInsertSlot() ?? undefined }); return;
            case "padReflowBars": executeAction({ type: "reflow-bars" }); return;
            case "padReflowLines": executeAction({ type: "reflow-lines", textMeasurer: options.textMeasurer }); return;
            case "padAutoBarBtn": autoBar = !autoBar; syncUI(false); return;
            case "padOctaveState": {
                const target = getActiveTarget();
                pendingOctave = 0;
                if (mode === "select" && target?.kind === "note" && target.octave !== 0) executeAction({ type: "adjust-octave", delta: -target.octave });
                else syncUI(false);
                return;
            }
        }

        // 2. 多音关系模式参数子项与已选音符移除
        if (relationSession) {
            if (ds.tupletNormal) { relationSession.tupletNormal = Number(ds.tupletNormal); syncUI(false); return; }
            if (ds.dynDelta) { relationSession.dynDelta = Number(ds.dynDelta); syncUI(false); return; }
            if (ds.ottavaShift) { relationSession.ottavaShift = Number(ds.ottavaShift); syncUI(false); return; }
            if (ds.voltaPass) { relationSession.voltaPass = Number(ds.voltaPass); syncUI(false); return; }
            if (ds.removePicked !== undefined) { relationSession.picked.splice(Number(ds.removePicked), 1); syncUI(false); return; }
        }

        // 3. 时值、附点、音高、八度、变音记号
        if (ds.div !== undefined) { handleRhythmChange({ div: Number(ds.div) }); return; }
        if (ds.dot !== undefined) {
            const dotVal = Number(ds.dot);
            handleRhythmChange({ dot: activeRhythm().dot === dotVal ? 0 : dotVal });
            return;
        }
        if (ds.pitch !== undefined) { handlePitchInput(ds.pitch); return; }
        if (ds.octave !== undefined) { adjustOctave(Number(ds.octave)); return; }
        if (ds.acc !== undefined) { toggleAccidental(ds.acc as "#" | "b" | "n"); return; }

        // 4. 开启或关闭多音关系拾取会话（若当前已选中音符则自动作为第 1 个拾取项）
        if (ds.relationCmd !== undefined) {
            const kind = ds.relationCmd as RelationCommandSpec["kind"];
            if (relationSession?.kind === kind) {
                relationSession = null;
            } else {
                const initialTarget = getActiveTarget();
                relationSession = {
                    kind,
                    picked: initialTarget && (initialTarget.kind === "note" || initialTarget.kind === "dash") ? [initialTarget] : [],
                    tupletNormal: 2,
                    dynDelta: 24,
                    ottavaShift: 1,
                    voltaPass: 1,
                };
            }
            syncUI(false);
            return;
        }

        // 5. 装饰符号、前后倚音、小节线、拍号、调号与速度
        if (ds.symbol !== undefined) {
            // 插入态下作用于前一个音符，完成后选中它
            executeAction({ type: "toggle-symbol", symbol: ds.symbol }, mode === "select" ? selectedSpan : targetBeforeCursor()?.span ?? null);
            return;
        }
        if (ds.grace !== undefined) { executeAction({ type: "insert-grace", side: ds.grace as "pre" | "post" }); return; }
        if (ds.barType !== undefined) { executeAction({ type: "set-bar", barType: Number(ds.barType), slot: getActiveInsertSlot() ?? undefined }); return; }
        if (ds.meter !== undefined) {
            const [numerator, denominator] = ds.meter.split("/").map(Number);
            executeAction({ type: "set-meter", numerator, denominator, slot: getActiveInsertSlot() ?? undefined });
            return;
        }
        if (ds.key !== undefined) { executeAction({ type: "set-key", tonality: ds.key, slot: getActiveInsertSlot() ?? undefined }); return; }
        if (ds.tempo !== undefined) { executeAction({ type: "set-tempo", bpm: Number(ds.tempo), slot: getActiveInsertSlot() ?? undefined }); return; }
        if (ds.tempoDelta !== undefined) {
            const target = getActiveTarget();
            executeAction({ type: "set-tempo", bpm: (target?.kind === "tempo" ? target.bpm : 100) + Number(ds.tempoDelta), slot: getActiveInsertSlot() ?? undefined });
        }
    });

    // 鼠标点按钮不夺焦，按键仍归面板；键盘 Tab 到按钮上时 Enter 保留原生激活
    pane.addEventListener("mousedown", event => {
        if (!(event.target as Element | null)?.closest("button")) return;
        event.preventDefault();
        scorepadRoot.focus({ preventScroll: true });
    });

    // 全局键盘直通：当交互模式开启且焦点不在可输入控件或源码编辑器时，支持电脑键盘直接打谱
    document.addEventListener("keydown", event => {
        if (!isActive || event.defaultPrevented) return;
        const activeEl = document.activeElement;
        if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement || activeEl instanceof HTMLSelectElement
            || (activeEl instanceof HTMLElement && activeEl.isContentEditable)
            || activeEl?.closest(".cm-editor, [role='menu']")) return;

        const mod = event.ctrlKey || event.metaKey;
        if (mod && !event.altKey) {
            const lower = event.key.toLowerCase();
            if (lower === "z" && !event.shiftKey) { event.preventDefault(); handleUndo(); }
            else if (lower === "y" || (lower === "z" && event.shiftKey)) { event.preventDefault(); handleRedo(); }
            return;
        }
        if (mod || event.altKey) return;

        const key = event.key;
        if (key === "Enter" && activeEl instanceof HTMLButtonElement) return;
        if (relationSession) {
            if (key === "Enter") { event.preventDefault(); commitRelationSession(); }
            else if (key === "Escape") { event.preventDefault(); relationSession = null; syncUI(false); }
            else if (key === "Backspace" || key === "Delete") { event.preventDefault(); handleDelete(); }
            return;
        }
        if (key >= "0" && key <= "9") { event.preventDefault(); handlePitchInput(key); return; }
        if (key === "x" || key === "X") { event.preventDefault(); handlePitchInput("9"); return; }
        if (key === "z" || key === "Z") { event.preventDefault(); handlePitchInput("0"); return; }
        if (key === "-") { event.preventDefault(); handlePitchInput("-"); return; }
        if (key === "/") { event.preventDefault(); handleRhythmChange({ div: (activeRhythm().div + 1) % 4 }); return; }
        if (key === ".") { event.preventDefault(); handleRhythmChange({ dot: activeRhythm().dot === 1 ? 0 : 1 }); return; }
        if (key === "#" || key === "b") { event.preventDefault(); toggleAccidental(key); return; }
        if (key === "ArrowLeft") { event.preventDefault(); stepSelection(-1); return; }
        if (key === "ArrowRight") { event.preventDefault(); stepSelection(1); return; }
        if (key === "ArrowUp") { event.preventDefault(); adjustOctave(1); return; }
        if (key === "ArrowDown") { event.preventDefault(); adjustOctave(-1); return; }
        if (key === "Backspace" || key === "Delete") { event.preventDefault(); handleDelete(); return; }
        if (key === "Enter") {
            event.preventDefault();
            if (mode === "select") enterInsertMode(true);
            else executeAction({ type: "insert-line-break", slot: getActiveInsertSlot() ?? undefined });
            return;
        }
        if (key === "Escape" && mode === "select") {
            event.preventDefault();
            enterInsertMode(false);
        }
    });

    return {
        get active() { return isActive; },
        reflowLines(barsPerLine?: number) {
            return executeAction({ type: "reflow-lines", barsPerLine, textMeasurer: options.textMeasurer });
        },
        setActive(active: boolean) {
            isActive = active;
            if (!active) {
                relationSession = null;
                options.onHighlightsChanged([], false);
                return;
            }
            // ensureCompiled 触发重编译时 onCompiled 已建好索引
            const compiled = options.ensureCompiled() && !editIndex ? options.getCompiled() : null;
            if (compiled) adoptCompiled(options.getSource(), compiled);
            syncUI(true);
            scorepadRoot.focus({ preventScroll: true });
        },
        onCompiled(source: string, compiled: CompileScoreResult) {
            adoptCompiled(source, compiled);
            if (isActive) syncUI(true);
        },
        onInvalidated(changes: PositionMapping) {
            editIndex = null;
            if (!ownEdit) {
                // 外部改动打乱了与 CodeMirror 历史的对应，旧快照与拾取会话的区间都已失效
                selectedSpan = mapSpan(selectedSpan, changes);
                insertAfterSpan = mapSpan(insertAfterSpan, changes);
                undoSnapshots.length = 0;
                redoSnapshots.length = 0;
                relationSession = null;
            }
            if (!isActive) options.onHighlightsChanged([], false);
        },
        handlePreviewClick(navigation: PreviewNavigationMap, x: number, y: number, tolerance: number) {
            if (!isActive || !editIndex) return;
            const activeSlot = !relationSession && mode === "insert" ? getActiveInsertSlot() : null;
            const hit = editHitAt(editIndex, navigation, x, y, tolerance, activeSlot);
            scorepadRoot.focus({ preventScroll: true });

            // 点击谱面空白处：退回当前锚点后的 [+] 插入模式
            if (!hit) {
                if (!relationSession) enterInsertMode(false);
                return;
            }
            // 关系拾取模式下：点击音符/延长线将其加入或移出拾取列表
            if (relationSession) {
                if (hit.kind === "target" && (hit.target.kind === "note" || hit.target.kind === "dash")) {
                    const idx = relationSession.picked.findIndex(item => item.span.start === hit.target.span.start && item.span.end === hit.target.span.end);
                    if (idx >= 0) relationSession.picked.splice(idx, 1);
                    else relationSession.picked.push(hit.target);
                    syncUI(false);
                }
                return;
            }
            // 命中虚线 [+] 插入槽：切入插入模式
            if (hit.kind === "insert") {
                mode = "insert";
                selectedSpan = null;
                insertAfterSpan = hit.slot.afterSpan;
                syncUI(false);
                return;
            }
            // 命中已有谱面元素：选中该元素并同步其时值与八度到预设栏
            mode = "select";
            selectedSpan = hit.target.span;
            insertAfterSpan = hit.target.span;
            if (hit.target.kind === "note") {
                rhythmPreset = hit.target.rhythm;
                pendingOctave = hit.target.octave;
            }
            syncUI(false);
        },
    };
}

