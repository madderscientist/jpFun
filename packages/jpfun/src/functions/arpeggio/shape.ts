import { pathBounds } from "../../layout/path.js";
import type { Rect } from "../../layout/types.js";
import type { PathCommand } from "../../render/types.js";

const TILE_WIDTH = 54.2813;
const TILE_HEIGHT = 87.37505;
const TILE_STEP = 72.8125;
const ARROW_HEIGHT = 93.6719;
const ARROW_X = -27.4688;
const ARROW_Y = -7.9375;
const ARROW_BOTTOM = ARROW_Y + ARROW_HEIGHT;

/** MuseScore 4.7.4 导出的琶音波形块，已旋转到自上而下的局部坐标。 */
const TILE: readonly PathCommand[] = [
    { op: "M", x: 28.1406, y: 86.06255 },
    { op: "C", cx1: 28.1406, cy1: 86.06255, cx2: 30.4531, cy2: 84.07815, x: 32.7656, y: 81.42185 },
    { op: "C", cx1: 33.7656, cy1: 80.43755, cx2: 34.0938, cy2: 79.10935, x: 34.0938, y: 78.10935 },
    { op: "C", cx1: 34.0938, cy1: 77.12505, cx2: 33.7656, cy2: 76.45315, x: 33.0938, y: 75.79685 },
    { op: "L", x: 29.4531, y: 72.15625 },
    { op: "C", cx1: 28.7969, cy1: 71.50005, cx2: 28.4688, cy2: 70.82815, x: 28.4688, y: 70.17185 },
    { op: "C", cx1: 28.4688, cy1: 68.84375, cx2: 29.4531, cy2: 68.18755, x: 29.4531, y: 68.18755 },
    { op: "C", cx1: 29.4531, cy1: 68.18755, cx2: 47.6563, cy2: 47.00005, x: 50.6406, y: 43.68755 },
    { op: "C", cx1: 53.2969, cy1: 40.04685, cx2: 54.2813, cy2: 36.40625, x: 54.2813, y: 33.09375 },
    { op: "C", cx1: 54.2813, cy1: 26.14065, cx2: 50.3125, cy2: 19.85935, x: 47.3281, y: 17.21875 },
    { op: "L", x: 31.4375, y: 1.32812 },
    { op: "C", cx1: 30.4531, cy1: 0.32812, cx2: 29.7969, cy2: 0, x: 28.7969, y: 0 },
    { op: "C", cx1: 27.1406, cy1: 0, cx2: 25.8125, cy2: 1.32812, x: 25.8125, y: 1.32812 },
    { op: "C", cx1: 25.8125, cy1: 1.32812, cx2: 23.5, cy2: 3.3125, x: 21.1875, y: 5.95312 },
    { op: "C", cx1: 20.1875, cy1: 6.95313, cx2: 19.8594, cy2: 7.9375, x: 19.8594, y: 8.9375 },
    { op: "C", cx1: 19.8594, cy1: 9.92188, cx2: 20.1875, cy2: 10.59375, x: 20.8594, y: 11.25 },
    { op: "L", x: 24.5, y: 14.89063 },
    { op: "C", cx1: 25.1563, cy1: 15.5625, cx2: 25.4844, cy2: 16.21875, x: 25.4844, y: 16.875 },
    { op: "C", cx1: 25.4844, cy1: 18.20315, cx2: 24.5, cy2: 19.20315, x: 24.5, y: 19.20315 },
    { op: "C", cx1: 24.5, cy1: 19.20315, cx2: 6.625, cy2: 40.37505, x: 3.64063, y: 43.68755 },
    { op: "C", cx1: 1, cy1: 47.32815, cx2: 0, cy2: 50.96875, x: 0, y: 54.28125 },
    { op: "C", cx1: 0, cy1: 61.23435, cx2: 3.96875, cy2: 67.51565, x: 6.95313, y: 70.17185 },
    { op: "L", x: 22.8438, y: 86.06255 },
    { op: "C", cx1: 23.8281, cy1: 87.04685, cx2: 24.8281, cy2: 87.37505, x: 25.4844, y: 87.37505 },
    { op: "C", cx1: 27.1406, cy1: 87.37505, cx2: 28.1406, cy2: 86.06255, x: 28.1406, y: 86.06255 },
];

/** MuseScore 下行琶音的末端箭头轮廓，坐标方向同 TILE。 */
const DOWN_ARROW: readonly PathCommand[] = [
    { op: "M", x: 111.8751, y: 21.5156 },
    { op: "C", cx1: 112.5313, cy1: 20.1875, cx2: 113.5313, cy2: 18.2031, x: 113.5313, y: 16.875 },
    { op: "C", cx1: 113.5313, cy1: 12.23438, cx2: 109.8907, cy2: 8.9375, x: 105.2501, y: 8.9375 },
    { op: "C", cx1: 103.9219, cy1: 8.9375, cx2: 101.6094, cy2: 9.26563, x: 100.2813, y: 10.25 },
    { op: "L", x: 72.1563, y: 31.7656 },
    { op: "L", x: 72.1563, y: 28.4531 },
    { op: "C", cx1: 72.1563, cy1: 16.54688, cx2: 66.8594, cy2: 8.26563, x: 58.2501, y: 0.98437 },
    { op: "C", cx1: 57.2657, cy1: 0.32812, cx2: 55.9376, cy2: 0, x: 55.2657, y: 0 },
    { op: "C", cx1: 53.6251, cy1: 0, cx2: 52.9532, cy2: 0.98437, x: 52.9532, y: 0.98437 },
    { op: "C", cx1: 51.6251, cy1: 2.3125, cx2: 49.3126, cy2: 4.29687, x: 48.3282, y: 5.625 },
    { op: "C", cx1: 47.3282, cy1: 6.9375, cx2: 47.0001, cy2: 7.9375, x: 47.0001, y: 8.9375 },
    { op: "C", cx1: 47.0001, cy1: 9.92188, cx2: 47.3282, cy2: 10.57813, x: 47.6563, y: 11.25 },
    { op: "C", cx1: 49.9688, cy1: 13.5625, cx2: 50.9688, cy2: 16.21875, x: 50.9688, y: 18.8594 },
    { op: "C", cx1: 50.9688, cy1: 24.8125, cx2: 46.3282, cy2: 30.1094, x: 41.0469, y: 30.1094 },
    { op: "C", cx1: 39.3907, cy1: 30.1094, cx2: 37.7344, cy2: 29.4531, x: 36.4063, y: 28.4531 },
    { op: "L", x: 12.9063, y: 10.57813 },
    { op: "C", cx1: 11.5782, cy1: 9.59375, cx2: 9.5938, cy2: 8.9375, x: 7.9375, y: 8.9375 },
    { op: "C", cx1: 3.6407, cy1: 8.9375, cx2: 0, cy2: 12.57813, x: 0, y: 16.875 },
    { op: "C", cx1: 0, cy1: 18.2031, cx2: 0.6563, cy2: 20.1875, x: 1.3125, y: 21.5156 },
    { op: "L", x: 49.9688, y: 90.3594 },
    { op: "C", cx1: 51.2969, cy1: 92.3438, cx2: 54.2813, cy2: 93.6719, x: 56.5938, y: 93.6719 },
    { op: "C", cx1: 58.9063, cy1: 93.6719, cx2: 61.8907, cy2: 92.3438, x: 63.2188, y: 90.3594 },
    { op: "L", x: 111.8751, y: 21.5156 },
];

function appendShape(
    output: PathCommand[],
    shape: readonly PathCommand[],
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
    scale: number,
    reverse: boolean,
) {
    const x = (value: number) => offsetX + (reverse ? width - value : value) * scale;
    const y = (value: number) => offsetY + (reverse ? height - value : value) * scale;
    for (const command of shape) {
        if (command.op === "Z") output.push(command);
        else if (command.op === "C") output.push({
            op: "C",
            cx1: x(command.cx1), cy1: y(command.cy1),
            cx2: x(command.cx2), cy2: y(command.cy2),
            x: x(command.x), y: y(command.y),
        });
        else if (command.op === "Q") output.push({
            op: "Q",
            cx: x(command.cx), cy: y(command.cy),
            x: x(command.x), y: y(command.y),
        });
        else output.push({ op: command.op, x: x(command.x), y: y(command.y) });
    }
}

/** 按 MuseScore 的原始重叠比例铺满指定高度，并一次性返回最终边界。 */
export function prepareArpeggioShape(
    height: number,
    em: number,
    direction: "" | "up" | "down",
): { commands: PathCommand[]; bounds: Rect } {
    const arrow = direction === "up" || direction === "down";
    const segments = Math.max(1, Math.round(height / (em * 0.3)));
    const regularCount = arrow ? Math.max(0, segments - 1) : segments;
    const naturalHeight = !arrow
        ? TILE_HEIGHT + TILE_STEP * (regularCount - 1)
        : ARROW_BOTTOM + TILE_STEP * regularCount;
    const scale = height / naturalHeight;
    const commands: PathCommand[] = [];
    for (let index = 0; index < regularCount; index++) {
        appendShape(commands, TILE, TILE_WIDTH, TILE_HEIGHT, 0, index * TILE_STEP * scale, scale, direction === "");
    }
    if (arrow) {
        appendShape(
            commands,
            DOWN_ARROW,
            113.5313,
            ARROW_HEIGHT,
            ARROW_X * scale,
            (regularCount * TILE_STEP + ARROW_Y) * scale,
            scale,
            false,
        );
    }
    const bounds = pathBounds(commands);
    if (direction !== "up") return { commands, bounds };
    const rotated: PathCommand[] = commands.map(command => command.op === "Z" ? command : command.op === "C" ? {
        op: "C",
        cx1: bounds.x + bounds.w - (command.cx1 - bounds.x), cy1: height - command.cy1,
        cx2: bounds.x + bounds.w - (command.cx2 - bounds.x), cy2: height - command.cy2,
        x: bounds.x + bounds.w - (command.x - bounds.x), y: height - command.y,
    } : command.op === "Q" ? {
        op: "Q",
        cx: bounds.x + bounds.w - (command.cx - bounds.x), cy: height - command.cy,
        x: bounds.x + bounds.w - (command.x - bounds.x), y: height - command.y,
    } : {
        op: command.op,
        x: bounds.x + bounds.w - (command.x - bounds.x), y: height - command.y,
    });
    return {
        commands: rotated,
        bounds: { x: bounds.x, y: height - bounds.y - bounds.h, w: bounds.w, h: bounds.h },
    };
}
