import * as core from "../core.js";

const target = globalThis as typeof globalThis & { jpfun?: Record<string, unknown> };
Object.assign(target.jpfun ??= {}, core);