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

test("full and core bundles reference the separately distributed Bravura glyph license", async () => {
  const license = await readFile(new URL("../packages/jpfun/Bravura-LICENSE.txt", import.meta.url), "utf8");
  assert.match(license, /Copyright \(c\) 2026, Steinberg Media Technologies GmbH/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(license, /OTHER DEALINGS IN THE FONT SOFTWARE\./);
  assert.equal(await readFile(new URL("../packages/jpfun/dist/Bravura-LICENSE.txt", import.meta.url), "utf8"),
    license, "browser distributions must include the complete license beside the bundles");
  const manifest = JSON.parse(await readFile(new URL("../packages/jpfun/package.json", import.meta.url), "utf8"));
  assert.ok(manifest.files.includes("Bravura-LICENSE.txt") && manifest.files.includes("dist"));
  for (const glyph of ["turn.js", "coda.js"]) {
    const glyphModule = await readFile(new URL(
      `../packages/jpfun/dist/functions/symbol/symbols/${glyph}`, import.meta.url), "utf8");
    const notice = glyphModule.match(/\/\*![\s\S]*?\*\//)?.[0];
    assert.ok(notice?.includes("OFL-1.1") && notice.includes("Bravura-LICENSE.txt"));
    for (const bundle of ["jpfun.min.js", "jpfun.core.min.js"]) {
      const source = await readFile(new URL(`../packages/jpfun/dist/${bundle}`, import.meta.url), "utf8");
      assert.ok(source.includes(notice), `${bundle} must preserve the short OFL notice for ${glyph}`);
    }
  }
});

test("full bundle exports core and converters", async () => {
  const target = context();
  await load(target, "jpfun.min.js");
  assert.equal(typeof target.jpfun.compileScore, "function");
  assert.equal(typeof target.jpfun.symbols?.register, "function");
  assert.equal(typeof target.jpfun.symbols?.reset, "function");
  assert.equal(typeof target.jpfun.midiJsonToJpFun, "function");
  assert.equal(typeof target.jpfun.musicXmlToJpFun, "function");
});

test("core bundle excludes converters", async () => {
  const target = context();
  await load(target, "jpfun.core.min.js");
  assert.equal(typeof target.jpfun.compileScore, "function");
  assert.equal(typeof target.jpfun.symbols?.register, "function");
  assert.equal(typeof target.jpfun.symbols?.reset, "function");
  assert.equal(target.jpfun.midiJsonToJpFun, undefined);
  assert.equal(target.jpfun.musicXmlToJpFun, undefined);
});

test("pagebreak and pb preserve options through ESM and IIFE entry points", async () => {
  const entries = [await import(new URL("../packages/jpfun/dist/index.js", import.meta.url))];
  for (const name of ["jpfun.min.js", "jpfun.core.min.js"]) {
    const target = context();
    await load(target, name);
    entries.push(target.jpfun);
  }
  for (const entry of entries) {
    for (const name of ["pagebreak", "pb"]) {
      const result = entry.compileScore(`1 @${name}(justify=false)`);
      assert.equal(result.diagnostics.length, 0);
      assert.equal(result.layout.pages.length, 2);
      const control = result.lowering.columns.flat().find(node => node.addon?.pageBreakBefore !== undefined);
      assert.equal(control?.addon?.pageBreakBefore, false);
      assert.equal(control?.addon?.breakBefore, 1);
    }
  }
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
  await load(target, "jpfun.min.js");
  assert.equal(typeof target.jpfun.compileScore, "function");
  assert.equal(typeof target.jpfun.musicXmlToJpFun, "function");
  assert.equal(JSON.stringify(target.jpfun.musicXmlToJpFun(document.documentElement)), JSON.stringify(result));
  const notes = target.jpfun.compilePlayback(target.jpfun.compileScore(result.script).lowering).events
    .filter(event => event.kind === "note-on");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].velocity, 10);
});