import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const commands = [
    ["packages/jpfun", "typescript/bin/tsc", ["-p", "tsconfig.json", "--watch", "--preserveWatchOutput"]],
    ["apps/playground", "vite/bin/vite.js", ["--host", process.env.HOST || "127.0.0.1", "--port", process.env.PORT || "4173"]],
];

const children = commands.map(([cwd, bin, args]) => spawn(
    process.execPath,
    [resolve(root, cwd, "node_modules", bin), ...args],
    { cwd: resolve(root, cwd), stdio: "inherit" },
));

function shutdown() {
    for (const child of children) child.kill();
}

for (const child of children) {
    child.once("error", error => {
        console.error("Unable to start jpFun dev server:", error.message);
        process.exitCode = 1;
        shutdown();
    });
    child.once("exit", code => {
        if (code) process.exitCode = code;
        shutdown();
    });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);