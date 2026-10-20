# jpFun

A zero-dependency TypeScript engine that compiles a functional numbered-notation (Jianpu) DSL into SVG, Canvas, and layout-independent playback plans.

[Documentation](https://madderscientist.github.io/jpFun/docs/) · [Playground](https://madderscientist.github.io/jpFun/playground) · [Grammar Reference](grammar.md)

## Installation

```sh
npm install jpfun
```

The npm package is ESM-only and supports Node.js 18+ and modern browsers.

Or load via CDN (`globalThis.jpfun`):

```html
<script src="https://unpkg.com/jpfun"></script>
```

In production, pin all CDN bundles to the same `jpfun@x.y.z` version.

IIFE bundles under `jpfun/dist/` share the `jpfun` global:

| Bundle | Capabilities |
| --- | --- |
| `jpfun.min.js` | Core and both converters |
| `jpfun.core.min.js` | Compilation, rendering, playback, and source editing; no converters |
| `jpfun.from-midi.min.js` | MIDI JSON import; automatic line breaking also requires core |
| `jpfun.from-musicxml.min.js` | Standalone MusicXML import |

For standalone MIDI import, set a positive `barsPerLine`.

## Quick Start

```ts
import {
  compilePlayback,
  compileScore,
  renderLayoutPagesToSvg,
} from "jpfun";

const source = `
  @1(C4) @tempo(96)
  1/ 2/ 3 4 | 5 -
`;

// Compile source, retaining diagnostics and intermediate results
const compiled = compileScore(source);

// Render to SVG strings (one per page)
const svgPages = renderLayoutPagesToSvg(compiled.layout);

// Generate timed events and score mappings; this does not play audio
const playback = compilePlayback(compiled.lowering);
```

Check returned `diagnostics` for recoverable problems and catch compilation errors when processing user input. The host handles audio/MIDI devices, real-time scheduling, and MIDI byte encoding.

For Canvas, create and size one canvas per layout page; see the [rendering example](https://madderscientist.github.io/jpFun/docs/developer/use/#渲染结果). The default text measurer estimates widths; `CanvasTextMeasurer` measures browser font widths for both SVG and Canvas layout.

## Core APIs

### Custom Symbols (`symbols`)

Register or override `@symbol` (`$name`) definitions for instrument-specific symbol packages:

```ts
import { symbols, type SymbolDefinition } from "jpfun";

const dieyin: SymbolDefinition = {
  name: "dizi.dy",
  description: "Dieyin ornament",
  text: { content: "又", fontFamily: "serif" },
  emitPlayback: emitter => emitter.affectFollowing(symbols.ornament({ body: [1, 0] })),
};

symbols.register(dieyin); // Register or override by lowercase name
```

The registry is shared across compilations. Names are case-insensitive, and later registrations override existing definitions, including built-ins. When finished, use `symbols.reset()` to remove extensions and restore `symbols.core`; `symbols.clear()` removes everything, including built-ins.

### Note Transformations & Editor Analysis

- `transformNotes(source, lowering, operation, ranges?)`: Returns `{ span, text }[]` edits for `"to-absolute"`, `"to-relative"`, `"semitone-up"`, or `"semitone-down"`. Use lowering from the exact same source; apply edits in one editor transaction or from right to left.
- `analyzeScoreSyntax(source, functions?)`: Fault-tolerant lexical/call analysis for real-time editor highlighting and completion.
- `Diagnostic.format(code, message, params)`: Override to localize diagnostic messages.

### MIDI & MusicXML Import

Import from dedicated subpaths (or from `"jpfun"`):

```ts
import { midiJsonToJpFun } from "jpfun/converter/midi";
import { musicXmlToJpFun } from "jpfun/converter/musicxml";

const fromMidi = midiJsonToJpFun(parsedMidiJson, { pitchMode: "absolute", alignRate: 4, barsPerLine: 0 });
const { script, diagnostics } = musicXmlToJpFun(xmlDocument.documentElement, { pitchMode: "absolute", barsPerLine: 4 });
```

MIDI import expects [midi.js](https://madderscientist.github.io/noteDigger/lib/midi.js)-compatible JSON, not MIDI bytes. MusicXML import expects a parsed DOM root: provide a DOM implementation in Node.js and decompress `.mxl` first. Conversion can be lossy; inspect MusicXML diagnostics, and do not treat an empty array as a lossless guarantee.

See the [Developer Documentation](https://madderscientist.github.io/jpFun/docs/developer/use/) for full option and diagnostic details.

## License

[Apache-2.0](LICENSE)