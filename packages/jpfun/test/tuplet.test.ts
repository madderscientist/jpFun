import { test } from "node:test";

import type { TemporalNodeBase, VisualTemporalNode } from "../src/lowering/types.js";
import {
    assert,
    attachmentCommands,
    expectCompileError,
    expectSnapshot,
    layoutOf,
    lower,
} from "./helpers.js";

test("tuplet 从内容推导单位数并精确缩放时间", () => {
    const result = lower(`@tuplet({1/23},4) 4`);
    const events = result.columns.map(column => column[0]);

    assert(events.length === 4, "tuplet must keep every member in the global time columns");
    assert(events[0].t.equals(0) && events[0].T.equals(2, 5), "the eighth member must become 2/5 QN");
    assert(events[1].t.equals(2, 5) && events[1].T.equals(4, 5), "the second member must start at 2/5 QN");
    assert(events[2].t.equals(6, 5) && events[2].T.equals(4, 5), "the third member must end the tuplet at 2 QN");
    assert(events[3].t.equals(2) && result.duration.equals(3), "the following event must start at the rewritten cursor");
});

test("tuplet 支持等长、扩张与嵌套比例", () => {
    const triplet = lower(`@tuplet({1/2/3/},2)`).columns.map(column => column[0]);
    assert(triplet.every(event => event.T.equals(1, 3)), "three eighth notes in two units must each last 1/3 QN");

    const duplet = lower(`@tuplet({12},3)`);
    assert(duplet.duration.equals(3) && duplet.columns[1][0].t.equals(3, 2),
        "two quarter notes in three units must expand to 3/2 QN each");

    const nested = lower(`@tuplet({@tuplet({1/2/3/},2) 4},3)`);
    assert(nested.duration.equals(1), "nested tuplets must compose from inner to outer using exact fractions");
});

test("tuplet 拒绝无时值、非法比例与并行内容", () => {
    expectCompileError(`@tuplet({@text(A)},2)`, "E_TUPLET_EMPTY");
    expectCompileError(`@tuplet({1/. 2/},2)`, "E_TUPLET_NON_INTEGRAL_UNITS");
    expectCompileError(`@tuplet({12},2)`, "E_TUPLET_INVALID_RATIO");
    expectCompileError(`@tuplet({1&2},3)`, "E_TUPLET_PARALLEL_CONTENT");
    expectCompileError(`@tuplet({12},0)`, "E_TUPLET_INVALID_NORMAL");
    expectCompileError(`@tuplet({1 @br() 2},3)`, "E_TUPLET_CROSS_LINE");
});

test("tuplet 的最终时间供拍号和自动连梁使用", () => {
    const metered = lower(`@meter(2,4) @tuplet({1/23},4) |`);
    assert(!metered.diagnostics.some(diagnostic => diagnostic.code === "W_METER_MISMATCH"),
        "meter must validate the tuplet's rewritten 2 QN duration");

    const beamed = lower(`@tuplet({1/2/3/},2)`);
    assert(beamed.attachments.length === 2,
        "three divided tuplet members must create one automatic beam plus one tuplet bracket");
});

test("tuplet 在 onTimeState 向 up 与 grace 的隐藏成员同步最终宿主时值", () => {
    const up = lower(`@tuplet({@up(1.,3) 2.},1)`).columns[0][0] as TemporalNodeBase & {
        members: readonly TemporalNodeBase[];
    };
    assert(up.T.equals(3, 4) && up.members.every(member => member.T.equals(3, 4)),
        "up members must receive the rewritten chord duration");

    const grace = lower(`@tuplet({2>1 3},3)`).columns[0][0] as TemporalNodeBase & {
        host: TemporalNodeBase;
        graces: readonly TemporalNodeBase[];
    };
    assert(grace.T.equals(3, 2) && grace.host.T.equals(3, 2),
        "the grace host must receive the rewritten composite duration");
    assert(grace.graces[0].T.equals(1, 2), "grace members must preserve their written duration");
});

test("tuplet 在整组上方绘制居中的单位数与括线", () => {
    const result = layoutOf(`@tuplet({1/23},4)`);
    const attachment = result.attachments.find(item =>
        attachmentCommands(item).some(command => command.kind === "text" && command.text === "5"),
    );
    assert(attachment, "tuplet must create an attachment that displays the inferred actual count");

    const commands = attachmentCommands(attachment);
    const number = commands.find(command => command.kind === "text" && command.text === "5");
    const lines = commands.filter(command => command.kind === "line");
    const members = result.objects as VisualTemporalNode[];
    const memberLeft = members[0].box.x + (members[0].ports["body.left"]?.x ?? 0);
    const memberRight = members.at(-1)!.box.x
        + (members.at(-1)!.ports["body.right"]?.x ?? members.at(-1)!.box.w);
    assert(number?.kind === "text", "tuplet must draw its actual count as text");
    assert(lines.length === 4, "tuplet must draw two horizontal segments and two end hooks");
    assert(Math.abs(number.x - (memberLeft + memberRight) / 2) < 1e-6,
        "the tuplet number must be centered over the member span");
    assert(attachment.box.y < Math.min(...members.map(member => member.box.y)),
        "the tuplet bracket must reserve space above its members");

    expectSnapshot("tuplet-bracket", [
        `box=${attachment.box.x.toFixed(2)},${attachment.box.y.toFixed(2)},${attachment.box.w.toFixed(2)},${attachment.box.h.toFixed(2)}`,
        `number=${number.x.toFixed(2)},${number.y.toFixed(2)},${number.style.fontSize.toFixed(2)}`,
        `lines=${lines.map(line => `${line.x1.toFixed(2)},${line.y1.toFixed(2)}-${line.x2.toFixed(2)},${line.y2.toFixed(2)}`).join(";")}`,
    ].join("\n"));
});