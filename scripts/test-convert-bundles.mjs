import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../packages/convert/package.json", import.meta.url));
const { DOMParser } = require("@xmldom/xmldom");

async function load(context, name, packageName = "convert") {
  const source = await readFile(new URL(`../packages/${packageName}/dist/${name}`, import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: name });
}

test("from-midi works alone for fixed and with core for automatic line breaks", async () => {
  const target = vm.createContext({ console });
  const midi = {
    header: { name: "Smoke", tick: 480, tempos: [], timeSignatures: [] },
    tracks: [{ channel: 0, name: "Piano", controlChanges: [], instruments: [],
      notes: [{ ticks: 0, durationTicks: 1920, midi: 60, intensity: 1 }] }],
  };
  await load(target, "jpfun.from-midi.min.js");
  assert.equal(target.jpfun.compileScore, undefined);
  assert.match(target.jpfun.midiJsonToJpFun(midi, { barsPerLine: 1 }), /C4/);
  await load(target, "jpfun.min.js", "jpfun");
  assert.match(target.jpfun.midiJsonToJpFun(midi), /C4/);
  const entry = await import(new URL("../packages/convert/dist/midi/index.js", import.meta.url));
  assert.equal(entry.midiJsonToJpFun(midi), target.jpfun.midiJsonToJpFun(midi));
});

test("from-musicxml registers independently and survives later core load", async () => {
  const target = vm.createContext({ console });
  await load(target, "jpfun.from-musicxml.min.js");
  assert.equal(target.jpfun.compileScore, undefined);
  const document = new DOMParser().parseFromString(`
    <score-partwise version="4.0">
      <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
      <part id="P1"><measure number="1">
        <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
        <direction placement="below"><direction-type><dynamics><pppp/></dynamics></direction-type></direction>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><notations><articulations><staccato/><caesura/></articulations></notations></note>
      </measure></part>
    </score-partwise>
  `, "application/xml");
  const result = target.jpfun.musicXmlToJpFun(document.documentElement);
  assert.match(result.script, /C4/);
  assert.match(result.script, /\$staccato/);
  assert.match(result.script, /_ \$pppp/);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "W_MUSICXML_UNSUPPORTED_ELEMENT");
  assert.equal(result.diagnostics[0].severity, "warning");
  assert.equal(result.diagnostics[0].location.element, "caesura");
  await load(target, "jpfun.min.js", "jpfun");
  assert.equal(JSON.stringify(target.jpfun.musicXmlToJpFun(document.documentElement)), JSON.stringify(result));
  const notes = target.jpfun.compilePlayback(target.jpfun.compileScore(result.script).lowering).events
    .filter(event => event.kind === "note-on");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].velocity, 10);
  const entry = await import(new URL("../packages/convert/dist/musicxml/index.js", import.meta.url));
  assert.equal(JSON.stringify(entry.musicXmlToJpFun(document.documentElement)), JSON.stringify(result));
});