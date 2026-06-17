export interface LayoutBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface TimeLineEvent {
    t: number; // 事件发生的时间点
    T: number; // 事件的持续时间
}