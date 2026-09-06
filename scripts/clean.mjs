import { rm } from "node:fs/promises";

await Promise.all([
    "dist",
    "packages/jpfun/dist",
    "packages/jpfun/tsconfig.tsbuildinfo",
    "apps/playground/dist",
    "apps/docs/dist",
].map(path => rm(path, { recursive: true, force: true })));