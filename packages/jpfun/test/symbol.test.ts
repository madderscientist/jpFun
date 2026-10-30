import { test } from "node:test";
import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";

import { DEFAULT_VELOCITY, TemporalNodeBase } from "../src/functions/temporal.js";
import { symbolBounds, type SymbolShape } from "../src/functions/symbol/shape.js";
import { trSymbol } from "../src/functions/symbol/symbols/tr.js";
import { symbols, type SymbolDefinition } from "../src/core.js";
import { analyzeScoreSyntax, compileScore } from "../src/pipeline.js";
import { compilePlayback } from "../src/playback/compile.js";
import { assert, compileValid, expectDiagnostic, layoutOf, lower, nearly, parse, playedNotes, recordCommands } from "./helpers.js";

test("符号查表、正则变体与未知符号诊断", () => {
    for (const source of ["$TR", "@symbol(TR)"]) {
        const node = parse(source).content[0];
        assert("definition" in node && node.definition === trSymbol, "查表应直接返回登记的定义");
    }
    const variant = parse("$TR+++").content[0];
    assert("definition" in variant && variant.definition && typeof variant.definition === "object"
        && "name" in variant.definition && variant.definition.name === "tr+++", "正则应构造小写名称变体");

    for (const name of ["tr", "tr+", "tr+++", "TR++++"]) {
        const source = `$${name}`;
        const { syntax, diagnostics } = analyzeScoreSyntax(source);
        assert(diagnostics.length === 0 && syntax.tokens.length === 1 && syntax.tokens[0].span.end === source.length, source);
    }

    for (const source of [
        "$tr+++/", "$tr+++oops", "$123", "$中文", "$not-registered",
        "@symbol(not-registered)", "$ffffp", "$ppppf", "$staccatissimo", "$breath",
    ]) {
        const result = compileScore(source);
        assert(result.diagnostics.length === 1 && result.diagnostics[0].code === "W_UNKNOWN_SYMBOL", source);
        expectDiagnostic(() => parse(`@set(strict=true) ${source}`), "E_UNKNOWN_SYMBOL");
    }

    const fallback = compileScore(`@div($tr_2)`).lowering.columns[0]?.[0];
    assert(fallback?.constructor === TemporalNodeBase && fallback.T.isZero() && !fallback.box,
        "未知 symbol 应降级为零时值、不可见的基础 Temporal");
});

test("重复字形的边界与颤音尾巴几何及播放等价性", () => {
    const shape: SymbolShape = { path: [{ op: "M", x: 0, y: 0 }, { op: "L", x: 2, y: 1 }], style: { fill: "#000" } };
    deepStrictEqual(symbolBounds([shape, { ...shape, dx: 3 }]), { x: 0, y: 0, w: 5, h: 1 });

    const base = compileValid("$tr").layout.objects[0].box;
    const extended = compileValid("$tr+++").layout;
    const box = extended.objects[0].box;
    const paths = recordCommands(extended).filter(command => command.kind === "path");
    assert(paths.length === 4 && nearly(box.h, base.h) && box.w > base.w && nearly(box.anchor, base.anchor),
        "每个加号增加一截尾巴，保持高度与原对齐点不变");
    deepStrictEqual(recordCommands(extended), recordCommands(compileValid('@symbol("tr+++")').layout));

    const summary = (source: string) => playedNotes(compilePlayback(lower(source)))
        .map(note => `${note.midi}:${note.start}:${note.duration}`).join(" ");
    strictEqual(summary("1 ^ $tr 2"), summary("1 ^ $tr+++ 2"));
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
    const run = playedNotes(compilePlayback(lower(`$p 1 2 $f 3 4`)));
    assert(run.map(note => note.velocity).join(" ") === "49 49 96 96",
        "力度应一直生效到被下一个力度记号改写");

    // `$p ^ 1` 里符号是宿主，按“附属成员先、宿主最后”它轮不到同一折叠体里的本音，只影响后继音
    const below = playedNotes(compilePlayback(lower(`$p ^ 1 2`)));
    assert(below.map(note => `${note.midi}:${note.velocity}@${note.start}`).join(" ") === "60:80@0 62:49@1",
        "符号写在下方成员之前时，宿主仍须发声且不得偷走时值");

    // 力度按位置生效，所以反复回跳后不沿用上一遍演到的值
    const repeated = playedNotes(compilePlayback(lower(`|: 1 $f 2 :|`)));
    assert(repeated.map(note => note.velocity).join(" ") === "80 96 80 96",
        "第二遍应与第一遍听起来完全一样");
});

test("力度属于声部，速度属于全篇", () => {
    const parallel = playedNotes(compilePlayback(lower(`@stack({1 2 3}, {5 $p 6 7})`)));
    assert(parallel.filter(note => note.track === 0).map(note => note.velocity).join(" ") === "80 80 80",
        "并行音轨写下的 $p 不能压低另一条音轨");
    assert(parallel.filter(note => note.track === 1).map(note => note.velocity).join(" ") === "80 49 49",
        "$p 所在音轨仍须从记号处开始变弱");

    const inherited = playedNotes(compilePlayback(lower(`$f 1 @voices(@voice({2 3}, 甲), @voice({6 7}, 乙))`)));
    assert(inherited.every(note => note.velocity === 96),
        "新分叉的声部继承分叉处父轨的力度");
    const branched = playedNotes(compilePlayback(lower(`@stack({1 2}, {5 $p 6}) @voices(@voice({1}, 甲), @voice({3}, 乙))`)));
    assert(branched.filter(note => note.start.compare(2) >= 0).every(note => note.velocity === 80),
        "分支自己写下的 $p 不得传给之后从父轨分叉出来的声部");

    const tempo = playedNotes(compilePlayback(lower(`@stack({1 2}, {5 @tempo(60) 6})`)));
    assert(tempo.every(note => note.bpm === (note.start.isZero() ? 120 : 60)),
        "速度是全篇共享的，写在任一音轨都影响所有声部");
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

    const prall = playedNotes(compilePlayback(lower(`1 ^ $prall`)));
    assert(prall.length === 3, "$prall 应展开为三个音");
    assert(prall.map(note => note.midi).join(",") === "60,62,60",
        "$prall 应按本音、上方音、本音排列");
    assert(prall.every(note => note.duration.equals(1, 3)),
        "$prall 三个子音应均分宿主时值");

    const mordent = playedNotes(compilePlayback(lower(`1 ^ $mordent`)));
    assert(mordent.map(note => note.midi).join(",") === "60,59,60",
        "$mordent 应按本音、下方音、本音排列");
    assert(playedNotes(compilePlayback(lower(`4 ^ $mordent`))).map(note => note.midi).join(",") === "65,64,65",
        "下方二度同样走调内音阶，C 调 4 的下方是 3");
});

test("fermata 通过速度控制影响重叠声部、休止符、延音与连音", () => {
    for (const [source, expectedTempos, expectedSeconds] of [
        [`N: 1 2/.^$fermata 3//\nN: 3 4/ 5/`, "0:120 1:60 7/4:120", undefined],
        [`1 ^ $fermata ^ $fermata`, "0:60 1:120", undefined],
        [`@stack({1 ^ $fermata}, {3 ^ $fermata})`, "0:60 1:120", 1],
        [`1 1@tie ^ $fermata -`, "0:120 1:60 3:120", 2.5],
        [`1@a 1@b ^ $fermata 1@c @tie(a,b,c)`, "0:120 1:60 3:120", undefined],
        [`1 ^ $fermata 2 ^ $fermata`, "0:60 2:120", undefined],
        [`|: 1 ^ $fermata 2 :|`, "0:60 1:120 2:60 3:120", undefined],
        [`@stack({0 ^ $fermata}, {1})`, "0:60 1:120", 1],
        [`0 ^ $fermata - 1`, "0:60 2:120", 2.5],
        [`1 - ^ $fermata - 2`, "0:120 1:60 3:120", 3],
        [`@tempo(30) @stack({1@a ^ $fermata 1@b @tie(a,b)}, {0 3 ^ $tr})`, "0:15 2:30", undefined],
    ] as const) {
        const plan = compilePlayback(lower(source));
        strictEqual(plan.events.filter(event => event.kind === "tempo")
            .map(event => `${event.at}:${event.bpm}`).join(" "), expectedTempos, source);
        if (expectedSeconds !== undefined) assert(nearly(plan.durationSeconds, expectedSeconds), source);
    }

    assert(playedNotes(compilePlayback(lower(`@tempo(20) 1 ^ $fermata ^ $tr`))).length === 48,
        "fermata 的最终速度应参与装饰音密度计算");
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

    const composed = playedNotes(compilePlayback(lower(`1 ^ $tr ^ $prall`)));
    assert(composed.map(note => note.midi).join(",") === "60,62,62,64,60,62",
        "装饰音继续展开派生音时，应以派生音自己的调内位置为基准");
});

test("内置 symbol 使用固定图形生成稳定几何、支持大小写与等比缩放", () => {
    const names = ["tr", "fermata", "prall", "mordent", "accent", "wheel", "harmonic",
        "dc", "ds", "segno", "fine", "coda", "tocoda",
        "tenuto", "marcato", "staccato", "turn", "iturn",
        "ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"];
    for (const name of names) {
        const layout = compileValid(`$${name}`).layout;
        const box = layout.objects[0].box;
        assert(layout.objects.length === 1 && box.w > 0 && box.h > 0 && recordCommands(layout).length > 0, `$${name}`);
    }
    for (const name of ["tenuto", "marcato", "staccato", "turn", "iturn", "harmonic"]) {
        const layout = compileValid(`$${name}`).layout;
        deepStrictEqual(recordCommands(compileValid(`$${name.toUpperCase()}`).layout), recordCommands(layout));
        deepStrictEqual(recordCommands(compileValid(`@symbol(${name})`).layout), recordCommands(layout));
        const box = layout.objects[0].box;
        const doubled = compileValid(`@symbol(${name}, size=1em)`).layout.objects[0].box;
        assert(nearly(doubled.w, box.w * 2) && nearly(doubled.h, box.h * 2), name);
    }
});

test("回音与逆回音按调内二度均分宿主时值，且不影响后继音符", () => {
    for (const [name, expected] of [["turn", [62, 60, 59, 60]], ["iturn", [59, 60, 62, 60]]] as const) {
        const plan = compilePlayback(compileValid(`1 ^ $${name} 2`).lowering);
        const notes = playedNotes(plan);
        deepStrictEqual(notes.slice(0, 4).map(note => note.midi), expected);
        assert(notes.slice(0, 4).every((note, i) => note.start.equals(i, 4) && note.duration.equals(1, 4))
            && notes.length === 5 && notes[4].start.equals(1), name);
        strictEqual(playedNotes(compilePlayback(compileValid(`9 ^ $${name}`).lowering)).length, 1);
    }
    deepStrictEqual(playedNotes(compilePlayback(lower("@1(D4) 3 ^ $turn"))).map(note => note.midi), [67, 66, 64, 66]);
    deepStrictEqual(playedNotes(compilePlayback(lower("#1 ^ $iturn"))).map(note => note.midi), [59, 61, 62, 61]);
});

test("强调音、断奏与纯记谱符号的播放行为", () => {
    deepStrictEqual(playedNotes(compilePlayback(lower(`1 ^ $marcato 2`))).map(note => note.velocity), [100, DEFAULT_VELOCITY]);
    for (const [source, firstEnd, count] of [
        [`1 ^ $staccato 2`, [1, 2], 2],
        [`1 ^ $staccato - 2`, [1, 1], 2],
        [`1 ^ $tr ^ $staccato`, [1, 2], 4],
    ] as const) {
        const notes = playedNotes(compilePlayback(lower(source)));
        assert(notes.length === count && notes[count === 2 ? 0 : count - 1].end.equals(firstEnd[0], firstEnd[1]), source);
    }
    const baseline = playedNotes(compilePlayback(lower("1 2"))).map(n => `${n.midi}:${n.start}:${n.duration}:${n.velocity}`);
    for (const name of ["tenuto", "wheel", "harmonic"]) {
        deepStrictEqual(playedNotes(compilePlayback(lower(`1 ^ $${name} 2`))).map(n => `${n.midi}:${n.start}:${n.duration}:${n.velocity}`), baseline);
    }
});

test("力度记号横向拼接字形，默认力度与 MuseScore 一致", () => {
    const ladder = [["pppp", 10], ["ppp", 16], ["pp", 33], ["p", 49],
        ["mp", 64], ["mf", 80], ["f", 96], ["ff", 112], ["fff", 126], ["ffff", 127]] as const;
    for (const [name, velocity] of ladder) {
        const result = compileValid(`1 ^ $${name} 2 3^$mf`);
        deepStrictEqual(playedNotes(compilePlayback(result.lowering)).map(note => note.velocity),
            [velocity, velocity, DEFAULT_VELOCITY], name);
    }
    const boxes = ["p", "pp", "ppp"].map(name => layoutOf(`$${name}`).objects[0].box);
    assert(boxes.every(item => nearly(item.h, boxes[0].h)) && boxes[0].w < boxes[1].w && boxes[1].w < boxes[2].w,
        "同族记号应等高且逐个变宽");
});

test("$dc 跳回曲首再演一遍，它所在的时间列不发声", () => {
    const played = (source: string) =>
        playedNotes(compilePlayback(lower(source))).map(note => note.midi).join(" ");

    assert(played("1 2 3") === "60 62 64", "没有 $dc 时只演奏一遍");
    assert(played("1 2 3 $dc") === "60 62 64 60 62 64", "$dc 应跳回曲首再演一遍");
    // 反复线每条只回跳一次，所以 D.C. 之后的那一遍不再重复曲中的反复段
    assert(played("|: 1 :| 2 $dc") === "60 60 62 60 62", "D.C. 之后不再重复曲中的反复段");
    // 跳转的定义是当前列不演奏，所以叠在音符上会吞掉第一遍的那个音
    assert(played("1 2 3^$dc") === "60 62 60 62 64", "$dc 所在的列在跳转的那一遍不发声");
});

test("$ds 跳回记号处", () => {
    const played = (source: string) =>
        playedNotes(compilePlayback(lower(source))).map(note => note.midi).join(" ");

    assert(played("1 $segno 2 3 $ds") === "60 62 64 62 64", "D.S. 应跳回 $segno 所在的列");
    assert(played("1 2 3 $ds") === "60 62 64 60 62 64", "没有 $segno 时 D.S. 退回曲首");
    assert(played("1 2 $ds 3 $segno 4") === "60 62 60 62 64 65", "写在 D.S. 之后的 $segno 不是回跳目标");
});

test("$fine 只在回跳之后生效，不被反复线提前触发", () => {
    const played = (source: string) =>
        playedNotes(compilePlayback(lower(source))).map(note => note.midi).join(" ");

    assert(played("1 2 3 | _$fine 4 5 | _$dc") === "60 62 64 65 67 60 62 64", "回跳后经过 Fine 应收尾");
    // 判据若是“第二次经过”，这两条会在反复的第二遍就静默地把曲子停掉
    assert(played("|: 1 2 $fine :| 3 $dc") === "60 62 60 62 64 60 62", "反复段内的 Fine 不受反复线影响");
    assert(played("|: 1 2 $fine 3 :| 4") === "60 62 64 60 62 64 65", "没有回跳记号时 Fine 不生效");
    assert(played("1 $dc 2 $fine 3") === "60 60 62 64", "写在回跳点之后的 Fine 永远不生效");
});

test("$tocoda 只在回跳之后跳向后方最近的 $coda，且正常绕过回跳列不报缺失诊断", () => {
    const played = (source: string) => {
        const plan = compilePlayback(lower(source));
        deepStrictEqual(plan.diagnostics, [], `${source} 不应产生未演奏列警告`);
        return playedNotes(plan).map(note => note.midi).join(" ");
    };

    assert(played("1 2 | _$tocoda 3 4 | _$dc | ^$coda 5 6") === "60 62 64 65 60 62 67 69",
        "D.C. al Coda 应在回跳后从 $tocoda 跳到 $coda");
    assert(played("1 2 ^ $segno 3 | _$tocoda 4 5 | _$ds 6 ^ $coda 7") === "60 62 64 65 67 62 64 69 71",
        "D.S. al Coda 应先回跳到 $segno，再从 $tocoda 跳到 $coda");
    assert(played("|: 1 2 $tocoda :| 3 $dc $coda 4") === "60 62 60 62 64 60 62 65",
        "反复段内的 $tocoda 在首轮普通反复时不提前触发");
    assert(played("|: 1 2 $tocoda 3 :| $coda 4") === "60 62 64 60 62 64 65",
        "后方没有 $dc/$ds 时 $tocoda 不生效");
    assert(played("1 2 $tocoda 3 $dc") === "60 62 64 60 62 64",
        "后方没有 $coda 时 $tocoda 不生效");
    assert(played("1 $coda 2 $tocoda 3 $dc") === "60 62 64 60 62 64",
        "写在 $tocoda 之前的 $coda 不是正向跳转目标");
    assert(played("1 $dc 2 $tocoda 3 $coda 4") === "60 60 62 64 65",
        "写在回跳点之后的 $tocoda 永远不生效");
});

test("symbols 支持分包注册、同名覆盖、清空与回退到 core", (t) => {
    const { register, clear, reset } = symbols;
    t.after(reset);

    strictEqual(Object.isFrozen(symbols), true, "symbols 命名空间对象应只读冻结");
    strictEqual(Object.isFrozen(symbols.core), true, "symbols.core 备份列表应只读冻结");
    strictEqual(symbols.bounds, symbolBounds, "symbols.bounds 应暴露图形包围盒工具");
    const table = symbols.table;
    deepStrictEqual([...table.values()], symbols.core);

    const diziDieyin: SymbolDefinition = {
        name: "dizi.dy",
        description: "竹笛叠音",
        text: { content: "又", fontFamily: "serif" },
        emitPlayback: emitter => emitter.affectFollowing(symbols.ornament({ body: [1, 0] })),
    };
    const guitarP: SymbolDefinition = {
        name: "p",
        description: "吉他右手拇指",
        text: { content: "p", fontFamily: "serif" },
    };
    const customTr: SymbolDefinition = {
        name: "tr",
        description: "无尾巴颤音覆盖",
        text: { content: "tr", fontFamily: "serif" },
    };
    const customFF: SymbolDefinition = {
        name: "ff",
        description: "自定义 ff",
        text: { content: "ff", fontFamily: "serif" },
    };

    // 非法正则（含 g/y）应在整批写入前拦截，不破坏既有符号表或 pattern
    for (const regex of [/^tr(\++)/g, /^tr(\++)/y]) {
        throws(() => register(diziDieyin, {
            name: "tr",
            description: "非法正则",
            pattern: { regex, resolve: () => customTr },
        }), Error);
        expectDiagnostic(() => parse("@set(strict=true) $dizi.dy"), "E_UNKNOWN_SYMBOL");
        strictEqual(parse("$tr").content[0].toString("$tr"), "@symbol(tr)");
        strictEqual(parse("$tr+++").content[0].toString("$tr+++"), "@symbol(tr+++)", "批次失败不应破坏原有 tr pattern");
    }

    register(diziDieyin, guitarP, customTr, customFF);
    strictEqual(symbols.table, table);
    strictEqual(table.get("dizi.dy"), diziDieyin);
    strictEqual(table.get("p"), guitarP);
    strictEqual(table.size, symbols.core.length + 2);
    const overridden = compileValid("1 ^ $FF 2 ^ $fff");
    deepStrictEqual(playedNotes(compilePlayback(overridden.lowering)).map(note => note.velocity),
        [DEFAULT_VELOCITY, 126], "精确注册优先于正则，且只覆盖这一档");

    const diziPlayed = playedNotes(compilePlayback(lower("1 ^ $dizi.dy"))).map(note => note.midi).join(" ");
    strictEqual(diziPlayed, "62 60", "新注册符号应支持 symbols.ornament 播放展开");

    const pNode = parse("$p").content[0];
    assert("definition" in pNode && pNode.definition === guitarP, "同名注册应覆盖内置 $p");
    const pPlayed = playedNotes(compilePlayback(lower("$p 1")));
    strictEqual(pPlayed[0].velocity, DEFAULT_VELOCITY, "被覆盖后的 $p 不再触发内置弱记号力度");

    for (const name of ["pp", "ppp", "pppp"]) {
        expectDiagnostic(() => parse(`@set(strict=true) $${name}`), "E_UNKNOWN_SYMBOL");
    }
    expectDiagnostic(() => parse("@set(strict=true) $tr+++"), "E_UNKNOWN_SYMBOL");

    clear();
    strictEqual(table.size, 0);
    expectDiagnostic(() => parse("@set(strict=true) $p"), "E_UNKNOWN_SYMBOL");
    expectDiagnostic(() => parse("@set(strict=true) $dizi.dy"), "E_UNKNOWN_SYMBOL");

    reset();
    deepStrictEqual([...table.values()], symbols.core);
    expectDiagnostic(() => parse("@set(strict=true) $dizi.dy"), "E_UNKNOWN_SYMBOL");
    strictEqual(parse("$tr+++").content[0].toString("$tr+++"), "@symbol(tr+++)", "reset 后内置正则变体应恢复");
    compileValid("@set(strict=true) 1 ^ $wheel 2 ^ $harmonic $tenuto $marcato $staccato $turn $iturn");
    const restoredP = playedNotes(compilePlayback(lower("$p 1")));
    assert(restoredP[0].velocity < DEFAULT_VELOCITY, "reset 后内置 $p 力度语义应恢复");
    strictEqual(playedNotes(compilePlayback(lower("1 ^ $ff")))[0].velocity, 112, "reset 应恢复正则力度");
});
