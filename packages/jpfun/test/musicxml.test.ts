import test from "node:test";
import { throws } from "node:assert/strict";
import { DOMParser } from "@xmldom/xmldom";

import {
  compilePlayback,
  compileScore,
  musicXmlToJpFun as convertMusicXmlElement,
} from "../src/index.js";
import { assert, lower, playedNotes, recordCommands } from "./helpers.js";

function musicXmlToJpFun(
  source: string,
  options?: Parameters<typeof convertMusicXmlElement>[1],
) {
  const errors: string[] = [];
  const document = new DOMParser({
    onError(level, message) {
      if (level !== "warning") errors.push(message);
    },
  }).parseFromString(source, "application/xml");
  if (errors.length > 0 || !document.documentElement) {
    throw new SyntaxError(`Invalid MusicXML: ${errors[0] ?? "missing document element"}`);
  }
  return convertMusicXmlElement(document.documentElement, options);
}

const SCORE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Example</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
    <score-part id="P2"><part-name>Flute</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <note><rest/><duration>8</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>12</duration></backup>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>12</duration><voice>5</voice><staff>2</staff></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>12</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

test("MusicXML 的 part、staff、voice、chord、rest 和 backup 转成可播放 jpFun", () => {
    const source = musicXmlToJpFun(SCORE);
    const plan = compilePlayback(lower(source));
    const notes = playedNotes(plan);
    assert(plan.diagnostics.length === 0, `转换结果不应产生诊断：${source}`);
    assert(!source.includes("@head(")
        && source.includes("H.title: Example")
        && source.includes("H.signature: 1=G4 3/4") && source.includes("H.tempo: 120"),
        `初始调号、拍号和速度必须使用 head 语法糖：${source}`);
    assert(!source.slice(source.indexOf("\n\n") + 2, source.indexOf("N(")).match(/@(1|tempo|meter)\(/),
        `正文首行不得重复初始状态：${source}`);
    assert(source.includes("N(\"Piano\"):") && source.includes("N(\"Flute\"):"),
        `part 名称和多声部结构应保留：${source}`);
    assert(!source.includes("@note(") && !source.includes("@div(")
      && !source.includes("@voice(") && !source.includes("@voices("),
    `普通音符、减时线和 voices 应使用语法糖：${source}`);
    assert(notes.length === 4 && notes.some(note => note.midi === 67 && note.start.equals(0) && note.duration.equals(1))
        && notes.some(note => note.midi === 71 && note.start.equals(0) && note.duration.equals(1))
        && notes.some(note => note.midi === 55 && note.start.equals(0) && note.duration.equals(3))
        && notes.some(note => note.midi === 74 && note.start.equals(0) && note.duration.equals(3)),
    `和弦、backup 与 part 并行时间应保持：${source}`);
});

test("MusicXML 保留复合拍号的书面分母", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Meter</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>2</divisions><time><beats>6</beats><beat-type>8</beat-type></time></attributes><note><rest/><duration>6</duration><voice>1</voice></note></measure></part></score-partwise>`);
  assert(source.includes("H.signature: 1=C4 6/8"), `6/8 不得约分成 3/4：${source}`);
});

test("MusicXML unpitched 使用显示音高而非静默转成休止", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Drums</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><unpitched><display-step>G</display-step><display-octave>4</display-octave></unpitched><duration>1</duration><voice>1</voice></note></measure></part></score-partwise>`);
  const notes = playedNotes(compilePlayback(lower(source)));
  assert(source.includes("G4") && notes.length === 1 && notes[0].midi === 67,
    `unpitched 应按 display-step/display-octave 保留为可播放事件：${source}`);
});

test("MusicXML instrument 切换 program 且 channel 10 鼓点跳过", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list>
<score-part id="P1"><part-name>Lead</part-name><score-instrument id="P1-I1"><instrument-name>A</instrument-name></score-instrument><score-instrument id="P1-I2"><instrument-name>B</instrument-name></score-instrument><midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>41</midi-program></midi-instrument><midi-instrument id="P1-I2"><midi-channel>1</midi-channel><midi-program>42</midi-program></midi-instrument></score-part>
<score-part id="P2"><part-name>Drums</part-name><score-instrument id="P2-I1"><instrument-name>Drums</instrument-name></score-instrument><midi-instrument id="P2-I1"><midi-channel>10</midi-channel><midi-program>1</midi-program></midi-instrument></score-part>
</part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><instrument id="P1-I1"/><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><instrument id="P1-I2"/><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure></part><part id="P2"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><instrument id="P2-I1"/><unpitched><display-step>C</display-step><display-octave>2</display-octave></unpitched><duration>1</duration><voice>1</voice></note><note><instrument id="P2-I1"/><unpitched><display-step>D</display-step><display-octave>2</display-octave></unpitched><duration>1</duration><voice>1</voice></note></measure></part></score-partwise>`);
  const plan = compilePlayback(lower(source));
  const programs = plan.events.filter(event => event.kind === "program-change");

  assert(source.includes("@program(40)") && source.includes("@program(41)"),
    `MusicXML program 应从 1..128 转为 0..127：${source}`);
  assert(!source.includes("Drums") && playedNotes(plan).map(note => note.midi).join() === "60,62",
    `channel 10 的 MusicXML 鼓点应被跳过：${source}`);
  assert(programs.map(event => `${event.at}:${event.program}`).join(" ") === "0:40 1:41",
    `instrument id 切换应生成对应 program-change：${source}`);
});

test("首个 MusicXML lane 全休止时仍保留中途状态", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P0"><part-name>Rest</part-name></score-part><score-part id="P1"><part-name>Melody</part-name></score-part></part-list><part id="P0"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><rest/><duration>1</duration><voice>1</voice></note></measure><measure number="2"><attributes><key><fifths>1</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="80"/></direction><note><rest/><duration>2</duration><voice>1</voice></note></measure></part><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure><measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note></measure></part></score-partwise>`);
  assert(source.includes("@1(G4)") && source.includes("@meter(2, 4)") && source.includes("@tempo(80)"),
    `中途调号、拍号和速度不得因首 lane 全休止而丢失：${source}`);
  assert(compilePlayback(lower(source)).diagnostics.length === 0, `休止上的状态声明应可编译：${source}`);
});

test("MusicXML 状态变化在持续音内部的精确时刻生效", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Held</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><offset>2</offset><sound tempo="80"/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note></measure><measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note></measure></part></score-partwise>`);
  const notes = playedNotes(compilePlayback(lower(source)));
  const next = notes.find(note => note.midi === 62);
  assert(/\{-+\s+\^\s+@tempo\(80\)\}/.test(source), `长音必须在变化点切出带状态的 dash：${source}`);
  assert(next?.bpm === 80, `变化后的音符必须使用新速度：${source}`);
});

test("MusicXML 状态变化可附着到 tuplet 首成员", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Tuplet State</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>6</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>B</step><octave>3</octave></pitch><duration>6</duration><voice>1</voice></note><direction><sound tempo="80"/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="start"/></notations></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="stop"/></notations></note><note><rest/><duration>12</duration><voice>1</voice></note></measure></part></score-partwise>`);
  assert(/@tuplet\(\{\{C4[/.]*\s+\^\s+@tempo\(80\)\}/.test(source),
    `状态必须附着到 tuplet 首成员，而不是包裹整个 tuplet：${source}`);
  assert(compilePlayback(lower(source)).diagnostics.length === 0, `带状态的 tuplet 必须可编译：${source}`);
});

test("MusicXML tuplet 内后续成员消费状态且不切开整组", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Tuplet State</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>6</divisions><key><fifths>0</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>B</step><octave>3</octave></pitch><duration>6</duration><voice>1</voice></note><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="start"/></notations></note><attributes><key><fifths>1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="80"/></direction><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="stop"/></notations></note><note><rest/><duration>6</duration><voice>1</voice></note></measure></part></score-partwise>`);
  const tuplet = source.match(/@tuplet\(\{([\s\S]*?)\}, 2\)/)?.[1] ?? "";
  assert(tuplet.includes("@1(G4)") && tuplet.includes("@meter(3, 4)") && tuplet.includes("@tempo(80)"),
    `tuplet 第二成员的状态必须留在整组内部：${source}`);
  assert((source.match(/@tempo\(80\)/g) ?? []).length === 1
    && (source.match(/@meter\(3, 4\)/g) ?? []).length === 1
    && (source.match(/@1\(G4\)/g) ?? []).length === 1,
  `tuplet 内状态不得被外层时间线重复输出：${source}`);
});

test("MusicXML tuplet 成员内部的状态按 offset 精确切分", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Tuplet Offset</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>6</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>B</step><octave>3</octave></pitch><duration>6</duration><voice>1</voice></note><direction><offset>1</offset><sound tempo="80"/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="start"/></notations></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="stop"/></notations></note><note><pitch><step>F</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice></note></measure></part></score-partwise>`);
  const tuplet = source.match(/@tuplet\(\{([\s\S]*?)\}, 4\)/)?.[1] ?? "";
  assert(/C4\/{2}\s+\{-\/{2}\s+\^\s+@tempo\(80\)\}/.test(tuplet),
    `成员内部状态必须切出带状态的 continuation：${source}`);
  const notes = playedNotes(compilePlayback(lower(source)));
  const triplet = notes.filter(note => note.midi >= 60 && note.midi <= 64);
  assert(triplet.length === 3 && triplet.every((note, index) =>
    note.start.equals(index + 3, 3) && note.duration.equals(1, 3)),
  `内部状态切分不得改变三连音的起点和时值：${source}`);
  const next = notes.find(note => note.midi === 65);
  assert(next?.bpm === 80, `tuplet 后续音符必须读取内部变化后的速度：${source}`);
});

test("MusicXML tuplet 休止被状态切分后按真实 token 数补歌词槽", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Tuplet Lyrics</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>6</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>B</step><octave>3</octave></pitch><duration>6</duration><voice>1</voice><lyric><text>before</text></lyric></note><direction><offset>1</offset><sound tempo="80"/></direction><note><rest/><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="start"/></notations></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><lyric><text>after</text></lyric></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="stop"/></notations></note><note><rest/><duration>12</duration><voice>1</voice></note></measure></part></score-partwise>`);
  assert(source.includes('L: "before @ @ after @ @ @"'),
    `切成两个 token 的 tuplet 休止必须补两个歌词槽：${source}`);
  const texts = recordCommands(compileScore(source).layout).filter(command => command.kind === "text");
  assert(texts.some(command => command.text === "before") && texts.some(command => command.text === "after"),
    `休止切分后歌词仍必须进入正确音符：${source}`);
});

test("MusicXML 缺失 tempo 的 sound 不会被当作零速度", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Sound</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><sound dynamics="80"/><sound tempo=""/><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type><sound/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure></part></score-partwise>`);
  assert(source.includes("H.tempo: 90"), `缺失 tempo 的 sound 应忽略，direction 应回退 metronome：${source}`);
});

test("MusicXML note modifier 保留 placement", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Placement</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><articulations><accent placement="below"/></articulations></notations></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><ornaments><trill-mark placement="below"/></ornaments></notations></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><fermata type="inverted"/></notations></note></measure></part></score-partwise>`);
  assert(source.includes("_ $accent") && source.includes("_ $tr") && source.includes("_ $fermata"),
    `显式 below 与 inverted fermata 必须输出到音符下方：${source}`);
});

test("MusicXML 后续和弦成员的 modifier 合并到和弦", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Chord Modifier</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><articulations><accent placement="below"/></articulations></notations></note><note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><articulations><accent placement="below"/></articulations><ornaments><trill-mark placement="above"/></ornaments></notations></note></measure></part></score-partwise>`);
  assert(source.includes("_ $accent") && source.includes("^ $tr"),
    `后续和弦成员的 modifier 必须保留：${source}`);
  assert((source.match(/\$accent/g) ?? []).length === 1,
    `相同名称和位置的 modifier 必须去重：${source}`);
});

test("最上方 MusicXML lane 提前结束后仍在休止时间线上保留状态", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P0"><part-name>Short</part-name></score-part><score-part id="P1"><part-name>Long</part-name></score-part></part-list><part id="P0"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice></note></measure><measure number="2"><direction><sound tempo="80"/></direction><forward><duration>1</duration></forward></measure></part><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure><measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure></part></score-partwise>`);
  const notes = playedNotes(compilePlayback(lower(source)));
  const next = notes.find(note => note.midi === 62);
  assert(/\{0\s+\^\s+@tempo\(80\)\}/.test(source), `首 lane 结束后必须在补出的休止上写状态：${source}`);
  assert(next?.bpm === 80, `其他 lane 的后续音符必须使用新速度：${source}`);
});

  test("每个谱面系统都重新生成完整 N 声部组", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>A</part-name></score-part><score-part id="P2"><part-name>B</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure><measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure></part><part id="P2"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure><measure number="2"><note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure></part></score-partwise>`, { barsPerLine: 1 });
    assert((source.match(/^N(?:\(|:)/gm) ?? []).length === 4 && !source.includes("@br()"),
      `两声部两系统应有四条 N 且不写显式 br：${source}`);
    const systems = source.split("\n\n").slice(1);
    assert(systems.length === 2
      && systems[0].includes('N("A"):') && systems[0].includes('N("B"):')
      && !systems[1].includes('N("') && (systems[1].match(/^N:/gm) ?? []).length === 2,
    `首系统应有 A/B 标签，后续系统只写 N:：${source}`);
    assert(compilePlayback(lower(source)).diagnostics.length === 0, `分段 N 声部输出应无诊断：${source}`);
  });

test("MusicXML 的 grace、tie、力度、wedge 和反复线映射到 jpFun", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Solo</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>4</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
    <barline location="left"><repeat direction="forward"/></barline>
    <direction placement="below"><direction-type><dynamics><p/></dynamics><wedge type="crescendo" number="1"/></direction-type></direction>
    <note><grace slash="yes"/><pitch><step>D</step><octave>4</octave></pitch><voice>1</voice></note>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><tie type="start"/><notations><tied type="start"/></notations></note>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><tie type="stop"/><notations><tied type="stop"/></notations></note>
    <direction><direction-type><wedge type="stop" number="1"/></direction-type></direction>
    <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
    <barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>
  </measure></part>
</score-partwise>`);
    assert(source.includes(" > ") && source.includes("$p") && source.includes("@tie(")
        && source.includes("@dyn(") && source.includes("|:") && source.includes(":|"),
    `grace、tie、力度、wedge 与反复线都应输出：${source}`);
    assert(/@mx\d+\s+@tie\(mx\d+, mx\d+\)/.test(source),
      `tie 应紧跟在 stop 端点音符之后：${source}`);
    const plan = compilePlayback(lower(source));
    assert(plan.diagnostics.length === 0, `综合 MusicXML 转换不应产生诊断：${source}`);
    const notes = playedNotes(plan);
    assert(notes.some(note => note.midi === 62) && notes.filter(note => note.midi === 60).length === 2,
        `倚音与反复后的连音应保留：${source}`);
});

test("MusicXML time-modification 精确生成 jpFun tuplet", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Triplet</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>6</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="start"/></notations></note>
    <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
    <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="stop"/></notations></note>
    <note><rest/><duration>9</duration><voice>1</voice></note>
  </measure></part>
</score-partwise>`);
    assert(source.includes("@tuplet("), `三连音应生成 @tuplet：${source}`);
    const plan = compilePlayback(lower(source));
    assert(plan.diagnostics.length === 0, `三连音结果不应产生诊断：${source}`);
    const notes = playedNotes(plan);
    assert(notes.length === 3
        && notes[0].start.equals(0) && notes[0].duration.equals(1, 6)
        && notes[1].start.equals(1, 6) && notes[1].duration.equals(1, 6)
        && notes[2].start.equals(1, 3) && notes[2].duration.equals(1, 6),
    `三连音必须保持精确的 1/6 QN 时值：${source}`);
});

  test("跨小节 MusicXML tuplet 保留内部小节线与整组比例", () => {
    const triplet = (step: string, marker = "") => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>${marker ? `<notations><tuplet type="${marker}"/></notations>` : ""}</note>`;
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0">
    <part-list><score-part id="P1"><part-name>Long Triplet</part-name></score-part></part-list>
    <part id="P1">
    <measure number="1"><attributes><divisions>6</divisions><time><beats>1</beats><beat-type>8</beat-type></time></attributes>${triplet("C", "start")}${triplet("D")}${triplet("E")}</measure>
    <measure number="2">${triplet("F")}${triplet("G")}${triplet("A", "stop")}</measure>
    </part>
  </score-partwise>`, { barsPerLine: 1 });
    assert(source.includes("@tuplet(") && source.includes(", 4)")
      && (source.match(/^N/gm) ?? []).length === 1,
    `六个 3:2 子音组成的整组应推导 normal=4，且内部小节线不得拆系统：${source}`);
    const plan = compilePlayback(lower(source));
    assert(plan.diagnostics.length === 0, `跨小节 tuplet 不应产生诊断：${source}`);
    const notes = playedNotes(plan);
    assert(notes.length === 6 && notes.every((note, index) =>
      note.start.equals(index, 6) && note.duration.equals(1, 6)),
    `跨小节三连音应保持连续六个 1/6 QN：${source}`);
  });

  test("MusicXML 多段歌词保留连字符并为缺词音符补位", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0">
    <part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
    <part id="P1"><measure number="1">
    <attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric number="1"><syllabic>begin</syllabic><text>Hel</text><elision>‿</elision><text>le</text></lyric><lyric number="2"><text>你好</text></lyric></note>
    <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric number="1"><syllabic>end</syllabic><text>lo</text></lyric></note>
    <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric number="2"><text>呀</text></lyric></note>
    </measure></part>
  </score-partwise>`);
    assert(source.includes('"Hel~le- lo @"') && source.includes('"{你好} @ 呀"'),
      `两段歌词与占位应写入 voice：${source}`);
    const commands = recordCommands(compileScore(source).layout);
    assert(commands.some(command => command.kind === "text" && command.text === "Hel~le-")
      && commands.some(command => command.kind === "text" && command.text === "lo")
      && commands.some(command => command.kind === "text" && command.text === "你好")
      && commands.some(command => command.kind === "text" && command.text === "呀"),
    `歌词应实际进入布局：${source}`);
  });

  test("MusicXML forward 生成的休止为后续歌词补位", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Gap</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric><text>one</text></lyric></note><forward><duration>1</duration></forward><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric><text>two</text></lyric></note></measure></part></score-partwise>`);
    assert(source.includes('L: "one @ two"'), `forward 休止必须占一个歌词槽：${source}`);
    const commands = recordCommands(compileScore(source).layout).filter(command => command.kind === "text");
    const one = commands.find(command => command.text === "one");
    const two = commands.find(command => command.text === "two");
    assert(one && two && one.x < two.x, `two 必须落到第二个音符而非中间休止：${source}`);
  });

  test("MusicXML 含空格的单个歌词保持一个音符槽", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Space</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric><text>one word</text></lyric></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric><text>two</text></lyric></note></measure></part></score-partwise>`);
    assert(source.includes('L: "{one word} two"'), `含空格歌词应使用单槽分组：${source}`);
    const texts = recordCommands(compileScore(source).layout).filter(command => command.kind === "text");
    assert(texts.some(command => command.text === "one word") && texts.some(command => command.text === "two"),
      `分组歌词应显示原始文本：${source}`);
  });

  test("MusicXML 歌词中的槽位控制字符按字面保留", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Literal</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric><text>@{a-b}</text></lyric></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric><text>C:\Music</text></lyric></note></measure></part></score-partwise>`);
    const texts = recordCommands(compileScore(source).layout).filter(command => command.kind === "text");
    assert(texts.some(command => command.text === "@{a-b}") && texts.some(command => command.text === "C:\Music"),
        `歌词控制字符不得被解释为空槽或分组，普通反斜杠也不得丢失：${source}`);
  });

  test("MusicXML 混合文字和非 ASCII 连读歌词各保持一个槽", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Mixed</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric><text>A你</text></lyric></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric><syllabic>begin</syllabic><text>你</text></lyric></note></measure></part></score-partwise>`);
    const texts = recordCommands(compileScore(source).layout).filter(command => command.kind === "text");
    assert(texts.some(command => command.text === "A你") && texts.some(command => command.text === "你-"),
        `混合文字和连读标记不得增加歌词槽：${source}`);
  });

  test("MusicXML 有显式换行时不叠加 barsPerLine 自动换行", () => {
    const measures = Array.from({ length: 10 }, (_, index) => `<measure number="${index + 1}">${index === 0 ? '<attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes>' : ""}${index === 6 ? '<print new-system="yes"/>' : ""}<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>`).join("");
    const source = musicXmlToJpFun(`<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Breaks</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`, { barsPerLine: 4 });
    assert(source.split("\n\n").length - 1 === 2,
        `十小节应沿用 MusicXML 的 6+4 系统，不得额外切成 4+2+4：${source}`);
  });

test("MusicXML first/second ending 生成 volta 并控制反复顺序", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Ending</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>
    <measure number="2"><barline location="left"><ending number="1" type="start"/></barline><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>
    <measure number="3"><barline location="left"><ending number="2" type="start"/></barline><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="right"><ending number="2" type="stop"/></barline></measure>
  </part>
</score-partwise>`);
    assert(source.includes("@volta(") && source.includes("|:") && source.includes(":|"),
        `房子与反复线应同时生成：${source}`);
    const plan = compilePlayback(lower(source));
    assert(plan.diagnostics.length === 0, `房子转换不应产生诊断：${source}`);
    const pitches = playedNotes(plan).map(note => note.midi);
    assert(pitches.join() === "60,62,60,64", `first/second ending 应播放 C D C E，实际 ${pitches}: ${source}`);
});

  test("首个 MusicXML lane 全休止时 ending 仍从有声 lane 取端点", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0">
    <part-list><score-part id="P0"><part-name>Rest</part-name></score-part><score-part id="P1"><part-name>Melody</part-name></score-part></part-list>
    <part id="P0"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><rest/><duration>1</duration><voice>1</voice></note></measure><measure number="2"><note><rest/><duration>1</duration><voice>1</voice></note></measure><measure number="3"><note><rest/><duration>1</duration><voice>1</voice></note></measure></part>
    <part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure><measure number="2"><barline location="left"><ending number="1" type="start"/></barline><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure><measure number="3"><barline location="left"><ending number="2" type="start"/></barline><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="right"><ending number="2" type="stop"/></barline></measure></part>
  </score-partwise>`);
    assert(source.includes("@volta("), `休止 lane 不得阻止房子生成：${source}`);
    const pitches = playedNotes(compilePlayback(lower(source))).map(note => note.midi);
    assert(pitches.join() === "60,62,60,64", `有声 lane 的房子顺序应为 C D C E，实际 ${pitches}: ${source}`);
  });

  test("ending 跨 lane 取全区间端点，不在第二遍泄漏较早声部", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Cross Lane</part-name></score-part></part-list><part id="P1">
    <measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note></measure>
    <measure number="2"><barline location="left"><ending number="1" type="start"/></barline><note><rest/><duration>1</duration><voice>1</voice></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><backup><duration>2</duration></backup><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note><note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>
    <measure number="3"><barline location="left"><ending number="2" type="start"/></barline><note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note><barline location="right"><ending number="2" type="stop"/></barline></measure>
  </part></score-partwise>`);
    const pitches = playedNotes(compilePlayback(lower(source))).map(note => note.midi);
    assert(pitches.filter(pitch => pitch === 64).length === 1,
      `第一房子起点 E 不得在第二遍泄漏，实际 ${pitches}: ${source}`);
  });

  test("替代 ending 的 tie stop 共享房子外 tie start", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Branch Tie</part-name></score-part></part-list><part id="P1">
    <measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="start"/></note></measure>
    <measure number="2"><barline location="left"><ending number="1" type="start"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="stop"/></note><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>
    <measure number="3"><barline location="left"><ending number="2" type="start"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="stop"/></note><barline location="right"><ending number="2" type="stop"/></barline></measure>
  </part></score-partwise>`);
    assert((source.match(/@tie\(/g) ?? []).length === 2,
      `两个替代房子都应连接共同 tie start：${source}`);
    assert(compilePlayback(lower(source)).diagnostics.length === 0, `替代房子 tie 应无诊断：${source}`);
  });

  test("第一 ending 的 tie continue 不覆盖第二 ending 的公共起点", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Branch Continue</part-name></score-part></part-list><part id="P1">
    <measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="start"/></note></measure>
    <measure number="2"><barline location="left"><ending number="1" type="start"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="stop"/><tie type="start"/></note><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>
    <measure number="3"><barline location="left"><ending number="2" type="start"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="stop"/></note><barline location="right"><ending number="2" type="stop"/></barline></measure>
  </part></score-partwise>`);
    const ties = [...source.matchAll(/@tie\((mx\d+), (mx\d+)\)/g)];
    assert(ties.length === 2 && ties[0][1] === ties[1][1],
      `两个替代房子必须共享房子外的 tie 起点：${source}`);
    assert(compilePlayback(lower(source)).diagnostics.length === 0,
      `替代房子中的 tie continue 应无诊断：${source}`);
  });

  test("ending 分支内的 tie continue 保持自己的链", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Branch Chain</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="start"/></note></measure><measure number="2"><attributes><time><beats>2</beats><beat-type>4</beat-type></time></attributes><barline location="left"><ending number="1" type="start"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="stop"/><tie type="start"/></note><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="stop"/></note><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure><measure number="3"><barline location="left"><ending number="2" type="start"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><tie type="stop"/></note><barline location="right"><ending number="2" type="stop"/></barline></measure></part></score-partwise>`);
    const ties = [...source.matchAll(/@tie\((mx\d+), (mx\d+)\)/g)].map(match => [match[1], match[2]]);
    assert(ties.length === 3 && ties[0][1] === ties[1][0] && ties[0][0] === ties[2][0],
      `第一房子应沿局部 continue 链，第二房子仍从公共起点连接：${source}`);
  });

  test("MusicXML defaults 和 credit 生成页面与完整谱头", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0">
    <work><work-title>Untitled Score</work-title></work>
    <identification><creator type="lyricist">Lyricist</creator><creator type="composer">Composer</creator></identification>
    <defaults><scaling><millimeters>10</millimeters><tenths>40</tenths></scaling><page-layout><page-height>1200</page-height><page-width>800</page-width><page-margins type="odd"><left-margin>50</left-margin><right-margin>50</right-margin><top-margin>60</top-margin><bottom-margin>60</bottom-margin></page-margins></page-layout></defaults>
    <credit><credit-type>title</credit-type><credit-words>Real Title</credit-words></credit>
    <credit><credit-type>subtitle</credit-type><credit-words>Subtitle</credit-words></credit>
    <part-list><score-part id="P1"><part-name>Part</part-name></score-part></part-list>
    <part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><rest/><duration>4</duration><voice>1</voice></note></measure></part>
  </score-partwise>`);
    assert(source.includes("@page(") && source.includes("Real Title")
      && source.includes("Subtitle") && source.includes("Composer") && !source.includes("Untitled Score"),
    `页面与 credit 元数据应写入源码：${source}`);
    assert(compileScore(source).parser.diagnostics.length === 0, `带页面谱头的结果应无诊断：${source}`);
  });

  test("score-timewise、metronome、minor key 与绝对音高均受支持", () => {
    const xml = `<?xml version="1.0"?>
  <score-timewise version="4.0">
    <part-list><score-part id="P1"><part-name>Part</part-name></score-part></part-list>
    <measure number="1"><part id="P1">
    <attributes><divisions>1</divisions><key><fifths>-3</fifths><mode>minor</mode></key><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
    <direction><direction-type><metronome><beat-unit>eighth</beat-unit><per-minute>120</per-minute></metronome></direction-type></direction>
    <note><pitch><step>E</step><alter>-1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
    </part></measure>
  </score-timewise>`;
    const absolute = musicXmlToJpFun(xml);
    const relative = musicXmlToJpFun(xml, { pitchMode: "relative" });
    assert(absolute === musicXmlToJpFun(xml, { pitchMode: "absolute" }),
      "默认调用必须等价于显式 absolute 模式");
    assert(relative.includes("H.signature: 1=C4 2/4") && relative.includes("H.tempo: 60"),
      `C minor 与八分音符=120 应转换为 1=C、四分音符=60：${relative}`);
    assert(absolute.includes("Eb4"), `绝对模式应保留 Eb 拼写：${absolute}`);
    const notes = playedNotes(compilePlayback(lower(absolute)));
    assert(notes.length === 1 && notes[0].midi === 63 && notes[0].duration.equals(2),
      `timewise 音符应保持 Eb4 两拍：${absolute}`);
  });

  test("相对音高把升降号写在数字前面", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Chromatic</part-name></score-part></part-list><part id="P1"><measure number="1">
    <attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>1</beats><beat-type>4</beat-type></time></attributes>
    <note><pitch><step>C</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
  </measure></part></score-partwise>`, { pitchMode: "relative" });
    assert(source.includes("#1"), `相对音高应输出前置升号：${source}`);
    assert(compileScore(source).parser.diagnostics.length === 0, `前置升号输出必须可重新编译：${source}`);
  });

  test("measure sound、64th metronome、复合拍号和标准调式均正确换算", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Meta</part-name></score-part></part-list><part id="P1"><measure number="1">
    <attributes><divisions>2</divisions><key><fifths>0</fifths><mode>dorian</mode></key><time><beats>2</beats><beat-type>4</beat-type><beats>3</beats><beat-type>8</beat-type></time></attributes>
    <sound tempo="90"/><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
    <direction><direction-type><metronome><beat-unit>64th</beat-unit><per-minute>120</per-minute></metronome></direction-type></direction>
    <attributes><key><fifths>0</fifths><mode>lydian</mode></key></attributes>
    <note><pitch><step>F</step><octave>4</octave></pitch><duration>5</duration><voice>1</voice></note>
  </measure></part></score-partwise>`);
    assert(source.includes("H.signature: 1=D4 7/8") && source.includes("H.tempo: 90")
      && source.includes("@tempo(7.5)") && source.includes("@1(F4)"),
    `标准 mode、复合拍号、中途 key 和两类 tempo 都应输出：${source}`);
    assert(source.includes("^ @tempo(7.5)") && source.includes("^ @1(F4)"),
      `中途 tempo/key 必须用 up 附着到最上方声部的首个生效音符：${source}`);
    const plan = compilePlayback(lower(source));
    assert(plan.diagnostics.length === 0, `元事件转换不应产生诊断：${source}`);
    const tempos = plan.events.filter(event => event.kind === "tempo");
    assert(tempos.some(event => event.at.equals(0) && event.bpm === 90)
      && tempos.some(event => event.at.equals(1) && event.bpm === 7.5),
    `measure sound 与 64th metronome 应在正确时刻生效：${source}`);
  });

  test("MusicXML repeat times 和未指定 voice 的 dynamics 作用完整", () => {
    const repeated = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Repeat</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="right"><repeat direction="backward" times="3"/></barline></measure></part></score-partwise>`);
    assert(repeated.includes(":| :|"), `三遍反复应生成两条 backward repeat：${repeated}`);
    assert(playedNotes(compilePlayback(lower(repeated))).map(note => note.midi).join() === "60,60,60",
      `times=3 应播放三遍：${repeated}`);

    const dynamics = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Dynamics</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><backup><duration>1</duration></backup><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note></measure></part></score-partwise>`);
    const velocities = compilePlayback(lower(dynamics)).events
      .filter(event => event.kind === "note-on").map(event => event.velocity);
    assert(velocities.length === 2 && velocities.every(value => value === 48),
      `未指定 voice 的 p 应作用同 staff 全部声部：${dynamics}`);

    const wedge = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Wedge</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><direction><direction-type><wedge type="crescendo"/></direction-type></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><backup><duration>2</duration></backup><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note><note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note><direction><direction-type><wedge type="stop"/></direction-type></direction></measure></part></score-partwise>`);
    assert((wedge.match(/@dyn\(/g) ?? []).length === 2,
      `未指定 voice 的 wedge 应为两个声部分别生成 dyn：${wedge}`);
    assert(compilePlayback(lower(wedge)).diagnostics.length === 0, `多声部 wedge 应无诊断：${wedge}`);

    const sustainedWedge = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Sustained Wedge</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>2</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note><direction><offset>-1</offset><direction-type><wedge type="crescendo"/></direction-type></direction><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note><direction><direction-type><wedge type="stop"/></direction-type></direction></measure></part></score-partwise>`);
    assert((sustainedWedge.match(/@dyn\(/g) ?? []).length === 1,
      `持续音内部开始的 wedge 应从持续音连接到后继音：${sustainedWedge}`);
    assert(compilePlayback(lower(sustainedWedge)).diagnostics.length === 0,
      `持续音内部开始的 wedge 应无诊断：${sustainedWedge}`);
  });

  test("带命名空间的 MusicXML direction 后代元素不会丢失", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <m:score-partwise xmlns:m="http://www.musicxml.org/ns/musicxml" version="4.0"><m:part-list><m:score-part id="P1"><m:part-name>NS</m:part-name></m:score-part></m:part-list><m:part id="P1"><m:measure number="1"><m:attributes><m:divisions>1</m:divisions><m:time><m:beats>2</m:beats><m:beat-type>4</m:beat-type></m:time></m:attributes><m:direction placement="below"><m:direction-type><m:dynamics><m:p/></m:dynamics><m:words>rit.</m:words><m:wedge type="crescendo"/></m:direction-type><m:sound tempo="90"/></m:direction><m:note><m:pitch><m:step>C</m:step><m:octave>4</m:octave></m:pitch><m:duration>1</m:duration><m:voice>1</m:voice></m:note><m:note><m:pitch><m:step>D</m:step><m:octave>4</m:octave></m:pitch><m:duration>1</m:duration><m:voice>1</m:voice></m:note><m:direction><m:direction-type><m:wedge type="stop"/></m:direction-type></m:direction></m:measure></m:part></m:score-partwise>`);
    assert(source.includes("H.tempo: 90") && source.includes("$p")
      && source.includes('"rit."') && source.includes("@dyn("),
    `命名空间前缀不得让 tempo、words、dynamics 或 wedge 丢失：${source}`);
    assert(compilePlayback(lower(source)).diagnostics.length === 0, `命名空间 MusicXML 应无诊断：${source}`);
  });

  test("MusicXML rehearsal 用 box 包裹且不影响普通 words", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Rehearsal</part-name></score-part></part-list><part id="P1"><measure number="9"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><direction placement="above" system="only-top"><direction-type><rehearsal font-weight="bold" font-size="14">9</rehearsal><words>Verse</words></direction-type></direction><note><rest measure="yes"/><duration>1</duration><voice>1</voice></note></measure></part></score-partwise>`);
    assert(source.includes('@box("9")') && source.includes('^ "Verse"') && !source.includes('@box("Verse")'),
      `rehearsal 应有 box，普通 words 不应被一并包裹：${source}`);
    assert(compilePlayback(lower(source)).diagnostics.length === 0,
      `带 rehearsal box 的转换结果应无诊断：${source}`);
  });

  test("middle barline 在当前游标位置控制反复", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Middle</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="middle"><repeat direction="forward"/></barline><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="middle"><repeat direction="backward"/></barline><note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure></part></score-partwise>`, { barsPerLine: 1 });
    const pitches = playedNotes(compilePlayback(lower(source))).map(note => note.midi);
    assert(pitches.join() === "60,62,64,62,64,65",
      `middle repeat 应只重复 D E，实际 ${pitches}: ${source}`);
    assert(!source.includes("@br()"), `单个物理小节不得因 middle barline 提前换行：${source}`);
  });

  test("纯休止 ending 仍生成 volta，零时刻左反复不提前换行", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Rest Ending</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure><measure number="2"><barline location="left"><ending number="1" type="start"/></barline><note><rest/><duration>1</duration><voice>1</voice></note><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure><measure number="3"><barline location="left"><ending number="2" type="start"/></barline><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="right"><ending number="2" type="stop"/></barline></measure><measure number="4"><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure></part></score-partwise>`, { barsPerLine: 4 });
    assert(source.includes("@volta(") && !source.includes("@br()"),
      `纯休止房子应有 volta，time=0 左反复不应计入四小节换行：${source}`);
  });

  test("仅由 forward 构成的 ending 仍生成并执行 volta", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Forward Ending</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure><measure number="2"><barline location="left"><ending number="1" type="start"/></barline><forward><duration>1</duration></forward><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure><measure number="3"><barline location="left"><ending number="2" type="start"/></barline><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="right"><ending number="2" type="stop"/></barline></measure><measure number="4"><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure></part></score-partwise>`);
    assert((source.match(/@volta\(/g) ?? []).length === 2,
      `forward 合成休止与第二房子都必须生成 volta：${source}`);
    const notes = playedNotes(compilePlayback(lower(source)));
    const d = notes.find(note => note.midi === 62);
    const e = notes.find(note => note.midi === 64);
    assert(d?.start.equals(3) && e?.start.equals(4),
      `第二遍必须跳过第一房子的 forward 休止，实际 D=${d?.start} E=${e?.start}: ${source}`);
  });

  test("同一时刻开始和结束的空 ending 不生成反向 volta", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Empty</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="middle"><ending number="1" type="start"/></barline><barline location="middle"><ending number="1" type="stop"/><repeat direction="backward"/></barline><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure></part></score-partwise>`);
    assert(!source.includes("@volta("), `空 ending 不得生成端点反向的 volta：${source}`);
    const pitches = playedNotes(compilePlayback(lower(source))).map(note => note.midi);
    assert(pitches.join() === "60,60,62", `空 ending 不得破坏反复播放，实际 ${pitches}: ${source}`);
  });

  test("长音内部的空 ending 不创建合成声部", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Empty Span</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note><backup><duration>3</duration></backup><barline location="middle"><ending number="1" type="start"/></barline><barline location="middle"><ending number="1" type="stop"/></barline></measure></part></score-partwise>`);
    assert((source.match(/^N/gm) ?? []).length === 1 && !source.includes("@volta("),
      `长音内部的空 ending 不得创建零时长合成声部：${source}`);
    const notes = playedNotes(compilePlayback(lower(source)));
    assert(notes.length === 1 && notes[0].duration.equals(4), `空 ending 不得改变长音：${source}`);
  });

  test("跨 ending 边界的长音不阻止合成 volta 锚点", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Spanning</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note><backup><duration>3</duration></backup><barline location="middle"><ending number="1" type="start"/></barline><forward><duration>1</duration></forward><barline location="middle"><ending number="1" type="stop"/></barline></measure></part></score-partwise>`);
    assert(source.includes("@volta("), `跨边界长音之外必须建立可见 ending 锚点：${source}`);
    assert(compilePlayback(lower(source)).diagnostics.length === 0,
      `合成锚点不得与跨边界长音产生无效标签：${source}`);
  });

  test("全谱无 note 时 forward ending 仍创建可承载声部", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Empty Ending</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><ending number="1" type="start"/></barline><forward><duration>1</duration></forward><barline location="right"><ending number="1" type="stop"/></barline></measure></part></score-partwise>`);
    assert(source.includes('N("Empty Ending"):') && source.includes("@volta("),
      `无 note 乐谱也必须生成合成休止声部和 volta：${source}`);
    assert(compilePlayback(lower(source)).diagnostics.length === 0, `无 note ending 应可编译：${source}`);
  });

  test("空 ending 中的 direction 绑定合成休止而非后续音符", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Direction Ending</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><ending number="1" type="start"/></barline><direction><direction-type><words>first only</words></direction-type></direction><forward><duration>1</duration></forward><barline location="right"><ending number="1" type="stop"/></barline></measure><measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure></part></score-partwise>`);
    assert(/\{0\s+\^\s+"first only"\}/.test(source),
      `空 ending 的文字必须附着合成休止，不得泄漏到后续音符：${source}`);
  });

  test("无 voice 的文字优先绑定覆盖当前时刻的 lane", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Words</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><forward><duration>1</duration></forward><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><backup><duration>2</duration></backup><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>2</voice></note><backup><duration>1</duration></backup><direction><direction-type><words>mark</words></direction-type></direction></measure></part></score-partwise>`);
    assert(/\{E4\s+\^\s+"mark"\}/.test(source) && !/\{D4\s+\^\s+"mark"\}/.test(source),
      `文字应绑定覆盖时刻的 E4，而不是未来 D4：${source}`);
  });

  test("空 ending 的合成锚点跟随 direction 所属 part", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P0"><part-name>Other</part-name></score-part><score-part id="P1"><part-name>Target</part-name></score-part></part-list><part id="P0"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure></part><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><ending number="1" type="start"/></barline><direction><direction-type><words>inside</words></direction-type></direction><forward><duration>1</duration></forward><barline location="right"><ending number="1" type="stop"/></barline></measure></part></score-partwise>`);
    const target = source.slice(source.indexOf('N("Target"):'), source.indexOf("@volta("));
    assert(target.includes('"inside"'), `P1 direction 必须绑定 P1 的合成锚点：${source}`);
  });

  test("短和弦关系端点的标签位于减时线之后", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Chord Wedge</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>2</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><direction><direction-type><wedge type="crescendo"/></direction-type></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><direction><direction-type><wedge type="stop"/></direction-type></direction></measure></part></score-partwise>`);
    assert(/\{C4\/ \^ E4\}@mx\d+/.test(source) && !/@mx\d+\s+\//.test(source),
      `和弦减时线必须写在宿主音符上且位于关系标签之前：${source}`);
    const plan = compilePlayback(lower(source));
    assert(plan.diagnostics.length === 0, `短和弦 wedge 应无诊断：${source}`);
    assert(playedNotes(plan).every(note => note.duration.equals(1, 2)),
      `短和弦与后继音都应保持半拍：${source}`);
  });

  test("附点和弦把点写在宿主音符上，不拆成减时 dash", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Dotted</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>4</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>6</duration><voice>1</voice></note><note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>6</duration><voice>1</voice></note><note><rest/><duration>6</duration><voice>1</voice></note></measure></part></score-partwise>`);
    assert(source.includes("{C4. ^ E4}") && source.includes("0.") && !source.includes("-/"),
      `附点和弦/休止应直接使用点，不得拆成 dash：${source}`);
    const notes = playedNotes(compilePlayback(lower(source)));
    assert(notes.length === 2 && notes.every(note => note.duration.equals(3, 2)),
      `附点和弦成员都应保持 3/2 QN：${source}`);
  });

  test("多 part 复用控制 part 的首小节边界", () => {
    const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Control</part-name></score-part><score-part id="P2"><part-name>Sparse</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note></measure><measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note></measure></part><part id="P2"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure><measure number="2"><note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note></measure></part></score-partwise>`);
    const notes = playedNotes(compilePlayback(lower(source)));
    const f = notes.find(note => note.midi === 65);
    assert(f?.start.equals(4), `第二 part 的下一小节必须沿用控制 part 边界 QN=4：${source}`);
  });

  test("score-timewise 保留外层 implicit 弱起小节长度", () => {
      const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-timewise version="4.0">
    <part-list><score-part id="P1"><part-name>Pickup</part-name></score-part></part-list>
    <measure number="0" implicit="yes"><part id="P1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></part></measure>
    <measure number="1"><part id="P1"><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><rest/><duration>1</duration><voice>1</voice></note></part></measure>
  </score-timewise>`);
      const notes = playedNotes(compilePlayback(lower(source)));
      assert(notes.length === 2 && notes[0].start.equals(0) && notes[1].start.equals(1),
          `timewise 弱起后的第二小节必须从 1 QN 开始：${source}`);
  });

  test("direction voice 精确选择声部，steal-time-previous 生成后倚音", () => {
      const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0">
    <part-list><score-part id="P1"><part-name>Voices</part-name></score-part></part-list>
    <part id="P1"><measure number="1">
      <attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      <direction placement="below"><direction-type><dynamics><p/></dynamics><words>pizz.</words></direction-type><voice>2</voice></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><rest/><duration>1</duration><voice>1</voice></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>2</voice></note>
      <note><grace steal-time-previous="20"/><pitch><step>F</step><octave>4</octave></pitch><voice>2</voice></note>
    </measure></part>
  </score-partwise>`);
      assert(source.includes(" < ") && source.includes("$p") && source.includes('_ "pizz."'),
        `后倚音、voice=2 力度和文字方向应保留：${source}`);
      const notes = playedNotes(compilePlayback(lower(source)));
      const c = notes.find(note => note.midi === 60);
      const e = notes.find(note => note.midi === 64);
      assert(c?.velocity === 80 && e?.velocity === 48 && notes.some(note => note.midi === 65),
          `p 只能作用 voice 2，后倚音 F 必须发声：${source}`);
  });

  test("未声明 steal-time-previous 的倚音跨小节绑定后继主音", () => {
      const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0">
    <part-list><score-part id="P1"><part-name>Grace</part-name></score-part></part-list>
    <part id="P1">
      <measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>
      <measure number="2"><note><grace/><pitch><step>D</step><octave>4</octave></pitch><voice>1</voice></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>
    </part>
  </score-partwise>`);
      assert(source.includes("{{D4} > E4}") && !source.includes("< {D4}"),
          `无 steal-time-previous 的倚音必须跨小节绑定后继主音：${source}`);
  });

  test("grace pitch 参与 tie 标签链", () => {
      const source = musicXmlToJpFun(`<?xml version="1.0"?>
  <score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Grace Tie</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><grace/><pitch><step>C</step><octave>4</octave></pitch><voice>1</voice><tie type="start"/></note><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="stop"/></note></measure></part></score-partwise>`);
      assert(source.includes("@tie("), `grace tie 应生成关系：${source}`);
      assert(compilePlayback(lower(source)).diagnostics.length === 0, `grace tie 应无诊断：${source}`);
  });

  test("MusicXML 非法 XML、音高、必填时值和选项会抛错", () => {
    throws(() => musicXmlToJpFun("<score-partwise>"));
    throws(() => musicXmlToJpFun(SCORE, { pitchMode: "other" as "relative" }));
    throws(() => musicXmlToJpFun(SCORE, { barsPerLine: 0 }));
    throws(() => musicXmlToJpFun(SCORE.replace("<duration>4</duration>", "")));
    throws(() => musicXmlToJpFun(SCORE.replace("<duration>4</duration>", "<duration>0</duration>")));
    throws(() => musicXmlToJpFun(SCORE.replace("<step>G</step>", "<step>H</step>")));
    throws(() => musicXmlToJpFun(SCORE.replace("<octave>4</octave>", "<alter>0.5</alter><octave>4</octave>")));
    throws(() => musicXmlToJpFun(SCORE.replace("<pitch><step>G</step><octave>4</octave></pitch>", "")));
    throws(() => musicXmlToJpFun(SCORE.replace("<fifths>1</fifths>", "<fifths>oops</fifths>")));
    const ending = (number: string) => `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Ending</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><ending number="${number}" type="start"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="right"><ending number="${number}" type="stop"/></barline></measure></part></score-partwise>`;
    for (const value of ["0", "2-1", "x", "257", "9007199254740992"]) {
      throws(() => musicXmlToJpFun(ending(value)), `非法 ending ${value} 必须抛错`);
    }
    const partialPage = SCORE.replace("<score-partwise version=\"4.0\">", "<score-partwise version=\"4.0\"><defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling><page-layout><page-margins><left-margin>40</left-margin><right-margin>40</right-margin><top-margin>40</top-margin><bottom-margin>40</bottom-margin></page-margins></page-layout></defaults>");
    assert(!musicXmlToJpFun(partialPage).includes("@page("), "缺少页面尺寸时应忽略不完整 page-layout");
    const noMargins = SCORE.replace("<score-partwise version=\"4.0\">", "<score-partwise version=\"4.0\"><defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling><page-layout><page-width>800</page-width><page-height>1200</page-height></page-layout></defaults>");
    assert(musicXmlToJpFun(noMargins).includes("top=48px, bottom=48px, left=40px, right=40px"),
      "缺少 page-margins 时应保留尺寸并采用 jpFun 默认边距");
  });