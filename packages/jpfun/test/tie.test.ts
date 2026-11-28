import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";

import type { PlacedAttachment } from "../src/layout/types.js";
import { compileScore } from "../src/pipeline.js";
import type { PathCommand } from "../src/render/types.js";
import { compilePlayback } from "../src/playback/compile.js";
import { assert, attachmentCommands, commandsOfKind, compileValid, layoutOf, lower, nearly, playedNotes, recordCommands } from "./helpers.js";

type LayoutObject = ReturnType<typeof layoutOf>["objects"][number];
type Composite = LayoutObject & {
    members: readonly LayoutObject[];
    host: LayoutObject;
    graces: readonly LayoutObject[];
};
type PathDraw = Extract<ReturnType<typeof attachmentCommands>[number], { kind: "path" }>;

const tiePaths = (attachment: PlacedAttachment) =>
    attachmentCommands(attachment).filter((command): command is PathDraw => command.kind === "path");

/** 连音线路径的起点（首个 M 指令） */
function startOf(path: PathDraw | undefined) {
    const start = path?.commands[0];
    if (start?.op !== "M") throw new Error("expected tie path to start with M");
    return start;
}

/** 两个控制点同高的三次贝塞尔，实际弧高是抬高的 3/4 */
function tieApexHeight(path: { commands: readonly PathCommand[] }) {
    const [start, outer] = path.commands;
    if (start.op !== "M" || outer.op !== "C") throw new Error("unexpected tie path shape");
    return (start.y - outer.cy1) * 0.75;
}

const opsOf = (path: { commands: readonly PathCommand[] }) =>
    path.commands.map(command => command.op).join(",");

test("增时线参与显式及默认连音端点，但不合并播放音符", () => {
    for (const source of [
        `1 -@a 1@b @tie(a,b)`,
        `1@a -@b 1 @tie(a,b)`,
        `1 1 - @tie()`,
        `1 - 1 @tie()`,
    ]) {
        const layout = layoutOf(source);
        const start = source.startsWith("1@a") ? layout.objects[0] : layout.objects[1];
        assert(nearly(startOf(tiePaths(layout.attachments[0])[0]).x, start.box.x + (start.ports["tie.top"]?.x ?? start.box.w / 2)),
            "default endpoints must include the recent dash instead of skipping it");
        const plan = compilePlayback(lower(source));
        const notes = playedNotes(plan);
        assert(notes.length === 2 && notes[0].midi === 60 && notes[1].midi === 60
            && notes[0].duration.clone().add(notes[1].duration).equals(3)
            && notes[1].start.equals(notes[0].duration),
        "a tie involving a dash must leave two separately articulated notes");
    }
});

test("连音线弧高支持自动跨度缩放、显式长度、作用域继承与跨行固定高度", () => {
    const smallTiePath = commandsOfKind(`1@a 2@b @tie(a,b,height=0.5em)`, "path", 20)[0];
    const largeTiePath = commandsOfKind(`1@a 2@b @tie(a,b,height=0.5em)`, "path", 40)[0];
    assert(nearly(tieApexHeight(largeTiePath), tieApexHeight(smallTiePath) * 2), "tie geometry scales with fontSize");
    assert(nearly(tieApexHeight(commandsOfKind(`1@a 2@b @tie(a,b,height=10px)`, "path")[0]), 10), "fixed length height");

    const autoPaths = commandsOfKind("1@a 2@b 3 4 5 6 7 1@c @tie(a,b,c)", "path", 20);
    assert(tieApexHeight(autoPaths[0]) < tieApexHeight(autoPaths[1]) && nearly(tieApexHeight(autoPaths[1]), 10),
        "automatic height grows with span and caps at 0.5em");
    const [graceTiePath] = tiePaths(layoutOf("{1@a 2 3 4 5 6 7 1@b @tie(a,b)}>3", 20).attachments[0]);
    assert(nearly(tieApexHeight(graceTiePath), 7), "grace tie automatic height scales with endpoint font size");
    deepStrictEqual(commandsOfKind("1@a 2@b @tie(a,b,height=0)", "path"), commandsOfKind("1@a 2@b @tie(a,b)", "path"));

    const crossAuto = commandsOfKind("1@a @br() 2@b @tie(a,b)", "path", 20);
    const crossFixed = commandsOfKind("1@a @br() 2@b @tie(a,b,height=0.45em)", "path", 20);
    deepStrictEqual(crossAuto, crossFixed, "cross-line automatic height uses 0.45em");

    const inherited = compileValid("@set(tie.height=2em) 1@a 2@b @tie(a,b)");
    strictEqual(inherited.ast.content.at(-1)!.toString("@set(tie.height=2em) 1@a 2@b @tie(a,b)"), "@tie(a, b, height=36px)");
    assert(compileScore("1@a 2@b @tie(a,b,height=bad)").diagnostics.some(d => d.code === "W_INVALID_LENGTH"), "invalid length");
});

test("ties leave a small font-relative gap above upper octave dots", () => {
    const tieAndDots = (source: string) => {
        const layout = layoutOf(source, 20);
        const start = startOf(tiePaths(layout.attachments[0])[0]);
        const dots = recordCommands(layout).filter(command => command.kind === "circle").filter(dot => nearly(dot.cx, start.x));
        return { start, dots };
    };
    const single = tieAndDots("1'@a 2'@b @tie(a,b)");
    const dots = single.dots.filter(dot => dot.cy > single.start.y);
    assert(dots.length > 0 && nearly(Math.min(...dots.map(dot => dot.cy - dot.r)) - single.start.y, 2),
        "the tie endpoint must stay 0.1em above the uppermost dot");

    const chord = tieAndDots("2@x ^3, 2@y ^3, @tie(x,y)");
    assert(chord.dots.length === 1 && chord.start.y - (chord.dots[0].cy + chord.dots[0].r) > 20 * 0.3,
        "heightening a tied lower chord member must push the upper member's lower octave dot clear of the tie arc");
});

test("同轨连音线上方留空按显式弧高估算，同一端点取各连音线的最大值", () => {
    const measure = (source: string) => {
        const layout = layoutOf(source, 20);
        const upper = (layout.objects[0] as Composite).members[1];
        const path = tiePaths(layout.attachments[0])[0];
        return { upper: { right: upper.box.x + upper.box.w, bottom: upper.box.y + upper.box.h }, path };
    };
    const gap = (source: string) => {
        const { upper, path } = measure(source);
        return startOf(path).y - upper.bottom;
    };
    const auto = gap("2@x ^3, 2@y ^3, @tie(x,y)");
    const tall = gap("2@x ^3, 2@y ^3, @tie(x,y,height=1em)");
    assert(tall > auto + 4, `显式 1em 弧高应比自动弧高预留更多空间: ${tall} vs ${auto}`);
    assert(nearly(gap("2@x ^3, 2@y ^3, @tie(x,y) @tie(x,y,height=1em)"), tall)
        && nearly(gap("2@x ^3, 2@y ^3, @tie(x,y,height=1em) @tie(x,y)"), tall),
    "同一端点上的多条连音线应按最大弧高留空，与书写顺序无关");

    // 跨度不小于参考跨度 2.5em 时，弧线外缘经过上方成员的水平范围内不得穿入该成员
    const { upper, path: { commands: [start, outer] } } = measure("2@x ^3, 4 2@y ^3, @tie(x,y,height=1em)");
    assert(start.op === "M" && outer.op === "C", "unexpected tie path shape");
    for (let i = 0; i <= 100; i++) {
        const t = i / 100, s = 1 - t;
        const x = s ** 3 * start.x + 3 * s * s * t * outer.cx1 + 3 * s * t * t * outer.cx2 + t ** 3 * outer.x;
        const y = s ** 3 * start.y + 3 * s * s * t * outer.cy1 + 3 * s * t * t * outer.cy2 + t ** 3 * outer.y;
        if (x <= upper.right) assert(y >= upper.bottom - 1e-6, `弧线在 x=${x} 处穿入上方成员: ${y} < ${upper.bottom}`);
    }
});

test("up/grace 成员上的标签连接该成员，整体之后的标签连接整个 up 或穿透到 grace 宿主", () => {
    const portOf = (object: LayoutObject) => ({
        x: object.box.x + (object.ports["tie.top"]?.x ?? object.box.anchor),
        y: object.box.y + (object.ports["tie.top"]?.y ?? 0),
    });
    const tieStart = (source: string) => {
        const layout = layoutOf(source);
        return { start: startOf(tiePaths(layout.attachments[0])[0]), node: layout.objects[0] as Composite };
    };

    const memberTie = tieStart(`{1@x}^{@1(C4)} 2@y @tie(x,y)`);
    assert(nearly(memberTie.start.y, portOf(memberTie.node.members[0]).y) && !nearly(memberTie.start.y, portOf(memberTie.node).y),
        "a tie from an up member label must use that member's own top port");
    const chordTie = tieStart(`{1^@1(C4)}@x 2@y @tie(x,y)`);
    assert(nearly(chordTie.start.y, portOf(chordTie.node).y) && !nearly(chordTie.start.y, portOf(chordTie.node.members[0]).y),
        "a tie from an up label must use the whole chord's top port");

    const graceTie = tieStart(`@grace({1},{2@x}) 3@y @tie(x,y)`);
    const gracePort = portOf(graceTie.node.graces[0]);
    assert(nearly(graceTie.start.x, gracePort.x) && nearly(graceTie.start.y, gracePort.y),
        "a label on a grace member must use that member's own port");
    const hostTie = tieStart(`@grace({1},{2})@x 3@y @tie(x,y)`);
    const hostPort = portOf(hostTie.node.host);
    assert(nearly(hostTie.start.x, hostPort.x) && nearly(hostTie.start.y, hostPort.y)
        && !nearly(hostTie.start.y, portOf(hostTie.node.graces[0]).y),
    "a label after grace must delegate to the host's labelable node");
});

test("跨系统连音线按首、中、尾分段绘制", () => {
    const twoLines = layoutOf(`1@a @br() 2@b @tie(a,b)`);
    assert(twoLines.objects[0].box.y > 0, "the first tie segment must push its note row down");
    // 首段升起、伸到右缘后折回；中段是一整条横带；尾段从左缘进入、落下后折回
    deepStrictEqual(tiePaths(twoLines.attachments[0]).map(opsOf), ["M,Q,L,L,L,Q,Z", "M,L,Q,Q,L,Z"]);
    deepStrictEqual(commandsOfKind(`1@a @br() 2 @br() 3@b @tie(a,b)`, "path").map(opsOf),
        ["M,Q,L,L,L,Q,Z", "M,L,L,L,Z", "M,L,Q,Q,L,Z"]);

    const emptyMiddle = layoutOf(`1@a @br() @br() 2@b @tie(a,b)`);
    const emptyMiddlePaths = tiePaths(emptyMiddle.attachments[0]);
    assert(emptyMiddle.lineCount === 3 && emptyMiddlePaths.length === 3,
        "a tie spanning br(2) must preserve its empty middle system and still emit three segments");
    assert(emptyMiddlePaths[1].commands.every(command => command.op === "Z" || command.y > 0),
        "an attachment-only middle system must receive a final positive visual-axis position");
});

test("短行跨行连音线的首尾段最短时只有起落弧", () => {
    const layout = layoutOf(`3@x

4@tie()`);
    const firstLineRight = Math.max(...layout.objects
        .filter(object => object.layoutLine === 0)
        .map(object => object.box.x + object.box.w));
    const curveWidth = layout.objects[0].ast.size * 0.45 * 1.2;
    const [opening, closing] = [0, 1].map(line => layout.attachments[0].regions.find(region => region.line === line));
    assert(opening && opening.x + opening.w >= firstLineRight,
        "a short opening tie segment must cover its system's actual content edge");
    assert(nearly(opening.w, curveWidth) && closing && nearly(closing.w, curveWidth),
        "short opening/closing tie segments must be exactly one rising/falling curve wide");

    const [openingPath, closingPath] = tiePaths(layout.attachments[0]);
    const [, openingCurve, openingLine] = openingPath.commands;
    assert(openingCurve.op === "Q" && openingLine.op === "L" && nearly(openingCurve.x, openingLine.x),
        "the shortest opening segment must have no horizontal line");
    const [closingStart, closingLine] = closingPath.commands;
    assert(closingStart.op === "M" && closingLine.op === "L" && nearly(closingStart.x, closingLine.x),
        "the shortest closing segment must have no horizontal line");
});

test("进入多声部系统的连音线尾段从大括号右侧、中段端点从该 Track 首音开始", () => {
    const closingStart = (source: string) => {
        const layout = layoutOf(source);
        const tie = layout.attachments.find(attachment => attachment.sourceSpan?.start === source.indexOf("@tie"));
        assert(tie, "the sample must create a tie");
        return { layout, start: startOf(tiePaths(tie).at(-1)) };
    };
    const braced = closingStart(`1@a @br()\n@voices(@voice({2@b 3}, A), @voice({4 5}, B))\n@tie(a,b)`);
    const brace = braced.layout.attachments.find(attachment => attachment.layer === "background");
    assert(brace && braced.start.x >= brace.regions[0].x + brace.regions[0].w,
        "the closing tie segment must not pass through the voices brace");

    const source = `3@x\n\nN: 44@tie(x)\nN: 3`;
    const midTrack = closingStart(source);
    const firstFour = midTrack.layout.objects.find(object => object.ast.sourceSpan.start === source.indexOf("44"));
    assert(firstFour && nearly(midTrack.start.x, firstFour.box.x),
        "the closing tie segment must start at the target track's leftmost note edge");
});

test("连音线可以跨行与跨轨，首尾弧从端点固定抬高", () => {
    const closingPath = tiePaths(layoutOf(`@set(tie.height=0.5em) 1@x\n\n@up(3,4) 5@y @tie(x,y)`).attachments[0]).at(-1)!;
    const closingPlateau = closingPath.commands[2];
    assert(closingPlateau.op === "Q" && nearly(closingPlateau.y - startOf(closingPath).y, 9),
        "a closing tie plateau must be exactly one configured height above its endpoint");

    const [openingPath] = tiePaths(layoutOf(`@set(tie.height=0.5em) @up(3,4) 5@x @br() 1@y @tie(x,y)`).attachments[0]);
    const openingPlateau = openingPath.commands[1];
    assert(openingPlateau.op === "Q" && nearly(startOf(openingPath).y - openingPlateau.y, 9),
        "an opening tie plateau must be exactly one configured height above its endpoint");

    const compactCrossTrackTie = layoutOf(`
@page(width=200px,height=150px,top=10px,bottom=10px,left=10px,right=10px)
@stack({1@a 2},{3 4@b}) @tie(a,b,height=60px)
`);
    const compactTieBox = compactCrossTrackTie.attachments[0].regions[0];
    assert(compactCrossTrackTie.pages.length === 1 && compactTieBox.y >= 10 - 1e-6 && compactTieBox.y + compactTieBox.h <= 140 + 1e-6,
        "a cross-track tie must not duplicate its height across tracks and must stay inside the page content area");
});

test("跨轨连音线只占用主体上方，不撑开两条轨之间的间距", () => {
    // 弧的下半截属于另一条轨；若整段都记给较高的那条轨，两支之间的空档会被重复计入
    const measure = (source: string) => {
        const [lower, upper] = layoutOf(source).objects;
        return { gap: lower.box.y - upper.box.y, top: upper.box.y };
    };
    const plain = measure(`@stack({1@a},{2@b})`);
    const shortTied = measure(`@stack({1@a},{2@b}) @tie(a,b)`);
    const tied = measure(`@stack({1@a},{2@b}) @tie(a,b,height=60px)`);
    assert(nearly(shortTied.gap, tied.gap), `a cross-track tie must not widen the branch gap: ${shortTied.gap} -> ${tied.gap}`);
    assert(tied.top - plain.top > 40, "a cross-track tie must still reserve its own height above the upper track");
});

test("跨越空谱面行的连音线只占自己的带宽", () => {
    // 空行没有主体可以让出下半截，此时整段弧带就是它自己的全部占用
    const middle = layoutOf(`@set(br.gap=0px) 1@a @br() @br() @br() 2@b @tie(a,b)`).attachments[0].regions
        .filter(region => region.line === 1 || region.line === 2)
        .sort((left, right) => left.y - right.y);
    assert(middle.length === 2 && nearly(middle[1].y - middle[0].y, middle[0].h),
        "a tie crossing empty systems must draw one band per system and reserve only that band");
});

test("跨页连音线每个逻辑系统一段，几何保持有限", () => {
    const layout = layoutOf(`
@page(width=200px, height=80px, top=10px, bottom=10px, left=20px, right=20px) @set(br.gap=5px)
1@a @br() 2 @br() 3 @br() 4@b @tie(a,b)
`);
    const tie = layout.attachments[0];
    assert(layout.pages.length > 1 && layout.pages.every(page => page.lineEnd > page.lineStart),
        "the cross-page tie sample must span multiple non-empty pages");
    assert(tiePaths(tie).length === 4, "a cross-page tie must retain one segment per logical system");
    assert(tie.regions.every(region => [region.x, region.y, region.w, region.h].every(Number.isFinite)),
        "cross-page tie geometry must stay finite");
});

test("普通连音线与八度点借用行间留白不拉大行距，超高外扩按 minGap 保底推开", () => {
    const plain = layoutOf(`1 2 3 4 @br() 1 2 3 4`);
    const line0Bottom = plain.objects[0].box.y + plain.objects[0].box.h;
    const line1Axis = (layout: typeof plain) => {
        const node = layout.objects.find(item => item.layoutLine === 1 && !item.T.isZero())!;
        return node.box.y + node.box.visualAxis;
    };
    for (const source of [
        `1 2 3 4 @br() 1@a 2@b 3 4 @tie(a,b)`,
        `1 2 3 4 @br() 1'' 2 3 4`,
        `1 2 3 4 @br() 1 ^ $tenuto 2 3 4`,
        `1 2 3 4 @br() 1 ^ $fermata 2 3 4`,
    ]) {
        assert(nearly(line1Axis(layoutOf(source)), line1Axis(plain)), `${source} must borrow lineGap without pushing line 1`);
    }
    for (const [source, minGap] of [
        [`1 2 3 4 @br() 1 ^ @symbol(fermata, 0.6em) 2 3 4`, 7.2],
        [`N: 1 2 3\n\nN: 1 2 3^4`, 7.2],
        [`@set(br.gap=1em, br.minGap=0.8em)\nN: 1 2 3\n\nN: 1 2 3^4`, 18 * 0.8],
    ] as const) {
        const top = Math.min(...layoutOf(source).objects.filter(n => n.layoutLine === 1 && !n.T.isZero()).map(n => n.box.y));
        assert(nearly(top - line0Bottom, minGap), `${source} must keep ${minGap}px minGap`);
    }
    assert(nearly(layoutOf(`1 2 3 4 @br() 1@a 2@b 3 4 @tie(a,b,height=30px)`).attachments[0].regions[0].y - line0Bottom, 7.2),
        "an oversized tie must keep the default 7.2px minGap");

    // 歌词位于基线下方，行距从歌词底部算起；下一行的普通 tie 仍借用这段行距
    const lyricPlain = layoutOf(`@voice({1 2}, , "甲 乙") @br() @voice({3 4})`);
    const lyricTied = layoutOf(`@voice({1 2}, , "甲 乙") @br() @voice({3@a 4@b @tie(a,b)})`);
    const lyricBox = lyricPlain.attachments[0].regions[0];
    assert(nearly(line1Axis(lyricPlain) - 9 - (lyricBox.y + lyricBox.h), 18)
        && nearly(line1Axis(lyricTied), line1Axis(lyricPlain)),
        "lyrics must preserve full lineGap below them while allowing next-line ties to borrow it");
});

test("carry：延音线不跨小节顺延变音，小节内被连接音沿用记忆并合并播放", () => {
    const C = "@set(note.carry=true) ";
    const played = (source: string) => playedNotes(compilePlayback(lower(C + source)))
        .map(note => [note.midi, note.duration.toString()]);
    deepStrictEqual(played("#1 | 1@tie() 1"), [[61, "1"], [60, "1"], [60, "1"]]);
    deepStrictEqual(played("1 2 3 #4 | #4@tie() n4 4"), [[60, "1"], [62, "1"], [64, "1"], [66, "2"], [65, "1"], [65, "1"]]);
    deepStrictEqual(played("#1 1@tie() 1"), [[61, "2"], [61, "1"]]);
});
