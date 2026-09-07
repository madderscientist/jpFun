import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
    base: "./",
    resolve: {
        alias: [
            { find: /^jpfun$/, replacement: fileURLToPath(new URL("../../packages/jpfun/src/index.ts", import.meta.url)) },
            { find: /^jpfun\/converter\/midi$/, replacement: fileURLToPath(new URL("../../packages/jpfun/src/converter/midi/index.ts", import.meta.url)) },
            { find: /^jpfun\/converter\/musicxml$/, replacement: fileURLToPath(new URL("../../packages/jpfun/src/converter/musicxml/index.ts", import.meta.url)) },
        ],
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
});