import { createRequire } from "node:module";
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/jpfun");
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild");
const banner = "/*! jpfun | Apache-2.0 | github.com/madderscientist/jpFun */";

await copyFile(path.join(root, "Bravura-LICENSE.txt"), path.join(root, "dist", "Bravura-LICENSE.txt"));

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/iife/full.ts"],
  outfile: "dist/jpfun.min.js",
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  legalComments: "inline",
  banner: { js: banner },
  metafile: true,
});

const companionPaths = ["../convert/", "../editor-tools/"];
const unexpected = Object.keys(result.metafile.inputs)
  .map(input => input.replaceAll("\\", "/"))
  .filter(input => companionPaths.some(pattern => input.includes(pattern)));
if (unexpected.length > 0) {
  throw new Error(`Default bundle unexpectedly includes:\n${unexpected.join("\n")}`);
}