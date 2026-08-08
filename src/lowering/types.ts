import { ASTNodeBase } from "../functions/ASTtypes.js";
import type {
    LayoutAttachment,
    HorizontalSpringConfig,
    LayoutBox,
    LayoutDecoration,
    LayoutHost,
    PageConfig,
    LayoutPoint,
    LayoutPrepareContext,
    TimeLineEvent,
} from "../layout/types.js";
import type { Painter } from "../render/types.js";
import type { ArrangeFn, Track } from "./track.js";

/** 时间流固化后生成额外 attachment；所有 augmenter 读取同一份输入快照 */
export type LoweringAugmenter = (result: LoweringResult) => Iterable<LayoutAttachment>;

/** 所有 augmenter 结果追加完成后的最终处理；按注册顺序执行，可修改完整结果或抛出语义错误 */
export type LoweringFinalizer = (result: LoweringResult) => void;

/**
 * lowering 的输出
 *
 * columns 时间列，是横向弹簧模型的输入
 * attachments 保存 tie、beam、box 等不直接推进时间的附属布局对象
 * astToTemporal 从 AST 到 Temporal 的映射（一对多）
 * rootTrack 纵向音轨树的根，layout 沿它递归求解每行的纵向轴
 */
export interface LoweringResult {
    columns: TemporalNodeBase[][];  // 按时间和对齐规则归并的事件列
    attachments: LayoutAttachment[]; // 不推进时间的关系与分组对象
    astToTemporal: Map<ASTNodeBase, TemporalNodeBase[]>; // 关系函数和编辑器使用的 AST 到本轮事件索引
    duration: number;               // 当前 lowering 范围的总时长
    rootTrack: Track;               // 纵向音轨树的根
    page?: PageConfig;              // 文档页面配置；缺省时 layout 使用默认页面
}

/**
 * lowering 递归作用域的通用观察者
 *
 * onTemporal 在事件加入时间列、推进时间游标前调用。
 */
export interface LoweringGroup {
    attachment?: LayoutAttachment;
    onTemporal?(node: TemporalNodeBase): void;
    onAttachment?(attachment: LayoutAttachment): void;
}

/**
 * parallel 节点的分轨与纵向排列声明
 *
 * 这是具体函数唯一需要提供的纵向信息。LoweringContext 据此分配音轨，
 * layout 据此求解纵向轴；两者都不需要知道声明它的是 stack、voices 还是别的什么。
 */
export interface TrackArrangement {
    /**
     * 音轨复用键：同一宿主上 laneKey 相同的多次出现共用同一批音轨（同一条基线）
     * 例如 stack 用 "stack"，voices 用 `voices/成员数`
     */
    laneKey: string;
    /**
     * 哪个成员就地留在宿主轨上，缺省为 0
     * stack 用默认值以保证宿主的旋律主线不被打断；voices 传 null 表示宿主不是成员
     */
    hostIndex?: number | null;
    /** 纵向排列策略 */
    arrange: ArrangeFn;
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

/**
 * 在时间列中怎么表现
 * - anchor: 时间对齐点，比如 bar
 * - single: 需要单独成列，一般是设置或 br 等控制事件，避免与普通事件合列
 * - default: 其他所有希望被分到同一个时间列的
 * 
 * 由于有优先级别（需要可比），所以用了枚举
 */
export const enum ColType {
    ANCHOR, // anchor 最优先
    SINGLE,
    DEFAULT // 普通事件必须最后
}

/** 
 * 时间线事件
 * 
 * 由 AST 节点在 lowering 阶段产生，负责得到时间、设置布局参数
 */
export class TemporalNodeBase implements TimeLineEvent {
    // 下面这批字段统一由 LoweringContext.initEvent 原地补全

    // 横向 layout 要用的三个属性
    t!: number; // 事件发生的时间点
    T!: number; // 事件的持续时间
    track!: Track;  // 所在的纵向音轨；同轨判断使用引用相等

    ast!: ASTNodeBase;  // 对应的 AST 节点
    order!: number;     // timeAllocation 创建顺序，作为id。可以用于区分同时发生的父子、排序同一时刻发生的事件
    addon?: Record<string, any>; // 其他任意字段，仅在存在已固化的函数语义时创建，比如存储 div 和 dot 的数目
    type!: ColType;     // 事件类型

    /**
     * 被折叠进哪个宿主的盒子（由宿主自己设置）
     *
     * 折叠成员不进入全局 columns，在时间流里没有独立位置，
     * 因此它对外（标签、关系函数端点）一律由宿主代表；嵌套折叠沿链上溯。
     */
    foldedInto?: TemporalNodeBase;

    /**
     * 请求在自己所在时间列之前换几行，默认 0
     */
    breakBefore = 0;

    /** 由 LoweringContext 在列归并后固化的谱面行号 */
    layoutLine = 0;

    /** 不可见状态事件保持 undefined */
    box?: LayoutBox;

    /**
     * 横向弹簧布局参数
     * 大部分对象使用空对象即可采用布局器默认值
     */
    springConfig!: HorizontalSpringConfig;

    /**
     * 关系函数可使用的命名局部坐标
     * prepareLayout 每次执行时由具体节点和装饰函数重新生成
     */
    ports!: Record<string, LayoutPoint>;

    /**
     * 当前一次 layout 已经实例化并完成测量的装饰对象
     *
     * 起因：addon 只保存 lowering 阶段冻结的语义值，例如 `@div: 2`，它没有字号、局部坐标，也不能表达 note 自身生成的下八度点。
     * 布局需要把这些语义统一转换成可排序、可占高、可绘制的 LayoutDecoration 实例。
     *
     * 生命周期：
     * 1. layout 的 prepareLayoutHost 开始时创建或清空数组；
     * 2. Temporal.prepareLayout 可先加入节点自身的装饰，例如下八度点；
     * 3. 引擎再通过 addon 对应的 layoutDecorationHandler 加入函数装饰；
     * 4. arrangeBelowDecorations 按 belowOrder 分配主体下方空间并调用 place；
     * 5. 最终 paintLayout 在主体 paint 后依次调用 decoration.paint。
     *
     * 数组必须保留到绘制结束，因为 decoration 通常以闭包保存本次测量得到的几何。它只属于当前 layout pass，不能跨 pass 复用。
     * prepare 阶段生成、place 后冻结、paint 后失效
     */
    decorations!: LayoutDecoration[];

    /**
     * 创建并返回当前事件唯一的 LayoutBox
     * 可见子类应在构造函数中调用一次（或自行填写）
     */
    protected initLayoutBox(): LayoutBox {
        return this.box = {
            x: 0, y: 0,
            w: 0, h: 0,
            anchor: 0, visualAxis: 0,
        };
    }

    /**
     * 时间状态 修改&冻结 入口
     * 调用时机在时间位置已经确定之后，处理“调性、速度、拍号”等时间信息的固化
     */
    onTimeState?(state: Record<string, any>): void;

    /**
     * 根据已经固化的语义生成固有尺寸
     * 一般为使用 LayoutPrepareContext.glyphs 测量字形或文本，填写 box.w/h/anchor/visualAxis
     * 此时 x 和 y 仍然没有最终含义
     */
    prepareLayout(_ctx: LayoutPrepareContext): void {}

    /**
     * 装饰完成纵向排列后调用（得到了最终的 box）
     * 第三方节点可在这里发布依赖最终 box.w/box.h 的端口
     */
    finalizeLayout?(_ctx: LayoutPrepareContext): void;

    /**
     * 布局器每次改变 x 或 y 后调用
     * 普通叶节点不需要处理，具有内部几何的复合节点可用它同步子对象坐标
     */
    onPlaced?(): void;

    /**
     * 只执行绘制，不允许在这里重新测量或改变 LayoutBox
     */
    paint(_painter: Painter): void {}
}

/** 可以进入视觉布局的 Temporal，同时满足 decoration 所需的 LayoutHost 协议 */
export type VisualTemporalNode = TemporalNodeBase & LayoutHost;
export function isVisualTemporalNode(node: TemporalNodeBase): node is VisualTemporalNode {
    return node.box !== undefined;
}
