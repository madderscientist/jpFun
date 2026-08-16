# jpFun

A functional numbered musical notation typesetting engine for TypeScript and modern ESM runtimes.

```ts
import { compileScore, renderLayoutToSvg } from "jpfun";

const compiled = compileScore("1 2 3 | 4");
const svg = renderLayoutToSvg(compiled.layout);
```

The public pipeline preserves its parser, AST, lowering result, and final document layout. SVG and Canvas renderers consume the same layout result.

## Development

This package is maintained in the jpFun pnpm workspace. From the repository root:

```sh
pnpm run build:core
pnpm test
```
