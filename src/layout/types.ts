import type { GlyphProvider, Painter } from "../render/types.js";

/**
 * 一个排版对象的完整矩形和两个对齐基准
 *
 * prepareLayout 负责填写 w、h、anchor、baseline
 * layout 负责原地修改 x、y
 * 所有字段保持扁平，布局器可以直接持有并修改这个对象的引用
 */
export interface LayoutBox {
    x: number;          // 最终左边界坐标
    y: number;          // 最终上边界坐标
    w: number;          // 对象需要占用的完整宽度
    h: number;          // 对象需要占用的完整高度
    anchor: number;     // 横向对齐点到盒子左边界的距离
    baseline: number;   // 谱面行视觉对齐轴到盒子上边界的距离
    // 下面两个属性目的是让“#2./”只在2下绘制减时线，而不是绘制在整个box的底边
    leftExtent?: number; // 从 anchor 到核心有效左边界，缺省为 anchor
    rightExtent?: number;// 从 anchor 到核心有效右边界，缺省为 w-anchor
}

/**
 * 横向弹簧的物理属性 含义见排版模型的文档
 */
export interface ElementConfig {
    alpha_L?: number;   // 左侧固有弹性间距系数
    alpha_R?: number;   // 增加该值会增加弹簧长度
    mu_L?: number;      // 左侧重叠阻尼惩罚系数
    mu_R?: number;      // 增加该值可以减少“穿模”
    beta_L?: number;    // 左侧弹性系数
    beta_R?: number;    // 建议不设置beta 依赖 layoutElement() 自动计算
}


export interface TimeLineEvent {
    t: number; // 事件发生的时间点
    T: number; // 事件的持续时间
    track: any;// 事件所属轨道的任意标识符
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
 * glyphs 同时服务于固有尺寸计算和最终绘制
 * em 是没有显式字号时使用的基础尺寸
 */
export interface LayoutPrepareContext {
    glyphs: GlyphProvider;   // 测量固定 glyph 与任意文本的统一来源
    em: number;              // 没有显式字号时使用的基础尺寸
    decorationHandlers: ReadonlyMap<string, LayoutDecorationHandler>; // addon key 到装饰 handler 的注册表
}

/**
 * 辅助排版阶段额外需要的页面信息
 *
 * getBaseline 在横向阶段尚未求出结果时返回 undefined
 * 在最终纵向阶段返回指定谱面行和轨道的绝对 baseline
 */
export interface LayoutPassContext extends LayoutPrepareContext {
    width: number;       // 当前谱面行允许使用的横向宽度
    originX: number;     // 当前页面坐标系的横向起点
    getBaseline(line: number, track: unknown): number | undefined; // 查询谱面行和轨道的最终 baseline
}


/**
 * 每个可以进入排版或绘制阶段的对象都满足这个接口
 *
 * TemporalNodeBase 会直接实现它
 * over 的内部节点也继续使用同一个接口，不需要另一套对象体系
 */
export interface LayoutObject {
    box: LayoutBox;                         // 布局器原地读写的完整几何盒
    elementConfig: ElementConfig;           // 独立于几何盒的横向弹簧参数
    ports: Record<string, LayoutPoint>;      // 关系对象查询的命名局部坐标
    /** prepare 阶段生成、place 后冻结、paint 后失效的本轮装饰实例 */
    decorations: LayoutDecoration[];
    prepareLayout(context: LayoutPrepareContext): void;   // 生成主体固有尺寸
    finalizeLayout?(context: LayoutPrepareContext): void; // 装饰排完后发布最终几何
    onPlaced?(): void;                      // x 或 y 改变后同步复合子对象
    paint(painter: Painter): void;           // 只读最终几何并发出绘制命令
}

/**
 * 相对于对象 LayoutBox 左上角的局部坐标
 * tie、beam 等关系函数通过命名端口获取几何位置
 */
export interface LayoutPoint {
    x: number;          // 相对于所属 LayoutBox 左边界的横坐标
    y: number;          // 相对于所属 LayoutBox 上边界的纵坐标
}

/**
 * 一次 layout 中生成并保留到 paint 阶段的装饰对象
 *
 * 实例有两种来源：LayoutObject.prepareLayout 可以直接加入；addon 对应的 LayoutDecorationHandler 也可以在主体 prepareLayout 后创建
 * 它可以在返回实例前调整 target.box，例如 dot handler 先扩张主体宽度。
 *
 * 通用部分只有 paint：主体绘制完成后，引擎调用它绘制当前装饰。
 *
 * belowOrder/belowGap/belowHeight/place 组成可选的“主体下方空间”子协议。
 * 只有声明 belowOrder 才会进入下方空间管理。该协议只向下扩张 box.h，不管理主体上方空间
 * 上方内容若会改变主体 baseline 或内部绘制坐标，应由具体 LayoutObject 在 prepareLayout 中处理。
 *
 * 当前内置示例：
 * - dot：handler 生成只负责横向扩宽和绘制的装饰，不声明 belowOrder；
 * - div：handler 生成减时线装饰，使用 belowOrder=0，排在主体下方最内层；
 * - note 下八度点：prepareLayout 直接加入装饰，使用 belowOrder=100，排在减时线之后；
 * - note 上八度点不使用 LayoutDecoration，而是主体 prepareLayout 的一部分。
 *
 * LayoutDecoration 不是 addon 语义本身。实例可以用闭包保存本次测量参数和 place 结果，因此必须由 LayoutObject.decorations 持有到 paint 结束；下一次 layout 会重新创建。
 */
export interface LayoutDecoration {
    paint(painter: Painter, target: LayoutObject): void; // 只读取冻结几何

    // 可选：主体下方空间管理；只有 belowOrder 存在时生效
    belowOrder?: number;    // 存在时加入主体下方空间管理 越小越靠近主体，相同值保持注册顺序
    belowGap?: number;      // 与主体或前一个下方装饰的间隔，可以为负数
    belowHeight?: number;   // 下方区域占用高度，布局时强制为非负数
    place?(target: LayoutObject, y: number): void; // 接收相对于 target.box 顶部的下方区域起点
}

/** addon 装饰工厂；在主体 prepareLayout 后调用，可以先调整 target.box */
export type LayoutDecorationHandler = (
    target: LayoutObject,
    value: unknown,
    context: LayoutPrepareContext,
) => LayoutDecoration | null;

/**
 * 不占用时间、附着于一个或多个主体对象的独立排版对象
 *
 * tie、beam、box 和歌词都使用这个接口
 * 它们不进入时间列，但可以拥有自己的边界、申报纵向占用，并在主体横向或纵向位置确定后更新几何
 */
export interface LayoutAttachment {
    box: LayoutBox; // attachment 自己的最终外接矩形
    layer: "background" | "foreground"; // 相对于 Temporal 主体的绘制层 "background"比内容先绘制
    verticalExtents?: LayoutVerticalExtent[];   // 向各轨道申报的纵向占用
    layoutAfterHorizontal?(context: LayoutPassContext): void; // 横坐标确定后计算相对几何
    layoutAfterVertical?(context: LayoutPassContext): void;   // baseline 确定后计算绝对几何
    paint(painter: Painter): void;  // 只读最终几何并发出绘制命令
}

/** attachment 对某一谱面行中某一轨道提出的纵向占用范围 */
export interface LayoutVerticalExtent {
    line: number;   // 占用范围所属谱面行
    track: unknown; // 占用范围所属轨道
    top: number;    // 相对于该轨道 baseline 的最上边界
    bottom: number; // 相对于该轨道 baseline 的最下边界
}