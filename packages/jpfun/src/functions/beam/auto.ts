import {
    ANCHOR_KEY,
    isVisualTemporalNode,
    type TemporalNodeBase,
    type VisualTemporalNode,
} from "../temporal.js";
import type { LoweringResult } from "../../lowering/types.js";
import { Fraction } from "../../fraction.js";
import type { LayoutAttachment } from "../../layout/types.js";
import {
    getDivOwner,
    type DivNode,
} from "../div/index.js";
import { meterChangeAt } from "../meter/index.js";
import {
    collectExplicitBeamEndpoints,
    createBeamLayoutAttachment,
} from "./layout.js";

interface AutoBeamGroup {
    nodes: VisualTemporalNode[];
    beat: number;
    endTime: Fraction;
}

/** 按最外层 div 作用域收集可见事件，顺序与最终时间列一致 */
function collectDivScopes(result: LoweringResult): Map<InstanceType<typeof DivNode>, VisualTemporalNode[]> {
    const scopes = new Map<InstanceType<typeof DivNode>, VisualTemporalNode[]>();
    for (const column of result.columns) {
        for (const node of column) {
            if (!isVisualTemporalNode(node)) continue;
            const owner = getDivOwner(node);
            if (!owner) continue;
            const nodes = scopes.get(owner);
            if (nodes) nodes.push(node);
            else scopes.set(owner, [node]);
        }
    } return scopes;
}

function createAutoBeam(nodes: VisualTemporalNode[]): LayoutAttachment {
    let start = Infinity;
    let end = -Infinity;
    for (const node of nodes) {
        const owner = getDivOwner(node)!;
        start = Math.min(start, node.ast.sourceSpan.start, owner.sourceSpan.start);
        end = Math.max(end, node.ast.sourceSpan.end, owner.sourceSpan.end);
    }
    return createBeamLayoutAttachment(nodes, false, { start, end });
}

/** 同一个 div 内部始终按轨道连接，手工 beam 端点会截断自动片段 */
function createScopeBeams(
    scopes: Iterable<readonly VisualTemporalNode[]>,
    explicitEndpoints: ReadonlySet<TemporalNodeBase>,
): LayoutAttachment[] {
    const attachments: LayoutAttachment[] = [];
    const segments = new Map<TemporalNodeBase["track"], VisualTemporalNode[]>();
    const flush = (segment: VisualTemporalNode[] | undefined) => {
        if (segment && segment.length >= 2) attachments.push(createAutoBeam(segment));
    };

    for (const scopeNodes of scopes) {
        if (scopeNodes.length < 2) continue;
        for (const node of scopeNodes) {
            if (explicitEndpoints.has(node)) {
                flush(segments.get(node.track));
                segments.delete(node.track);
                continue;
            }
            const segment = segments.get(node.track);
            if (segment) segment.push(node);
            else segments.set(node.track, [node]);
        }
        for (const segment of segments.values()) flush(segment);
        segments.clear();
    }

    return attachments;
}

/**
 * 多个独立 div 的默认连接规则
 *
 * MuseScore 和 LilyPond 都以拍号的 beat structure 作为默认分组边界，并允许手工 beam 覆盖。
 * 随当前生效的 @meter 分拍（缺省或散板按四分音符，复拍子及 3/8 按三个分母单位，其余短分母按一个分母单位）。
 * 分组不跨轨道、逻辑行、拍点、小节线、拍号变更、时间间隙、普通长事件、开关边界或显式 beam。
 */
function createAdjacentBeams(
    result: LoweringResult,
    scopes: ReadonlyMap<InstanceType<typeof DivNode>, readonly VisualTemporalNode[]>,
    explicitEndpoints: ReadonlySet<TemporalNodeBase>,
): LayoutAttachment[] {
    const attachments: LayoutAttachment[] = [];
    const groups = new Map<TemporalNodeBase["track"], AutoBeamGroup>();
    const phaseStart = new Fraction();
    const beatTime = new Fraction();
    const beatDuration = new Fraction(1);
    let candidateDuration: Fraction | number = 1;
    let currentLine = 0;

    const flush = (track: TemporalNodeBase["track"]) => {
        const group = groups.get(track);
        if (!group) return;
        groups.delete(track);
        if (group.nodes.length >= 2) attachments.push(createAutoBeam(group.nodes));
    };

    const flushAll = () => {
        for (const track of groups.keys()) flush(track);
    };

    for (const column of result.columns) {
        const line = column[0].layoutLine;
        let meter: ReturnType<typeof meterChangeAt>;
        let hasAnchor = false;
        for (const node of column) {
            meter = meterChangeAt(node) ?? meter;
            if (node.mergeKey === ANCHOR_KEY) hasAnchor = true;
        }
        if (line !== currentLine || meter || hasAnchor) {
            currentLine = line;
            flushAll();
            phaseStart.copyFrom(column[0].t);
        }
        if (meter) {
            const { numerator, denominator } = meter;
            if (numerator > 0 && denominator > 4) {
                beatDuration.set(denominator >= 8 && numerator % 3 === 0 ? 12 : 4, denominator);
            } else {
                beatDuration.set(1);
            }
            candidateDuration = beatDuration.compare(1) < 0 ? beatDuration : 1;
        }

        for (const node of column) {
            if (node.mergeKey === ANCHOR_KEY) continue;

            const owner = isVisualTemporalNode(node) ? getDivOwner(node) : undefined;
            const isCandidate = isVisualTemporalNode(node)
                && owner !== undefined
                && owner.autoBeamEnabled
                && scopes.get(owner)?.length === 1
                && node.T.compare(candidateDuration) < 0
                && !explicitEndpoints.has(node);

            if (!isCandidate) {
                // 同轨可见元素必须打断相邻关系，即使它本身是零时长文本
                // 不可见的 set/key/tempo 等零时长状态不会打断
                if (isVisualTemporalNode(node) || !node.T.isZero()) flush(node.track);
                continue;
            }

            beatTime.copyFrom(node.t).sub(phaseStart);
            const beat = Math.floor(
                beatTime.numerator * beatDuration.denominator / (beatTime.denominator * beatDuration.numerator),
            );
            const current = groups.get(node.track);
            if (!current || beat !== current.beat || !node.t.equals(current.endTime)) {
                flush(node.track);
                groups.set(node.track, {
                    nodes: [node],
                    beat,
                    endTime: node.t.clone().add(node.T),
                });
                continue;
            }

            current.nodes.push(node);
            current.endTime.copyFrom(node.t).add(node.T);
        }
    }

    flushAll();
    return attachments;
}

/** beam 域在 lowering 固化后统一生成作用域连接和相邻自动连接 */
export function createAutomaticBeamAttachments(result: LoweringResult): void {
    const scopes = collectDivScopes(result);
    if (scopes.size === 0) return;
    const explicitEndpoints = collectExplicitBeamEndpoints(result.attachments);
    result.attachments.push(
        ...createScopeBeams(scopes.values(), explicitEndpoints),
        ...createAdjacentBeams(result, scopes, explicitEndpoints),
    );
}