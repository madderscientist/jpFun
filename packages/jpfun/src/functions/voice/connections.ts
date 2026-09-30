import { ErrorDiagnostic } from "../../diagnostic.js";
import { pathBounds } from "../../layout/path.js";
import type { SourceSpan } from "../ASTtypes.js";
import type { PathCommand } from "../../render/types.js";

export const CURVED_BRACE_COMMANDS: readonly PathCommand[] = [
    { op: "M", x: 2.98438, y: -165.5 },
    { op: "C", cx1: 8.9375, cy1: -171.781, cx2: 20.5156, cy2: -184.688, x: 20.5156, y: -208.531 },
    { op: "C", cx1: 20.5156, cy1: -238.641, cx2: 7.60938, cy2: -269.094, x: 7.60938, y: -287.969 },
    { op: "C", cx1: 7.60938, cy1: -308.156, cx2: 19.2031, cy2: -327.016, x: 19.8594, y: -327.688 },
    { op: "C", cx1: 19.8594, cy1: -328.016, cx2: 19.8594, cy2: -328.016, x: 19.8594, y: -328.344 },
    { op: "C", cx1: 19.8594, cy1: -328.672, cx2: 19.8594, cy2: -329, x: 19.5313, y: -329.344 },
    { op: "C", cx1: 19.2031, cy1: -329.344, cx2: 18.5313, cy2: -329.344, x: 18.2031, y: -328.672 },
    { op: "C", cx1: 17.875, cy1: -328.344, cx2: 0, cy2: -310.469, x: 0, y: -283.328 },
    { op: "C", cx1: 0, cy1: -254.203, cx2: 11.5781, cy2: -233.688, x: 11.5781, y: -195.625 },
    { op: "C", cx1: 11.5781, cy1: -188.328, cx2: 8.60938, cy2: -176.75, x: 0.328125, y: -166.484 },
    { op: "C", cx1: 0, cy1: -166.484, cx2: 0, cy2: -165.828, x: 0, y: -165.5 },
    { op: "C", cx1: -0.328125, cy1: -165.172, cx2: 0, cy2: -164.828, x: 0.328125, y: -164.5 },
    { op: "C", cx1: 8.60938, cy1: -154.25, cx2: 11.5781, cy2: -142.656, x: 11.5781, y: -135.375 },
    { op: "C", cx1: 11.5781, cy1: -97.3125, cx2: 0, cy2: -76.7969, x: 0, y: -47.6563 },
    { op: "C", cx1: 0, cy1: -20.8594, cx2: 17.875, cy2: -2.64063, x: 18.2031, y: -2.3125 },
    { op: "C", cx1: 18.5313, cy1: -1.65625, cx2: 19.2031, cy2: -1.32813, x: 19.5313, y: -1.65625 },
    { op: "C", cx1: 19.8594, cy1: -1.98438, cx2: 20.1875, cy2: -2.3125, x: 19.8594, y: -2.64063 },
    { op: "C", cx1: 19.8594, cy1: -2.64063, cx2: 19.8594, cy2: -2.98438, x: 19.8594, y: -3.3125 },
    { op: "C", cx1: 19.2031, cy1: -3.96875, cx2: 7.60938, cy2: -22.8438, x: 7.60938, y: -43.0313 },
    { op: "C", cx1: 7.60938, cy1: -61.8906, cx2: 20.5156, cy2: -92.3438, x: 20.5156, y: -122.469 },
    { op: "C", cx1: 20.5156, cy1: -146.625, cx2: 8.9375, cy2: -159.203, x: 2.98438, y: -165.5 },
    { op: "Z" },
];

export const CURVED_BRACE_BOUNDS = pathBounds(CURVED_BRACE_COMMANDS);

/** 方括线端钩，以粗竖线宽度为单位，绘制时上下镜像 */
export const BRACKET_HOOK_REACH = 2.33;
export const BRACKET_HOOK_DROP = 1.17;
const BRACKET_HOOK_BASE = 0.34;
export const BRACKET_HOOK_COMMANDS: readonly PathCommand[] = [
    { op: "M", x: 0, y: 0 },
    { op: "L", x: 0, y: -BRACKET_HOOK_BASE },
    {
        op: "C",
        cx1: BRACKET_HOOK_REACH * 0.421, cy1: -BRACKET_HOOK_BASE + BRACKET_HOOK_DROP * 0.077,
        cx2: BRACKET_HOOK_REACH * 0.733, cy2: -BRACKET_HOOK_BASE + BRACKET_HOOK_DROP * 0.346,
        x: BRACKET_HOOK_REACH, y: -BRACKET_HOOK_BASE + BRACKET_HOOK_DROP,
    },
    { op: "L", x: BRACKET_HOOK_REACH * 0.929, y: -BRACKET_HOOK_BASE + BRACKET_HOOK_DROP },
    {
        op: "C",
        cx1: BRACKET_HOOK_REACH * 0.696, cy1: -BRACKET_HOOK_BASE + BRACKET_HOOK_DROP * 0.535,
        cx2: BRACKET_HOOK_REACH * 0.328, cy2: -BRACKET_HOOK_BASE + BRACKET_HOOK_DROP * 0.352,
        x: 0, y: 0,
    },
    { op: "Z" },
];

export type ConnectionKind = "brace" | "bracket";

export interface ConnectionSpec {
    kind: ConnectionKind;
    from?: number;
    to?: number;
}

/** 开放端点在声部收集完毕后补全 */
export type VoiceConnection = Required<ConnectionSpec>;

function invalidConnection(span: SourceSpan) {
    return new ErrorDiagnostic(
        "E_VOICES_CONNECT",
        '@voices 的 connect 必须是 [起点-终点] 或 {起点-终点} 的组合；端点可省略，否则须为有效声部编号。空字符串表示只有连谱线。',
        span,
    );
}

export function parseConnections(value: string, span: SourceSpan): ConnectionSpec[] {
    const source = value.trim();
    // 粘连匹配必须消费整串，不能跳过非法字符
    // 非空数字与其后空白一起可选，避免省略端点时重复回溯
    const pattern = /\s*([\[{])\s*(?:(\d+)\s*)?-\s*(?:(\d+)\s*)?([\]}])\s*/y;
    const result: ConnectionSpec[] = [];
    while (pattern.lastIndex < source.length) {
        const match = pattern.exec(source);
        if (!match || match[4] !== (match[1] === "[" ? "]" : "}")) throw invalidConnection(span);
        const from = match[2] ? Number(match[2]) : undefined;
        const to = match[3] ? Number(match[3]) : undefined;
        for (const endpoint of [from, to]) {
            if (endpoint !== undefined && (!Number.isSafeInteger(endpoint) || endpoint < 1)) {
                throw invalidConnection(span);
            }
        }
        if (from !== undefined && to !== undefined && from > to) throw invalidConnection(span);
        result.push({ kind: match[1] === "[" ? "bracket" : "brace", from, to });
    }
    return result;
}

export function resolveConnections(specs: readonly ConnectionSpec[], count: number, span: SourceSpan): VoiceConnection[] {
    return specs.map(({ kind, from = 1, to = count }) => {
        if (from > to || to > count) throw invalidConnection(span);
        return { kind, from, to };
    });
}

export function serializeConnections(specs: readonly ConnectionSpec[]): string {
    return specs.map(({ kind, from, to }) => {
        const range = `${from ?? ""}-${to ?? ""}`;
        return kind === "brace" ? `{${range}}` : `[${range}]`;
    }).join("");
}
