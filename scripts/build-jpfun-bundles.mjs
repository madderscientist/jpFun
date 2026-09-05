import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/jpfun");
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild");
const banner = "/*! jpfun | Apache-2.0 | github.com/madderscientist/jpFun */";

async function bundle(entry, outfile) {
  return build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2022",
    legalComments: "none",
    banner: { js: banner },
    metafile: true,
  });
}

const full = await bundle("dist/iife/full.js", "dist/jpfun.min.js");
const core = await bundle("dist/iife/core.js", "dist/jpfun.core.min.js");
const fromMidi = await bundle("dist/iife/from-midi.js", "dist/jpfun.from-midi.min.js");
const fromMusicXml = await bundle("dist/iife/from-musicxml.js", "dist/jpfun.from-musicxml.min.js");

function assertExcludes(result, name, patterns) {
  const inputs = Object.keys(result.metafile.inputs).map(input => input.replaceAll("\\", "/"));
  const unexpected = inputs.filter(input => patterns.some(pattern => input.includes(pattern)));
  if (unexpected.length > 0) {
    throw new Error(`${name} unexpectedly includes:\n${unexpected.join("\n")}`);
  }
}

assertExcludes(core, "core bundle", ["/converter/"]);
assertExcludes(fromMidi, "from-midi bundle", ["/pipeline.js", "/layout/", "/render/", "/playback/"]);
assertExcludes(fromMusicXml, "from-musicxml bundle", ["/pipeline.js", "/layout/", "/render/", "/playback/"]);

void full;