import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../packages/jpfun/package.json", import.meta.url));
const { DOMParser } = require("@xmldom/xmldom");

const midi = {
  header: {
    name: "Smoke",
    tick: 480,
    tempos: [],
    timeSignatures: [],
  },
  tracks: [{
    channel: 0,
    name: "Piano",
    controlChanges: [],
    instruments: [],
    notes: [{ ticks: 0, durationTicks: 1920, midi: 60, intensity: 1 }],
  }],
};

async function load(context, name) {
  const source = await readFile(new URL(`../packages/jpfun/dist/${name}`, import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: name });
}

function context() {
  return vm.createContext({ console });
}

test("full bundle exports core and converters", async () => {
  const target = context();
  await load(target, "jpfun.min.js");
  assert.equal(typeof target.jpfun.compileScore, "function");
  assert.equal(typeof target.jpfun.midiJsonToJpFun, "function");
  assert.equal(typeof target.jpfun.musicXmlToJpFun, "function");
});

test("core bundle excludes converters", async () => {
  const target = context();
  await load(target, "jpfun.core.min.js");
  assert.equal(typeof target.jpfun.compileScore, "function");
  assert.equal(target.jpfun.midiJsonToJpFun, undefined);
  assert.equal(target.jpfun.musicXmlToJpFun, undefined);
});

test("from-midi works alone for fixed and with core for automatic line breaks", async () => {
  const target = context();
  await load(target, "jpfun.from-midi.min.js");
  assert.match(target.jpfun.midiJsonToJpFun(midi, { barsPerLine: 1 }), /C4/);
  await load(target, "jpfun.core.min.js");
  assert.match(target.jpfun.midiJsonToJpFun(midi), /C4/);
});

test("from-musicxml registers independently and survives later full load", async () => {
  const target = context();
  await load(target, "jpfun.from-musicxml.min.js");
  assert.equal(typeof target.jpfun.musicXmlToJpFun, "function");
  const document = new DOMParser().parseFromString(`
    <score-partwise version="4.0">
      <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
      <part id="P1"><measure number="1">
        <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>
      </measure></part>
    </score-partwise>
  `, "application/xml");
  assert.match(target.jpfun.musicXmlToJpFun(document.documentElement), /C4/);
  await load(target, "jpfun.min.js");
  assert.equal(typeof target.jpfun.compileScore, "function");
  assert.equal(typeof target.jpfun.musicXmlToJpFun, "function");
});