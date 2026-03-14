/**
 * 源码区间（左闭右开）
 */
export interface SourceSpan {
    start: number;
    end: number;
}

/**
 * 有单位的长度值
 */
export interface LengthValue {
    value: number;
    unit: "em" | "px";
};