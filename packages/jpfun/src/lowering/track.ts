/**
 * 相对某条基线的纵向占用
 * 约定 top <= 0 <= bottom
 */
export interface Extent {
    top: number;    // 基线以上的边界，通常为负
    bottom: number; // 基线以下的边界，通常为正
}

/** measure 给出的单个成员的局部位置 */
export interface TrackPlacement {
    /**
     * 成员在本行实际占用的范围
     * 允许与传入值不同：例如 voices 会给本行缺席的成员补一个默认高度的空槽
     */
    extent: Extent;
    /** 成员基线相对宿主基线的偏移 */
    offset: number;
}

/**
 * 测量一组成员在分组局部坐标中的位置
 *
 * @param members 每个成员的完整子树占用；null 表示该成员本行没有任何内容
 * @param gap     本行建议的最小间隙，按占用边界算而不是基线（缺省为该行最大字号的 0.75 倍）
 * @returns       与 members 等长；null 表示该成员本行不占位
 */
export type MeasureFn = (
    members: readonly (Extent | null)[],
    gap: number,
) => readonly (TrackPlacement | null)[];

/** 宿主与分组都完成测量后，决定整个分组相对宿主基线的偏移 */
export type PlaceFn = (host: Extent, group: Extent, gap: number) => number;

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
    /** 成员在分组局部坐标中怎么排列 */
    measure: MeasureFn;
    /** 需要完整宿主占用才能定位时声明；缺省表示分组直接落在宿主基线上 */
    place?: PlaceFn;
}

/** 一组由同一个 parallel 函数派生出来的分支音轨 */
export interface TrackGroup {
    readonly laneKey: string;
    /** 只含分支音轨，不含宿主；顺序即书写顺序 */
    readonly members: Track[];
    readonly measure: MeasureFn;
    readonly place?: PlaceFn;
}

/**
 * 纵向音轨
 *
 * 一条 Track 就是谱面上的一条基线。它描述“谁挂在谁上面/下面”的静态拓扑，不保存任何布局求解结果
 * 每一行的实际纵向轴由 layout 独立解出并存在自己的表里，因此 Track 本身是可以安全共享的不可变值
 *
 * “音乐上是不是同一条轨”与“视觉上是不是同一条基线”在这里被合并成同一个对象
 * 两次出现要不要共用基线，完全由申请音轨时给出的 laneKey 决定（见 group）
 */
export class Track {
    /**
     * 挂在本轨上的分组；无需宿主定位的先合并，其余按声明顺序向外放置
     * 一个 group 理解为时间线上的一次分叉，但分叉模式相同会直接复用
     */
    readonly groups: TrackGroup[] = [];

    /** 本轨从哪条基线分叉而来，根轨为 null；新声部据此继承力度这类持续状态 */
    constructor(readonly parent: Track | null = null) {}

    /**
     * 申请一组分支音轨
     *
     * laneKey 相同的两次调用复用同一批 Track 对象，也就是共用同一条基线：
     * - stack 固定用 "stack"，让同一行里先后出现的多个 stack 落在同一条伴奏轨上，基线不抖；
     * - voices 用 `voices/成员数`，让成员数相同的块共线、成员数不同的块各自围绕宿主居中。
     *
     * 同一个 laneKey 首次注册的排列策略生效，后续调用只负责按需扩充成员数量。
     */
    group(spec: TrackArrangement, count: number): TrackGroup {
        let group = this.groups.find(group => group.laneKey === spec.laneKey);
        if (!group) {
            group = { laneKey: spec.laneKey, members: [], measure: spec.measure, place: spec.place };
            this.groups.push(group);
        }
        while (group.members.length < count) group.members.push(new Track(this));
        return group;
    }
}