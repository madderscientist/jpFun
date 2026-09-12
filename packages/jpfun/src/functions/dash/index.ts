import { ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes.js";
import { GrammarCallNodeTyped } from "../../parser/grammarType.js";
import { DEFAULT_KEY, TemporalNodeBase, type TimeState } from "../temporal.js";
import type { LayoutBox } from "../../layout/types.js";
import type { Painter } from "../../render/types.js";
import { WarningDiagnostic } from "../../diagnostic.js";
import type { PlaybackEmitter, PlaybackOrigin } from "../../playback/types.js";

class DashFunction extends ASTFunctionNode {
    static override def = {
        name: ["dash", "-"],
        description: "增时线",
        details: `\
~~~jpfun
1 @dash()
~~~
无参数。添加一根增时线，扩展前方音符或休止符的完整时值；也可简写为 \`1 -\`。每根线的基础时值为一个四分音符，可用减时线或附点调整。装饰音覆盖延长后的完整音符，例如 \`1 ^ $tr -\` 在两拍内持续颤音。`,
        allowExtraArgs: false,
        args: []
    };

    static deSugarAtom(source: string, start: number, _end: number) {
        if (source[start] !== '-') return null;
        const node: GrammarCallNodeTyped = {
            kind: "call",
            typed: true,
            name: "-",
            args: new Map(),
            span: { start, end: start + 1 },
            syntaxKind: "atom",
        };
        return { next: start + 1, node };
    };

    size: number;

    constructor(span: SourceSpan, _args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        this.size = ctx.variables.fontsize;
    }

    override loweringEnter() {
        return [new DashTemporalNode(this)];
    }

    override labelable() { return this; }

    override toString() { return "-"; }
}

export const DashNode: ASTFunctionClass = DashFunction;

class DashTemporalNode extends TemporalNodeBase {
    declare ast: DashFunction;
    declare box: LayoutBox;

    private lineWidth = 0;
    private lineY = 0;

    constructor(ast: DashFunction) {
        super();
        this.ast = ast;
        this.T.set(1);
        this.mergeKey = DEFAULT_KEY;
        this.initLayoutBox();
    }

    /** 固化记谱位置的速度，控制流直接跳到增时线时也能恢复正确状态 */
    override onTimeState(state: TimeState) {
        this.playbackState = { bpm: state.bpm };
    }

    override prepareLayout() {
        const size = this.ast.size;
        this.lineWidth = size * 0.42;

        // dash 与数字音符共享视觉中心和完整字号高度
        // 线本身位于数字视觉中心，不使用极小的 glyph 高度作为轨道高度
        this.box.w = this.lineWidth;
        this.box.h = size;
        this.box.anchor = this.lineWidth / 2;
        this.lineY = size * 0.5;
        this.box.visualAxis = this.lineY;
    }

    /**
     * 在结构阶段延长前方同轨、时间相接的一组区间
     * 有声与无声目标都保留原对象，后续声音变换才能使用延长后的完整时值
     */
    override emitPlayback(emitter: PlaybackEmitter) {
        const start = emitter.start.clone();
        const track = emitter.track;
        const sourceSpan = this.ast.sourceSpan;
        // 这里只查询已发布的结构前缀；装饰音尚未展开，不需要逐个修改子音。
        emitter.defer(context => {
            let rootOrigin: PlaybackOrigin | undefined;
            // 从最近发布的区间向前找，锁定与当前起点相接的那次顶层访问。
            // 来源身份限定了整组目标，防止延长更早的音符或另一遍反复中的同一节点。
            for (let index = context.spans.length - 1; index >= 0; index--) {
                const span = context.spans[index];
                if (span.track !== track) continue;
                if (rootOrigin === undefined) {
                    if (!span.end.equals(start)) continue;
                    rootOrigin = span.origins[0];
                } else if (span.origins[0] !== rootOrigin) {
                    break;
                }
                // 一组目标可以含多个成员；extend 同时承接当前访问在新增部分上的速度效果。
                if (span.end.equals(start)) {
                    emitter.extend(span);
                }
            }
            if (rootOrigin === undefined) {
                context.diagnostics.push(new WarningDiagnostic(
                    "W_PLAYBACK_SUSTAIN_WITHOUT_TARGET",
                    "增时线前没有可延续的音段",
                    sourceSpan,
                ));
            }
        });
    }

    override paint(painter: Painter) {
        painter.drawLine(
            this.box.x,
            this.box.y + this.lineY,
            this.box.x + this.lineWidth,
            this.box.y + this.lineY,
            { stroke: "#000", strokeWidth: Math.max(1, this.ast.size * 0.1) },
        );
    }
}