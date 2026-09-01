/**
 * 时间线事件的基类
 * 由 AST 产生，跨越 lowering / layout / playback 三个阶段
 */
import type { ASTNodeBase } from "./ASTtypes.js";
import { Fraction } from "../fraction.js";
import type {
    HorizontalSpringConfig,
    LayoutBox,
    LayoutDecoration,
    LayoutHost,
    LayoutPoint,
    LayoutPrepareContext,
    HorizontalLineView,
    TimeLineEvent,
} from "../layout/types.js";
import type { Track } from "../lowering/track.js";
import type { PlaybackEmitter, PlaybackState } from "../playback/types.js";
import type { Painter } from "../render/types.js";

/**
 * 沿记谱顺序流动的时间状态
 *
 * 速度、力度、调性是系统级字段：有确定的类型和初值，任何时刻都能直接读，不用写兼容分支。
 * 其余键由具体函数自行约定，核心不认识。
 *
 * velocity 按音轨各自流动，新音轨继承分叉处父轨的值；其余键整篇共享。
 */
export interface TimeState {
    bpm: number;
    velocity: number;
    keySignature: string;
    [key: string]: any;
}
export const DEFAULT_BPM = 120;
export const DEFAULT_VELOCITY = 80;
export const DEFAULT_TONALITY = "C4";

/**
 * 事件的合并组：同一时刻 mergeKey 相等的事件归并成一列
 *
 * 缺省取事件自身的 order，因而互不相等、各自独占一列；需要合并的显式取相同的值。
 * 数值同时决定同时刻的列先后，越小越靠左。已占用的共享常量：-1 br，-2 声部名
 */
/** 时间对齐点（小节线）；必须是最小值，最先出队 */
export const ANCHOR_KEY = -Infinity;
/** 普通事件的公共组 */
export const DEFAULT_KEY = Infinity;

/** 
 * 时间线事件
 * 
 * 由 AST 节点在 lowering 阶段产生，负责得到时间、设置布局参数
 */
export class TemporalNodeBase implements TimeLineEvent {
    // 下面这批字段统一由 LoweringContext.initEvent 原地补全

    // 横向 layout 要用的三个属性
    readonly t = new Fraction(); // 事件发生的时间点
    readonly T = new Fraction(); // 事件的持续时间
    track!: Track;  // 所在的纵向音轨；同轨判断使用引用相等

    ast!: ASTNodeBase;  // 对应的 AST 节点
    order!: number;     // 事件创建序号，作为id。可用于区分同时发生的父子、排序同一时刻发生的事件
    addon?: Record<string, any>; // 其他任意字段，仅在存在已固化的函数语义时创建，比如存储 div 和 dot 的数目

    /**
     * 时间列合并组：同一时刻 mergeKey 相等的事件归并成一列
     *
     * 缺省取事件自身的 order，因而互不相等、各自独占一列；需要合并的显式取相同的值。
     * 数值同时决定同时刻的列先后，越小越靠左。已占用的共享常量：-1 br，-2 声部名
     */
    mergeKey!: number;

    /**
     * 被折叠进哪个宿主的盒子（由宿主自己设置）
     *
     * 折叠成员不进入全局 columns，在时间流里没有独立位置，
     * 按全局事件工作的消费者可以沿链上溯到宿主。
     */
    foldedInto?: TemporalNodeBase;

    /** 请求在自己所在时间列之前换几行，默认 0 */
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
     * 4. arrangeBelowDecorations 按 below.order 分配主体下方空间并调用 below.place；
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
    onTimeState?(state: TimeState): void;

    /** 把已固化的音乐语义声明为播放事件；不执行实时播放 */
    emitPlayback?(emitter: PlaybackEmitter): void;
    /** 给自己所在的时间列贴播放标记，供控制流游标查询 */
    playbackMarks?(): readonly string[];
    /** 向播放系统告知自己这个记谱位置上的速度与力度 */
    playbackState?: PlaybackState;

    /**
     * 根据已经固化的语义生成固有尺寸
    * 一般为测量函数自有图形或使用 LayoutPrepareContext.textMeasurer 测量文本，填写 box.w/h/anchor/visualAxis
     * 此时 x 和 y 仍然没有最终含义
     */
    prepareLayout(_ctx: LayoutPrepareContext): void {}

    /** 横向拓扑建立后调整弹簧参数或注册横向布局 hook */
    prepareHorizontal?(_line: HorizontalLineView): void;

    /**
     * 得到了最终的 box 后被调用（和 prepareLayout 之间隔了 decoration 的布局计算）
     * 可在这里发布依赖最终 box.w/box.h 的端口
     */
    finalizeLayout?(_ctx: LayoutPrepareContext): void;

    /**
     * 布局器每次改变 x 或 y 后调用
     * 普通叶节点不需要处理，具有内部几何的复合节点可用它同步子对象坐标
     */
    onPlaced?(): void;

    /** 只执行绘制，不允许在这里重新测量或改变 LayoutBox */
    paint(_painter: Painter): void {}
}

/** 可以进入视觉布局的 Temporal，同时满足 decoration 所需的 LayoutHost 协议 */
export type VisualTemporalNode = TemporalNodeBase & LayoutHost;
export function isVisualTemporalNode(node: TemporalNodeBase): node is VisualTemporalNode {
    return node.box !== undefined;
}
