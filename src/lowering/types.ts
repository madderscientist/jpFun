import { ASTNodeBase } from "../functions/ASTtypes.js";
import type {
    LayoutAttachment,
    ElementConfig,
    LayoutBox,
    LayoutDecoration,
    PageConfig,
    LayoutPoint,
    LayoutPrepareContext,
    TimeLineEvent,
} from "../layout/types.js";
import type { Painter } from "../render/types.js";

/** 进行时间变换的 hook；针对 div 和 dot 设计 */
export type TimeWrapFunc = (vars: Record<string, any>, dt: number) => number;
export type TimeWrapConfig = {
    priority: number;  // 优先级 越大越后执行
    func: TimeWrapFunc;
}

/** 函数在时间列、行号和时间状态固化后追加关系排版对象的 hook */
export type LoweringFinalizer = (result: LoweringResult) => Iterable<LayoutAttachment>;

/**
 * lowering 的输出
 *
 * columns 时间列，是横向弹簧模型的输入
 * attachments 保存 tie、beam、box 等不直接推进时间的附属布局对象
 * astToTemporal 从 AST 到 Temporal 的映射（一对多）
 */
export interface LoweringResult {
    columns: TemporalNodeBase[][];  // 按时间和对齐规则归并的事件列
    attachments: LayoutAttachment[]; // 不推进时间的关系与分组对象
    astToTemporal: Map<ASTNodeBase, TemporalNodeBase[]>; // 关系函数和编辑器使用的 AST 到本轮事件索引
    duration: number;               // 当前 lowering 范围的总时长
    page?: PageConfig;              // 文档页面配置；缺省时 layout 使用默认页面
}

/**
 * 时间流动模式（由 AST 节点的 timeFlowMode 返回）
 *
 * 当父节点展开子节点时，时间指针如何推进：
 * - sequence: 子节点串行，后一个子节点从前一个子节点结束位置开始
 * - parallel: 子节点并行，所有子节点都从同一个 startQN 开始，父节点结束时间取最大值
 */
export type TimeFlowMode = "sequence" | "parallel";

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
    // 这些字段的填充靠 LoweringContext.appendEvents

    // 横向 layout 要用的三个属性
    t!: number; // 事件发生的时间点
    T!: number; // 事件的持续时间
    /**
     * 构造阶段表示轨道偏移(number)
     * LoweringContext.appendEvents 会把它覆盖为字符串，变为轨道标识符
     */
    track!: string | number; // 事件所属轨道的标识符

    ast!: ASTNodeBase;  // 对应的 AST 节点
    order!: number;     // timeAllocation 创建顺序，作为id。可以用于区分同时发生的父子、排序同一时刻发生的事件
    addon?: Record<string, any>; // 其他任意字段 仅在存在装饰快照或函数附加数据时创建
    type!: ColType;     // 事件类型

    /**
     * 构造阶段表示当前时间列开始前的行偏移，默认 0，br 设置为 1，需要换行显示的也设置为 1
     * 列归并完成后由 LoweringContext 覆盖为实际行号
     */
    layoutLine = 0;

    /** 不可见状态事件保持 undefined */
    box?: LayoutBox;

    /**
     * 横向弹簧布局参数
     * 大部分对象使用空对象即可采用布局器默认值
     */
    elementConfig!: ElementConfig;

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
     * 1. layout 的 prepareObject 开始时创建或清空数组；
     * 2. Temporal.prepareLayout 可先加入节点自身的装饰，例如下八度点；
     * 3. 引擎再通过 addon 对应的 layoutDecorationHandler 加入函数装饰；
     * 4. arrangeBelowDecorations 按 belowOrder 分配主体下方空间并调用 place；
     * 5. 最终 paintLayout 在主体 paint 后依次调用 decoration.paint。
     *
     * 数组必须保留到绘制结束，因为 decoration 通常以闭包保存本次测量得到的几何。重复 layout 时必须清空并重建，不能复用上次坐标。
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
            anchor: 0, baseline: 0,
        };
    }

    /**
     * 时间状态 修改&冻结 入口
     * 调用时机在时间位置已经确定之后，处理“调性、速度、拍号”等时间信息的固化
     */
    onTimeState?(state: Record<string, any>): void;

    /**
     * 根据已经固化的语义生成固有尺寸
     * 此时 x 和 y 仍然没有最终含义
     */
    prepareLayout(_ctx: LayoutPrepareContext): void {}

    /**
     * 装饰完成纵向排列后调用
     * 第三方节点可在这里发布依赖最终 box.w/box.h 的端口
     */
    finalizeLayout?(_ctx: LayoutPrepareContext): void;

    /**
     * 布局器每次改变 x 或 y 后调用
     * 普通叶节点不需要处理，over 等复合节点用它同步子节点坐标
     */
    onPlaced?(): void;

    /**
     * 只执行绘制，不允许在这里重新测量或改变 LayoutBox
     */
    paint(_painter: Painter): void {}
}

/** 可以进入视觉布局的 Temporal，即 box 不是 undefined */
export type VisualTemporalNode = TemporalNodeBase & { box: LayoutBox };

export function isVisualTemporalNode(node: TemporalNodeBase): node is VisualTemporalNode {
    return node.box !== undefined;
}
