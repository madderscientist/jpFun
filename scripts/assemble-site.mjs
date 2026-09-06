import { cp, rm } from "node:fs/promises";

const playgroundTarget = "apps/docs/dist/playground";

await rm(playgroundTarget, { recursive: true, force: true });
await cp("apps/playground/dist", playgroundTarget, { recursive: true });