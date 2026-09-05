import type { ASTNodeBase } from "../functions/ASTtypes.js";
import type { TemporalNodeBase } from "../functions/temporal.js";
import type { Diagnostic } from "../diagnostic.js";
import type { SourceSpan } from "../parser/types.js";
import type { Fraction } from "../fraction.js";
import type { PageConfig } from "../layout/types.js";
import type { Track, TrackArrangement } from "./track.js";

/** lowering 产生的不推进时间的附属对象；具体能力由 layout/playback 子协议声明 */
export interface LoweringAttachment {
    readonly sourceSpan?: SourceSpan;
}

/** 时间流固化后生成额外 attachment；读取统一追加前的结果，不直接修改结果 */
export type LoweringAugmenter = (result: LoweringResult) => Iterable<LoweringAttachment>;

/** 所有 augmenter 结果追加完成后的最终处理；按注册顺序执行，可修改完整结果或抛出语义错误 */
export type LoweringFinalizer = (result: LoweringResult) => void;

/**
 * lowering 的输出
 *
 * - columns 时间列，是横向弹簧模型的输入
 * - attachments 保存不直接推进时间的布局附件（如 tie、box）、播放关系与控制声明
 * - astToTemporal 从 AST 到 Temporal 的映射（一对多）
 * - rootTrack 纵向音轨树的根，layout 沿它递归求解每行的纵向轴
 */
export interface LoweringResult {
    diagnostics: Diagnostic[];      // parser 与 lowering 共享的诊断信息
    columns: TemporalNodeBase[][];  // 按时间和对齐规则归并的事件列
    attachments: LoweringAttachment[]; // 不推进时间的附属对象，由 layout/playback 按能力消费
    astToTemporal: Map<ASTNodeBase, TemporalNodeBase[]>; // 关系函数和编辑器使用的 AST 到本轮事件索引
    duration: Fraction;             // 当前 lowering 范围的总时长
    rootTrack: Track;               // 纵向音轨树的根
    tracks: readonly Track[];       // 按本轮首次承载 Temporal 的顺序收集，空轨不进入
    page?: PageConfig;              // 文档页面配置；缺省时 layout 使用默认页面
}

/**
 * lowering 递归作用域的通用观察者
 *
 * 回调按当前作用域栈由内向外执行；onTemporal 在事件加入时间列、推进时间游标前调用。
 */
export interface LoweringGroup {
    /**
     * 当前分组退出后会自动注册的 attachment
     *
     * attachment 在 layout 的时候会按照顺序求解，对于 box 这样的必须让子元素先被测量，才能确定尺寸，所以需要最后加入
     * 之所以有这个字段（而不是在 endLoweringGroup 之后手动 push）是为了收集到的信息可以直接传递，参考 box
     */
    attachment?: LoweringAttachment;
    /** 观察组内生成的事件 */
    onTemporal?(node: TemporalNodeBase): void;
    /** 观察组内注册的附属对象 */
    onAttachment?(attachment: LoweringAttachment): void;
}

/**
 * 时间流动模式（由 AST 节点的 timeFlowModel 返回）
 *
 * 当父节点展开子节点时，时间指针如何推进：
 * - sequence: 子节点串行，后一个子节点从前一个子节点结束位置开始
 * - parallel: 子节点并行，所有子节点都从同一个时间点开始，父节点结束时间取最大值，
 *   并且要额外声明分轨与纵向排列方式
 */
export type TimeFlowModel =
    | { mode: "sequence"; children: ASTNodeBase[] }
    | { mode: "parallel"; children: ASTNodeBase[]; tracks: TrackArrangement };
