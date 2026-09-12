import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, FunctionArgs, SourceSpan } from "../ASTtypes.js";
import { ParserContext } from "../ASTtypes.js";
import type { CallArgumentInfo } from "../../parser/grammarType.js";
import { Diagnostic, ErrorDiagnostic } from "../../diagnostic.js";
import type { LoweringContext } from "../../lowering/loweringContext.js";
import type { TemporalNodeBase } from "../temporal.js";
import { createAutomaticBeamAttachments } from "./auto.js";
import {
    createBeamLayoutAttachment,
    validateExplicitBeamAttachments,
} from "./layout.js";

class BeamFunction extends ASTFunctionNode {
    static override loweringAugment = createAutomaticBeamAttachments;
    static override loweringFinalize = validateExplicitBeamAttachments;

    static override def = {
        name: ["beam"],
        description: "减时线连接",
        details: `\
事后将多个减时线**强行**相连
~~~jpfun
1/@a 2/@b | 3/@c @beam(a, b, c)
~~~
**位置参数**：已标记音符的标签，按传入顺序连接减时线，显式指定一组。先用 \`/\` 或 \`@div\` 为目标添加减时线，再用 \`@beam\` 控制连接。端点须同轨、同谱面行且相邻，可跨小节线；连线直接穿过小节线，保留原有间距。`,
        allowExtraArgs: true,
        extraArgType: "label" as const,
        args: [],
    };

    endPoints: ASTNodeBase[] = [];

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        for (const [, value] of args) {
            const parsed = value instanceof ASTFunctionNode
                ? value
                : ctx.parseArgWithType((value as CallArgumentInfo).valueSpan, "label", sourceSpan.start);
            if (parsed instanceof ASTFunctionNode) this.endPoints.push(parsed);
        }

        // 未显式给全时，回退到最近可标记对象，至少取两个。
        let k = ctx.labelableNodes.length - 1;
        while (this.endPoints.length < 2 && k >= 0) {
            const candidate = ctx.labelableNodes[k--];
            if (!candidate || this.endPoints.includes(candidate)) continue;
            this.endPoints.unshift(candidate);
        }

        if (this.endPoints.length < 2) {
            throw new ErrorDiagnostic("E_NOT_ENOUGH_ARGS", "@beam 至少需要两个端点", sourceSpan);
        }
    }

    /** 与 tie 一样，只注册不推进时间的关系排版对象 */
    override loweringEnter(ctx: LoweringContext) {
        const endPoints: TemporalNodeBase[] = [];
        for (const ast of this.endPoints) {
            // 暂时只用最后一个；理应有且仅有一个
            let temporal = ctx.getTemporalNodes(ast).at(-1);
            while (temporal?.foldedInto) temporal = temporal.foldedInto;
            if (!temporal) continue;
            endPoints.push(temporal);
        }

        if (endPoints.length < 2) {
            ctx.diagnostics.push(Diagnostic.warning.UnresolvedEndpoint("beam", this.sourceSpan));
            return [];
        }
        ctx.addAttachment(createBeamLayoutAttachment(endPoints, true, this.sourceSpan));
        return [];
    }
}

export const BeamNode: ASTFunctionClass = BeamFunction;
