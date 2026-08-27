import { test } from "node:test";

import { assert, attachmentCommands, expectSnapshot, layoutOf, nearly } from "./helpers.js";

test("括线两端贴在相邻的小节线上", () => {
    const layout = layoutOf(`|: 1 2 | 3@a 4@b :| 5@c 6@d || @volta(a, b, 1) @volta(c, d, 2)`);
    const anchors = layout.objects
        .filter(object => object.ast.toString("").startsWith("@bar"))
        .map(bar => bar.box.x + bar.box.anchor);
    assert(anchors.length === 4, `应有四条小节线，实际 ${anchors.length}`);

    const [first, second] = layout.attachments.map(attachment => {
        const top = attachmentCommands(attachment).find(command => command.kind === "line")!;
        return [top.x1, top.x2];
    });
    // 右沿正压在小节线上，左沿右移一小段让开它；让开多少是可调的视觉参数
    assert(nearly(first[1], anchors[2]) && nearly(second[1], anchors[3]),
        "两个房子的右沿应压在反复线和终止线上");
    const gap = first[0] - anchors[1];
    assert(gap > 0 && gap < anchors[2] - anchors[1],
        "第一房子的左沿应在中间的小节线右侧一小段处");
    assert(nearly(second[0] - anchors[2], gap),
        "第二房子的左沿应让开反复线同样的距离");

    // 两侧都没有小节线时仍按内容取边
    const bare = layoutOf(`1 2 3@a 4@b 5 @volta(a, b, 1)`);
    const line = attachmentCommands(bare.attachments[0]).find(command => command.kind === "line")!;
    const notes = bare.objects;
    assert(line.x1 > notes[1].box.x + notes[1].box.w && line.x2 < notes[4].box.x,
        "没有相邻小节线时括线只覆盖自己的内容");
});

test("跨谱面行时逐行补满，只有真正的首尾下折", () => {
    const layout = layoutOf(`|: 1 2 | 3@a @br() 4 @br() 5@b :| 5 5 || @volta(a, b, 1)`);
    const house = layout.attachments[0];
    assert(house.regions.length === 3, `跨三行应各画一段，实际 ${house.regions.length}`);

    const [top, middle, bottom] = house.regions;
    assert(nearly(middle.x, bottom.x), "中间行与末行都应从页面左边缘起笔");
    assert(nearly(middle.x + middle.w, top.x + top.w), "中间行与首行都应画到页面右边缘");
    assert(middle.w > top.w && middle.w > bottom.w, "整行的中间段应比首末段更宽");

    const vertical = attachmentCommands(house)
        .filter(command => command.kind === "line" && nearly(command.x1, command.x2));
    assert(vertical.length === 2,
        `换行断点处不下折，竖线只应有首末两条，实际 ${vertical.length}`);

    // 中间整行空白时没有主体可参照，仍要补上这一段
    const blank = layoutOf(`1@a @br(2) 2@b @volta(a, b, 1)`).attachments[0];
    assert(blank.regions.length === 3, `空白行也要补一段，实际 ${blank.regions.length}`);

    expectSnapshot("volta-cross-line", house.regions.map(region =>
        `line${region.line}=${region.x.toFixed(2)},${region.y.toFixed(2)},`
        + `${region.w.toFixed(2)},${region.h.toFixed(2)}`).join("\n"));
});

test("房子端点换到另一轨时仍跨到终点所在行", () => {
    const source = `1@x

N: 2@y 3
N: 45

@volta(x,y,1)`;
    const layout = layoutOf(source);
    const house = layout.attachments.find(attachment =>
        attachment.sourceSpan?.start === source.indexOf("@volta"))!;
    assert(house.regions.length === 2,
        `跨轨端点位于下一行时应画两段，实际 ${house.regions.length}`);
    const lastLine = house.regions.at(-1)!.line!;
    const lineTop = Math.min(...layout.objects
        .filter(object => object.layoutLine === lastLine)
        .map(object => object.box.y));
    const lastLineTop = attachmentCommands(house)
        .filter(command => command.kind === "line")
        .filter(command => nearly(command.y1, command.y2))
        .at(-1)!;
    assert(lastLineTop.y1 < lineTop, "跨行房子应画在 voices 全部主体的上方");

    const lowerSource = `1@x

N: @set(fontsize=2em) 2 @set(fontsize=1em) 3
N: 4@y 5

@volta(x,y,1)`;
    const lowerLayout = layoutOf(lowerSource);
    const lowerHouse = lowerLayout.attachments.find(attachment =>
        attachment.sourceSpan?.start === lowerSource.indexOf("@volta"))!;
    const topHost = lowerLayout.objects.find(object =>
        object.ast.sourceSpan.start === lowerSource.indexOf("2 @set"))!;
    const lastHorizontal = attachmentCommands(lowerHouse)
        .filter(command => command.kind === "line")
        .filter(command => nearly(command.y1, command.y2))
        .at(-1)!;
    const topRight = topHost.box.x + (topHost.ports["body.right"]?.x ?? topHost.box.w);
    assert(nearly(lastHorizontal.x2, topRight),
        "终点标签在下声部时，房子右端仍应取该列最上面的对象");
});

test("括线高度只看房子覆盖的列", () => {
    // 高标记会把整行的轴一起压低，所以只能比相对距离
    const clearance = (source: string) => {
        const layout = layoutOf(source);
        const house = layout.attachments.find(attachment =>
            attachment.sourceSpan?.start === source.indexOf("@volta"))!;
        const top = attachmentCommands(house)
            .filter(command => command.kind === "line")
            .find(command => nearly(command.y1, command.y2))!.y1;
        const end = layout.objects.find(object =>
            object.ast.sourceSpan.start === source.indexOf("3@b"))!;
        return end.box.y - top;
    };

    const plain = clearance(`|: 1 2@a 3@b :| 4 5 || @volta(a, b, 1)`);
    const outside = clearance(`|: 1 2@a 3@b :| 4 ^ @tempo(120) 5 || @volta(a, b, 1)`);
    assert(nearly(plain, outside), `区间外的高标记不该抬高括线，${plain} vs ${outside}`);

    const inside = clearance(`|: 1 2@a ^ @tempo(120) 3@b :| 4 5 || @volta(a, b, 1)`);
    assert(inside > plain + 1, `区间内的高标记应把括线顶上去，${inside} vs ${plain}`);
});

test("房子画出上方括线、两端下折和遍数标签", () => {
    const layout = layoutOf(`|: 1 2@a :| 3@b || @volta(a, a, 1) @volta(b, b, 2)`);
    assert(layout.attachments.length === 2, `两个房子各产生一条括线，实际 ${layout.attachments.length}`);

    const commands = attachmentCommands(layout.attachments[0]);
    const lines = commands.filter(command => command.kind === "line");
    assert(lines.length === 3, `一条括线由顶线和两个折角组成，实际 ${lines.length}`);

    const [top, left, right] = lines;
    assert(nearly(top.y1, top.y2) && top.x2 > top.x1, "第一条应是水平的顶线");
    assert(nearly(left.x1, left.x2) && left.y2 > left.y1, "左端应向下折");
    assert(nearly(right.x1, right.x2) && right.y2 > right.y1, "右端同样向下折");
    assert(nearly(left.x1, top.x1) && nearly(right.x1, top.x2), "两个折角应落在顶线两端");

    const labels = commands.filter(command => command.kind === "text");
    assert(labels.length === 1 && labels[0].text === "1.", "第一房子应写出一个 1. 标签");
    assert(labels[0].y > top.y1 && labels[0].x > left.x1, "标签应写在括线内侧");

    const second = attachmentCommands(layout.attachments[1]).filter(command => command.kind === "text");
    assert(second.length === 1 && second[0].text === "2.", "第二房子的标签应是 2.");

    const shared = layoutOf(`|: 1 2@a :| :| 3@b || @volta(a, a, 1, 2) @volta(b, b, 3)`);
    const sharedLabel = attachmentCommands(shared.attachments[0]).find(command => command.kind === "text")!;
    assert(sharedLabel.text === "1.2.", `共用房子的标签应把遍数依次写出，实际 ${sharedLabel.text}`);

    // 括线高度、下折长度、描边粗细和标签位置都是只能肘眼确认一次的视觉参数
    const box = layout.attachments[0].box;
    expectSnapshot("volta-bracket", [
        `box=${box.x.toFixed(2)},${box.y.toFixed(2)},${box.w.toFixed(2)},${box.h.toFixed(2)}`,
        `label=${labels[0].x.toFixed(2)},${labels[0].y.toFixed(2)},${labels[0].style.fontSize.toFixed(2)}`,
        `lines=${lines.map(line =>
            `${line.x1.toFixed(2)},${line.y1.toFixed(2)}-${line.x2.toFixed(2)},${line.y2.toFixed(2)}`)
            .join(";")}`,
    ].join("\n"));
});
