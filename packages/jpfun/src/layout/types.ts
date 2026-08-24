import type { Painter, TextMeasurer } from "../render/types.js";
import type { Extent, Track } from "../lowering/track.js";
import type { Fraction } from "../fraction.js";
import type { SourceSpan } from "../parser/types.js";
import type { HorizontalLayoutHook } from "./model.js";

/** 轴对齐矩形，是所有排版几何的公共部分 */
export interface Rect {
    x: number;  // 左边界坐标
    y: number;  // 上边界坐标
    w: number;  // 完整占用宽度
    h: number;  // 完整占用高度
}

/**
 * 一个排版对象的完整矩形和两个对齐基准
 *
 * prepareLayout 负责填写 w、h、anchor、visualAxis
 * layout 负责原地修改 x、y
 * 所有字段保持扁平，布局器可以直接持有并修改这个对象的引用
 */
export interface LayoutBox extends Rect {
    anchor: number;     // 横向对齐点到盒子左边界的距离
    visualAxis: number; // 垂直视觉对齐轴距盒顶的距离 通常为 h/2
}

/**
 * 横向弹簧的物理属性 含义见排版模型的文档
 */
export interface HorizontalSpringConfig {
    alpha_L?: number;   // 左侧固有弹性间距系数
    alpha_R?: number;   // 增加该值会增加弹簧长度
    mu_L?: number;      // 左侧重叠阻尼惩罚系数
    mu_R?: number;      // 增加该值可以减少“穿模”
    beta_L?: number;    // 左侧弹性系数
    beta_R?: number;    // 建议不设置 beta，由 completeSpringConfig() 按 F/alpha 自动补齐
}


export interface TimeLineEvent {
    t: Fraction;  // 事件发生的时间点
    T: Fraction;  // 事件的持续时间
    track: Track; // 事件所在的纵向音轨
}

/** 文档页面的固化尺寸，所有值均为 px */
export interface PageConfig {
    width: number;       // 纸张总宽度
    height: number;      // 纸张总高度；Infinity 表示不分页
    marginTop: number;
    marginBottom: number;
    marginLeft: number;
    marginRight: number;
    lineGap: number;     // 相邻谱面行之间的最小空隙
}

/**
 * 排版前的共享资源
 *
 * textMeasurer 只负责确定性文本测量
 * 字号由具体视觉函数在 parse 时固化为 px，不属于布局上下文
 */
export interface LayoutPrepareContext {
    textMeasurer: TextMeasurer;
    decorationHandlers: ReadonlyMap<string, LayoutDecorationHandler>; // addon key 到装饰 handler 的注册表
}

/** attachment 根据当前视觉轴生成几何时需要的完整页面信息 */
export interface AttachmentLayoutContext extends LayoutPrepareContext {
    width: number;      // 整篇可用的内容宽（页宽减左右边距），与行无关
    originX: number;    // 内容区的左边界，即页面左边距
    getVisualAxis(line: number, track: Track): number;
    /** 只包含可见主体的轴局部占用（top 通常为负），不受 attachment 或最终分页坐标影响 */
    getHostExtent(line: number, track: Track): Readonly<Extent> | undefined;
    /** 读取本轮已完成的 attachment 边界；分组在 endLoweringGroup 才注册，因而组内对象必然排在分组之前 */
    getAttachmentBox(attachment: LayoutAttachment): Readonly<Rect>;
}


/**
 * 装饰所依附的主体
 *
 * 属性含义参考 TemporalNodeBase
 * 其他属性刻意不开放：
 * - addon 的值会直接传递给 LayoutDecorationHandler
 * - decorations 正是 LayoutDecorationHandler 的返回值构成的，也就是此时 LayoutHost 的 decorations 正在建立
 * - prepareLayout/finalizeLayout/onPlaced/paint 是引擎调度的生命周期方法，不许私自调用
 */
export interface LayoutHost extends TimeLineEvent {
    box: LayoutBox;
    springConfig: HorizontalSpringConfig;
    ports: Record<string, LayoutPoint>;
    readonly layoutLine: number;
    readonly ast: { readonly size: number }; // 具体视觉函数在 parse 时冻结 px 字号
}

/**
 * 一条谱面行进入横向求解前的只读视图
 *
 * 时间列拓扑不可改变，但其中的 host 仍可写；
 * 调用方可以调整 springConfig，也可以注册在 LayoutElement 归一化后执行的横向布局
 */
export interface HorizontalLineView {
    /** 谱面行号，与 host.layoutLine 同一坐标系 */
    readonly index: number;
    /** 同一 Track 上按时间列顺序排好的主体，相邻两项即视觉上的前后邻居 */
    readonly trackRuns: ReadonlyMap<Track, readonly LayoutHost[]>;
    /** 主体所在时间列下标；不在本行时返回 -1 */
    columnOf(host: LayoutHost): number;
    /** 注册横向布局 hook；同一行内按跨度从小到大执行 */
    registerHorizontalLayoutHook(from: LayoutHost, to: LayoutHost, hook: HorizontalLayoutHook): void;
}

/**
 * 相对于对象 LayoutBox 左上角的局部坐标
 * tie、beam 等关系函数通过命名端口获取几何位置
 */
export interface LayoutPoint {
    x: number;          // 相对于所属 LayoutBox 左边界的横坐标
    y: number;          // 相对于所属 LayoutBox 上边界的纵坐标
}

/** 把 addon 字段变为可绘制的 LayoutDecoration；返回 null 表示本次不生成装饰 */
export type LayoutDecorationHandler = (
    host: LayoutHost,
    value: unknown, // 存在 addon 中的值
    context: LayoutPrepareContext,
) => LayoutDecoration | null;

/**
 * 一次 layout 中生成并保留到 paint 阶段的装饰对象
 *
 * 实例有两种来源：Temporal.prepareLayout 可以直接加入；addon 对应的 LayoutDecorationHandler 也可以在主体 prepareLayout 后创建
 * 两者都在创建时就拿到了宿主，因此回调不再重复传入它；实例可以在返回前调整 host.box，例如 dot 先扩张主体宽度
 * 被 arrangeBelowDecorations 使用
 *
 * 通用部分只有 paint：主体绘制完成后，引擎调用它绘制当前装饰。
 *
 * below 是可选的“主体下方空间”子协议，只向下扩张 box.h，不管理主体上方空间
 * 上方内容若会改变主体 visualAxis 或内部绘制坐标，应由具体 Temporal 在 prepareLayout 中处理。
 *
 * 当前内置示例：
 * - dot：handler 生成只负责横向扩宽和绘制的装饰，不声明 below；
 * - div：handler 生成减时线装饰，使用 order=0，排在主体下方最内层；
 * - note 下八度点：prepareLayout 直接加入装饰，使用 order=100，排在减时线之后；
 * - note 上八度点不使用 LayoutDecoration，而是主体 prepareLayout 的一部分。
 *
 * LayoutDecoration 不是 addon 语义本身。实例可以用闭包保存本次测量参数和 place 结果，因此必须由 Temporal.decorations 持有到当前 paint 结束。
 */
export interface LayoutDecoration {
    paint(painter: Painter): void; // 只读取冻结几何

    /** 声明后进入主体下方空间管理，引擎只理解这四个字段，不知道空间来自哪个函数 */
    below?: {
        order: number;      // 越小越靠近主体，相同值保持注册顺序
        gap?: number;       // 与主体或前一个下方装饰的间隔，可以为负数
        height?: number;    // 下方区域占用高度，布局时强制为非负数
        /**
         * 引擎分配好本装饰的下方区域后调用一次，y 是该区域 **顶边到 host.box 顶部** 的距离
         *
         * 该做的：把这一刻才确定的局部几何存进闭包供 paint 使用（note 存下八度点的 y），
         * 以及发布依赖这个位置的端口（div 在这里建 div.N.left/right）。只占位不绘制时可以不实现。
         *
         * 不该做的：改 box.h（引擎会按 height 统一扩张）、读 box.y 或 box.h （前者尚未求解、后者正在向下累加）。
         * 此时只有 box.w/anchor 和 ports 是最终值，因此一律记录相对盒顶的局部坐标，绘制时再加 host.box.x / host.box.y。
         *
         * 例（一条减时线）：
         * ```ts
         * let lineY = 0;   // 闭包保存本轮测量结果
         * return {
         *     below: {
         *         order: 0,
         *         height: strokeWidth,
         *         place(y) {
         *             lineY = y + strokeWidth / 2;
         *             host.ports["div.0.left"] = { x: 0, y: lineY };
         *         },
         *     },
         *     paint(painter) {
         *         const y = host.box.y + lineY;    // 此时 box.y 才有意义
         *         painter.drawLine(host.box.x, y, host.box.x + host.box.w, y, { stroke: "#000", strokeWidth });
         *     },
         * };
         * ```
         */
        place?(y: number): void;
    };
}

/**
 * 一次 attachment 放置产生的完整几何
 *
 * 每次 createGeometry 都必须返回一个新结果；首轮试测可能被丢弃，只有最终结果会 paint。
 */
export interface AttachmentGeometry {
    /** 绘制与命中的真实边界；同时是外接盒和缺省的 Track 占用 */
    readonly regions: readonly LayoutRegion[];
    /** 可选的 Track 占用；缺省时直接使用 regions */
    readonly occupancy?: readonly LayoutRegion[];
    paint(painter: Painter): void;
}

/**
 * lowering 产生的无时间关系定义
 *
 * 实例只保存语义输入和一次横向准备状态，不保存最终 box、regions 或绘制几何。
 */
export interface LayoutAttachment {
    /** 相对于 Temporal 主体的绘制层；background 比内容先绘制 */
    readonly layer: "background" | "foreground";
    /** 对应的源码范围；自动生成图形可覆盖其首末宿主的源码 */
    readonly sourceSpan?: SourceSpan;
    /** 横向求解前：调整弹簧参数或注册横向布局 hook，不得改变对象/列顺序 */
    prepareHorizontal?(context: HorizontalLineView[]): void;
    createGeometry(context: AttachmentLayoutContext): AttachmentGeometry;
}

/** layoutDocument 输出的最终 attachment 快照 */
export interface PlacedAttachment {
    readonly box: Readonly<Rect>;
    readonly regions: readonly LayoutRegion[];
    /** 相对于 Temporal 主体的绘制层；background 比内容先绘制 */
    readonly layer: "background" | "foreground";
    readonly sourceSpan?: SourceSpan;
    paint(painter: Painter): void;
}

/**
 * attachment 报出的一块几何（全局坐标）
 *
 * 总是计入外接盒；同时声明 line 和 track 时，还会折算成该轨道的纵向占用
 * 只想影响画布边界、不想撑高行的图形（括线、边框）省略归属即可
 */
export type LayoutRegion = Rect & (
    | { line: number; track: Track }
    | { line?: never; track?: never }
);