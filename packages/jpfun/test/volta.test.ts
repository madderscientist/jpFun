import { test } from "node:test";

import { compilePlayback } from "../src/playback/compile.js";
import { secondsToScoreTime, scoreTimeToSeconds } from "../src/playback/time.js";
import type { RecordedPaintCommand } from "../src/render/recording.js";
import { assert, attachmentCommands, expectSnapshot, layoutOf, lower, nearly, playedNotes } from "./helpers.js";
/** 用相对 C4 的半音数（C4 记作 1）表示演奏序列，断言失败时比 MIDI 号好读 */
function played(source: string) {
    return playedNotes(compilePlayback(lower(source)))
        .map(note => `${note.midi - 59}@${note.start}`).join(" ");
}

test("反复线把段落展开成多遍播放", () => {
    assert(played(`|: 1 2 :|`) === "1@0 3@1 1@2 3@3", "|: :| 之间的内容应播两遍且演奏时间连续");
    assert(played(`1 :| 2`) === "1@0 1@1 3@2", "没有 |: 时 :| 应回到曲首");
    assert(played(`|: 1 |: 2 :| 3 :|`) === "1@0 3@1 3@2 5@3 3@4 5@5",
        "结束反复线应回到此前最近的开始线，与 MuseScore 的 122323 语义一致");
    assert(played(`1 2`) === "1@0 3@1", "没有反复线时播放顺序不变");
});

test("房子只在自己那一遍播放，末尾房子天然落在段外", () => {
    assert(played(`|: 1 2@a :| 3@b || @volta(a, a, 1) @volta(b, b, 2)`) === "1@0 3@1 1@2 5@3",
        "第一房子只在第一遍播，第二房子只在第二遍播");
    assert(played(`|: 1 2@a :| 3@b :| 4@c || @volta(a, a, 1) @volta(b, b, 2) @volta(c, c, 3)`)
        === "1@0 3@1 1@2 5@3 1@4 6@5",
        "写几条反复线就是几遍，同一个 |: 被连续的房子共用");

    assert(played(`|: 1 2@a 3@b :| 5@c 6@d | 7 @volta(a, b, 1) @volta(c, d, 2)`)
        === "1@0 3@1 5@2 1@3 8@4 10@5 12@6",
        "区间可以跨多个音，房子之后的内容不得被吹进去");
});

test("每个反复段的遍数各自从第一遍数起", () => {
    assert(played(`|: 1 3@a :| 5@b || |: 2 6@c :| 7@d || @volta(a,a,1) @volta(b,b,2) @volta(c,c,1) @volta(d,d,2)`)
        === "1@0 5@1 1@2 8@3 3@4 10@5 3@6 12@7",
        "后一个反复段的房子不能因为前面已经反复过而被跳过");
    assert(played(`|: 1 :| |: 2 3@a :| 5@b || @volta(a,a,1) @volta(b,b,2)`) === "1@0 1@1 3@2 5@3 3@4 8@5",
        "前置的无房子反复段不得影响后面那段的遍数计数");
});

test("一个房子可以承担多遍", () => {
    assert(played(`|: 1 2@a :| :| 3@b || @volta(a, a, 1, 2) @volta(b, b, 3)`) === "1@0 3@1 1@2 3@3 1@4 5@5",
        "前两遍都应走第一个房子，第三遍才换房子");
    assert(played(`|: 1 2@a :| :| 3@b || @volta(a, a, 2, 1) @volta(b, b, 3)`) === "1@0 3@1 1@2 3@3 1@4 5@5",
        "遍数乱序或重复不改变行为");
    assert(played(`|: 1 2@a :| 3@b || @volta(a, a, 1, 9) @volta(b, b, 2)`) === "1@0 3@1 1@2 5@3",
        "多余的遍数不影响够得着的那些");
    assert(played(`|: 1 2@a :| 3@b || @volta(a, a, 8, 9) @volta(b, b, 2)`) === "1@0 1@1 5@2",
        "遍数一遍都够不着时该房子就不发声，不做扯回来的保底");
});

test("反复让谱面进度回退，演奏时间继续前进", () => {
    const lowering = lower(`|: 1 2 :|`);
    const plan = compilePlayback(lowering);
    assert(lowering.duration.equals(2) && plan.performanceDuration.equals(4),
        "反复只增加演奏时长，不改变乐谱时长");
    assert(nearly(secondsToScoreTime(plan, 0.5), 1), "第一遍第二拍对应谱面第 1 拍");
    assert(nearly(secondsToScoreTime(plan, 1.0), 0), "跳回后谱面进度应回到段首");
    assert(nearly(secondsToScoreTime(plan, 1.5), 1), "第二遍与第一遍映射到同一段谱面");

    // 点谱面起播应落在第一遍，而不是最后一遍
    assert(nearly(scoreTimeToSeconds(plan, 1), 0.5), "谱面第 1 拍应定位到第一遍");
    for (const score of [0, 0.5, 1, 1.5]) {
        assert(nearly(secondsToScoreTime(plan, scoreTimeToSeconds(plan, score)), score),
            `谱面位置 ${score} 的正反查询应往返自洽`);
    }
    // 第一遍只覆盖到 2 拍，所以它之后的位置得落到第二遍
    const tail = compilePlayback(lower(`|: 1 2 :| 3`));
    assert(nearly(scoreTimeToSeconds(tail, 2), 2), "反复段之后的音符应定位到两遍之后");
});

test("房子按时间列生效，覆盖同一时刻的所有声部", () => {
    // 房子只写在上方声部里，伴奏声部的同时刻内容也跟着被跳过
    const plan = compilePlayback(lower(
        `@stack({|: 1 3@a :| 5@b ||}, {|: 6 7 :| 2 ||}) @volta(a, a, 1) @volta(b, b, 2)`));
    const notes = playedNotes(plan);
    assert(notes.filter(note => note.start.equals(1)).length === 2,
        "第一遍的房子位置上两个声部都应发声");
    const second = notes.filter(note => note.start.compare(2) >= 0);
    assert(second.length === 4, `第二遍应该只剩主体与第二房子共四个音，实际 ${second.length}`);

    // 同一列被两个房子标成互斥的遍数，任一要求跳过即跳过，于是它一遍都轮不上
    const conflict = compilePlayback(lower(
        `|: @stack({1@a}, {5@b}) :| @volta(a, a, 1) @volta(b, b, 2)`));
    assert(playedNotes(conflict).length === 0, "被标成互斥遍数的一列不会发声");
    assert(conflict.diagnostics.some(item => item.code === "W_PLAYBACK_COLUMN_NEVER_PLAYED"),
        "一遍都轮不上的列应报诊断");
});

test("永久跳过的谱面区间定位到下一可达位置", () => {
    const plan = compilePlayback(lower(`1 2@a 3@b 4 @volta(a,b,2)`));
    const next = scoreTimeToSeconds(plan, 3);
    for (const score of [1, 1.5, 2, 2.5]) {
        assert(nearly(scoreTimeToSeconds(plan, score), next),
            `不可达谱面位置 ${score} 应定位到下一段实际播放内容`);
    }
    assert(nearly(secondsToScoreTime(plan, next), 3),
        "从不可达区间定位后应反查到下一可达谱面位置");
});

test("反复段起点是标记，写进和弦里一样找得到", () => {
    // `|:` 折叠进和弦后不在时间列里，游标要沿宿主上溯才能把它当成跳转目标
    assert(played(`1 @up(3, @bar(2)) 5 :|`) === "1@0 5@1 8@2 5@3 8@4",
        "折叠成员上的反复起点应生效，而不是退回曲首");
    assert(played(`1 3 5 :|`) === "1@0 5@1 8@2 1@3 5@4 8@5",
        "没有反复起点时才回到曲首");

    assert(played(`1 @up(3@a,@bar(2)) 5 :| @volta(a,a,2)`) === "1@0 8@1 5@2 8@3",
        "房子首端点与折叠反复起点同列时，应按该起点计算当前遍数");
});

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

    const horizontal = attachmentCommands(house)
        .filter((command): command is Extract<RecordedPaintCommand, { kind: "line" }> =>
            command.kind === "line" && nearly(command.y1, command.y2));
    const objectsOn = (line: number) => layout.objects.filter(object => object.layoutLine === line);
    const firstTimedOn = (line: number) => objectsOn(line).find(object => !object.T.isZero())!;
    const visualRightOn = (line: number) => Math.max(...objectsOn(line).map(object => object.box.x + object.box.w));
    assert(nearly(horizontal[0].x2, visualRightOn(0)) && nearly(horizontal[1].x2, visualRightOn(1)),
        "跨行首段和中间段应止于各自系统的视觉最右边");
    assert(nearly(horizontal[1].x1, firstTimedOn(1).box.x)
        && nearly(horizontal[2].x1, firstTimedOn(2).box.x),
        "跨行中间段和末段应从各自系统的首个正时值主体起笔");

    const vertical = attachmentCommands(house)
        .filter(command => command.kind === "line" && nearly(command.x1, command.x2));
    assert(vertical.length === 2,
        `换行断点处不下折，竖线只应有首末两条，实际 ${vertical.length}`);

    // 中间整行空白时没有主体可参照，仍要补上这一段
    const blank = layoutOf(`1@a @br(2) 2@b @volta(a, b, 1)`).attachments[0];
    assert(blank.regions.length === 3, `空白行也要补一段，实际 ${blank.regions.length}`);
    assert(blank.regions[1].w > blank.regions[0].w && blank.regions[1].w > blank.regions[2].w,
        "空白中间行仍应回退到完整内容区宽度");

    expectSnapshot("volta-cross-line", house.regions.map(region =>
        `line${region.line}=${region.x.toFixed(2)},${region.y.toFixed(2)},`
        + `${region.w.toFixed(2)},${region.h.toFixed(2)}`).join("\n"));
});

test("后声明的跨行房子在空白中间行也排在外层", () => {
    const layout = layoutOf(`1@a @br(2) 2@b @volta(a,b,1) @volta(a,b,1)`);
    const [inner, outer] = layout.attachments;
    assert(inner.regions.length === 3 && outer.regions.length === 3,
        "both houses must bridge the blank middle line");
    const innerMiddle = inner.regions[1];
    const outerMiddle = outer.regions[1];
    assert(outerMiddle.y + outerMiddle.h <= innerMiddle.y + 1e-6,
        "the later house must clear the earlier house on a line without hosts");
});

test("房子端点横移越过另一端时仍产生有效边界", () => {
    const layout = layoutOf(`@adjust({1@a}, dx=700px) 2@b @volta(a,b,1)`);
    const house = layout.attachments[0];
    assert(house.regions.every(region => region.w >= 0),
        "reversed drawing endpoints must not produce negative layout regions");
    const label = attachmentCommands(house).find(command => command.kind === "text");
    assert(label?.kind === "text" && label.x >= house.box.x && label.x <= house.box.x + house.box.w,
        "the volta label must remain inside its reported layout box");
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
    const lastRegion = house.regions.at(-1)!;
    const firstTimedHost = layout.objects.find(object => object.layoutLine === lastLine
        && object.track === lastRegion.track && !object.T.isZero())!;
    assert(nearly(lastLineTop.x1, firstTimedHost.box.x),
        "跨行房子的续行入口应跳过声部名，从本轨首个正时值主体起笔");

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
