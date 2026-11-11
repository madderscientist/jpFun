import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
    base: "./",
    publicDir: "../docs/public",
    resolve: {
        alias: [
            { find: /^jpfun$/, replacement: fileURLToPath(new URL("../../packages/jpfun/src/index.ts", import.meta.url)) },
            { find: /^@jpfun\/convert\/midi$/, replacement: fileURLToPath(new URL("../../packages/convert/src/midi/index.ts", import.meta.url)) },
            { find: /^@jpfun\/convert\/musicxml$/, replacement: fileURLToPath(new URL("../../packages/convert/src/musicxml/index.ts", import.meta.url)) },
            { find: /^@jpfun\/editor-tools\/navigation$/, replacement: fileURLToPath(new URL("../../packages/editor-tools/src/navigation.ts", import.meta.url)) },
            { find: /^@jpfun\/editor-tools\/language$/, replacement: fileURLToPath(new URL("../../packages/editor-tools/src/language.ts", import.meta.url)) },
            { find: /^@jpfun\/editor-tools\/edit$/, replacement: fileURLToPath(new URL("../../packages/editor-tools/src/edit.ts", import.meta.url)) },
        ],
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
});