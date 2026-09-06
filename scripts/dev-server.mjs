import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const playgroundRoot = resolve(root, "apps/playground");
const docsRoot = resolve(root, "apps/docs");
const playgroundRequire = createRequire(resolve(playgroundRoot, "package.json"));
const docsRequire = createRequire(resolve(docsRoot, "package.json"));
const { createServer } = await import(pathToFileURL(playgroundRequire.resolve("vite")).href);
const { dev } = await import(pathToFileURL(docsRequire.resolve("astro")).href);
const base = `${(process.env.BASE_PATH || "/").replace(/\/$/, "")}/`;
const playgroundBase = `${base}playground/`;
let playground;
let docs;
let watcher;
let stopping = false;

async function shutdown() {
    if (stopping) return;
    stopping = true;
    watcher?.kill();
    await Promise.all([docs?.stop(), playground?.close()]);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
    playground = await createServer({
        root: playgroundRoot,
        base: playgroundBase,
        server: { host: "127.0.0.1", port: 0 },
    });
    await playground.listen();
    const playgroundPort = playground.httpServer.address().port;

    docs = await dev({
        root: docsRoot,
        server: {
            host: process.env.HOST || "127.0.0.1",
            port: Number(process.env.PORT || 4321),
        },
        vite: {
            server: {
                proxy: {
                    [playgroundBase.replace(/\/$/, "")]: {
                        target: `http://127.0.0.1:${playgroundPort}`,
                        ws: true,
                    },
                },
            },
        },
    });

    watcher = spawn(process.execPath, [
        resolve(root, "packages/jpfun/node_modules/typescript/bin/tsc"),
        "-p", "tsconfig.json", "--watch", "--preserveWatchOutput",
    ], { cwd: resolve(root, "packages/jpfun"), stdio: "inherit" });
    watcher.once("error", error => {
        console.error("Unable to start jpFun dev server:", error.message);
        process.exitCode = 1;
        void shutdown();
    });
    watcher.once("exit", code => {
        if (code) process.exitCode = code;
        void shutdown();
    });

    const origin = `http://${process.env.HOST || "127.0.0.1"}:${docs.address.port}`;
    console.log(`\njpFun: ${origin}${base}`);
    console.log(`Docs: ${origin}${base}docs/`);
    console.log(`Playground: ${origin}${playgroundBase}\n`);
} catch (error) {
    console.error("Unable to start jpFun dev server:", error);
    process.exitCode = 1;
    await shutdown();
}