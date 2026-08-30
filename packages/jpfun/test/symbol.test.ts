import { test } from "node:test";

import { analyzeScoreSyntax } from "../src/pipeline.js";
import { compilePlayback } from "../src/playback/compile.js";
import { assert, expectDiagnostic, layoutOf, lower, nearly, parse, playedNotes, recordCommands } from "./helpers.js";

test("$name 由词法层识别为完整的 symbol 原子", () => {
    const source = `$tr`;
    const { syntax, diagnostics } = analyzeScoreSyntax(source);
    assert(diagnostics.length === 0, "合法 symbol 糖在词法层不应报错");
    assert(syntax.tokens.length === 1 && syntax.tokens[0].kind === "atom",
        "symbol 糖应产生一个 atom token");
    assert(syntax.tokens[0].span.start === 0 && syntax.tokens[0].span.end === source.length,
        "symbol token 应覆盖完整名称");
});

test("未登记的 symbol 在语义层明确报错", () => {
    expectDiagnostic(() => parse(`$not-registered`), "E_UNKNOWN_SYMBOL");
    expectDiagnostic(() => parse(`@symbol(not-registered)`), "E_UNKNOWN_SYMBOL");
});

test("effect 类符号只影响同一 up 中位于其下方的成员", () => {
    assert(playedNotes(compilePlayback(lower(`1 ^ $accent`)))[0].velocity === 100, "$accent 应增强下方音符力度");
    assert(playedNotes(compilePlayback(lower(`$accent 1`)))[0].velocity === 80, "独立写出的 effect 不能泄漏到后继音符");

    const split = playedNotes(compilePlayback(lower(`1 ^ $accent ^ 3`)));
    assert(split[0].midi === 64 && split[0].velocity === 80,
        "位于 symbol 上方的 up 成员不应受影响");
    assert(split[1].midi === 60 && split[1].velocity === 100,
        "位于 symbol 下方的 up 成员应接收 modifier");

    // 大括号阻断展平，$accent 落在中间那层里；它下方还有外层自己的成员
    const nested = playedNotes(compilePlayback(lower(`1 ^ {3 ^ $accent} ^ 5`)));
    assert(nested.map(note => `${note.midi}:${note.velocity}`).join(" ") === "67:80 64:100 60:80",
        "内层折叠体注册的 modifier 不能泄漏给外层的后续成员");

    const composite = playedNotes(compilePlayback(lower(`@up({@up(1,3)}, $accent)`)));
    assert(composite.length === 2 && composite.every(note => note.velocity === 100),
        "作用于内部复合体的 modifier 对每个叶音只执行一次");
});

test("力度由记谱位置决定，持续到下一个力度记号", () => {
    assert(playedNotes(compilePlayback(lower(`1 ^ $p`)))[0].velocity === 48, "$p 应把同位置的音符设为弱力度");
    assert(playedNotes(compilePlayback(lower(`1 ^ $f`)))[0].velocity === 96, "$f 应把同位置的音符设为强力度");

    const run = playedNotes(compilePlayback(lower(`$p 1 2 $f 3 4`)));
    assert(run.map(note => note.velocity).join(" ") === "48 48 96 96",
        "力度应一直生效到被下一个力度记号改写");

    // `$p ^ 1` 里符号是宿主，按“附属成员先、宿主最后”它轮不到同一折叠体里的本音，只影响后继音
    const below = playedNotes(compilePlayback(lower(`$p ^ 1 2`)));
    assert(below.map(note => `${note.midi}:${note.velocity}@${note.start}`).join(" ") === "60:80@0 62:48@1",
        "符号写在下方成员之前时，宿主仍须发声且不得偷走时值");

    // 力度按位置生效，所以反复回跳后不沿用上一遍演到的值
    const repeated = playedNotes(compilePlayback(lower(`|: 1 $f 2 :|`)));
    assert(repeated.map(note => note.velocity).join(" ") === "80 96 80 96",
        "第二遍应与第一遍听起来完全一样");
});

test("延长记号调制速度，颤音和波音展开为点事件", () => {
    const fermata = compilePlayback(lower(`1 ^ $fermata 2`));
    const fermataNotes = playedNotes(fermata);
    const tempos = fermata.events.filter(event => event.kind === "tempo");
    assert(tempos.map(event => `${event.at}:${event.bpm}`).join(" ") === "0:60 1:120",
        "$fermata 应在宿主区间把有效速度减半");
    assert(fermataNotes[0].duration.equals(1) && fermataNotes[1].start.equals(1)
        && nearly(fermata.durationSeconds, 1.5),
    "$fermata 不改 QN 事件位置，只增加实际秒数");

    const trill = playedNotes(compilePlayback(lower(`1 ^ $tr`)));
    assert(trill.length === 8, "默认速度下四分音符上的 $tr 应展开为八个八分之一 QN 的子音");
    for (let i = 0; i < trill.length; i++) {
        assert(trill[i].midi === (i % 2 === 0 ? 60 : 62), "$tr 应在本音与调内上方二度间交替");
        assert(trill[i].start.equals(i, 8)
            && trill[i].duration.equals(1, 8), "$tr 子音必须连续填满宿主时值");
    }

    const mordent = playedNotes(compilePlayback(lower(`1 ^ $mordent`)));
    assert(mordent.length === 3, "$mordent 应展开为三个音");
    assert(mordent.map(note => note.midi).join(",") === "60,62,60",
        "$mordent 应按本音、上方音、本音排列");
    assert(mordent.every(note => note.duration.equals(1, 3)),
        "$mordent 三个子音应均分宿主时值");
});

test("fermata 通过速度控制影响所有重叠声部", () => {
    const plan = compilePlayback(lower(`N: 1 2/.^$fermata 3//\nN: 3 4/ 5/`));
    const tempos = plan.events.filter(event => event.kind === "tempo");
    assert(tempos.length === 3
        && tempos[0].at.equals(0) && tempos[0].bpm === 120
        && tempos[1].at.equals(1) && tempos[1].bpm === 60
        && tempos[2].at.equals(7, 4) && tempos[2].bpm === 120,
    "fermata 应在附属音符区间把系统速度减半，并在末端恢复");

    const fiveOn = plan.events.find(event => event.kind === "note-on" && event.midi === 67);
    assert(fiveOn?.kind === "note-on", "下方声部的 5 应产生 NoteOn");
    const noteId = fiveOn.noteId;
    const fiveOff = plan.events.find(event => event.kind === "note-off" && event.noteId === noteId);
    assert(fiveOff !== undefined && fiveOn.at.equals(3, 2) && fiveOff.at.equals(2),
        "fermata 不应移动 5 的 QN 起止点");

    const staggered = compilePlayback(lower(`N: 1 2^$fermata 3/\nN: 3/. 4/. 5/ 6.`));
    const staggeredTempos = staggered.events.filter(event => event.kind === "tempo");
    assert(staggeredTempos.map(event => `${event.at}:${event.bpm}`).join(" ") === "0:120 1:60 2:120",
        "fermata 从另一声部音符中途开始、跨过下一音符后应在自身末端恢复速度");
    const staggeredNotes = playedNotes(staggered);
    const four = staggeredNotes.find(note => note.midi === 65);
    const five = staggeredNotes.find(note => note.midi === 67);
    assert(four?.start.equals(3, 4) && four.end.equals(3, 2)
        && five?.start.equals(3, 2) && five.end.equals(2),
    "复杂跨声部 fermata 不应移动任何音符的 QN 边界");
    assert(staggered.performanceDuration.equals(7, 2) && nearly(staggered.durationSeconds, 9 / 4),
        "复杂跨声部 fermata 应只通过速度积分增加实际时长");

    const doubled = compilePlayback(lower(`1 ^ $fermata ^ $fermata`));
    const doubledTempos = doubled.events.filter(event => event.kind === "tempo");
    assert(doubledTempos.map(event => `${event.at}:${event.bpm}`).join(" ") === "0:30 1:120",
        "重叠的控制事件应按系统状态修改自然组合");
});

test("颤音密度按发声速度而不是固定记谱时值", () => {
    const slow = playedNotes(compilePlayback(lower(`@tempo(20) 1 ^ $tr`)));
    const fast = playedNotes(compilePlayback(lower(`@tempo(600) 1 ^ $tr`)));
    assert(slow.length === 24, `20 BPM 下四分音符长 3 秒，应展开为 24 个子音，实际 ${slow.length}`);
    assert(fast.length === 6, `600 BPM 下应收敛到上限频率，实际 ${fast.length}`);
    for (const plan of [slow, fast]) {
        const last = plan[plan.length - 1];
        assert(last.start.clone().add(last.duration).equals(1), "任何密度下子音都必须恰好填满宿主时值");
    }
});

test("颤音从通用调内位置求每个音符自己的上方二度", () => {
    const firstPair = (source: string) => playedNotes(compilePlayback(lower(source))).slice(0, 2).map(note => note.midi).join(",");
    assert(firstPair(`3 ^ $tr`) === "64,65", "C 调 3 的上方二度是 4，只升一个半音");
    assert(firstPair(`7 ^ $tr`) === "71,72", "C 调 7 的上方二度应跨八度到高音 1");
    assert(firstPair(`@1(D4) 3 ^ $tr`) === "66,67", "D 调 3 的颤音应在 F# 与 G 间交替");
    assert(firstPair(`#1 ^ $tr`) === "61,62", "主体临时升号不应传给调内上方二度");

    const composed = playedNotes(compilePlayback(lower(`1 ^ $tr ^ $mordent`)));
    assert(composed.map(note => note.midi).join(",") === "60,62,62,64,60,62",
        "装饰音继续展开派生音时，应以派生音自己的调内位置为基准");
});

test("内置 symbol 使用固定图形生成稳定几何和绘制命令", () => {
    const names = ["tr", "f", "p", "fermata", "mordent", "accent"];
    for (const name of names) {
        const layout = layoutOf(`$${name}`);
        assert(layout.objects.length === 1, `$${name} 应生成一个可见对象`);
        const box = layout.objects[0].box;
        assert(Number.isFinite(box.w) && Number.isFinite(box.h) && box.w > 0 && box.h > 0,
            `$${name} 应生成有限的正尺寸盒子`);
        assert(recordCommands(layout).length > 0, `$${name} 应产生 Painter 命令`);
    }

    const sugar = layoutOf(`$tr`).objects[0].box;
    const explicit = layoutOf(`@symbol(tr)`).objects[0].box;
    assert(nearly(sugar.w, explicit.w) && nearly(sugar.h, explicit.h), "$tr 与 @symbol(tr) 应完全等价");
});

test("包围盒取曲线真实极值，宽扁符号用 weight 修正视觉重量", () => {
    // 延长记号的两段弧若按控制点求边界会把高度高估三分之一
    const fermata = layoutOf(`$fermata`).objects[0].box;
    assert(nearly(fermata.h, 11 * 0.6), "延长记号的高度应是 size 乘以自己的 weight");
    assert(fermata.w / fermata.h > 2, "延长记号是宽扁字形，真实包围盒的宽高比应大于 2");

    const tr = layoutOf(`$tr`).objects[0].box;
    assert(nearly(tr.h, 11), "未声明 weight 的符号高度应等于 size");
});
