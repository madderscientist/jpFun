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

## Browser via CDN

A bundled, minified build ships with the package, so no build step is needed for a plain web page. Load it with a `<script>` tag and use the `jpfun` global:

```html
<script src="https://unpkg.com/jpfun"></script>
<script>
  const { compileScore, renderLayoutPagesToSvg } = jpfun;
  document.body.innerHTML = renderLayoutPagesToSvg(compileScore("1 2 3 | 4 -").layout)[0];
</script>
```

For ES modules, jsDelivr bundles the package on the fly:

```html
<script type="module">
  import { compileScore } from "https://cdn.jsdelivr.net/npm/jpfun/+esm";
</script>
```

Both URLs resolve to the latest published version. In production, append an exact version (`jpfun@x.y.z`) so that publishing a new release cannot change an existing page.

## Quick Start

```ts
import { compileScore, renderLayoutPagesToSvg } from "jpfun";

const source = `
  @1(C4)
  @tempo(96)

  1/ 2/ 3 4 | 5 -
`;

const result = compileScore(source);
const pages = renderLayoutPagesToSvg(result.layout);
```

`renderLayoutPagesToSvg` returns one SVG string per page. Even an infinite-height document produces one natural-height page. Each SVG can be written to a file, sent in an HTTP response, or inserted into a browser page.

## Canvas Rendering

```ts
import { compileScore, renderLayoutPagesToCanvas } from "jpfun";

const result = compileScore("1 2 3 | 4");
const canvas = document.querySelector("canvas");
const context = canvas.getContext("2d");

if (context) {
  renderLayoutPagesToCanvas(result.layout, [context]);
}
```

## Text Measurement

Layout depends on text widths, so `compileScore` needs a `TextMeasurer`. The default one estimates every character at a fixed fraction of the font size. That keeps results platform-independent, which is what tests and server-side rendering want, but it does not match the real glyph widths of a browser font — narrow letters are overestimated, so right-aligned text and `@box` bounds drift visibly.

In a browser, pass `CanvasTextMeasurer` so that measurement agrees with what the renderer draws:

```ts
import { compileScore, CanvasTextMeasurer } from "jpfun";

const context = document.createElement("canvas").getContext("2d")!;
const result = compileScore(source, { textMeasurer: new CanvasTextMeasurer(context) });
```

This applies to SVG output too, since measurement happens during layout rather than during painting. The context is only used for measuring and need not be the canvas you render into.

## Compilation Pipeline

jpFun exposes the intermediate results of its compilation pipeline:

```text
Source
  -> Parser     -> AST
  -> Lowering   -> timed events and relations
      |-> Playback -> NoteOn / NoteOff / Tempo events
       `-> Layout   -> document geometry
            -> Renderer -> SVG or Canvas
```

```ts
const result = compileScore("1 2 3 | 4");

result.parser;
result.ast;
result.lowering;
result.layout;
```

Playback is compiled independently from layout:

```ts
import { compilePlayback } from "jpfun";

const playback = compilePlayback(result.lowering);
playback.events;
playback.scoreMap;
playback.tracks;
playback.durationSeconds;
```

For scores with unusually large repeat expansion, raise the control-flow budget explicitly:

```ts
const playback = compilePlayback(result.lowering, { maxFlowSteps: 200_000 });
```

The default is 65,536 visited columns. Exceeding it throws instead of returning a partial playback plan.

The plan stores device-independent `note-on`, `note-off`, and `tempo` events. Its track number is the same channel identity used by the visual Track; Web Audio, Web MIDI, and Standard MIDI File adapters consume that identity and the exact `Fraction` timestamps at their boundary.

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