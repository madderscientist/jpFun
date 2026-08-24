import {
    ANCHOR_KEY,
    isVisualTemporalNode,
    type LoweringResult,
    type TemporalNodeBase,
    type VisualTemporalNode,
} from "../../lowering/types.js";
import { Fraction } from "../../fraction.js";
import type { LayoutAttachment } from "../../layout/types.js";
import type { ASTNodeBase, SourceSpan } from "../ASTtypes.js";
import {
    DIV_ADDON_KEY,
    DivNode,
} from "../div/index.js";
import {
    collectExplicitBeamEndpoints,
    createBeamLayoutAttachment,
} from "./layout.js";

interface AutoBeamGroup {
    nodes: VisualTemporalNode[];
    line: number;
    beat: number;
    endTime: Fraction;
}

interface DivScope {
    owner: InstanceType<typeof DivNode>;
    nodes: VisualTemporalNode[];
}

/** 只返回实际参与当前事件 div addon 的 div，先沿祖先链找，不够再按书写顺序向下补 */
function findActiveDivs(node: VisualTemporalNode): InstanceType<typeof DivNode>[] {
    const result: InstanceType<typeof DivNode>[] = [];
    let remainingLevels = Math.max(0, Math.floor(Number(node.addon?.[DIV_ADDON_KEY]) || 0));

    const take = (div: InstanceType<typeof DivNode>) => {
        result.push(div);
        remainingLevels -= Math.max(0, div.n);
    };

    let ast = node.ast.parent;
    while (ast && remainingLevels > 0) {
        if (ast instanceof DivNode) take(ast);
        ast = ast.parent;
    }

    // 复合节点（如 up）把代表成员的修饰提升成了自己的，提供层级的 div 在子树里
    const descend = (parent: ASTNodeBase) => {
        for (const child of parent.children ?? []) {
            if (remainingLevels <= 0) return;
            if (child instanceof DivNode) take(child);
            descend(child);
        }
    };
    descend(node.ast);

    return result;
}

/** 收集每个 div 作用域内的可见事件，顺序与最终时间列一致 */
function collectDivScopes(result: LoweringResult): {
    scopes: DivScope[];
    nodeScopes: Map<VisualTemporalNode, DivScope[]>;
} {
    const scopesByOwner = new Map<InstanceType<typeof DivNode>, DivScope>();
    const nodeScopes = new Map<VisualTemporalNode, DivScope[]>();

    for (const column of result.columns) {
        for (const node of column) {
            if (!isVisualTemporalNode(node)) continue;

            const owners = findActiveDivs(node);
            if (owners.length === 0) continue;

            const memberships: DivScope[] = [];
            for (const owner of owners) {
                let scope = scopesByOwner.get(owner);
                if (!scope) {
                    scope = { owner, nodes: [] };
                    scopesByOwner.set(owner, scope);
                }
                scope.nodes.push(node);
                memberships.push(scope);
            }
            nodeScopes.set(node, memberships);
        }
    }

    return {
        scopes: [...scopesByOwner.values()],
        nodeScopes,
    };
}

/** 嵌套 div 由最外层作用域一次连接，内部级别通过端口自然形成次级 beam */
function outermostScopes(scopes: DivScope[]): DivScope[] {
    const owners = new Set(scopes.map(scope => scope.owner));

    return scopes.filter(scope => {
        let parent = scope.owner.parent;
        while (parent) {
            if (parent instanceof DivNode && owners.has(parent)) return false;
            parent = parent.parent;
        }
        return true;
    });
}

function sourceSpanForAutoBeam(nodes: readonly VisualTemporalNode[]): SourceSpan {
    let start = Infinity;
    let end = -Infinity;
    for (const node of nodes) {
        start = Math.min(start, node.ast.sourceSpan.start);
        end = Math.max(end, node.ast.sourceSpan.end);
        for (const div of findActiveDivs(node)) {
            start = Math.min(start, div.sourceSpan.start);
            end = Math.max(end, div.sourceSpan.end);
        }
    }
    return { start, end };
}

function createAutoBeam(nodes: VisualTemporalNode[]): LayoutAttachment {
    return createBeamLayoutAttachment(nodes, false, sourceSpanForAutoBeam(nodes));
}

/** 同一个 div 内部始终按轨道连接，手工 beam 端点会截断自动片段 */
function createScopeBeams(
    scopes: DivScope[],
    explicitEndpoints: ReadonlySet<TemporalNodeBase>,
): LayoutAttachment[] {
    const attachments: LayoutAttachment[] = [];

    for (const scope of outermostScopes(scopes)) {
        const tracks = new Map<TemporalNodeBase["track"], VisualTemporalNode[]>();
        for (const node of scope.nodes) {
            const trackNodes = tracks.get(node.track);
            if (trackNodes) trackNodes.push(node);
            else tracks.set(node.track, [node]);
        }

        for (const nodes of tracks.values()) {
            let segment: VisualTemporalNode[] = [];
            const flush = () => {
                if (segment.length >= 2) attachments.push(createAutoBeam(segment));
                segment = [];
            };

            for (const node of nodes) {
                if (explicitEndpoints.has(node)) {
                    flush();
                    continue;
                }
                segment.push(node);
            }
            flush();
        }
    }

    return attachments;
}

function beatAt(time: Fraction): number {
    return Math.floor(time.numerator / time.denominator);
}

/** 折叠成员不进全局时间列，但书写上就是相邻音符，因此整串始终相连，不看拍点 */
function createFoldedRunBeams(result: LoweringResult): LayoutAttachment[] {
    const attachments: LayoutAttachment[] = [];
    // 复合体可能又被当作宿主或和弦成员折叠进去，只有这张表能同时看到嵌套各层
    for (const nodes of result.astToTemporal.values()) {
        for (const node of nodes) {
            const run = node.foldedRun;
            if (run && run.length >= 2) attachments.push(createAutoBeam([...run]));
        }
    }
    return attachments;
}

/**
 * 多个独立 div 的默认连接规则
 *
 * MuseScore 和 LilyPond 都以拍号的 beat structure 作为默认分组边界，并允许手工 beam 覆盖。
 * 当前语言没有拍号，暂以四分音符为拍单位。
 * 分组不跨轨道、逻辑行、拍点、小节线、时间间隙、普通长事件、开关边界或显式 beam。
 */
function createAdjacentBeams(
    result: LoweringResult,
    nodeScopes: Map<VisualTemporalNode, DivScope[]>,
    explicitEndpoints: ReadonlySet<TemporalNodeBase>,
): LayoutAttachment[] {
    const attachments: LayoutAttachment[] = [];
    const groups = new Map<TemporalNodeBase["track"], AutoBeamGroup>();
    const lineStarts = new Map<number, Fraction>();
    const measureStart = new Fraction();
    const beatTime = new Fraction();

    for (const column of result.columns) {
        for (const node of column) {
            const current = lineStarts.get(node.layoutLine);
            if (current === undefined || node.t.compare(current) < 0) lineStarts.set(node.layoutLine, node.t);
        }
    }

    const flush = (track: TemporalNodeBase["track"]) => {
        const group = groups.get(track);
        if (!group) return;
        groups.delete(track);
        if (group.nodes.length >= 2) attachments.push(createAutoBeam(group.nodes));
    };

    const flushAll = () => {
        for (const track of [...groups.keys()]) flush(track);
    };

    for (const column of result.columns) {
        const anchor = column.find(node => node.mergeKey === ANCHOR_KEY);
        if (anchor) {
            flushAll();
            measureStart.copyFrom(anchor.t);
        }

        for (const node of column) {
            if (node.mergeKey === ANCHOR_KEY) continue;

            const memberships = isVisualTemporalNode(node) ? nodeScopes.get(node) : undefined;
            const isIndependentDiv = memberships?.every(scope => scope.nodes.length === 1) ?? false;
            const autoBeamEnabled = memberships?.every(scope => scope.owner.autoBeamEnabled) ?? false;
            const isCandidate = isVisualTemporalNode(node)
                && isIndependentDiv
                && autoBeamEnabled
                && node.T.compare(1) < 0
                && !explicitEndpoints.has(node);

            if (!isCandidate) {
                // 同轨可见元素必须打断相邻关系，即使它本身是零时长文本
                // 不可见的 set/key/tempo 等零时长状态不会打断
                if (isVisualTemporalNode(node) || !node.T.isZero()) flush(node.track);
                continue;
            }

            const lineStart = lineStarts.get(node.layoutLine) ?? node.t;
            const activeStart = measureStart.compare(lineStart) >= 0 ? measureStart : lineStart;
            const beat = beatAt(beatTime.copyFrom(node.t).sub(activeStart));
            const current = groups.get(node.track);
            if (!current) {
                groups.set(node.track, {
                    nodes: [node],
                    line: node.layoutLine,
                    beat,
                    endTime: node.t.clone().add(node.T),
                });
                continue;
            }

            const isContinuous = node.t.equals(current.endTime);
            if (node.layoutLine !== current.line || beat !== current.beat || !isContinuous) {
                flush(node.track);
                groups.set(node.track, {
                    nodes: [node],
                    line: node.layoutLine,
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
export function createAutomaticBeamAttachments(result: LoweringResult): LayoutAttachment[] {
    const { scopes, nodeScopes } = collectDivScopes(result);
    const explicitEndpoints = collectExplicitBeamEndpoints(result.attachments);
    return [
        ...createScopeBeams(scopes, explicitEndpoints),
        ...createAdjacentBeams(result, nodeScopes, explicitEndpoints),
        ...createFoldedRunBeams(result),
    ];
}