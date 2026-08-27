// 把一个 SVG 文件转成 @symbol 的 shapes 字面量，直接粘进 src/functions/symbol/symbols/<name>.ts
//
//   node scripts/svg-to-symbol.mjs path/to/glyph.svg
//
// 只认顶层的 <path> 与 <circle>，不处理 transform、<g>、<use> 和弧线 A 命令；
// 遇到这些请先在矢量编辑器里展平并把弧线转成曲线。

import { readFileSync } from "node:fs";

const TOKEN = /[A-Za-z]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/gi;
const isCommand = token => /^[A-Za-z]$/.test(token);
const num = value => Number(value.toFixed(5));

function parsePath(data) {
    const tokens = data.match(TOKEN) ?? [];
    const out = [];
    let index = 0;
    let command = "";
    let x = 0, y = 0, startX = 0, startY = 0;
    // S / T 的隐含控制点是上一条曲线控制点关于当前点的镜像
    let lastControl = null;

    const next = () => {
        const token = tokens[index++];
        if (token === undefined || isCommand(token)) throw new Error(`path 数据在第 ${index} 个 token 处缺少数值`);
        return Number(token);
    };

    while (index < tokens.length) {
        if (isCommand(tokens[index])) command = tokens[index++];
        if (!command) throw new Error("path 数据必须以命令字母开头");
        const relative = command === command.toLowerCase();
        const kind = command.toUpperCase();
        if (kind === "A") throw new Error("不支持弧线 A，请先在编辑器里转成三次曲线");

        if (kind === "Z") {
            out.push({ op: "Z" });
            x = startX; y = startY;
            lastControl = null;
            command = "";
            continue;
        }

        let first = true;
        while (index < tokens.length && !isCommand(tokens[index])) {
            const baseX = x, baseY = y;
            const abs = (value, base) => relative ? base + value : value;

            if (kind === "M" || kind === "L" || kind === "H" || kind === "V") {
                if (kind === "H") x = abs(next(), baseX);
                else if (kind === "V") y = abs(next(), baseY);
                else { x = abs(next(), baseX); y = abs(next(), baseY); }
                const op = kind === "M" && first ? "M" : "L";
                out.push({ op, x: num(x), y: num(y) });
                if (op === "M") { startX = x; startY = y; }
                lastControl = null;
            } else if (kind === "C" || kind === "S") {
                let cx1, cy1;
                if (kind === "S") {
                    cx1 = lastControl ? 2 * baseX - lastControl.x : baseX;
                    cy1 = lastControl ? 2 * baseY - lastControl.y : baseY;
                } else {
                    cx1 = abs(next(), baseX);
                    cy1 = abs(next(), baseY);
                }
                const cx2 = abs(next(), baseX);
                const cy2 = abs(next(), baseY);
                x = abs(next(), baseX);
                y = abs(next(), baseY);
                out.push({ op: "C", cx1: num(cx1), cy1: num(cy1), cx2: num(cx2), cy2: num(cy2), x: num(x), y: num(y) });
                lastControl = { x: cx2, y: cy2 };
            } else if (kind === "Q" || kind === "T") {
                let cx, cy;
                if (kind === "T") {
                    cx = lastControl ? 2 * baseX - lastControl.x : baseX;
                    cy = lastControl ? 2 * baseY - lastControl.y : baseY;
                } else {
                    cx = abs(next(), baseX);
                    cy = abs(next(), baseY);
                }
                x = abs(next(), baseX);
                y = abs(next(), baseY);
                out.push({ op: "Q", cx: num(cx), cy: num(cy), x: num(x), y: num(y) });
                lastControl = { x: cx, y: cy };
            } else {
                throw new Error(`不支持的 path 命令: ${command}`);
            }
            first = false;
        }
    }
    return out;
}

function attributes(tag) {
    const result = {};
    for (const [, key, value] of tag.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) result[key] = value;
    return result;
}

function styleOf(attrs) {
    const parts = [];
    const fill = attrs.fill === "none" ? undefined : attrs.fill ?? "#000";
    const stroke = attrs.stroke === "none" ? undefined : attrs.stroke;
    if (fill) parts.push(`fill: ${JSON.stringify(fill)}`);
    if (stroke) {
        parts.push(`stroke: ${JSON.stringify(stroke)}`);
        parts.push(`strokeWidth: ${Number(attrs["stroke-width"] ?? 1)}`);
    }
    return `{ ${parts.join(", ")} }`;
}

const file = process.argv[2];
if (!file) {
    console.error("用法: node scripts/svg-to-symbol.mjs path/to/glyph.svg");
    process.exit(1);
}

const svg = readFileSync(file, "utf8");
if (/<(g|use)[\s>]/.test(svg) || /\stransform\s*=/.test(svg)) {
    console.error("检测到 <g> / <use> / transform，请先在矢量编辑器里展平");
    process.exit(1);
}

const shapes = [];
for (const [tag] of svg.matchAll(/<path\b[^>]*>/g)) {
    const attrs = attributes(tag);
    if (!attrs.d) continue;
    const commands = parsePath(attrs.d)
        .map(c => c.op === "Z"
            ? `                { op: "Z" },`
            : c.op === "C"
                ? `                { op: "C", cx1: ${c.cx1}, cy1: ${c.cy1}, cx2: ${c.cx2}, cy2: ${c.cy2}, x: ${c.x}, y: ${c.y} },`
                : c.op === "Q"
                    ? `                { op: "Q", cx: ${c.cx}, cy: ${c.cy}, x: ${c.x}, y: ${c.y} },`
                    : `                { op: "${c.op}", x: ${c.x}, y: ${c.y} },`)
        .join("\n");
    shapes.push(`        {\n            path: [\n${commands}\n            ],\n            style: ${styleOf(attrs)},\n        },`);
}
for (const [tag] of svg.matchAll(/<circle\b[^>]*>/g)) {
    const attrs = attributes(tag);
    shapes.push(`        {\n            circle: { cx: ${num(Number(attrs.cx ?? 0))}, cy: ${num(Number(attrs.cy ?? 0))}, r: ${num(Number(attrs.r ?? 0))} },\n            style: ${styleOf(attrs)},\n        },`);
}

if (shapes.length === 0) {
    console.error("没有找到任何 <path> 或 <circle>");
    process.exit(1);
}

console.log(`    shapes: [\n${shapes.join("\n")}\n    ],`);
