import * as full from "../index.js";

const target = globalThis as typeof globalThis & { jpfun?: Record<string, unknown> };
Object.assign(target.jpfun ??= {}, full);