import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../packages/convert", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild");

for (const name of ["midi", "musicxml"]) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [`src/iife/from-${name}.ts`],
    outfile: `dist/jpfun.from-${name}.min.js`,
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2022",
    legalComments: "inline",
    metafile: true,
  });
  const included = Object.values(result.metafile.outputs).flatMap(output =>
    Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([file]) => file.replaceAll("\\", "/")));
  const unexpected = included.filter(file => ["/pipeline.", "/layout/", "/render/", "/playback/"].some(part => file.includes(part)));
  if (unexpected.length) throw new Error(`from-${name} unexpectedly includes:\n${unexpected.join("\n")}`);
}