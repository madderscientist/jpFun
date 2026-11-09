/**
 * 可视化编辑引擎的数据契约与类型定义
 *
 * 本模块仅包含宿主无关的纯数据结构，供索引层（index-targets.ts）、
 * 源码改写层（transform.ts）与前端交互层共同依赖。
 */
import {
    Fraction,
    type ASTFunctionNode,
    type ASTNodeBase,
    type Rect,
    type SourceEdit,
    type SourceSpan,
} from "jpfun";

/** 简谱时值描述：`div` 为减时线数量（0~3），`dot` 为附点数量（0~2） */
export interface RhythmSpec {
    readonly div: number;
    readonly dot: number;
}

/** 支持可视化拾取与删除的多音关系命令类别 */
export type RelationKind = "tie" | "gliss" | "tuplet" | "dyn" | "ottava" | "volta" | "beam";

/** 所有谱面可编辑目标共享的基础几何与源码定位字段 */
export interface BaseEditTarget {
    /** 目标核心语法节点的源码区间 */
    readonly span: SourceSpan;
    /** 包含外层单音包装器、折叠符号（^$...）与尾随 @label 在内的完整词法单元区间 */
    readonly unitSpan: SourceSpan;
    /** 当该元素位于 @tuplet / @div / @grace 等分组末尾时，跳出分组右括号后的安全插入偏移 */
    readonly postGroupInsertEnd: number;
    /** 谱面布局包围盒（用于Overlay高亮与点击命中） */
    readonly region: Rect;
    /** 编译器 lowering 产出的实际拍数时值（已计入 @tuplet 等缩放） */
    readonly compiledDuration: Fraction;
    /** 若位于 @tuplet 内部，记录外层 @tuplet 调用区间以免在其内部误插小节线 */
    readonly enclosingTupletSpan?: SourceSpan;
    /** 是否为 @up / @down 和弦的非根音成员 */
    readonly isChordMember: boolean;
    /** 所属声部轨道索引（0 为主旋律轨道） */
    readonly trackIndex: number;
}

/** 音符目标（含语法糖 `1/.` 与显式函数 `@note(...)`） */
export interface NoteEditTarget extends BaseEditTarget {
    readonly kind: "note";
    /** 音符对应的底层 AST 节点 */
    readonly noteAst: ASTFunctionNode;
    /** 仅包裹音高/八度/变音本体的区间（不含外层 `/`、`.` 与符号） */
    readonly noteSpan: SourceSpan;
    /** 包裹音符本体及其独占 `/`、`.` 时值后缀的区间（后倚音 `<` 需包裹此区间以保留宿主时值） */
    readonly stemSpan: SourceSpan;
    /** 若挂载了 `^$symbol` 或和弦 `@up/@down`，记录该折叠节点区间 */
    readonly foldSpan?: SourceSpan;
    /** 若位于 `{1 2}/` 等多音共享减时线块内，指向最外层共享 `@div` AST 节点 */
    readonly outerSharedDiv?: ASTFunctionNode & { content: ASTNodeBase; n: number };
    /** 若自身是倚音分支中的音符，指向所属 `@grace` 节点 */
    readonly graceBranchParent?: ASTFunctionNode & { host: ASTNodeBase; grace: ASTNodeBase };
    /** 若自身是挂载了倚音的宿主音符，指向所属 `@grace` 节点（删除宿主时一并清理倚音） */
    readonly graceHostParent?: ASTFunctionNode & { host: ASTNodeBase; grace: ASTNodeBase };
    /** 是否存在包裹在 `@up/@down` 之外的单音 `@div/@dot` 包装（如 `{1^$accent}/`） */
    readonly hasOuterWrapper: boolean;
    /** 是否由 `@set(note.acc=...)` 注入了默认变音记号 */
    readonly hasDefaultAcc: boolean;
    /** 插入 `@label` 锚点的源码偏移（紧随 `stemSpan` 之后） */
    readonly labelInsertOffset: number;
    readonly pitch: string;
    readonly acc: string;
    readonly octave: number;
    readonly rhythm: RhythmSpec;
    readonly symbols: readonly string[];
    readonly label?: string;
    readonly sharedDiv: boolean;
    readonly isGrace: boolean;
}

export interface DashEditTarget extends BaseEditTarget {
    readonly kind: "dash";
    readonly stemSpan: SourceSpan;
    readonly outerSharedDiv?: ASTFunctionNode & { content: ASTNodeBase; n: number };
    readonly labelInsertOffset: number;
    readonly rhythm: RhythmSpec;
    readonly label?: string;
    readonly sharedDiv: boolean;
}

export interface BarEditTarget extends BaseEditTarget {
    readonly kind: "bar";
    readonly barType: number;
}

export interface MeterEditTarget extends BaseEditTarget {
    readonly kind: "meter";
    readonly numerator: number;
    readonly denominator: number;
    readonly inHeader: boolean;
}

export interface KeyEditTarget extends BaseEditTarget {
    readonly kind: "key";
    readonly tonality: string;
    readonly displayName: string;
    readonly displayAcc: string;
    readonly inHeader: boolean;
}

export interface TempoEditTarget extends BaseEditTarget {
    readonly kind: "tempo";
    readonly bpm: number;
    readonly inHeader: boolean;
}

export interface RestEditTarget extends BaseEditTarget {
    readonly kind: "rest";
    readonly measures: number;
}

export interface RelationEditTarget extends BaseEditTarget {
    readonly kind: "relation";
    readonly relationKind: RelationKind;
    readonly regions: readonly Rect[];
}

export type ScoreStreamTarget =
    | NoteEditTarget
    | DashEditTarget
    | BarEditTarget
    | MeterEditTarget
    | KeyEditTarget
    | TempoEditTarget
    | RestEditTarget;

export type ScoreEditTarget = ScoreStreamTarget | RelationEditTarget;

export interface ActiveMeterInfo {
    readonly numerator: number;
    readonly denominator: number;
    readonly measureDuration: Fraction;
}

export interface ScoreInsertSlot {
    readonly insertAt: number;
    readonly afterSpan: SourceSpan | null;
    readonly region: Rect;
    readonly meter: ActiveMeterInfo | null;
    readonly measureUsed: Fraction;
    readonly measureRemaining: Fraction | null;
}

export interface ScoreEditIndex {
    readonly targets: readonly ScoreEditTarget[];
    readonly streamTargets: readonly ScoreStreamTarget[];
    readonly defaultInsertSlot: ScoreInsertSlot;
}

export type ScoreEditAction =
    | { readonly type: "set-pitch"; readonly pitch: string; readonly advance?: boolean }
    | { readonly type: "set-accidental"; readonly acc: "" | "#" | "b" | "n" }
    | { readonly type: "adjust-octave"; readonly delta: number }
    | { readonly type: "set-rhythm"; readonly rhythm: Partial<RhythmSpec> }
    | { readonly type: "toggle-symbol"; readonly symbol: string }
    | { readonly type: "insert-grace"; readonly side: "pre" | "post"; readonly pitch?: string }
    | {
        readonly type: "insert-note";
        readonly slot: ScoreInsertSlot;
        readonly pitch: string;
        readonly acc?: string;
        readonly octave?: number;
        readonly rhythm: RhythmSpec;
        readonly autoBar?: boolean;
    }
    | { readonly type: "set-bar"; readonly barType: number; readonly slot?: ScoreInsertSlot }
    | { readonly type: "insert-line-break"; readonly slot?: ScoreInsertSlot }
    | { readonly type: "set-meter"; readonly numerator: number; readonly denominator: number; readonly slot?: ScoreInsertSlot }
    | { readonly type: "reflow-bars" }
    | { readonly type: "set-key"; readonly tonality: string; readonly slot?: ScoreInsertSlot }
    | { readonly type: "set-tempo"; readonly bpm: number; readonly slot?: ScoreInsertSlot }
    | { readonly type: "delete"; readonly slot?: ScoreInsertSlot };

export type RelationCommandSpec =
    | { readonly kind: "tie" | "gliss" | "beam"; readonly targets: readonly ScoreEditTarget[] }
    | { readonly kind: "tuplet"; readonly targets: readonly ScoreEditTarget[]; readonly normal?: number }
    | { readonly kind: "dyn"; readonly targets: readonly ScoreEditTarget[]; readonly dv?: number }
    | { readonly kind: "ottava"; readonly targets: readonly ScoreEditTarget[]; readonly shift?: number }
    | { readonly kind: "volta"; readonly targets: readonly ScoreEditTarget[]; readonly pass?: number };

export interface ScoreEditResult {
    readonly edits: SourceEdit[];
    readonly nextMode: "select" | "insert";
    readonly nextSpan: SourceSpan | null;
}

export const BAR_SUGAR = ["|", "||", "|||", "|:", ":|", ":|:"] as const;
const RELATION_KINDS = new Set<string>(["tie", "gliss", "tuplet", "dyn", "ottava", "volta", "beam"]);

export function isRelationKind(value: string): value is RelationKind {
    return RELATION_KINDS.has(value);
}

export function rhythmDuration(rhythm: RhythmSpec): Fraction {
    const div = Math.max(0, Math.trunc(rhythm.div));
    const dot = Math.max(0, Math.trunc(rhythm.dot));
    return new Fraction(2 ** (dot + 1) - 1, 2 ** (div + dot));
}
