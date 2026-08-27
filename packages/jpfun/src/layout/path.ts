/**
 * 路径几何：给一串绘制命令量出它实际占多大
 *
 * 放在 layout 而不是 render，是因为调用方全在布局阶段用它定尺寸和占位
 * （连音线的 regions/occupancy、符号的 box），而它本身是纯函数、不依赖任何绘制后端。
 *
 * 注意 `render/paint.ts` 里另有一份路径遍历，那是**故意**把控制点计入的——
 * 分页路由只需要一个保守超集，与这里求真实极值的目标相反，不要合并。
 */

import type { PathCommand } from "../render/types.js";
import type { Rect } from "./types.js";

/** 一维上的极值累加器 */
class Extent {
    min = Infinity;
    max = -Infinity;
    add(value: number) {
        if (value < this.min) this.min = value;
        if (value > this.max) this.max = value;
    }
}

/** 提成模块级而不是写成 cubicExtrema 内部的箭头函数：那里每次调用分配一个闭包，实测占了 96% 的耗时 */
function cubicAt(t: number, p0: number, p1: number, p2: number, p3: number, extent: Extent) {
    if (!(t > 0 && t < 1)) return;
    const u = 1 - t;
    extent.add(u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3);
}

/** 三次曲线的真实极值：导数是二次式，取区间内的驻点而不是控制点 */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number, extent: Extent) {
    extent.add(p0);
    extent.add(p3);
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;
    if (Math.abs(a) < 1e-12) {
        if (Math.abs(b) > 1e-12) cubicAt(-c / b, p0, p1, p2, p3, extent);
        return;
    }
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return;
    const root = Math.sqrt(discriminant);
    cubicAt((-b + root) / (2 * a), p0, p1, p2, p3, extent);
    cubicAt((-b - root) / (2 * a), p0, p1, p2, p3, extent);
}

function quadraticExtrema(p0: number, p1: number, p2: number, extent: Extent) {
    extent.add(p0);
    extent.add(p2);
    const denominator = p0 - 2 * p1 + p2;
    if (Math.abs(denominator) < 1e-12) return;
    const t = (p0 - p1) / denominator;
    if (!(t > 0 && t < 1)) return;
    const u = 1 - t;
    extent.add(u * u * p0 + 2 * u * t * p1 + t * t * p2);
}

/**
 * 按曲线真实极值求路径的外接矩形；空路径返回全 0
 *
 * 控制点不能直接计入：贝塞尔并不会到达控制点，用它会把弧顶高估约三分之一。
 * 这个错误在连音线和符号上各犯过一次（连音线无谓推开上方轨道、延长记号的盒子高出
 * 33% 且墨迹不居中），所以两边必须共用同一份判据。
 */
export function pathBounds(commands: readonly PathCommand[]): Rect {
    const x = new Extent();
    const y = new Extent();
    let cursorX = 0;
    let cursorY = 0;
    let startX = 0;
    let startY = 0;
    for (const command of commands) {
        if (command.op === "Z") {
            cursorX = startX;
            cursorY = startY;
            continue;
        }
        if (command.op === "C") {
            cubicExtrema(cursorX, command.cx1, command.cx2, command.x, x);
            cubicExtrema(cursorY, command.cy1, command.cy2, command.y, y);
        } else if (command.op === "Q") {
            quadraticExtrema(cursorX, command.cx, command.x, x);
            quadraticExtrema(cursorY, command.cy, command.y, y);
        } else {
            x.add(command.x);
            y.add(command.y);
            if (command.op === "M") {
                startX = command.x;
                startY = command.y;
            }
        }
        cursorX = command.x;
        cursorY = command.y;
    }
    return Number.isFinite(x.min)
        ? { x: x.min, y: y.min, w: x.max - x.min, h: y.max - y.min }
        : { x: 0, y: 0, w: 0, h: 0 };
}
