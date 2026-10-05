import type { Painter, TextMeasurer } from "../render/types.js";
import type { Track } from "../lowering/track.js";
import type { Fraction } from "../fraction.js";
import type { TemporalNodeBase, VisualTemporalNode } from "../functions/temporal.js";
import type { SourceSpan } from "../parser/types.js";
import type { HorizontalLayoutHook } from "./model.js";
import type { LoweringAttachment, LoweringContent } from "../lowering/types.js";

/** 轴对齐矩形，是所有排版几何的公共部分 */
export interface Rect {
    x: number;  // 左边界坐标
    y: number;  // 上边界坐标
    w: number;  // 完整占用宽度
    h: number;  // 完整占用高度
}

/**
 * 相对某条基线的纵向占用
 * 约定 top <= 0 <= bottom
 */
export interface Extent {
    top: number;    // 基线以上的边界，通常为负
    bottom: number; // 基线以下的边界，通常为正
}

/**
 * 一个排版对象的定位矩形和两个对齐基准
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
    fillRatio: number;   // 自然宽度达到版心比例后撑满
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
    /**
     * 按正文规则排版复合体内部的子域，排完后它就是一个刚性块
     *
     * columns 非空，外层表示先后、内层是同列的不同声部，成员位于 root 的 Track 树上。
     * 子域附件包括 attachments 里没有端点的内容附件，以及端点全部落在成员上的关系附件，后者写在哪里都算。
     * 它们在块内测量并参与局部重排，最终几何随块平移；外层只看得到 owner，私有轨归入 owner 所在的轨。
     *
     * 由 layoutDocument 在主体准备阶段注入；调用方创建的上下文没有它。
     */
    layoutSubdomain?(
        owner: TemporalNodeBase,
        columns: readonly (readonly VisualTemporalNode[])[],
        root: Track,
        attachments: readonly LoweringAttachment[],
    ): SubdomainLayout;
}

/** 子域块的尺寸与成员位置，坐标以块的左上角为原点 */
export interface SubdomainLayout {
    width: number;
    height: number;
    /** 与 columns.flat() 一一对应，不含成员 onPlaced 追加的平移 */
    positions: readonly LayoutPoint[];
}

export type LayoutRange = readonly [from: number, to: number]
    | readonly [from: LayoutHost, to: LayoutHost];

/** attachment 根据当前视觉轴生成几何时需要的完整页面信息 */
export interface AttachmentLayoutContext extends LayoutPrepareContext {
    /** 占用测量使用布局位置，最终绘制才应用后置平移 */
    readonly layoutOnly?: boolean;
    width: number;      // 整篇可用的内容宽（页宽减左右边距），与行无关
    originX: number;    // 内容区的左边界，即页面左边距
    pages: readonly Rect[]; // 本轮分页得到的纸张边界 page函数用于获取页码内容和位置
    lines: readonly Omit<HorizontalLineView, "registerHorizontalLayoutHook">[]; // 已完成横向求解的时间列拓扑与主体
    getVisualAxis(line: number, track: Track): number;
    /** 只包含可见主体的轴局部占用（top 通常为负），不受 attachment 或最终分页坐标影响 */
    getHostExtent(line: number, track: Track): Readonly<Extent> | undefined;
    /** 获取本行范围内的列；对象端点沿 foldedInto 上溯到本域的列 */
    getRangeColumns(line: number, range?: LayoutRange, track?: Track): readonly (readonly LayoutHost[])[];
    /**
     * 本行闭区间内的已定占用；全轨返回按 Track 分组的 Map，单轨直接返回 Extent 或 undefined
     *
     * 数字端点表示本域的列下标；对象端点沿 foldedInto 上溯到本域的列，跨行对象区间自动截取本行部分。
     * 子域对外是一个主体，正文查询不进入它的内部。
     * 主体按查询列筛选；attachment 按这些列最终盒子的横向范围筛选，并遵守 track 过滤。
     * attachment 部分与 getAttachmentBox 同一条可见性规则：只看得见比自己先注册的，
     * 也就是「后声明的排在外层」。避让型 attachment 用它把自己排到已有内容之外。
     * 省略列号表示整行，供跨行 attachment 查询没有可见列的中间行。
     */
    getRangeExtents(
        line: number,
        columns?: LayoutRange,
    ): ReadonlyMap<Track, Readonly<Extent>>;
    getRangeExtents(
        line: number,
        columns: LayoutRange | undefined,
        track: Track,
    ): Readonly<Extent> | undefined;
    /** 读取本轮已完成的 attachment 边界；分组在 endLoweringGroup 才注册，因而组内对象必然排在分组之前 */
    getAttachmentBox(attachment: LayoutAttachment): Readonly<Rect>;
    /** 读取已测附件的有效占用，保留显式空数组；尚未测量时返回 undefined */
    getAttachmentOccupancy(attachment: LayoutAttachment): readonly LayoutRegion[] | undefined;
    /** 内容的实际几何并集；只包含作用域内主体与此前已测附件，不代表撑行占用 */
    getContentBounds(content: LoweringContent): Readonly<Rect> | undefined;
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
    readonly mergeKey: number;  // 为了识别 ANCHOR 而留的
    readonly layoutLine: number;
    readonly ast: { readonly size: number }; // 具体视觉函数在 parse 时冻结 px 字号
}

/**
 * 一条谱面行的横向拓扑与求解扩展点
 *
 * 时间列拓扑不可改变，但其中的 host 仍可写；
 * 调用方可以调整 springConfig，也可以注册在 LayoutElement 归一化后执行的横向布局
 */
export interface HorizontalLineView {
    /** 谱面行号，与 host.layoutLine 同一坐标系 */
    readonly index: number;
    /** 本行按横向顺序排列的可见时间列 */
    readonly columns: readonly (readonly LayoutHost[])[];
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
 * 由引擎统一分配上下空间，place 的坐标相对主体定位矩形
 *
 * paint 可省略，此时只预留空间，不进入内容边界
 *
 * 当前内置示例：
 * - dot：handler 生成只负责横向扩宽和绘制的装饰，不声明 below；
 * - div：handler 生成减时线装饰，使用 order=0，排在主体下方最内层；
 * - note 八度点：prepareLayout 直接加入装饰，使用 order=100
 *
 * LayoutDecoration 不是 addon 语义本身。实例可以用闭包保存本次测量参数和 place 结果，因此必须由 Temporal.decorations 持有到当前 paint 结束。
 */
export interface LayoutDecoration {
    paint?(painter: Painter): void; // 只读取冻结几何
    above?: LayoutDecorationSpace;
    below?: LayoutDecorationSpace;
}

/** 上下装饰共用由内向外的排列协议 */
export interface LayoutDecorationSpace {
    order: number;      // 越小越靠近主体，相同值保持注册顺序
    gap?: number;       // 与主体或前一个装饰的间隔，可以为负数
    height?: number;    // 区域占用高度，布局时强制为非负数
    /**
     * y 是区域顶边相对 host.box 顶部的坐标，上方区域通常为负数
     * 只保存局部几何并发布端口，不读写正在排列的 box.h 或尚未放置的 box.y
     * 绘制时再加 host.box.x/y，纯留白可以省略 place
     */
    place?(y: number): void;
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
export interface LayoutAttachment extends LoweringAttachment {
    /** 后置平移仅影响绘制，不参与占用求解 */
    placementOffset?: LayoutPoint;
    /** 几何端点；端点全部落在同一子域的成员上时，附件属于该子域。不表示内容包含或播放端点投影 */
    readonly endPoints?: readonly TemporalNodeBase[];
    /** 相对于 Temporal 主体的绘制层；background 比内容先绘制 */
    readonly layer: "background" | "foreground";
    /** 对应的源码范围；自动生成图形可覆盖其首末宿主的源码 */
    readonly sourceSpan?: SourceSpan;
    /**
     * 横向求解前：可测量资源、调整弹簧参数或注册横向布局 hook，不得改变对象/列顺序
     *
     * 此时 box 的固有尺寸 w/h/anchor/visualAxis 已是终值，只有 x/y 未定
     */
    prepareHorizontal?(lines: HorizontalLineView[], context: LayoutPrepareContext): void;
    createGeometry(context: AttachmentLayoutContext): AttachmentGeometry;
}
export function isLayoutAttachment(attachment: LoweringAttachment): attachment is LayoutAttachment {
    return typeof (attachment as Partial<LayoutAttachment>).createGeometry === "function";
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