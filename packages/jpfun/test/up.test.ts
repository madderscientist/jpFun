import { test } from "node:test";

import { ASTFunctionNode, type ASTNodeBase } from "../src/functions/ASTtypes.js";
import type { LayoutBox } from "../src/layout/types.js";
import { ANCHOR_KEY, DEFAULT_KEY } from "../src/lowering/types.js";
import type { TemporalNodeBase, VisualTemporalNode } from "../src/lowering/types.js";
import { assert, expectLoweringError, layoutOf, lower, nearly, parse, recordCommands } from "./helpers.js";

const loweredUp = lower(`@up(1, #3', @text("上层")) 4`);
const upTemporal = loweredUp.columns[0][0] as TemporalNodeBase & {
    members: readonly TemporalNodeBase[];
};

test("up 成员不占全局列，共享和弦的时间位置与轨道", () => {
    assert(loweredUp.columns.length === 2, "up members must not create independent global columns");
    assert(upTemporal.members.length === 3, "up must retain exactly one visible temporal per argument");
    assert(upTemporal.T.equals(1), "up duration must come from its first member");
    assert(loweredUp.columns[1][0].t.equals(1), "the event after up must start after the first member duration");
    assert(
        upTemporal.members.every(member =>
            member.t.equals(upTemporal.t)
            && member.track === upTemporal.track
            && member.layoutLine === upTemporal.layoutLine
        ),
        "up members must share the outer temporal time position, track and layout line",
    );
});

test("up 继承成员的锚点合并组，并拒绝非法子节点", () => {
    assert(
        lower(`@up(1, @bar()) 2`).columns[0][0].mergeKey === ANCHOR_KEY,
        "up must inherit the anchor merge group from its members",
    );
    expectLoweringError(`@up({1 2}, 3)`, "E_UP_INVALID_CHILD");
    expectLoweringError(`@up({@tempo(90) 1}, 3)`, "E_UP_INVALID_CHILD");
});

test("up 成员标签与整体标签保持各自的 AST 承载者", () => {
    const labeledFunction = (source: string, label: string) => {
        let found: ASTFunctionNode | undefined;
        const visit = (node: ASTNodeBase) => {
            if (node instanceof ASTFunctionNode && node.label === label) found = node;
            for (const child of node.children ?? []) visit(child);
        };
        visit(parse(source));
        return found;
    };

    assert(labeledFunction(`{1@x}^{@1(C4)}`, "x")?.callName === "note",
        "a label written on an up member must stay on that member");
    assert(labeledFunction(`{1^@1(C4)}@x`, "x")?.callName === "up",
        "a label written after the grouped relation must target the whole up");
    assert(!labeledFunction(`{@1(C4)^@tempo(94)}@x`, "x"),
        "an up without any labelable member must not become labelable itself");
});

test("堆叠成员共享第一个成员的时值，零时长成员保持 0", () => {
    const upMemberDurations = (source: string) => {
        const temporal = lower(source).columns[0][0] as TemporalNodeBase & {
            members: readonly TemporalNodeBase[];
        };
        return { duration: temporal.T, members: temporal.members.map(member => member.T) };
    };
    const dottedChord = upMemberDurations(`@up(1., 3)`);
    assert(dottedChord.duration.equals(3, 2) && dottedChord.members.every(T => T.equals(3, 2)),
        "up members must adopt the first member duration");
    const flattenedChord = upMemberDurations(`@up(1, 3.)`);
    assert(flattenedChord.duration.equals(1) && flattenedChord.members.every(T => T.equals(1)),
        "a longer later member must be pulled back to the first member duration");
    const annotatedChord = upMemberDurations(`@up(1., @text("cresc."))`);
    assert(annotatedChord.members[0].equals(3, 2) && annotatedChord.members[1].isZero(),
        "a zero-duration up member must stay at zero");
});

test("up 内外的修饰都累加到和弦本身", () => {
    const dividedChord = lower(`@div(@up(@div(1, 1), 3), 1)`).columns[0][0];
    assert(dividedChord.T.equals(1, 4) && dividedChord.addon?.["@div"] === 2,
        "modifiers inside and outside up must accumulate on the chord itself");
});

test("和弦的减时线交还给代表成员，落在数字与下八度点之间", () => {
    const chordDivCommands = recordCommands(layoutOf(`1,,,/^3`));
    const chordDivDots = chordDivCommands.filter(command => command.kind === "circle");
    const chordDivLines = chordDivCommands.filter(command => command.kind === "line");
    assert(chordDivDots.length === 3 && chordDivLines.length === 1,
        "the chord's lead member must carry its own octave dots and div line");
    assert(chordDivLines[0].y1 < Math.min(...chordDivDots.map(command => command.cy)),
        "the chord div line must stay between the digit and its octave dots");
});

test("up 自己完成成员的堆叠定位与绘制", () => {
    const chord = layoutOf(`1 @up(3, 5) 2`);
    const chordTemporal = chord.objects[1] as VisualTemporalNode & {
        members: readonly { box: LayoutBox }[];
    };
    const [chordLow, chordHigh] = chordTemporal.members;
    assert(chord.objects.length === 3, "up members must stay out of the global visible object list");
    assert(
        nearly(chordLow.box.y + chordLow.box.visualAxis, chord.objects[0].box.y + chord.objects[0].box.visualAxis),
        "the first up member must sit on the track baseline",
    );
    assert(chordHigh.box.y + chordHigh.box.h <= chordLow.box.y, "later up members must stack above the previous one");
    assert(
        nearly(chordLow.box.x + chordLow.box.anchor, chordHigh.box.x + chordHigh.box.anchor),
        "up members must share one horizontal anchor",
    );
    assert(
        recordCommands(chord).filter(command => command.kind === "text").length === 4,
        "up must paint every stacked member",
    );
});

test("大括号阻断展平，内层 up 整体折叠成外层的一个成员", () => {
    const chordTextPositions = (source: string) => recordCommands(layoutOf(source))
        .filter(command => command.kind === "text")
        .map(command => `${command.text}@${command.y.toFixed(4)}`)
        .join(" ");
    const nestedChord = layoutOf(`@up({@up(1,3)}, 5)`).objects[0] as VisualTemporalNode & {
        members: readonly { members?: readonly unknown[] }[];
    };
    assert(nestedChord.members.length === 2 && nestedChord.members[0].members?.length === 2,
        "a braced inner up must stay one member of the outer up");
    assert(chordTextPositions(`@up({@up(1,3)}, 5)`) === chordTextPositions(`@up(1,3,5)`),
        "a nested up must render exactly like the flattened chord");
    assert(chordTextPositions(`@up(@up(1,3), 5)`) === chordTextPositions(`1^3^5`),
        "an unbraced inner up must flatten just like the ^ sugar");
});

test("叠在音符上方的状态标记传出和弦，但不撑宽横向占位", () => {
    const markedTempo = layoutOf(`1 ^ @tempo(120) 1`);
    const markedChord = markedTempo.objects[0] as VisualTemporalNode & {
        members: readonly { box: LayoutBox }[];
        mergeKey: number;
    };
    const markedFollower = markedTempo.objects[1] as VisualTemporalNode & { activeBpm: number };
    assert(markedFollower.activeBpm === 120, "a tempo stacked by ^ must reach the following notes");
    assert(markedChord.mergeKey === DEFAULT_KEY, "a folded member's own merge group must not leak to the chord");
    assert(nearly(markedChord.box.w, markedChord.members[0].box.w),
        "only the lead member decides the chord's horizontal footprint");
    assert(nearly(markedFollower.box.x, layoutOf(`1 1`).objects[1].box.x),
        "a wide upper mark must not push the next note away");

    const markedKey = layoutOf(`1 ^ @1(F#) 1`);
    const markedKeyChord = markedKey.objects[0] as VisualTemporalNode & {
        members: readonly { resolvedMidi?: number }[];
    };
    assert(markedKeyChord.members[0].resolvedMidi === 66 && (markedKey.objects[1] as { resolvedMidi?: number }).resolvedMidi === 66,
        "a key stacked by ^ must apply to its own chord and to the following notes");

    const graceState = layoutOf(`@tempo(60) @tempo(150) > 1 1`);
    assert((graceState.objects[2] as { activeBpm?: number }).activeBpm === 150,
        "a tempo written inside a grace must escape the composite too");
});

/** 谱面上从高到低的数字顺序；y 越小越靠上 */
const stackOrder = (source: string) => recordCommands(layoutOf(source))
    .filter(command => command.kind === "text")
    .sort((a, b) => a.y - b.y)
    .map(command => command.text)
    .join("");

/** 逐位比较两份源码画出的文字位置 */
const glyphPositions = (source: string) => recordCommands(layoutOf(source))
    .filter(command => command.kind === "text")
    .map(command => `${command.text}@${command.y.toFixed(4)}`)
    .join(" ");

test("_ 把成员叠到宿主下方，^ 叠到上方", () => {
    assert(stackOrder(`1 ^ 3`) === "31", "^ 必须把后写的成员放在宿主上方");
    assert(stackOrder(`1 _ 3`) === "13", "_ 必须把后写的成员放在宿主下方");
    assert(glyphPositions(`1 _ 3`) === glyphPositions(`@down(1, 3)`),
        "_ 语法糖必须与 @down 显式调用逐位一致");
    // 宿主留在轨道基线上，所以只向下堆叠时视觉轴不会被抬高
    const upward = layoutOf(`1 ^ 3`).objects[0] as VisualTemporalNode;
    const downward = layoutOf(`1 _ 3`).objects[0] as VisualTemporalNode;
    assert(nearly(upward.box.h, downward.box.h), "两个方向撑开的总高度必须相同");
    assert(downward.box.visualAxis < upward.box.visualAxis,
        "向下堆叠不得抬高视觉轴，否则宿主会离开轨道基线");
});

test("^ 与 _ 混写时全部绑到同一个宿主，像 LaTeX 上下标", () => {
    // 1 是基，2 和 4 是上标，3 和 5 是下标；写成嵌套或链式必须完全一致
    assert(stackOrder(`1^2_3^4_5`) === "42135",
        "混写的上下标必须全部绑到第一个宿主，而不是逐层嵌套");
    assert(glyphPositions(`1^2_3^4_5`) === glyphPositions(`@down(@up(1, 2, 4), 3, 5)`),
        "链式混写必须等价于按方向分组的显式调用");
    // 方向不会串：反过来写只是交换上下标
    assert(stackOrder(`1 _ 3 ^ 5`) === "513", "先写下标再写上标必须仍然绑到同一个宿主");
});

test("混写折叠体的 toString 是可解析的等价写法", () => {
    const foldNode = (source: string) => {
        let found: ASTFunctionNode | undefined;
        const visit = (node: ASTNodeBase) => {
            if (node instanceof ASTFunctionNode && (node.callName === "up" || node.callName === "down")) found ??= node;
            for (const child of node.children ?? []) visit(child);
        };
        visit(parse(source));
        return found;
    };
    // hover 的「替换」按钮直接用这段文本改写源码，写不出来就会生成非法代码
    const source = `1^2_3^4_5`;
    const desugared = foldNode(source)!.toString(source);
    assert(desugared.startsWith("@down(@up("), `混写必须输出嵌套形式，实际是 ${desugared}`);
    assert(glyphPositions(desugared) === glyphPositions(source),
        "替换成去糖写法之后谱面必须逐位不变");
    assert(foldNode(`1 ^ 3`)!.toString(`1 ^ 3`).startsWith("@up("),
        "纯向上的折叠体仍然输出 @up(...)");
});

