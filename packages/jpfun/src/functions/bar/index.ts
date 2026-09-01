import { LengthValue, ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../ASTtypes.js";
import { GrammarCallNodeTyped } from "../../parser/grammarType.js";
import { ANCHOR_KEY, TemporalNodeBase } from "../temporal.js";
import type { PlaybackColumnOf, PlaybackCursor, PlaybackFlow, PlaybackFlowHook } from "../../playback/types.js";
import type { HorizontalLineView, LayoutBox, LayoutHost } from "../../layout/types.js";
import type { Painter } from "../../render/types.js";

class BarFunction extends ASTFunctionNode {
    static override def = {
        name: ["bar", "|"],
        description: "小节线",
        example: `@bar(type, lengthEM) 创建一个小节线
语法糖: 
- type0: '|' 普通小节线
- type1: '||' 终止小节线 左细右粗
- type2: '|:' 重复小节线 左粗右细
- type3: ':|'
- type4: ':|:' 左右反复
`,
        allowExtraArgs: false,
        args: [
            {   // 小节线样式类型，对应普通、终止和反复线
                name: "type",
                type: "number" as const,
                default: 0,
            },
            {
                name: "length",
                type: "length" as const,
                default: {
                    value: 1.25,
                    unit: "em",
                } as LengthValue,
            },
        ]
    };

    static deSugarAtom(source: string, start: number, _end: number) {
        let pos = start;
        let type = 0;
        const slice2 = source.slice(pos, pos + 2);
        if (slice2 === "||") type = 1, pos += 2;
        else if (slice2 === "|:") type = 2, pos += 2;
        else if (slice2 === ":|") {
            if (source[pos + 2] === ":") type = 4, pos += 3;
            else type = 3, pos += 2;
        } else if (source[pos] === "|") type = 0, pos += 1;
        else return null;

        const argMap = new Map();
        argMap.set("type", type);
        const node: GrammarCallNodeTyped = {
            kind: "call",
            typed: true,
            name: "bar",
            args: argMap,
            span: { start, end: pos },
            syntaxKind: "atom",
        };
        return { next: pos, node };
    };

    type: number;
    size: number;

    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        const [type, size] = this.getArgValue(args, ctx) as [number, LengthValue];
        this.type = type;
        this.size = ctx.length2px(size);
    }

    override loweringEnter() {
        return [this.type >= 2 ? new RepeatBarTemporalNode(this) : new BarTemporalNode(this)];
    }

    override toString() {
        return `@bar(${this.type}, ${this.size}px)`;
    }
}

export const BarNode: ASTFunctionClass = BarFunction;

class BarTemporalNode extends TemporalNodeBase {
    declare ast: BarFunction;
    declare box: LayoutBox;

    private lines: { x: number; w: number }[] = [];
    private repeatDots: { x: number; y: number }[] = [];

    constructor(ast: BarFunction) {
        super();
        this.ast = ast;
        this.mergeKey = ANCHOR_KEY;
        this.initLayoutBox();
        // 由于有最小时长，因此设置alpha依然有效
        this.springConfig = {
            alpha_L: 128,
            alpha_R: 128,
        }
    }

    /**
     * 给 bar 两侧的相邻元素增加 mu，避免被压缩到一起
     */
    override prepareHorizontal(line: HorizontalLineView) {
        const run = line.trackRuns.get(this.track);
        const index = run?.indexOf(this) ?? -1;
        if (!run || index < 0) return;

        line.registerHorizontalLayoutHook(this, this, ({ columns, start }) => {
            const current = columns[start].find(element => element.time === this);
            if (!current) return;

            const elementOf = (node: LayoutHost) => {
                const column = line.columnOf(node);
                return column < 0 ? undefined : columns[column].find(element => element.time === node);
            };

            const left = index > 0 ? elementOf(run[index - 1]) : undefined;
            if (left) {
                left.config.mu_R *= 4;
                current.config.mu_L *= 4;
            }

            const rightNode = run[index + 1];
            const right = rightNode ? elementOf(rightNode) : undefined;
            // 相邻两个 bar 的中间 gap 由右侧 bar 处理，避免重复增强
            if (right && !(rightNode instanceof BarTemporalNode)) {
                current.config.mu_R *= 4;
                right.config.mu_L *= 4;
            }
        });
    }

    override prepareLayout() {
        const { type, size } = this.ast;
        this.lines.length = 0;
        this.repeatDots.length = 0;

        const h = size;
        const thin = Math.max(1, size * 0.065);
        const thick = thin * 2.6;
        const gap = thin * 1.8;
        const dotRadius = thin * 0.8;
        const dotGap = gap + dotRadius;
        const hasLeftDots = type === 3 || type === 4;
        const hasRightDots = type === 2 || type === 4;
        let x = hasLeftDots ? dotRadius * 2 + dotGap : 0;

        if (type === 1 || type === 3 || type === 4) {
            this.lines.push({ x, w: thin });
            x += thin + gap;
            this.lines.push({ x, w: thick });
            x += thick;
        } else if (type === 2) {
            this.lines.push({ x, w: thick });
            x += thick + gap;
            this.lines.push({ x, w: thin });
            x += thin;
        } else {
            this.lines.push({ x, w: thin });
            x += thin;
        }

        if (hasLeftDots) {
            const dotX = dotRadius;
            this.repeatDots.push({ x: dotX, y: h * 0.38 });
            this.repeatDots.push({ x: dotX, y: h * 0.62 });
        }

        if (hasRightDots) {
            const dotX = x + dotGap;
            this.repeatDots.push({ x: dotX, y: h * 0.38 });
            this.repeatDots.push({ x: dotX, y: h * 0.62 });
            x = dotX + dotRadius;
        }

        this.box.w = x;
        this.box.h = h;
        this.box.anchor = x / 2;
        this.box.visualAxis = h / 2;
    }

    override paint(painter: Painter) {
        for (const line of this.lines) {
            painter.drawRect(
                this.box.x + line.x,
                this.box.y,
                line.w,
                this.box.h,
                { fill: "#000" },
            );
        }

        const radius = Math.max(1, this.box.w * 0.06);
        for (const dot of this.repeatDots) {
            painter.drawCircle(
                this.box.x + dot.x,
                this.box.y + dot.y,
                radius,
                { fill: "#000" },
            );
        }
    }
}


/** 反复段起点标记：`:|` 靠它找回跳目标，遍数也按它计数 */
const REPEAT_START = "repeat.start";

/**
 * 某一列此刻处在所属反复段的第几遍
 *
 * 遍数是回跳的直接后果，所以和跳转规则一样归小节线所有；房子只消费这个数。
 * 没有 `|:` 时整首曲子就是一段。
 */
export function repeatPass(cursor: PlaybackCursor, column: number): number {
    return cursor.visits(cursor.seek(REPEAT_START, column + 1, -1) ?? 0);
}

/** 只有反复线参与播放顺序；普通小节线太多，进控制流扫描是纯开销 */
class RepeatBarTemporalNode extends BarTemporalNode implements PlaybackFlow {
    /** 只在 type>=2 时创建，所以剩下的三种是：2 段首、3 段尾、4 两者都是 */
    playbackMarks(): readonly string[] {
        return this.ast.type === 3 ? [] : [REPEAT_START];
    }

    /** 每条反复线只回跳一次，所以连写几条就是几遍 */
    playbackFlow(columnOf: PlaybackColumnOf): PlaybackFlowHook | undefined {
        if (this.ast.type === 2) return;
        const at = columnOf(this);
        if (at === undefined) return;
        return {
            range: [at, at],
            run: cursor => cursor.visits(at) > 1
                ? undefined
                : { kind: "jump", column: cursor.seek(REPEAT_START, at, -1) ?? 0 },
        };
    }
}