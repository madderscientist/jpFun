# jpFun

A functional numbered musical notation typesetting engine for TypeScript.

jpFun compiles a compact numbered-notation DSL into a reusable document layout that can be rendered as SVG or Canvas.

## Features

- Compact DSL with syntax sugar and function-based extensibility
- Exact rational timing and composable score structures
- Automatic spacing, explicit system breaks, and page-aware pagination
- Shared layout model for SVG and Canvas rendering
- Structured diagnostics and source locations
- Zero runtime dependencies
- Works in both Node.js and modern browsers

## Installation

```sh
npm install jpfun
```

jpFun is ESM-only and requires Node.js 18 or later:

```ts
import { compileScore } from "jpfun";
```

CommonJS `require("jpfun")` is not supported.

## Quick Start

```ts
import { compileScore, renderLayoutToSvg } from "jpfun";

const source = `
  @1(C4)
  @tempo(96)

  1/ 2/ 3 4 | 5 -
`;

const result = compileScore(source);
const svg = renderLayoutToSvg(result.layout);
```

`renderLayoutToSvg` returns an SVG string that can be written to a file, sent in an HTTP response, or inserted into a browser page.

## Canvas Rendering

```ts
import { compileScore, renderLayoutToCanvas } from "jpfun";

const result = compileScore("1 2 3 | 4");
const canvas = document.querySelector("canvas");
const context = canvas.getContext("2d");

if (context) {
  renderLayoutToCanvas(result.layout, context);
}
```

## Compilation Pipeline

jpFun exposes the intermediate results of its compilation pipeline:

```text
Source
  -> Parser     -> AST
  -> Lowering   -> timed events and relations
  -> Layout     -> document geometry
  -> Renderer   -> SVG or Canvas
```

```ts
const result = compileScore("1 2 3 | 4");

result.parser;
result.ast;
result.lowering;
result.layout;
```

This makes it possible to build editors, diagnostics, playback tools, and custom renderers on top of the same compilation result.

## Syntax Example

```jpfun
@page(width=860px, left=38px, right=38px)
@1(C4)
@tempo(96)

N(Melody): 1/ 1/ 5/ 5/ 6/ 6/ 5 -
N: @div(C4 C4) G4/G4/ A4/ A/ G
L(Lyrics): do do so so la la so
```

See the [language reference](grammar.md) for the complete syntax.

## Runtime Support

- ESM only
- Node.js 18 or later
- Modern browsers and bundlers
- No DOM dependency in the compiler
- No runtime dependencies

## Development

jpFun is maintained in a pnpm workspace. From the repository root:

```sh
pnpm install
pnpm run build:core
pnpm test
```

The repository also includes a browser-based Playground with diagnostics and SVG/Canvas previews:

```sh
pnpm run dev
```

Then open <http://127.0.0.1:4173>.

## Documentation

- [Language reference](grammar.md)
- [Repository](https://github.com/madderscientist/jpFun)
- [Issue tracker](https://github.com/madderscientist/jpFun/issues)

## License

[Apache License 2.0](LICENSE)