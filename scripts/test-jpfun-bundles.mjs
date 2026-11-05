import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function load(context, name) {
  const source = await readFile(new URL(`../packages/jpfun/dist/${name}`, import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: name });
}

function context() {
  return vm.createContext({ console });
}

test("browser bundle references the separately distributed Bravura glyph license", async () => {
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
    const source = await readFile(new URL("../packages/jpfun/dist/jpfun.min.js", import.meta.url), "utf8");
    assert.ok(source.includes(notice), `browser bundle must preserve the short OFL notice for ${glyph}`);
  }
});

test("default bundle exports core without converters", async () => {
  const target = context();
  await load(target, "jpfun.min.js");
  assert.equal(typeof target.jpfun.compileScore, "function");
  assert.equal(typeof target.jpfun.symbols?.register, "function");
  assert.equal(typeof target.jpfun.symbols?.reset, "function");
  assert.equal(target.jpfun.midiJsonToJpFun, undefined);
  assert.equal(target.jpfun.musicXmlToJpFun, undefined);
});

test("pagebreak and pb preserve options through ESM and IIFE entry points", async () => {
  const target = context();
  await load(target, "jpfun.min.js");
  const entries = [await import(new URL("../packages/jpfun/dist/index.js", import.meta.url)), target.jpfun];
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
