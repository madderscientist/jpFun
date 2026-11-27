import test from "node:test";
import { deepStrictEqual, throws } from "node:assert/strict";
import { DOMParser } from "@xmldom/xmldom";

import {
  ASTFunctionNode,
  compilePlayback,
  compileScore,
} from "jpfun";
import { musicXmlToJpFun as convertMusicXmlElement } from "@jpfun/convert/musicxml";
import { assert, assertProgramsAt, compileValid, lower, nearly, playedNotes, recordCommands } from "./helpers.js";

function importMusicXml(
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

function musicXmlToJpFun(source: string, options?: Parameters<typeof convertMusicXmlElement>[1]) {
  return importMusicXml(source, options).script;
}

function partwise(measures: string, name = "Part") {
  return `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>${name}</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
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

function restScore(count: number, style = count, extra = "", meter = "4") {
  return `<score-partwise><part-list><score-part id="P1"><part-name>Rest</part-name></score-part></part-list><part id="P1">${
    Array.from({ length: count }, (_, index) => `<measure number="${index + 1}">
      ${index === 0 ? `<attributes><divisions>1</divisions><time><beats>${meter}</beats><beat-type>4</beat-type></time><measure-style><multiple-rest>${style}</multiple-rest></measure-style></attributes>` : ""}
      ${index === 1 ? extra : ""}
      <note><rest measure="yes"/><duration>${meter}</duration><voice>1</voice></note>
      </measure>`).join("")
  }</part></score-partwise>`;
}

function compileMusicXml(xml: string, options?: Parameters<typeof convertMusicXmlElement>[1]) {
  const imported = importMusicXml(xml, options);
  deepStrictEqual(imported.diagnostics, []);
  const compiled = compileValid(imported.script);
  const playback = compilePlayback(compiled.lowering);
  deepStrictEqual(playback.diagnostics, []);
  return { ...compiled, script: imported.script, playback };
}

function slideScore(notations: string[], middle = "") {
  return `<score-partwise><part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
    <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>${
      notations.map((marks, i) => `${i === 1 ? middle : ""}<note><pitch><step>${i === 1 ? "F" : "B"}</step>
      <octave>${i === 1 ? 5 : 4}</octave></pitch><duration>1</duration><notations>${marks}</notations></note>`).join("")
    }</measure></part></score-partwise>`;
}

test("MusicXML MuseScore slide and four chord-line articulations retain visual marks and playback", () => {
  const marks = [
    '<slide line-type="solid" number="1" type="start"/>',
    '<slide line-type="solid" number="1" type="stop"/>',
    '<articulations><doit line-shape="straight"/><scoop line-shape="straight"/></articulations>',
    '<articulations><falloff line-shape="straight"/><plop line-shape="straight"/></articulations>',
  ];
  const result = compileMusicXml(slideScore(marks));
  assert((result.script.match(/@gliss\(/g) ?? []).length === 1, result.script);
  for (const combination of ["side=pre, direction=up", "side=pre, direction=down",
    "side=post, direction=up", "side=post, direction=down"]) assert(result.script.includes(combination), result.script);
  assert(result.layout.attachments.filter(item => item.sourceSpan
    && /^@(gliss|slide)\(/.test(result.script.slice(item.sourceSpan.start))).length === 5,
    "one gliss and four slide arrows");
  const plain = compileMusicXml(slideScore(["", "", "", ""]));
  const notes = (plan: typeof result.playback) => playedNotes(plan)
    .map(note => [note.midi, note.start.toString(), note.end.toString()]);
  deepStrictEqual(notes(result.playback), [
    [71, "0", "1/6"],
    [72, "1/6", "1/3"],
    [73, "1/3", "1/2"],
    [74, "1/2", "2/3"],
    [75, "2/3", "5/6"],
    [76, "5/6", "1"],
    ...notes(plain.playback).slice(1),
  ]);
});

test("MusicXML glissando kinds and numbers pair independently and report unsupported shapes", () => {
  const result = importMusicXml(slideScore([
    '<slide type="start" number="1"/><glissando type="start" number="1" line-type="wavy"/>',
    '<slide type="stop" number="1"/><glissando type="stop" number="1"/>',
  ]));
  assert((result.script.match(/@gliss\(/g) ?? []).length === 2, result.script);
  deepStrictEqual(result.diagnostics.map(item => item.code), ["W_MUSICXML_APPROXIMATED"]);
  compileValid(result.script);
  for (const marks of [
    ['<slide type="start"/>', ""],
    ["", '<slide type="stop"/>'],
    ['<slide type="start"/>', '<slide type="start"/>'],
  ]) {
    const unmatched = importMusicXml(slideScore(marks));
    assert(unmatched.diagnostics.length > 0 && unmatched.diagnostics.every(item =>
      item.code === "W_MUSICXML_UNRESOLVED_RELATION"), "unmatched relationships must warn");
    assert(!unmatched.script.includes("@gliss("), "no dangling labels");
  }
  const crossLine = compileMusicXml(slideScore(
    ['<slide type="start"/>', '<slide type="stop"/>'],
    '</measure><measure number="2"><print new-system="yes"/>'));
  const crossLineGliss = crossLine.layout.attachments.find(item => item.sourceSpan
    && crossLine.script.slice(item.sourceSpan.start).startsWith("@gliss("));
  assert(crossLineGliss?.regions.length === 2, "cross-line glissando spans two lines");
  const simultaneous = importMusicXml(slideScore(
    ['<slide type="start"/>', '<slide type="stop"/>']).replace(
      "<note><pitch><step>F</step>",
      "<note><chord/><pitch><step>F</step>"));
  assert(simultaneous.diagnostics.some(item => item.code === "W_MUSICXML_UNRESOLVED_RELATION"), "simultaneous warns");
  assert(!simultaneous.script.includes("@gliss("), "simultaneous relation omitted");
  compileValid(simultaneous.script);
});

test("MusicXML multiple-rest grouping, fallbacks, repeats and diagnostics", () => {
  const xml = restScore(4, 4, '<print new-system="yes"/>', "3").replace('<measure number="1">',
    '<measure number="1"><direction><direction-type><dynamics><p/></dynamics></direction-type><sound tempo="80"/></direction>');
  const result = compileMusicXml(xml);
  assert(result.script.includes("@rest(4)") && result.script.includes("$p"), result.script);
  assert(result.playback.performanceDuration.equals(12) && nearly(result.playback.durationSeconds, 9), "silent time retains tempo");

  const plainXml = restScore(2, 2, "", "3").replace("<measure-style><multiple-rest>2</multiple-rest></measure-style>", "");
  assert(!compileMusicXml(plainXml).script.includes("@rest("), "ordinary rests without multiple-rest stay 0");

  for (const count of [0, -1, 1.5]) throws(() => importMusicXml(restScore(1, count)), RangeError);
  for (const broken of [
    restScore(3, 3, '<direction><sound tempo="80"/></direction>'),
    restScore(2, 32),
  ]) {
    const imported = importMusicXml(broken);
    assert(!imported.script.includes("@rest(") && imported.diagnostics.some(d => d.location.element === "multiple-rest"), broken);
  }

  const twoVoice = restScore(2).replace("</measure>", `<backup><duration>4</duration></backup>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice></note></measure>`);
  assert(!importMusicXml(twoVoice).script.includes("@rest("), "active second voice prevents global @rest");

  const syncVoices = compileMusicXml(restScore(2).replaceAll("</measure>", `<backup><duration>4</duration></backup>
    <note><rest measure="yes"/><duration>4</duration><voice>2</voice></note></measure>`));
  assert(syncVoices.script.match(/@rest\(2\)/g)?.length === 2 && syncVoices.lowering.duration.equals(8), syncVoices.script);
});

test("MusicXML diagnoses omitted percussion with original XML location", () => {
  const result = importMusicXml(`<score-partwise><part-list><score-part id="P2"><midi-instrument id="D"><midi-channel>10</midi-channel></midi-instrument></score-part></part-list><part id="P2"><measure number="pickup"><attributes><divisions>1</divisions></attributes><note><unpitched><display-step>C</display-step><display-octave>2</display-octave></unpitched><duration>1</duration><voice>3</voice><staff>2</staff></note></measure></part></score-partwise>`);
  deepStrictEqual(result.diagnostics.map(({ code, severity, location }) => ({ code, severity, location })), [{
    code: "W_MUSICXML_PERCUSSION_SKIPPED",
    severity: "warning",
    location: { element: "note", partId: "P2", measureIndex: 1, measureNumber: "pickup", staff: "2", voice: "3" },
  }]);
  assert(!result.script.includes("C2"), "percussion must remain omitted");
});

test("MusicXML unequal-duration and cross-staff chords preserve every onset", () => {
  for (const [duration, staff] of [[1, 1], [2, 2], [1, 2]]) {
    const source = musicXmlToJpFun(`<score-partwise><part-list><score-part id="P1"><part-name>Chord</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><staves>2</staves></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note><note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>${duration}</duration><voice>1</voice><staff>${staff}</staff></note></measure></part></score-partwise>`);
    const result = compileScore(source);
    const notes = playedNotes(compilePlayback(result.lowering));
    assert(result.diagnostics.length === 0 && notes.length === 2, `both chord members must survive: ${source}`);
    assert(notes.every(note => note.start.equals(0)), "cross-staff chord members must share the leading onset");
    assert(notes.find(note => note.midi === 60)?.duration.equals(2), "leading duration must be retained");
    assert(notes.find(note => note.midi === 64)?.duration.equals(duration), "member duration must be retained");
  }
});

test("MusicXML diagnoses only discarded children of supported musical containers", () => {
  const xml = SCORE.replace("<note><pitch>", `<harmony><root><root-step>C</root-step></root><kind>major</kind></harmony><direction><direction-type><dynamics><p/><sfz/><f/></dynamics><pedal type="start"/></direction-type></direction><note><notations><fermata/><articulations><accent/><staccato/></articulations><ornaments><trill-mark/><tremolo>3</tremolo></ornaments><slur type="start"/></notations><pitch>`);
  const result = importMusicXml(xml);
  deepStrictEqual(result.diagnostics.map(item => item.location.element).sort(),
    ["f", "harmony", "pedal", "sfz", "slur", "tremolo"]);
  assert(result.diagnostics.every(item => item.code === "W_MUSICXML_UNSUPPORTED_ELEMENT"),
    "only discarded semantics should be diagnosed");
  assert(result.script.includes("$fermata") && result.script.includes("$accent")
    && result.script.includes("$tr") && result.script.includes("$p")
    && result.script.includes("$staccato"), "supported siblings must still be preserved");
});

test("MusicXML imports basic articulations, turns, and diagnoses unsupported or approximated marks", () => {
  for (const [container, tag, name] of [
    ["articulations", "staccato", "staccato"],
    ["articulations", "tenuto", "tenuto"],
    ["articulations", "strong-accent", "marcato"],
    ["articulations", "staccatissimo", "staccato"],
    ["articulations", "accent", "accent"],
    ["ornaments", "trill-mark", "tr"],
    ["ornaments", "turn", "turn"],
    ["ornaments", "inverted-turn", "iturn"],
  ] as const) {
    const result = compileMusicXml(slideScore([`<${container}><${tag} placement="below"/></${container}>`]));
    assert(result.script.includes(`_ $${name}`), result.script);
  }
  assert(compileMusicXml(slideScore(['<fermata type="inverted"/>'])).script.includes("_ $fermata"), "inverted fermata goes below");
  const approx = importMusicXml(slideScore(['<ornaments><turn slash="yes"/></ornaments>']));
  deepStrictEqual(approx.diagnostics.map(item => item.code), ["W_MUSICXML_APPROXIMATED"]);

  const breath = importMusicXml(slideScore(["<articulations><breath-mark>comma</breath-mark></articulations>"]));
  deepStrictEqual(breath.diagnostics.map(item => [item.code, item.location.element]),
    [["W_MUSICXML_UNSUPPORTED_ELEMENT", "breath-mark"]]);
});

test("MusicXML diagnoses unattached controls, unresolved relations, and overwritten tempos", () => {
  const note = `<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>`;
  const terminal = importMusicXml(`<score-partwise><part id="P1"><measure number="1">${note}<direction><direction-type><dynamics><p/></dynamics><metronome><beat-unit>quarter</beat-unit><per-minute>88</per-minute></metronome></direction-type></direction></measure></part></score-partwise>`);
  deepStrictEqual(terminal.diagnostics.map(item => item.location.element).sort(), ["dynamics", "metronome"]);

  const missingVoice = importMusicXml(`<score-partwise><part id="P1"><measure number="1"><direction><direction-type><dynamics><p/></dynamics><wedge type="crescendo"/></direction-type><staff>2</staff></direction>${note}<direction><direction-type><wedge type="stop"/></direction-type><staff>2</staff></direction></measure></part></score-partwise>`);
  deepStrictEqual(missingVoice.diagnostics.map(item => [item.code, item.location.element]), [
    ["W_MUSICXML_UNATTACHED_CONTENT", "dynamics"],
    ["W_MUSICXML_UNRESOLVED_RELATION", "wedge"],
  ]);

  const conflictTempo = importMusicXml(SCORE.replace("<note><pitch>", `<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="90"/></direction><note><pitch>`));
  assert(conflictTempo.script.includes("H.tempo: 90"), "sound tempo must retain precedence");
  deepStrictEqual(conflictTempo.diagnostics.map(item => item.location.element), ["metronome"]);

  const displayPitch = importMusicXml(SCORE.replace("<pitch><step>G</step><octave>4</octave></pitch>", "<unpitched><display-step>G</display-step><display-octave>4</display-octave></unpitched>"));
  deepStrictEqual(displayPitch.diagnostics.map(item => [item.code, item.location.element]), [["W_MUSICXML_APPROXIMATED", "unpitched"]]);
});

test("MusicXML percussion warnings do not cascade or alter chord and grace timing", () => {
  const result = importMusicXml(`<score-partwise><part-list><score-part id="P1"><midi-instrument id="D"><midi-channel>10</midi-channel></midi-instrument><midi-instrument id="M"><midi-channel>1</midi-channel></midi-instrument></score-part></part-list><part id="P1"><measure number="1"><note><instrument id="D"/><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><notations><articulations><staccato/></articulations></notations></note><note><chord/><instrument id="M"/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note><note><chord/><instrument id="D"/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note><note><grace/><instrument id="D"/><unpitched><display-step>C</display-step><display-octave>2</display-octave></unpitched></note><note><instrument id="M"/><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>`);
  deepStrictEqual(result.diagnostics.map(item => item.code), new Array(3).fill("W_MUSICXML_PERCUSSION_SKIPPED"));
  deepStrictEqual(playedNotes(compilePlayback(lower(result.script))).map(note => [note.midi, note.start.toString()]), [[64, "0"], [62, "1"]]);
  throws(() => importMusicXml(`<score-partwise><part-list><score-part id="P1"><midi-instrument><midi-channel>10</midi-channel></midi-instrument></score-part></part-list><part id="P1"><measure><note><unpitched/><duration>1</duration></note></measure></part></score-partwise>`), RangeError);
});

test("MusicXML diagnoses after-grace fallback without changing its converted host", () => {
  const xml = `<score-partwise><part id="P1"><measure number="1"><note><grace steal-time-previous="10"/><pitch><step>D</step><octave>4</octave></pitch></note><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>`;
  const result = importMusicXml(xml);
  deepStrictEqual(result.diagnostics.map(item => [item.code, item.location.element]), [["W_MUSICXML_APPROXIMATED", "grace"]]);
  assert(result.script === musicXmlToJpFun(xml.replace(' steal-time-previous="10"', "")),
    "the existing before-grace fallback must be retained");
});

test("MusicXML sound instrument changes honor direction offsets", () => {
  for (const change of [
    `<sound><midi-instrument id="I1"><midi-program>42</midi-program></midi-instrument></sound>`,
    `<direction><offset>0</offset><sound><midi-instrument id="I1"><midi-program>42</midi-program></midi-instrument></sound></direction>`,
  ]) {
    const source = musicXmlToJpFun(`<score-partwise><part-list><score-part id="P1"><part-name>Instrument</part-name><midi-instrument id="I1"><midi-channel>1</midi-channel><midi-program>41</midi-program></midi-instrument></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>${change}<note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>`);
    const programs = compilePlayback(lower(source)).events.filter(event => event.kind === "program-change");
    assert(programs.map(event => `${event.at}:${event.program}`).join() === "0:40,1:41", `sound must update the program: ${source}`);
  }
});

test("MusicXML future program changes do not leak through backup", () => {
  const source = musicXmlToJpFun(`<score-partwise><part-list><score-part id="P1"><part-name>Instrument</part-name><midi-instrument id="I1"><midi-program>41</midi-program></midi-instrument></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><direction><offset>2</offset><sound><midi-instrument id="I1"><midi-program>42</midi-program></midi-instrument></sound></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><backup><duration>3</duration></backup><note><pitch><step>F</step><octave>4</octave></pitch><duration>3</duration><voice>2</voice></note></measure></part></score-partwise>`);
  assert(assertProgramsAt(source, 2, 40, 41) === 4, "all voices must remain audible");
});

test("MusicXML imports repeated dynamics with placement, persistence and velocity clamping", () => {
  for (const [name, velocity] of [["pppppp", 1], ["p", 49], ["f", 96], ["ffffffff", 127]] as const) {
    const direction = `<direction placement="below"><direction-type><dynamics><${name}/></dynamics></direction-type></direction>`;
    const result = compileMusicXml(slideScore(["", "", ""], direction));
    assert(result.script.includes(`_ $${name}`), result.script);
    deepStrictEqual(playedNotes(result.playback).map(note => [note.start.toString(), note.velocity]),
      [["0", 80], ["1", velocity], ["2", velocity]]);
  }
  const result = importMusicXml(slideScore(["", ""],
    "<direction><direction-type><dynamics><fp/><ppppf/><ffff/><pppp/></dynamics></direction-type></direction>"));
  deepStrictEqual(result.diagnostics.map(item => [item.code, item.location.element]), [
    ["W_MUSICXML_UNSUPPORTED_ELEMENT", "fp"],
    ["W_MUSICXML_UNSUPPORTED_ELEMENT", "ppppf"],
    ["W_MUSICXML_UNSUPPORTED_ELEMENT", "pppp"],
  ]);
  deepStrictEqual(playedNotes(compilePlayback(compileValid(result.script).lowering)).map(note => note.velocity), [80, 127]);
});

test("MusicXML dynamics preserve offsets inside sustained notes and rests", () => {
  for (const first of [
    "<pitch><step>C</step><octave>4</octave></pitch>",
    "<rest/>",
  ]) {
    const source = musicXmlToJpFun(`<score-partwise><part-list><score-part id="P1"><part-name>Offset</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>2</divisions></attributes><direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type><offset>1</offset></direction><note>${first}<duration>4</duration></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration></note></measure></part></score-partwise>`);
    const result = compileScore(source);
    const notes = playedNotes(compilePlayback(result.lowering));
    const leading = notes.find(note => note.midi === 60);
    assert(!leading || leading.velocity === 80 && leading.start.equals(0) && leading.duration.equals(2),
      "a later dynamic must not change or retrigger the leading note");
    assert(notes.find(note => note.midi === 62)?.velocity === 49, "the next onset must inherit the dynamic");
    const dynamic = [...result.lowering.astToTemporal.values()].flat().find(node =>
      node.ast instanceof ASTFunctionNode && node.ast.callName === "symbol");
    assert(dynamic?.t.equals(1, 2), `the direction offset must survive conversion: ${source}`);
    assert(source.includes("_ $p"), "below placement must be retained");
  }
});

test("MusicXML dynamics inside tuplets stay local to the selected voice", () => {
  const tuplet = ["G", "A", "B"].map(step => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>2</duration><voice>2</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>`).join("");
  const source = musicXmlToJpFun(`<score-partwise><part-list><score-part id="P1"><part-name>Voices</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>6</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice></note><backup><duration>12</duration></backup><direction><direction-type><dynamics><p/></dynamics></direction-type><offset>1</offset><voice>2</voice></direction>${tuplet}<note><pitch><step>C</step><octave>5</octave></pitch><duration>6</duration><voice>2</voice></note></measure></part></score-partwise>`);
  const result = compileScore(source);
  const notes = playedNotes(compilePlayback(result.lowering));
  assert(notes.find(note => note.midi === 60)?.velocity === 80, "the other voice must retain its own dynamic");
  assert(notes.find(note => note.midi === 67)?.velocity === 80, "the first tuplet onset precedes the change");
  for (const [index, midi] of [67, 69, 71].entries()) {
    const note = notes.find(note => note.midi === midi);
    assert(note && note.start.equals(index, 3) && note.duration.equals(1, 3), "control slicing must preserve tuplet timing");
    if (index > 0) assert(note.velocity === 49, "later tuplet onsets must inherit the dynamic");
  }
  assert(notes.find(note => note.midi === 72)?.velocity === 49, "the dynamic must survive the end of the tuplet");
  const dynamic = [...result.lowering.astToTemporal.values()].flat().find(node =>
    node.ast instanceof ASTFunctionNode && node.ast.callName === "symbol");
  assert(dynamic?.t.equals(1, 6), `the tuplet direction must retain its exact offset: ${source}`);
});

test("MusicXML 的 part、staff、voice、chord、rest 和 backup 转成可播放 jpFun", () => {
    const { script: source, playback } = compileMusicXml(SCORE);
    assert(!source.includes("@head(")
        && source.includes("H.title: Example")
        && source.includes("H.signature: 1=G4 3/4") && source.includes("H.tempo: 120"),
        `初始调号、拍号和速度必须使用 head 语法糖：${source}`);
    assert(!source.slice(source.indexOf("\n\n") + 2, source.indexOf("N(")).match(/@(1|tempo|meter)\(/),
        `正文首行不得重复初始状态：${source}`);
    assert(source.includes("N(\"Piano\"):") && source.includes("N(\"Flute\"):")
      && !source.includes("@note(") && !source.includes("@div(")
      && !source.includes("@voice(") && !source.includes("@voices("),
    `part 名称应保留，普通音符、减时线和 voices 应使用语法糖：${source}`);
    deepStrictEqual(playedNotes(playback).map(note => `${note.midi}@${note.start}+${note.duration}`).sort(),
      ["55@0+3", "67@0+1", "71@0+1", "74@0+3"]);
});

test("MusicXML 保留复合拍号的书面分母", () => {
  const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>2</divisions><time><beats>6</beats><beat-type>8</beat-type></time></attributes><note><rest/><duration>6</duration><voice>1</voice></note></measure>`));
  assert(source.includes("H.signature: 1=C4 6/8"), `6/8 不得约分成 3/4：${source}`);
});

// 调号与移调测试用的最小 MusicXML 片段
const note = (pitch: string, staff = 0, duration = 1) => `<note><pitch><step>${pitch[0]}</step>${
  pitch[1] === "#" ? "<alter>1</alter>" : ""}<octave>4</octave></pitch><duration>${duration}</duration>${staff ? `<staff>${staff}</staff>` : ""}</note>`;
const rest = (staff = 0) => `<note><rest/><duration>1</duration>${staff ? `<staff>${staff}</staff>` : ""}</note>`;
const backup = (duration = 1) => `<backup><duration>${duration}</duration></backup>`;
const key = (fifths: number, attributes = "") => `<key${attributes}><fifths>${fifths}</fifths></key>`;
const bar = (number: number, attributes: string, body: string) =>
  `<measure number="${number}">${attributes && `<attributes>${attributes}</attributes>`}${body}</measure>`;
const scale = (fifths: number, pitches: string[], transpose = "", number = 1) =>
  bar(number, key(fifths) + transpose, pitches.map(pitch => note(pitch)).join(""));
const duet = (first: string, second: string, firstInstrument = "") => `<score-partwise><part-list>
  <score-part id="P1"><part-name>P1</part-name>${firstInstrument}</score-part>
  <score-part id="P2"><part-name>P2</part-name></score-part></part-list>
  <part id="P1">${first}</part><part id="P2">${second}</part></score-partwise>`;

const bbClarinet = "<transpose><chromatic>-2</chromatic></transpose>";
const aClarinet = "<transpose><diatonic>-2</diatonic><chromatic>-3</chromatic></transpose>";

test("MusicXML 移调乐器的音符与调号一起换算为实音", () => {
  const sax = "<transpose><diatonic>-5</diatonic><chromatic>-9</chromatic><octave-change>-1</octave-change></transpose>";
  for (const [name, xml, pitchMode, expected, midi] of [
    ["降 B 单簧管中途转调", partwise(scale(2, ["D", "E", "F#", "G"], bbClarinet) + scale(0, ["C"], "", 2)),
      "relative", ["1=C4", "1 2 3 4", "@1(Bb4)"], [60, 62, 64, 65, 58]],
    ["换 A 单簧管但不重写调号", partwise(scale(2, ["D"], bbClarinet) + bar(2, aClarinet, note("D"))),
      "relative", ["1=C4", "@1(B4)"], [60, 59]],
    ["低音域萨克斯的八度移调不改变调号", partwise(scale(0, ["C"], sax)), "absolute", ["1=Eb4", "Eb2"], [39]],
  ] as const) {
    const { script, playback } = compileMusicXml(xml, { pitchMode });
    assert(expected.every(text => script.includes(text)), `${name}\n${script}`);
    deepStrictEqual(playedNotes(playback).map(item => item.midi), midi, name);
  }
});

test("MusicXML 按谱表合成全谱实音调号", () => {
  const twoBarsOfD = scale(2, ["D"]) + scale(2, ["D"], "", 2);
  const drums = bar(1, key(0) + "<clef><sign>percussion</sign></clef>",
    "<note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>1</duration></note>");
  const visibleThenHidden = scale(0, ["C"]) + bar(2, key(2, ' print-object="no"'), note("D"));
  const concertG = scale(3, ["A"], bbClarinet);
  const hiddenUpperVisibleLower = `<staves>2</staves>${key(0, ' number="1" print-object="no"')}${key(2, ' number="2"')}`;
  const visibleBothStaves = `<staves>2</staves>${key(0, ' number="1"')}${key(2, ' number="2"')}`;
  const laterLowerStaff = (staves: string) =>
    bar(1, staves + key(0), rest(1)) + bar(2, "<staves>2</staves>", note("C", 2));
  const staffDrop = `<divisions>1</divisions><staves>2</staves>${key(1, ' number="1" print-object="no"')}${key(2, ' number="2"')}`;
  // [名称, XML, 首调, 后续换调, 冲突警告的 [声部, 小节, 谱表]]
  const cases: [string, string, string, string[], (string | number | undefined)[][]][] = [
    ["打击乐声部在前", duet(drums, twoBarsOfD), "D4", [], []],
    ["隐藏调号声部在前", duet(bar(1, key(0, ' print-object="no"'), note("C")), twoBarsOfD), "D4", [], []],
    ["通道 10 鼓轨在前", duet(scale(0, ["C"]), twoBarsOfD,
      `<midi-instrument id="P1-I1"><midi-channel>10</midi-channel></midi-instrument>`), "D4", [], []],
    ["钢琴与单簧管实音一致", duet(scale(0, ["C"]), scale(2, ["D"], bbClarinet)), "C4", [], []],
    ["单簧管与钢琴实音一致", duet(scale(2, ["D"], bbClarinet), scale(0, ["C"])), "C4", [], []],
    ["冲突时保留控制声部", duet(scale(0, ["C"]), concertG + scale(1, ["G"], "", 2)), "C4", [], [["P2", 1, undefined], ["P2", 2, undefined]]],
    ["控制声部为单簧管", duet(concertG, scale(0, ["C"]) + scale(1, ["G"], "", 2)), "G4", [], [["P2", 1, undefined]]],
    ["独奏调号改为隐藏", partwise(visibleThenHidden), "C4", ["D4"], []],
    ["隐藏后让给其他声部", duet(visibleThenHidden, scale(1, ["G"]) + scale(1, ["G"], "", 2)), "C4", ["G4"], [["P2", 1, undefined]]],
    ["控制声部转调后首次冲突", duet(scale(0, ["C"]) + scale(2, ["D"], "", 2) + scale(2, ["D"], "", 3),
      scale(0, ["C"]) + bar(2, "", rest()) + bar(3, "", rest())), "C4", ["D4"], [["P2", 2, undefined]]],
    ["显式等音换调号", partwise(scale(6, ["F#"]) + scale(-6, ["G"], "", 2)), "F#4", ["Gb4"], []],
    ["只有下谱表转调", partwise(bar(1, `<staves>2</staves>${key(0)}`, note("C", 1) + backup() + note("C", 2))
      + bar(2, key(2, ' number="2"'), note("C", 1) + backup() + note("D", 2))), "C4", [], [["P1", 2, "2"]]],
    ["全休止上谱表", partwise(bar(1, visibleBothStaves, rest(1) + backup() + note("D", 2))), "D4", [], []],
    ["只有无宿主倚音的上谱表", partwise(bar(1, visibleBothStaves, rest(1)
      + `<note><grace/><pitch><step>C</step><octave>5</octave></pitch><staff>1</staff></note>` + backup() + note("D", 2))), "D4", [], []],
    ["只有下谱表移调", partwise(bar(1, `<staves>2</staves>${key(0)}<transpose number="2"><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>`,
      note("C", 1) + backup() + note("D", 2))), "C4", [], [["P1", 1, "2"]]],
    ["移除可见调号的谱表", partwise(bar(1, hiddenUpperVisibleLower, note("C", 1) + backup() + note("D", 2))
      + bar(2, `<staves>1</staves>${key(1, ' print-object="no"')}`, note("G", 1))), "D4", ["G4"], []],
    ["移除唯一有调号的谱表", partwise(bar(1, `<divisions>1</divisions><staves>2</staves>${key(2, ' number="2"')}`, note("D", 2))
      + bar(2, "<staves>1</staves>", note("C", 1))), "D4", ["C4"], []],
    ["首个 staves 省略", duet(laterLowerStaff(""), twoBarsOfD), "D4", ["C4"], [["P2", 2, undefined]]],
    ["首个 staves 为 1", duet(laterLowerStaff("<staves>1</staves>"), twoBarsOfD), "D4", ["C4"], [["P2", 2, undefined]]],
    ["首小节只有 forward", partwise(bar(1, `<divisions>1</divisions><staves>1</staves>${key(2)}`, "<forward><duration>4</duration></forward>")
      + bar(2, "<staves>2</staves>", note("D", 2))), "D4", [], []],
    ["谱表数减为 0", duet(scale(0, ["C"]) + bar(2, "<staves>0</staves>", ""), twoBarsOfD), "C4", ["D4"], [["P2", 1, undefined]]],
    ["谱表数按时间生效", partwise(bar(1, staffDrop, note("G", 1, 2) + "<attributes><staves>1</staves></attributes>" + note("G", 1, 2)
      + backup(4) + note("D", 2, 2))), "D4", ["G4"], []],
    ["谱表数不按 XML 顺序生效", partwise(bar(1, "<divisions>1</divisions>", "<forward><duration>2</duration></forward>"
      + "<attributes><staves>1</staves></attributes>" + backup(2) + `<attributes>${staffDrop}</attributes>`
      + note("G", 1, 4) + backup(4) + note("D", 2, 2))), "D4", ["G4"], []],
  ];
  for (const [name, xml, signature, changes, warnings] of cases) {
    const { script, diagnostics } = importMusicXml(xml);
    assert(script.includes(`H.signature: 1=${signature}`), `${name}\n${script}`);
    deepStrictEqual([...script.matchAll(/@1\(([^)]+)\)/g)].map(match => match[1]), changes, name);
    deepStrictEqual(diagnostics.filter(({ location }) => location.element === "key" || location.element === "transpose")
      .map(({ location }) => [location.partId, location.measureIndex, location.staff]), warnings, name);
  }
});

test("MusicXML 按 part-list 而非正文顺序决定声部顺序与调号优先级", () => {
  const partList = `<part-list>${["P1", "P2"].map(id =>
    `<score-part id="${id}"><part-name>${id}</part-name></score-part>`).join("")}</part-list>`;
  const timewisePart = (id: string, fifths: number, step: string) => `<part id="${id}"><attributes>${key(fifths)}</attributes>${note(step)}</part>`;
  for (const xml of [
    `<score-partwise>${partList}<part id="P2">${scale(2, ["D"])}</part><part id="P1">${scale(0, ["C"])}</part></score-partwise>`,
    `<score-timewise>${partList}<measure number="1">${timewisePart("P2", 2, "D")}${timewisePart("P1", 0, "C")}</measure></score-timewise>`,
  ]) {
    const { script, diagnostics } = importMusicXml(xml);
    assert(script.includes("H.signature: 1=C4") && script.indexOf('N("P1")') < script.indexOf('N("P2")'), script);
    deepStrictEqual(diagnostics.map(({ location }) => [location.partId, location.element]), [["P2", "key"]]);
  }
});

test("MusicXML instrument 切换 program 且 channel 10 鼓点跳过", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list>
<score-part id="P1"><part-name>Lead</part-name><score-instrument id="P1-I1"><instrument-name>A</instrument-name></score-instrument><score-instrument id="P1-I2"><instrument-name>B</instrument-name></score-instrument><midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>41</midi-program></midi-instrument><midi-instrument id="P1-I2"><midi-channel>1</midi-channel><midi-program>42</midi-program></midi-instrument></score-part>
<score-part id="P2"><part-name>Drums</part-name><score-instrument id="P2-I1"><instrument-name>Drums</instrument-name></score-instrument><midi-instrument id="P2-I1"><midi-channel>10</midi-channel><midi-program>1</midi-program></midi-instrument></score-part>
</part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><instrument id="P1-I1"/><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><instrument id="P1-I2"/><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure></part><part id="P2"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><instrument id="P2-I1"/><unpitched><display-step>C</display-step><display-octave>2</display-octave></unpitched><duration>1</duration><voice>1</voice></note><note><instrument id="P2-I1"/><unpitched><display-step>D</display-step><display-octave>2</display-octave></unpitched><duration>1</duration><voice>1</voice></note></measure></part></score-partwise>`);
  const plan = compilePlayback(lower(source));
  const programs = plan.events.filter(event => event.kind === "program-change");
  assert(!source.includes("Drums") && playedNotes(plan).map(note => note.midi).join() === "60,62",
    `channel 10 的 MusicXML 鼓点应被跳过：${source}`);
  assert(programs.map(event => `${event.at}:${event.program}`).join(" ") === "0:40 1:41",
    `instrument id 切换应生成 1..128 → 0..127 的 program-change：${source}`);
});

test("首个 MusicXML lane 全休止时仍保留中途状态", () => {
  const source = musicXmlToJpFun(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P0"><part-name>Rest</part-name></score-part><score-part id="P1"><part-name>Melody</part-name></score-part></part-list><part id="P0"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><rest/><duration>1</duration><voice>1</voice></note></measure><measure number="2"><attributes><key><fifths>1</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="80"/></direction><note><rest/><duration>2</duration><voice>1</voice></note></measure></part><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure><measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note></measure></part></score-partwise>`);
  assert(source.includes("@1(G4)") && source.includes("@meter(2, 4)") && source.includes("@tempo(80)"),
    `中途调号、拍号和速度不得因首 lane 全休止而丢失：${source}`);
  assert(compilePlayback(lower(source)).diagnostics.length === 0, `休止上的状态声明应可编译：${source}`);
});

test("MusicXML 状态变化在持续音内部的精确时刻生效", () => {
  const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><offset>2</offset><sound tempo="80"/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note></measure><measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note></measure>`));
  const notes = playedNotes(compilePlayback(lower(source)));
  const next = notes.find(note => note.midi === 62);
  assert(/\{-+\s+\^\s+@tempo\(80\)\}/.test(source), `长音必须在变化点切出带状态的 dash：${source}`);
  assert(next?.bpm === 80, `变化后的音符必须使用新速度：${source}`);
});

test("MusicXML 状态变化可附着到 tuplet 首成员", () => {
  const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>6</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>B</step><octave>3</octave></pitch><duration>6</duration><voice>1</voice></note><direction><sound tempo="80"/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="start"/></notations></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="stop"/></notations></note><note><rest/><duration>12</duration><voice>1</voice></note></measure>`));
  assert(/@tuplet\(\{\{C4[/.]*\s+\^\s+@tempo\(80\)\}/.test(source),
    `状态必须附着到 tuplet 首成员，而不是包裹整个 tuplet：${source}`);
  assert(compilePlayback(lower(source)).diagnostics.length === 0, `带状态的 tuplet 必须可编译：${source}`);
});

test("MusicXML tuplet 内后续成员消费状态且不切开整组", () => {
  const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>6</divisions><key><fifths>0</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>B</step><octave>3</octave></pitch><duration>6</duration><voice>1</voice></note><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="start"/></notations></note><attributes><key><fifths>1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="80"/></direction><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="stop"/></notations></note><note><rest/><duration>6</duration><voice>1</voice></note></measure>`));
  const tuplet = source.match(/@tuplet\(\{([\s\S]*?)\}, 2\)/)?.[1] ?? "";
  assert(tuplet.includes("@1(G4)") && tuplet.includes("@meter(3, 4)") && tuplet.includes("@tempo(80)"),
    `tuplet 第二成员的状态必须留在整组内部：${source}`);
  assert((source.match(/@tempo\(80\)/g) ?? []).length === 1
    && (source.match(/@meter\(3, 4\)/g) ?? []).length === 1
    && (source.match(/@1\(G4\)/g) ?? []).length === 1,
  `tuplet 内状态不得被外层时间线重复输出：${source}`);
});

test("MusicXML tuplet 成员内部的状态按 offset 精确切分", () => {
  const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>6</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>B</step><octave>3</octave></pitch><duration>6</duration><voice>1</voice></note><direction><offset>1</offset><sound tempo="80"/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="start"/></notations></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="stop"/></notations></note><note><pitch><step>F</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice></note></measure>`));
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
  const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>6</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>B</step><octave>3</octave></pitch><duration>6</duration><voice>1</voice><lyric><text>before</text></lyric></note><direction><offset>1</offset><sound tempo="80"/></direction><note><rest/><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="start"/></notations></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><lyric><text>after</text></lyric></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="stop"/></notations></note><note><rest/><duration>12</duration><voice>1</voice></note></measure>`));
  assert(source.includes('L: "before @ @ after @ @ @"'),
    `切成两个 token 的 tuplet 休止必须补两个歌词槽：${source}`);
  const texts = recordCommands(compileScore(source).layout).filter(command => command.kind === "text");
  assert(texts.some(command => command.text === "before") && texts.some(command => command.text === "after"),
    `休止切分后歌词仍必须进入正确音符：${source}`);
});

test("MusicXML 缺失 tempo 的 sound 不会被当作零速度", () => {
  const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><sound dynamics="80"/><sound tempo=""/><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type><sound/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>`));
  assert(source.includes("H.tempo: 90"), `缺失 tempo 的 sound 应忽略，direction 应回退 metronome：${source}`);
});

test("MusicXML 后续和弦成员的 modifier 合并到和弦", () => {
  const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><articulations><accent placement="below"/></articulations></notations></note><note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><articulations><accent placement="below"/></articulations><ornaments><trill-mark placement="above"/></ornaments></notations></note></measure>`));
  assert(source.includes("_ $accent") && source.includes("^ $tr"),
    `后续和弦成员的 modifier 必须保留：${source}`);
  assert((source.match(/\$accent/g) ?? []).length === 1,
    `相同名称和位置的 modifier 必须去重：${source}`);
});

test("MusicXML arpeggiate 转成上下行 arp", () => {
  const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
<note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><notations><arpeggiate number="1"/></notations></note>
<note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><notations><arpeggiate number="1"/></notations></note>
<note><chord/><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><notations><arpeggiate number="1"/></notations></note>
<note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><notations><arpeggiate direction="down" number="1"/></notations></note>
<note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><notations><arpeggiate direction="down" number="1"/></notations></note>
<note><chord/><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><notations><arpeggiate direction="down" number="1"/></notations></note>
</measure>`));
  assert(source.includes("@arp({G4 ^ B4 ^ D5})")
    && source.includes("@arp({G4 ^ B4 ^ D5}, direction=down)"),
  `MusicXML 琶音方向必须包装整个和弦：${source}`);
  const notes = playedNotes(compilePlayback(lower(source)));
  assert(notes.slice(0, 3).map(note => note.midi).join(",") === "67,71,74"
    && notes.slice(3, 6).map(note => note.midi).join(",") === "74,71,67",
  `导入后的上下行琶音必须改变播放顺序：${source}`);

  const upThen = (second: string) => musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions></attributes>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><arpeggiate direction="up"/></notations></note>
<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><notations><arpeggiate${second}/></notations></note>
</measure>`));
  const explicitUp = upThen("");
  assert(explicitUp.includes("@arp({C4 ^ E4}, direction=up)"),
    `显式 up 必须保留向上箭头，未指定方向的和弦成员不得制造冲突：${explicitUp}`);
  throws(() => upThen(' direction="down"'), /Conflicting MusicXML arpeggiate directions/);
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
    const source = musicXmlToJpFun(partwise(`<measure number="1">
    <attributes><divisions>4</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
    <barline location="left"><repeat direction="forward"/></barline>
    <direction placement="below"><direction-type><dynamics><p/></dynamics><wedge type="crescendo" number="1"/></direction-type></direction>
    <note><grace slash="yes"/><pitch><step>D</step><octave>4</octave></pitch><voice>1</voice></note>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><tie type="start"/><notations><tied type="start"/></notations></note>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><tie type="stop"/><notations><tied type="stop"/></notations></note>
    <direction><direction-type><wedge type="stop" number="1"/></direction-type></direction>
    <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
    <barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>
  </measure>`));
    assert(source.includes(" > ") && source.includes("$p") && source.includes("@tie(")
        && source.includes("@dyn(") && source.includes("|:") && source.includes(":|"),
    `grace、tie、力度、wedge 与反复线都应输出：${source}`);
    assert(/@mx\d+\s+@tie\(mx\d+, mx\d+\)/.test(source), `tie 应紧跟在 stop 端点音符之后：${source}`);
    const plan = compilePlayback(lower(source));
    const notes = playedNotes(plan);
    assert(plan.diagnostics.length === 0
        && notes.some(note => note.midi === 62) && notes.filter(note => note.midi === 60).length === 2,
    `倚音与反复后的连音应保留：${source}`);
});

  test("跨小节 MusicXML tuplet 保留内部小节线与整组比例", () => {
    const triplet = (step: string, marker = "") => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>${marker ? `<notations><tuplet type="${marker}"/></notations>` : ""}</note>`;
    const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>6</divisions><time><beats>1</beats><beat-type>8</beat-type></time></attributes>${triplet("C", "start")}${triplet("D")}${triplet("E")}</measure>
    <measure number="2">${triplet("F")}${triplet("G")}${triplet("A", "stop")}</measure>`), { barsPerLine: 1 });
    assert(source.includes("@tuplet(") && source.includes(", 4)")
      && (source.match(/^N/gm) ?? []).length === 1,
    `六个 3:2 子音组成的整组应推导 normal=4，且内部小节线不得拆系统：${source}`);
    const plan = compilePlayback(lower(source));
    const notes = playedNotes(plan);
    assert(plan.diagnostics.length === 0 && notes.length === 6 && notes.every((note, index) =>
      note.start.equals(index, 6) && note.duration.equals(1, 6)),
    `跨小节三连音应保持连续六个 1/6 QN：${source}`);
  });

  test("MusicXML 多段歌词保留连字符并为缺词音符补位", () => {
    const source = musicXmlToJpFun(partwise(`<measure number="1">
    <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><lyric number="1"><syllabic>begin</syllabic><text>Hel</text><elision>‿</elision><text>le</text></lyric><lyric number="2"><text>你好</text></lyric></note>
    <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric number="1"><syllabic>end</syllabic><text>lo</text></lyric></note>
    <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric number="2"><text>呀</text></lyric></note>
    </measure>`));
    assert(source.includes('"Hel~le- @ lo @"') && source.includes('"{你好} @ @ 呀"'),
      `两段歌词、增时线与缺词音符占位应写入 voice：${source}`);
    const commands = recordCommands(compileScore(source).layout);
    assert(["Hel~le-", "lo", "你好", "呀"].every(text =>
      commands.some(command => command.kind === "text" && command.text === text)), `歌词应实际进入布局：${source}`);
  });

  test("MusicXML forward 生成的休止为后续歌词补位", () => {
    const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric><text>one</text></lyric></note><forward><duration>1</duration></forward><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric><text>two</text></lyric></note></measure>`));
    assert(source.includes('L: "one @ two"'), `forward 休止必须占一个歌词槽：${source}`);
    const commands = recordCommands(compileScore(source).layout).filter(command => command.kind === "text");
    const one = commands.find(command => command.text === "one");
    const two = commands.find(command => command.text === "two");
    assert(one && two && one.x < two.x, `two 必须落到第二个音符而非中间休止：${source}`);
  });

  test("MusicXML 含空格、槽位控制字符或混合文字的单个歌词保持一个槽并按字面显示", () => {
    for (const [first, second, expected] of [
      ["<text>one word</text>", "<text>two</text>", ["one word", "two"]],
      ["<text>@{a-b}</text>", "<text>C:\Music</text>", ["@{a-b}", "C:\Music"]],
      ["<text>A你</text>", "<syllabic>begin</syllabic><text>你</text>", ["A你", "你-"]],
    ] as const) {
      const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric>${first}</lyric></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><lyric>${second}</lyric></note></measure>`));
      const texts = recordCommands(compileScore(source).layout).filter(command => command.kind === "text");
      assert(expected.every(text => texts.some(command => command.text === text)), source);
      if (expected[0] === "one word") assert(source.includes('L: "{one word} two"'), `含空格歌词应使用单槽分组：${source}`);
    }
  });

  test("MusicXML 有显式换行时不叠加 barsPerLine 自动换行", () => {
    const measures = Array.from({ length: 10 }, (_, index) => `<measure number="${index + 1}">${index === 0 ? '<attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes>' : ""}${index === 6 ? '<print new-system="yes"/>' : ""}<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>`).join("");
    const source = musicXmlToJpFun(partwise(measures), { barsPerLine: 4 });
    assert(source.split("\n\n").length - 1 === 2,
        `十小节应沿用 MusicXML 的 6+4 系统，不得额外切成 4+2+4：${source}`);
  });

test("MusicXML ending 生成 volta、覆盖延音并支持分支 tie 链", () => {
  const source = musicXmlToJpFun(partwise(`
  <measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="start"/></note></measure>
  <measure number="2"><attributes><time><beats>2</beats><beat-type>4</beat-type></time></attributes><barline location="left"><ending number="1" type="start"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="stop"/><tie type="start"/></note><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="stop"/></note><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>
  <measure number="3"><barline location="left"><ending number="2" type="start"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><tie type="stop"/></note>  <barline location="right"><ending number="2" type="stop"/></barline></measure>`));
  const ties = [...source.matchAll(/@tie\((mx\d+), (mx\d+)\)/g)].map(match => [match[1], match[2]]);
  assert(ties.length === 3 && ties[0][1] === ties[1][0] && ties[0][0] === ties[2][0], source);
  assert(compilePlayback(lower(source)).diagnostics.length === 0, source);
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
    assert(compileScore(source).diagnostics.length === 0, `带页面谱头的结果应无诊断：${source}`);
  });

  test("score-timewise、metronome、minor key 与绝对/相对音高均受支持", () => {
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
    assert(relative.includes("#2") && compileScore(relative).diagnostics.length === 0,
      `相对音高应输出可编译的前置升号：${relative}`);
    assert(absolute.includes("Eb4"), `绝对模式应保留 Eb 拼写：${absolute}`);
    const notes = playedNotes(compilePlayback(lower(absolute)));
    assert(notes.length === 1 && notes[0].midi === 63 && notes[0].duration.equals(2),
      `timewise 音符应保持 Eb4 两拍：${absolute}`);
  });

  test("measure sound、64th metronome、复合拍号和标准调式均正确换算", () => {
    const source = musicXmlToJpFun(partwise(`<measure number="1">
    <attributes><divisions>2</divisions><key><fifths>0</fifths><mode>dorian</mode></key><time><beats>2</beats><beat-type>4</beat-type><beats>3</beats><beat-type>8</beat-type></time></attributes>
    <sound tempo="90"/><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
    <direction><direction-type><metronome><beat-unit>64th</beat-unit><per-minute>120</per-minute></metronome></direction-type></direction>
    <attributes><key><fifths>0</fifths><mode>lydian</mode></key></attributes>
    <note><pitch><step>F</step><octave>4</octave></pitch><duration>5</duration><voice>1</voice></note>
  </measure>`));
    assert(source.includes("H.signature: 1=D4 7/8") && source.includes("H.tempo: 90")
      && source.includes("^ @tempo(7.5)") && source.includes("^ @1(F4)"),
    `标准 mode、复合拍号与两类 tempo 应输出，中途 tempo/key 用 up 附着到首个生效音符：${source}`);
    const plan = compilePlayback(lower(source));
    const tempos = plan.events.filter(event => event.kind === "tempo");
    assert(plan.diagnostics.length === 0 && tempos.some(event => event.at.equals(0) && event.bpm === 90)
      && tempos.some(event => event.at.equals(1) && event.bpm === 7.5),
    `measure sound 与 64th metronome 应在正确时刻生效：${source}`);
  });

  test("MusicXML repeat times 和未指定 voice 的 dynamics 作用完整", () => {
    const repeated = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="right"><repeat direction="backward" times="3"/></barline></measure>`));
    assert(repeated.includes(":| :|") && playedNotes(compilePlayback(lower(repeated))).map(note => note.midi).join() === "60,60,60",
      `times=3 应生成两条 backward repeat 并播放三遍：${repeated}`);

    const dynamics = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><backup><duration>1</duration></backup><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note></measure>`));
    const velocities = compilePlayback(lower(dynamics)).events
      .filter(event => event.kind === "note-on").map(event => event.velocity);
    assert(velocities.length === 2 && velocities.every(value => value === 49),
      `未指定 voice 的 p 应作用同 staff 全部声部：${dynamics}`);

    const wedge = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><direction><direction-type><wedge type="crescendo"/></direction-type></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><backup><duration>2</duration></backup><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note><note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note><direction><direction-type><wedge type="stop"/></direction-type></direction></measure>`));
    assert((wedge.match(/@dyn\(/g) ?? []).length === 2 && compilePlayback(lower(wedge)).diagnostics.length === 0,
      `未指定 voice 的 wedge 应为两个声部分别生成 dyn：${wedge}`);

    const sustainedWedge = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>2</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note><direction><offset>-1</offset><direction-type><wedge type="crescendo"/></direction-type></direction><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note><direction><direction-type><wedge type="stop"/></direction-type></direction></measure>`));
    assert((sustainedWedge.match(/@dyn\(/g) ?? []).length === 1 && compilePlayback(lower(sustainedWedge)).diagnostics.length === 0,
      `持续音内部开始的 wedge 应从持续音连接到后继音：${sustainedWedge}`);
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
    const source = musicXmlToJpFun(partwise(`<measure number="9"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><direction placement="above" system="only-top"><direction-type><rehearsal font-weight="bold" font-size="14">9</rehearsal><words>Verse</words></direction-type></direction><note><rest measure="yes"/><duration>1</duration><voice>1</voice></note></measure>`));
    assert(source.includes('@box("9")') && source.includes('^ "Verse"') && !source.includes('@box("Verse")')
      && compilePlayback(lower(source)).diagnostics.length === 0,
    `rehearsal 应有 box，普通 words 不应被一并包裹：${source}`);
  });

  test("middle barline 与休止/空 ending 边界处理", () => {
    const middle = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="middle"><repeat direction="forward"/></barline><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="middle"><repeat direction="backward"/></barline><note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>`), { barsPerLine: 1 });
    assert(playedNotes(compilePlayback(lower(middle))).map(note => note.midi).join() === "60,62,64,62,64,65" && !middle.includes("@br()"), middle);

    const emptyEnding = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="middle"><ending number="1" type="start"/></barline><barline location="middle"><ending number="1" type="stop"/><repeat direction="backward"/></barline><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>`));
    assert(!emptyEnding.includes("@volta("), emptyEnding);
  });

  test("短和弦关系端点的标签位于减时线之后", () => {
    const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>2</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><direction><direction-type><wedge type="crescendo"/></direction-type></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><direction><direction-type><wedge type="stop"/></direction-type></direction></measure>`));
    assert(/\{C4\/ \^ E4\}@mx\d+/.test(source) && !/@mx\d+\s+\//.test(source),
      `和弦减时线必须写在宿主音符上且位于关系标签之前：${source}`);
    const plan = compilePlayback(lower(source));
    assert(plan.diagnostics.length === 0 && playedNotes(plan).every(note => note.duration.equals(1, 2)),
      `短和弦与后继音都应保持半拍：${source}`);
  });

  test("附点和弦把点写在宿主音符上，不拆成减时 dash", () => {
    const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>4</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>6</duration><voice>1</voice></note><note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>6</duration><voice>1</voice></note><note><rest/><duration>6</duration><voice>1</voice></note></measure>`));
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
      const source = musicXmlToJpFun(partwise(`<measure number="1">
      <attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      <direction placement="below"><direction-type><dynamics><p/></dynamics><words>pizz.</words></direction-type><voice>2</voice></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><rest/><duration>1</duration><voice>1</voice></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>2</voice></note>
      <note><grace steal-time-previous="20"/><pitch><step>F</step><octave>4</octave></pitch><voice>2</voice></note>
    </measure>`));
      assert(source.includes(" < ") && source.includes("$p") && source.includes('_ "pizz."'),
        `后倚音、voice=2 力度和文字方向应保留：${source}`);
      const notes = playedNotes(compilePlayback(lower(source)));
      const c = notes.find(note => note.midi === 60);
      const e = notes.find(note => note.midi === 64);
      assert(c?.velocity === 80 && e?.velocity === 49 && notes.some(note => note.midi === 65),
          `p 只能作用 voice 2，后倚音 F 必须发声：${source}`);
  });

  test("未声明 steal-time-previous 的倚音跨小节绑定后继主音", () => {
      const source = musicXmlToJpFun(partwise(`
      <measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>
      <measure number="2"><note><grace/><pitch><step>D</step><octave>4</octave></pitch><voice>1</voice></note>      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note></measure>`));
      assert(source.includes("{{D4} > E4}") && !source.includes("< {D4}"),
          `无 steal-time-previous 的倚音必须跨小节绑定后继主音：${source}`);
  });

  test("grace pitch 参与 tie 标签链", () => {
      const source = musicXmlToJpFun(partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><grace/><pitch><step>C</step><octave>4</octave></pitch><voice>1</voice><tie type="start"/></note><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><tie type="stop"/></note></measure>`));
      assert(source.includes("@tie(") && compilePlayback(lower(source)).diagnostics.length === 0, `grace tie 应生成关系：${source}`);
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
    const ending = (number: string) => partwise(`<measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><barline location="left"><ending number="${number}" type="start"/></barline><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><barline location="right"><ending number="${number}" type="stop"/></barline></measure>`);
    for (const value of ["0", "2-1", "x", "257", "9007199254740992"]) {
      throws(() => musicXmlToJpFun(ending(value)), `非法 ending ${value} 必须抛错`);
    }
    const partialPage = SCORE.replace("<score-partwise version=\"4.0\">", "<score-partwise version=\"4.0\"><defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling><page-layout><page-margins><left-margin>40</left-margin><right-margin>40</right-margin><top-margin>40</top-margin><bottom-margin>40</bottom-margin></page-margins></page-layout></defaults>");
    assert(!musicXmlToJpFun(partialPage).includes("@page("), "缺少页面尺寸时应忽略不完整 page-layout");
    const noMargins = SCORE.replace("<score-partwise version=\"4.0\">", "<score-partwise version=\"4.0\"><defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling><page-layout><page-width>800</page-width><page-height>1200</page-height></page-layout></defaults>");
    assert(musicXmlToJpFun(noMargins).includes("top=48px, bottom=48px, left=40px, right=40px"),
      "缺少 page-margins 时应保留尺寸并采用 jpFun 默认边距");
  });

test("MusicXML 导入 D.C. / D.S. / Segno / Fine / To Coda / Coda 并正确展开播放", () => {
  const n = (step: string) => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration></note>`;
  const words = (text: string, sound: string) => `<direction placement="below"><direction-type><words>${text}</words></direction-type><sound ${sound}/></direction>`;
  const score = (...measures: string[]) => partwise(measures.map((body, index) => `<measure number="${index + 1}">${
    index === 0 ? '<attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes>' : ""}${body}</measure>`).join(""), "Lead");

  const dsAlCoda = compileMusicXml(score(
    n("C"),
    `<direction placement="above"><direction-type><segno/></direction-type><sound segno="segno"/></direction>${n("D")}${words("To Coda", 'tocoda="coda"')}`,
    `${n("E")}${words("D.S. al Coda", 'dalsegno="segno"')}`,
    `<direction placement="above"><direction-type><coda/></direction-type><sound coda="coda"/></direction>${n("F")}`,
  ), { barsPerLine: 3 });
  assert(dsAlCoda.script.includes("{D4 ^ $segno}")
    && dsAlCoda.script.includes("{| _ $tocoda}")
    && dsAlCoda.script.includes("{| _ $ds}")
    && dsAlCoda.script.includes("{F4 ^ $coda}"), dsAlCoda.script);
  for (const mark of ["segno", "tocoda", "ds", "coda"]) {
    assert((dsAlCoda.script.match(new RegExp(`\\$${mark}`, "g")) ?? []).length === 1,
      `direction 与 sound 同时声明的相同反复记号应去重：${dsAlCoda.script}`);
  }
  deepStrictEqual(playedNotes(dsAlCoda.playback).map(note => note.midi), [60, 62, 64, 62, 65]);

  const dcAlFine = compileMusicXml(score(`${n("C")}${words("Fine.", 'fine="yes"')}`, `${n("D")}${words("D.C. al Fine", 'dacapo="yes"')}`));
  assert(dcAlFine.script.includes("{| _ $fine}") && dcAlFine.script.includes("{||| _ $dc}"), dcAlFine.script);
  deepStrictEqual(playedNotes(dcAlFine.playback).map(note => note.midi), [60, 62, 60]);

  const barlineAndSoundOnly = compileMusicXml(score(
    `<barline location="left"><segno/></barline>${n("C")}<sound tocoda="coda"/>`,
    `${n("D")}<sound dalsegno="segno"/>`,
    `<barline location="left"><coda/></barline>${n("E")}`,
  ));
  deepStrictEqual(playedNotes(barlineAndSoundOnly.playback).map(note => note.midi), [60, 62, 60, 64]);
});
