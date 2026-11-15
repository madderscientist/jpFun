/**
 * ScorePad 交互制谱面板的声明式配置表与视图模板
 *
 * 将静态键位表、多音关系参数表以及简谱字形（`X` 减时线/附点、`Ẋ` 八度上下点）渲染纯函数
 * 与状态机控制器分离，保持视图结构清晰且易于扩展。
 */
import type { RelationCommandSpec, ScoreEditTarget, ScoreInsertSlot } from "@jpfun/editor-tools/edit";

/** 多音关系拾取会话状态 */
export interface ActiveRelationSession {
    kind: RelationCommandSpec["kind"];
    picked: ScoreEditTarget[];
    tupletNormal: number;
    dynDelta: number;
    ottavaShift: number;
    voltaPass: number;
}

const DIV_LEVELS = [0, 1, 2, 3] as const;
const DOT_LEVELS = [1, 2] as const;

const PITCH_KEYS: readonly { pitch: string; label: string; title: string }[] = [
    { pitch: "1", label: "1", title: "音符 1" },
    { pitch: "2", label: "2", title: "音符 2" },
    { pitch: "3", label: "3", title: "音符 3" },
    { pitch: "4", label: "4", title: "音符 4" },
    { pitch: "5", label: "5", title: "音符 5" },
    { pitch: "6", label: "6", title: "音符 6" },
    { pitch: "7", label: "7", title: "音符 7" },
    { pitch: "8", label: "8", title: "隐形占位 8" },
    { pitch: "9", label: "X", title: "节奏音 X (按键 9 / X)" },
    { pitch: "0", label: "0", title: "休止符 0 (按键 0 / Z)" },
    { pitch: "-", label: "−", title: "增时线 -" },
];

const SYMBOLS: readonly { id: string; label: string; icon: string }[] = [
    { id: "staccato", label: "断音", icon: "▼" },
    { id: "accent", label: "重音", icon: ">" },
    { id: "tenuto", label: "保持", icon: "—" },
    { id: "fermata", label: "延长", icon: "𝄐" },
    { id: "tr", label: "颤音", icon: "tr" },
    { id: "p", label: "弱", icon: "p" },
    { id: "mf", label: "中强", icon: "mf" },
    { id: "f", label: "强", icon: "f" },
];

const BAR_TYPES: readonly { type: number; symbol: string; label: string }[] = [
    { type: 0, symbol: "|", label: "单小节线" },
    { type: 1, symbol: "||", label: "双小节线" },
    { type: 2, symbol: "|||", label: "终止线" },
    { type: 3, symbol: "|:", label: "前反复" },
    { type: 4, symbol: ":|", label: "后反复" },
    { type: 5, symbol: ":|:", label: "双向反复" },
];

const COMMON_METERS: readonly [number, number][] = [[2, 4], [3, 4], [4, 4], [3, 8], [6, 8]];
const KEYS = ["C", "D", "E", "F", "G", "A", "B", "Bb", "Eb", "F#", "Ab", "Db"] as const;

export const RELATION_COMMANDS: readonly { kind: RelationCommandSpec["kind"]; icon: string; label: string; minTargets: number }[] = [
    { kind: "tie", icon: "⌒", label: "连音线 @tie", minTargets: 2 },
    { kind: "gliss", icon: "↗", label: "滑音线 @gliss", minTargets: 2 },
    { kind: "tuplet", icon: "3", label: "多连音 @tuplet", minTargets: 1 },
    { kind: "dyn", icon: "＜", label: "渐强弱 @dyn", minTargets: 2 },
    { kind: "ottava", icon: "8va", label: "八度线 @ottava", minTargets: 2 },
    { kind: "volta", icon: "1.", label: "跳房 @volta", minTargets: 2 },
    { kind: "beam", icon: "═", label: "手动连梁 @beam", minTargets: 2 },
];

/** 各关系命令可选的子参数配置表（如多连音拍数、渐强/渐弱方向、8va/8vb、跳房房号） */
const RELATION_OPTION_SCHEMA: Partial<Record<RelationCommandSpec["kind"], {
    attr: string;
    field: "tupletNormal" | "dynDelta" | "ottavaShift" | "voltaPass";
    choices: readonly { value: number; label: string }[];
}>> = {
    tuplet: { attr: "data-tuplet-normal", field: "tupletNormal", choices: [{ value: 2, label: "2" }, { value: 3, label: "3" }, { value: 4, label: "4" }] },
    dyn: { attr: "data-dyn-delta", field: "dynDelta", choices: [{ value: 24, label: "＜" }, { value: -24, label: "＞" }] },
    ottava: { attr: "data-ottava-shift", field: "ottavaShift", choices: [{ value: 1, label: "8va" }, { value: -1, label: "8vb" }] },
    volta: { attr: "data-volta-pass", field: "voltaPass", choices: [{ value: 1, label: "1." }, { value: 2, label: "2." }, { value: 3, label: "3." }] },
};

/** 渲染带 0~3 条底部减时线或右侧附点的 `X` 简谱时值字形 */
export function renderXGlyph(div: number, dot: number): string {
    const beams = Array.from({ length: div }, () => '<i class="x-beam"></i>').join("");
    const dots = dot > 0 ? `<span class="x-dots">${"·".repeat(dot)}</span>` : "";
    return `<span class="x-glyph" data-div="${div}" aria-hidden="true"><span class="x-main"><span class="x-char">X</span>${dots}</span><span class="x-beams">${beams}</span></span>`;
}

/** 渲染带上下八度圆点的 `X` 八度状态字形 */
export function renderOctaveGlyph(octave: number): string {
    const dots = (n: number) => Array.from({ length: n }, () => '<i class="x-oct-dot"></i>').join("");
    return `<span class="x-octave-glyph" aria-hidden="true"><span class="x-oct-dots up">${octave > 0 ? dots(octave) : ""}</span><span class="x-char">X</span><span class="x-oct-dots down">${octave < 0 ? dots(-octave) : ""}</span></span>`;
}

/** 格式化插入槽所在小节的拍内已用时值进度（如 `3 / 4`） */
export function formatBeatProgress(slot: ScoreInsertSlot | null): string {
    return slot?.meter ? `${slot.measureUsed.toNumber()} / ${slot.meter.measureDuration.toNumber()}` : "";
}

/** 渲染当前关系命令的子参数按钮组 */
export function renderRelationOptionsMarkup(session: ActiveRelationSession): string {
    const schema = RELATION_OPTION_SCHEMA[session.kind];
    if (!schema) return "";
    const cur = session[schema.field];
    return schema.choices.map(c =>
        `<button type="button" class="pad-btn mini-opt" ${schema.attr}="${c.value}" aria-pressed="${cur === c.value}">${c.label}</button>`
    ).join("");
}

/** 生成整个 ScorePad 面板（含常规视图与关系拾取独占视图）的初始 HTML */
export function renderScorePadMarkup(): string {
    return `
        <div class="scorepad" tabindex="0" aria-label="所见即所得制谱面板">
            <div class="scorepad-normal-view" id="scorepadNormalView">
                <div class="scorepad-header" id="scorepadHeader">
                    <div class="scorepad-status-bar" id="scorepadNormalBar">
                        <div class="scorepad-hero">
                            <code class="scorepad-snippet" id="scorepadSnippet">X</code>
                            <span class="scorepad-beat-pill" id="scorepadBeatPill" hidden></span>
                        </div>
                        <div class="scorepad-nav-buttons">
                            <button type="button" class="pad-btn nav-btn" id="padUndo" title="撤销 (Ctrl+Z)" aria-label="撤销">↶</button>
                            <button type="button" class="pad-btn nav-btn" id="padRedo" title="重做 (Ctrl+Y)" aria-label="重做">↷</button>
                            <button type="button" class="pad-btn nav-btn" id="padPrev" title="上一个 (←)" aria-label="上一个">←</button>
                            <button type="button" class="pad-btn nav-btn" id="padNext" title="下一个 (→)" aria-label="下一个">→</button>
                            <button type="button" class="pad-btn nav-btn" id="padInsertMode" title="插入游标 [+]" aria-label="插入游标">+</button>
                            <button type="button" class="pad-btn nav-btn" id="padRevealSource" title="定位到源码" aria-label="定位到源码">{ }</button>
                            <button type="button" class="pad-btn danger-btn" id="padDelete" title="删除 (Backspace / Delete)" aria-label="删除">⌫</button>
                        </div>
                    </div>
                </div>

                <div class="scorepad-body" id="scorepadBody">
                    <section class="scorepad-section" aria-label="时值与附点">
                        <div class="scorepad-rhythm-bar" id="padRhythmBar">
                            <div class="rhythm-group" role="group" aria-label="减时线">
                                ${DIV_LEVELS.map(div => `<button type="button" class="pad-btn rhythm-btn" data-div="${div}" title="减时线 (${div})" aria-label="减时线 ${div}">${renderXGlyph(div, 0)}</button>`).join("")}
                            </div>
                            <div class="rhythm-divider" role="separator"></div>
                            <div class="rhythm-group dot-group" role="group" aria-label="附点">
                                ${DOT_LEVELS.map(dot => `<button type="button" class="pad-btn dot-btn" data-dot="${dot}" title="附点 (${dot})" aria-label="附点 ${dot}">${renderXGlyph(0, dot)}</button>`).join("")}
                            </div>
                        </div>
                    </section>

                    <section class="scorepad-section" aria-label="音高与增时线">
                        <div class="scorepad-pitch-grid" id="padPitchGrid">
                            ${PITCH_KEYS.map(item => `<button type="button" class="pad-btn pitch-key" data-pitch="${item.pitch}" title="${item.title}" aria-label="${item.title}">${item.label}</button>`).join("")}
                        </div>
                        <div class="scorepad-modifiers" id="padModifiers">
                            <div class="octave-stepper" role="group" aria-label="八度">
                                <button type="button" class="pad-btn octave-step-btn" data-octave="-1" title="降八度 (↓)" aria-label="降八度">−</button>
                                <button type="button" class="pad-btn octave-state-btn" id="padOctaveState" title="当前八度（点击归零）" aria-label="当前八度">${renderOctaveGlyph(0)}</button>
                                <button type="button" class="pad-btn octave-step-btn" data-octave="1" title="升八度 (↑)" aria-label="升八度">+</button>
                            </div>
                            <div class="acc-group" role="group" aria-label="变音记号">
                                <button type="button" class="pad-btn mod-btn" data-acc="#" title="升号 (#)" aria-label="升号">♯</button>
                                <button type="button" class="pad-btn mod-btn" data-acc="b" title="降号 (b)" aria-label="降号">♭</button>
                                <button type="button" class="pad-btn mod-btn" data-acc="n" title="还原号 (n)" aria-label="还原号">♮</button>
                            </div>
                        </div>
                    </section>

                    <section class="scorepad-section" aria-label="多音关系与装饰">
                        <div class="scorepad-chip-row" id="padRelations">
                            ${RELATION_COMMANDS.map(cmd => `<button type="button" class="pad-btn chip-btn" data-relation-cmd="${cmd.kind}" title="${cmd.label}" aria-label="${cmd.label}"><strong>${cmd.icon}</strong></button>`).join("")}
                        </div>
                        <div class="scorepad-chip-row" id="padSymbols">
                            ${SYMBOLS.map(sym => `<button type="button" class="pad-btn chip-btn" data-symbol="${sym.id}" title="${sym.label}" aria-label="${sym.label}"><strong>${sym.icon}</strong></button>`).join("")}
                            <button type="button" class="pad-btn chip-btn" data-grace="pre" title="前倚音" aria-label="前倚音"><code>X&gt;</code></button>
                            <button type="button" class="pad-btn chip-btn" data-grace="post" title="后倚音" aria-label="后倚音"><code>&lt;X</code></button>
                        </div>
                    </section>

                    <section class="scorepad-section" aria-label="小节线、拍号、调号与速度">
                        <div class="scorepad-chip-row" id="padBars">
                            ${BAR_TYPES.map(b => `<button type="button" class="pad-btn chip-btn" data-bar-type="${b.type}" title="${b.label}" aria-label="${b.label}"><code>${b.symbol}</code></button>`).join("")}
                            <button type="button" class="pad-btn chip-btn" id="padLineBreakBtn" title="换行 (Enter / @br)" aria-label="换行">↵</button>
                            <button type="button" class="pad-btn chip-btn" id="padAutoBarBtn" aria-pressed="true" title="满拍自动补小节线">| 自动</button>
                            <button type="button" class="pad-btn chip-btn" id="padReflowBars" title="按当前拍号重排后续小节线">⇄ |</button>
                        </div>
                        <div class="scorepad-chip-row" id="padMeters">
                            ${COMMON_METERS.map(([n, d]) => `<button type="button" class="pad-btn chip-btn" data-meter="${n}/${d}">${n}/${d}</button>`).join("")}
                        </div>
                        <div class="scorepad-chip-row" id="padKeys">
                            <span class="chip-group-label">1=</span>
                            ${KEYS.map(k => `<button type="button" class="pad-btn chip-btn" data-key="${k}">${k}</button>`).join("")}
                        </div>
                        <div class="scorepad-chip-row" id="padTempos">
                            <span class="chip-group-label">♩=</span>
                            <button type="button" class="pad-btn chip-btn" data-tempo-delta="-5">−5</button>
                            <button type="button" class="pad-btn chip-btn" data-tempo-delta="5">+5</button>
                            ${[60, 80, 96, 120, 144].map(bpm => `<button type="button" class="pad-btn chip-btn" data-tempo="${bpm}">${bpm}</button>`).join("")}
                        </div>
                    </section>
                </div>
            </div>

            <div class="scorepad-relation-view" id="scorepadRelationView" hidden>
                <div class="relation-view-card">
                    <div class="relation-header">
                        <div class="relation-title-group">
                            <strong class="relation-title" id="commandTitle">⌒ 连音线</strong>
                            <span class="command-hint" id="commandHint">0 / 2</span>
                        </div>
                        <div class="command-bar-actions">
                            <button type="button" class="pad-btn icon-action-btn command-confirm" id="commandConfirm" title="确定 (Enter)" aria-label="确定">
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                    <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <button type="button" class="pad-btn icon-action-btn command-cancel" id="commandCancel" title="取消 (Esc)" aria-label="取消">
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                    <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <div class="relation-options-row" id="commandOptions"></div>
                    <div class="relation-picked-box" id="commandPickedList" role="list" aria-label="已选音符"></div>
                </div>
            </div>
        </div>
    `;
}
