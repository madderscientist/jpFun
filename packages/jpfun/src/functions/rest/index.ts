import { ErrorDiagnostic } from "../../diagnostic.js";
import { Fraction } from "../../fraction.js";
import type { HorizontalLineView, LayoutBox, LayoutPrepareContext, TimeLineEvent } from "../../layout/types.js";
import type { LoweringResult } from "../../lowering/types.js";
import type { Track } from "../../lowering/track.js";
import type { PlaybackEmitter } from "../../playback/types.js";
import type { GlyphMetrics, Painter, TextStyle } from "../../render/types.js";
import {
    ASTFunctionNode, ASTNodeBase, type ASTFunctionClass, type FunctionArgs,
    type LengthValue, type ParserContext, type SourceSpan,
} from "../ASTtypes.js";
import { ANCHOR_KEY, isVisualTemporalNode, TemporalNodeBase, type TimeState, type VisualTemporalNode } from "../temporal.js";

// 同刻状态先固化，休止只与休止合列，普通音符随后进入
const REST_KEY = Number.MAX_VALUE;
const restsByHost = new WeakMap<TimeLineEvent, RestTemporal>();

class RestFunction extends ASTFunctionNode {
    static override def = {
        name: ["rest"],
        description: "多小节休止",
        details: `\
~~~jpfun
@meter(4,4) | @rest(19) |
~~~
使用当前拍号产生 19 个整小节的静音（必须先声明拍号）`,
        allowExtraArgs: false,
        args: [
            {
                name: "n",
                description: "休止的小节数",
                type: "number" as const,
                default: 1
            },
            {
                name: "width",
                description: "横线的最小宽度",
                type: "length" as const,
                default: { value: 3, unit: "em" } as LengthValue
            },
            {
                name: "size",
                description: "数字字号与笔画尺寸",
                type: "length" as const,
                default: { value: 1, unit: "em" } as LengthValue
            },
        ],
    };

    readonly count: number;
    readonly width: number;
    readonly size: number;
    readonly font: string;

    constructor(span: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(span, parent);
        const [count, width, size] = this.getArgValue(args, ctx) as [number, LengthValue, LengthValue];
        if (!Number.isSafeInteger(count) || count <= 0 || count > 0xffffffff) {
            throw new ErrorDiagnostic("E_REST_COUNT", "@rest 的 n 必须是正安全整数，且小节线数量可由数组表示", span);
        }
        this.count = count;
        this.width = ctx.length2px(width);
        this.size = ctx.length2px(size);
        if (!Number.isFinite(this.width) || this.width < 0 || !Number.isFinite(this.size) || this.size <= 0) {
            throw new ErrorDiagnostic("E_REST_SIZE", "@rest 的 width 必须有限且非负，size 必须有限且为正", span);
        }
        this.font = ctx.variables.numberfont;
    }

    override labelable() { return null; }

    override loweringEnter() {
        return [new RestTemporal(this)];
    }

    static override loweringFinalize(result: LoweringResult) {
        // 没有全局休止列时，跳过索引扫描和边界补入
        if (!result.columns.some(column => column.some(node => node.mergeKey === REST_KEY))) return;
        let order = 0;
        const onsets = new Map<TemporalNodeBase, TemporalNodeBase>();
        // 扫描完整来源索引，纳入未直接出现在时间列中的折叠成员
        for (const nodes of result.astToTemporal.values()) {
            // 为新增边界预留唯一 order，并记录各宿主的休止代表和最早音符
            for (const node of nodes) {
                order = Math.max(order, node.order + 1);
                if (!(node instanceof RestTemporal)
                    && (!(node.ast instanceof ASTFunctionNode)
                        || (node.ast.callName !== "note" && node.ast.callName !== "dash"))) continue;
                let host = node;
                // 沿折叠链找到最外层宿主，将内部成员归到同一主体
                while (host.foldedInto) host = host.foldedInto;
                // 私有倚音属于独立轨道，不代表外层宿主的休止或起音
                if (node.track !== host.track) continue;
                if (node instanceof RestTemporal) {
                    // 非宿主休止不接管外层时间列，同轨最早休止代表宿主
                    if (host.mergeKey !== REST_KEY) continue;
                    const rest = restsByHost.get(host);
                    if (!rest || node.order < rest.order) restsByHost.set(host, node);
                    continue;
                }
                const onset = onsets.get(host);
                if (!onset || node.order < onset.order) onsets.set(host, node);
            }
        }
        const columns: TemporalNodeBase[][] = [];
        const previous = new Map<Track, TemporalNodeBase>();
        // 保留原时间列，并在休止列后追加其内部小节边界
        for (const column of result.columns) {
            columns.push(column);
            let longest: RestTemporal | undefined;
            // 检查各轨是否用增时线延续休止，同时选出同列最长休止
            for (const node of column) {
                if (node.T.compare(0) > 0) {
                    const onset = onsets.get(node);
                    const before = previous.get(node.track);
                    if (before && restsByHost.has(before)
                        && onset?.ast instanceof ASTFunctionNode && onset.ast.callName === "dash") {
                        throw new ErrorDiagnostic("E_REST_SUSTAIN", "增时线不能延续整小节休止", onset.ast.sourceSpan);
                    }
                    previous.set(node.track, node);
                }
                const rest = restsByHost.get(node);
                if (rest && (!longest || rest.T.compare(longest.T) > 0)) longest = rest;
            }
            if (!longest) continue;
            const time = longest.t.clone();
            // 按小节时长补入 n−1 个不可见边界；时间已固化，不再参与声部归并
            for (let index = 1; index < longest.ast.count; index++) {
                time.add(longest.measureDuration);
                const boundary = new TemporalNodeBase();
                boundary.ast = new ASTNodeBase(longest.ast.sourceSpan, longest.ast);
                boundary.t.copyFrom(time);
                boundary.track = longest.track;
                boundary.layoutLine = longest.layoutLine;
                boundary.order = order++;
                boundary.mergeKey = ANCHOR_KEY;
                result.astToTemporal.set(boundary.ast, [boundary]);
                columns.push([boundary]);
            }
        }
        result.columns = columns;
    }

    override toString() { return `@rest(${this.count})`; }
}

export const RestNode: ASTFunctionClass = RestFunction;

class RestTemporal extends TemporalNodeBase {
    declare ast: RestFunction;
    declare box: LayoutBox;
    readonly measureDuration = new Fraction();
    private metrics!: GlyphMetrics;
    private lineWidth = 0;
    private readonly textStyle: TextStyle;

    constructor(ast: RestFunction) {
        super();
        this.ast = ast;
        this.mergeKey = REST_KEY;
        restsByHost.set(this, this);
        this.initLayoutBox();
        this.textStyle = { fontSize: ast.size, fontFamily: ast.font, textAlign: "center" };
    }

    override onTimeState(state: TimeState) {
        const measure = state.meter;
        if (!(measure instanceof Fraction)) {
            throw new ErrorDiagnostic("E_REST_METER", "整小节休止前必须有实际生效的显式拍号", this.ast.sourceSpan);
        }
        if (!Number.isSafeInteger(measure.numerator * this.ast.count)) {
            throw new ErrorDiagnostic("E_REST_COUNT", "@rest 的总时值超出精确整数范围", this.ast.sourceSpan);
        }
        this.measureDuration.copyFrom(measure);
        this.T.copyFrom(measure).mul(this.ast.count);
        this.playbackState = { bpm: state.bpm };
        return this.T;
    }

    override emitPlayback(emitter: PlaybackEmitter) {
        emitter.span({ start: emitter.start, end: emitter.end });
    }

    override prepareLayout(context: LayoutPrepareContext) {
        const size = this.ast.size;
        // 抵消布局器的时长平方根缩放，左右弹簧自然长度固定为 6px
        const alpha = 6 / Math.sqrt(this.T.toNumber());
        this.springConfig = { alpha_L: alpha, alpha_R: alpha };
        this.metrics = context.textMeasurer.measureText(String(this.ast.count), this.textStyle);
        this.lineWidth = Math.max(this.ast.width, this.metrics.w + size * 0.5);
        this.box.w = this.lineWidth + size * 0.25;
        this.box.h = this.metrics.h + size * 0.5;
        this.box.anchor = size * 0.4;
        this.box.visualAxis = this.box.h - size * 0.65 / 2;
    }

    override prepareHorizontal(line: HorizontalLineView) {
        let host: VisualTemporalNode = this;
        // 向外寻找实际占据布局列的宿主，让被包装的休止也能注册横向约束
        while (line.columnOf(host) < 0 && host.foldedInto && isVisualTemporalNode(host.foldedInto)) host = host.foldedInto;
        const column = line.columnOf(host);
        if (column < 0) return;
        const barAt = (index: number) => line.columns[index]?.find(
            node => node.track === host.track && node.mergeKey === ANCHOR_KEY) ?? host;
        const first = barAt(column - 1);
        const last = barAt(column + 1);
        if (first === last) return;
        line.registerHorizontalLayoutHook(first, last, ({ columns, rows, start, end, X, fixed }) => {
            // 锁定休止及相邻小节线之间的列间距，撑满行宽时也不拉开
            for (let i = start; i < end; i++) {
                if (fixed[i]) continue;
                let distance = 0;
                // 取所有声部所需间距的最大值，避免压紧休止时造成其他声部交叠
                for (let row = 0; row < rows; row++) {
                    const left = columns[i][row];
                    const right = columns[i + 1][row];
                    // 右侧留隙已在休止盒内，只给左侧补同样的墨迹间距
                    const rest = restsByHost.get(right.time);
                    const gap = rest ? rest.ast.size * 0.25 : 0;
                    distance = Math.max(distance, left.WR + right.WL + gap);
                }
                const shift = X[i] + distance - X[i + 1];
                // 平移右侧已锁定的块及其末列，保留连续休止先前确定的间隙
                for (let j = i + 1; j < X.length; j++) {
                    X[j] += shift;
                    if (!fixed[j]) break;
                }
                fixed[i] = 1;
            }
        });
    }

    override paint(painter: Painter) {
        const { size, count } = this.ast;
        const left = this.box.x;
        const right = left + this.lineWidth;
        const axis = this.box.y + this.box.visualAxis;
        const stroke = size * 0.12;
        const barStroke = stroke * 2;
        const halfCap = (size * 0.65 - stroke) / 2;
        painter.drawLine(left + barStroke / 2, axis, right - barStroke / 2, axis, { strokeWidth: barStroke });
        painter.drawLine(left + stroke / 2, axis - halfCap, left + stroke / 2, axis + halfCap, { strokeWidth: stroke });
        painter.drawLine(right - stroke / 2, axis - halfCap, right - stroke / 2, axis + halfCap, { strokeWidth: stroke });
        painter.drawText(String(count), left + this.lineWidth / 2, this.box.y + this.metrics.baseline, this.textStyle);
    }
}
