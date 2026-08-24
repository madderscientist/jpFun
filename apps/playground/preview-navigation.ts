/**
 * 后端无关的源码 <-> 谱面导航索引
 *
 * 本模块只把一次 CompileScoreResult 整理成源码 span 与最终布局区域的对应关系，
 * 并提供纯坐标命中函数。SVG/Canvas 坐标换算、滚动、波纹和编辑器选区归 preview.ts
 */
import {
    ASTFunctionNode,
    isVisualTemporalNode,
    type ASTNodeBase,
    type CompileScoreResult,
    type Rect,
    type SourceSpan,
    type VisualTemporalNode,
} from "jpfun";

/** attachment 是关系图形，object 是可见 Temporal，ancestor 是无独立图形的 AST 包装器 */
type TargetKind = "attachment" | "object" | "ancestor";

interface PreviewNavigationTarget {
    readonly span: SourceSpan;
    readonly regions: readonly Rect[];
    readonly kind: TargetKind;
}

export interface PreviewNavigationMap {
    /** 左侧源码点击使用，包含无独立图形但能归拢后代区域的 ancestor */
    readonly sourceTargets: readonly PreviewNavigationTarget[];
    /** 右侧谱面点击使用，只包含实际绘制出的 object 与 attachment */
    readonly hitTargets: readonly PreviewNavigationTarget[];
}

interface PreviewHit {
    readonly target: PreviewNavigationTarget;
    readonly region: Rect;
}

const kindPriority: Record<TargetKind, number> = {
    object: 0,
    attachment: 1,
    ancestor: 2,
};

function regionArea(region: Rect): number {
    return Math.max(1, region.w) * Math.max(1, region.h);
}

function smallestRegionArea(target: PreviewNavigationTarget): number {
    let area = Infinity;
    for (const region of target.regions) area = Math.min(area, regionArea(region));
    return area;
}

function compareSourceTargets(left: PreviewNavigationTarget, right: PreviewNavigationTarget): number {
    // 源码位置重叠时先取最窄 span；同 span 优先具体主体，再用最小视觉区域消歧
    return (left.span.end - left.span.start) - (right.span.end - right.span.start)
        || kindPriority[left.kind] - kindPriority[right.kind]
        || smallestRegionArea(left) - smallestRegionArea(right);
}

export function createPreviewNavigationMap(compiled: CompileScoreResult): PreviewNavigationMap {
    const hitTargets: PreviewNavigationTarget[] = [];
    const attachmentSpans = new Set<string>();
    const ancestorRegions = new Map<ASTFunctionNode, Rect[]>();
    const objects = new Set<VisualTemporalNode>(compiled.layout.objects.filter(object =>
        object.box.w > 0 || object.box.h > 0
    ));

    // grace/up 等折叠成员不在 layout.objects，但布局完成后仍保留最终 box。
    for (const temporals of compiled.lowering.astToTemporal.values()) {
        for (const temporal of temporals) {
            if (isVisualTemporalNode(temporal) && (temporal.box.w > 0 || temporal.box.h > 0)) {
                objects.add(temporal);
            }
        }
    }
    const visualAsts = new Set<ASTNodeBase>([...objects].map(object => object.ast));

    for (const attachment of compiled.layout.attachments) {
        if (!attachment.sourceSpan || attachment.regions.length === 0) continue;
        hitTargets.push({
            span: attachment.sourceSpan,
            regions: attachment.regions,
            kind: "attachment",
        });
        attachmentSpans.add(`${attachment.sourceSpan.start}:${attachment.sourceSpan.end}`);
    }

    for (const object of objects) {
        // 无可见 Temporal 的包装器（如 div/dot）仍可把自己的源码范围映射到唯一后代
        for (let node = object.ast.parent; node; node = node.parent) {
            if (!(node instanceof ASTFunctionNode)) continue;
            if (visualAsts.has(node)) continue;
            const regions = ancestorRegions.get(node);
            if (regions) regions.push(object.box);
            else ancestorRegions.set(node, [object.box]);
        }
    }

    for (const object of objects) {
        let span = object.ast.sourceSpan;
        // 只有唯一后代且没有独立 attachment 时才扩展 span，避免 grace/up 吞掉内部音符
        for (let node = object.ast.parent; node; node = node.parent) {
            if (!(node instanceof ASTFunctionNode)) continue;
            if (visualAsts.has(node)) break;
            if (ancestorRegions.get(node)?.length !== 1) break;
            if (attachmentSpans.has(`${node.sourceSpan.start}:${node.sourceSpan.end}`)) break;
            span = node.sourceSpan;
        }
        hitTargets.push({
            span,
            regions: [object.box],
            kind: "object",
        });
    }

    const sourceTargets = [...hitTargets];
    for (const [node, regions] of ancestorRegions) {
        sourceTargets.push({
            span: node.sourceSpan,
            regions,
            kind: "ancestor",
        });
    }

    return { sourceTargets, hitTargets };
}

export function sourceTargetAt(
    navigation: PreviewNavigationMap,
    position: number,
): PreviewNavigationTarget | null {
    let best: PreviewNavigationTarget | null = null;
    for (const target of navigation.sourceTargets) {
        if (position < target.span.start || position >= target.span.end) continue;
        if (!best || compareSourceTargets(target, best) < 0) best = target;
    }
    return best;
}

function axisDistance(value: number, start: number, size: number): number {
    if (value < start) return start - value;
    const end = start + size;
    return value > end ? value - end : 0;
}

export function previewHitAt(
    navigation: PreviewNavigationMap,
    x: number,
    y: number,
    tolerance: number,
): PreviewHit | null {
    let best: PreviewHit | null = null;
    let bestDistance = Infinity;
    let bestArea = Infinity;
    let bestSpanLength = Infinity;

    for (const target of navigation.hitTargets) {
        for (const region of target.regions) {
            const dx = axisDistance(x, region.x, region.w);
            const dy = axisDistance(y, region.y, region.h);
            if (dx > tolerance || dy > tolerance) continue;
            const distance = dx * dx + dy * dy;
            const area = regionArea(region);
            const spanLength = target.span.end - target.span.start;
            // 容差内先选更小的图形（细 beam/tie 不被大盒吞掉），再比较距离与 span
            if (area > bestArea
                || (area === bestArea && distance > bestDistance)
                || (area === bestArea && distance === bestDistance && spanLength >= bestSpanLength)) continue;
            best = { target, region };
            bestDistance = distance;
            bestArea = area;
            bestSpanLength = spanLength;
        }
    }
    return best;
}