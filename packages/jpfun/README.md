# jpFun

A TypeScript engine that compiles a compact numbered-notation DSL into SVG or Canvas, with layout-independent playback.

[Documentation](https://madderscientist.github.io/jpFun/)

## Features

- Extensible music DSL with exact rational timing
- Automatic spacing and pagination, shared by SVG and Canvas
- Structured diagnostics and source-aware editing
- Zero runtime dependencies; works in Node.js and modern browsers

## Installation

```sh
npm install jpfun
```

jpFun is ESM-only, supports Node.js 18+ and modern browsers, and has no compiler DOM dependency.

## Browser via CDN

Use the bundled `jpfun` global without a build step:

```html
<script src="https://unpkg.com/jpfun"></script>
<script>
  const { compileScore, renderLayoutPagesToSvg } = jpfun;
  document.body.innerHTML = renderLayoutPagesToSvg(compileScore("1 2 3 | 4 -").layout)[0];
</script>
```

Or import an ES module:

```html
<script type="module">
  import { compileScore } from "https://cdn.jsdelivr.net/npm/jpfun/+esm";
</script>
```

Pin `jpfun@x.y.z` in production; these URLs otherwise use the latest release.

Optional bundles under `https://unpkg.com/jpfun/dist/` share the same global:

| Bundle | Capabilities |
| --- | --- |
| `jpfun.core.min.js` | Compilation, rendering, playback, and source editing |
| `jpfun.from-musicxml.min.js` | Standalone MusicXML import |
| `jpfun.from-midi.min.js` | MIDI JSON import; automatic line breaking also requires the core bundle |

For standalone MIDI import, set a positive `barsPerLine`.

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

`renderLayoutPagesToSvg` returns one SVG string per page, ready to save or insert into a web page.

## Note Source Transformations

`transformNotes(source, lowering, operation, ranges?)` returns sorted `{ span, text }` edits for `to-absolute`, `to-relative`, `semitone-up`, or `semitone-down`. Use lowering from the same source and apply edits in one editor transaction or right to left.

Only notes fully covered by `ranges` are changed; omit it for the whole source, or pass `[]` for no changes. Conversion preserves pitch; semitone shifts preserve each note's representation. Key declarations, rests, spacers, percussion, and surrounding source are retained. Invalid note input throws a diagnostic.

## Browser Rendering

The default text measurer estimates glyph widths. For accurate browser layout, pass `CanvasTextMeasurer`, including when rendering SVG:

```ts
import { compileScore, CanvasTextMeasurer, renderLayoutPagesToCanvas } from "jpfun";

const context = document.createElement("canvas").getContext("2d")!;
const result = compileScore(source, { textMeasurer: new CanvasTextMeasurer(context) });
renderLayoutPagesToCanvas(result.layout, [context]);
```

Canvas rendering takes one context per page. Measurement can use a separate canvas.

## Compilation Pipeline

```text
Source
  -> Parser     -> AST
  -> Lowering   -> timed events and relations
      |-> Playback -> NoteOn / NoteOff / Tempo events
       `-> Layout   -> document geometry
            -> Renderer -> SVG or Canvas
```

`compileScore` exposes `parser`, `ast`, `lowering`, and `layout`. Compile playback separately:

```ts
import { compilePlayback } from "jpfun";

const playback = compilePlayback(result.lowering);
```

The plan contains device-independent `events`, `scoreMap`, `tracks`, and `durationSeconds`, with exact `Fraction` timestamps. Repeat expansion exceeding 65,536 visited columns throws; raise the limit with `{ maxFlowSteps: 200_000 }` when needed.

## MIDI JSON Conversion

`midiJsonToJpFun` accepts the JSON returned by [`midi.js`](https://madderscientist.github.io/noteDigger/lib/midi.js)'s `JSON()` method. Parse MIDI bytes in your application.

```ts
import { midiJsonToJpFun } from "jpfun";

const source = midiJsonToJpFun(parsedMidiJson, {
  title: "My Score",
  alignRate: 4,
  barsPerLine: 0,
});
```

`pitchMode` defaults to `"absolute"`; `"relative"` uses C-based numbered notation. `alignRate` controls quantization. `barsPerLine` defaults to `0` for automatic breaks; positive values fix the measures per system.

Preserves notes, tracks, tempo, time signatures, programs, and standard 3:2 quarter-, eighth-, and sixteenth-note triplets. Other tuplets are unsupported. Percussion channel 10, velocity, controllers, pitch bends, and lyrics are omitted; time-signature changes snap to measure boundaries.

## MusicXML Conversion

`musicXmlToJpFun` accepts a parsed MusicXML root element. Use `DOMParser` in browsers or a compatible DOM implementation in Node.js:

```ts
import { musicXmlToJpFun } from "jpfun";

const xml = await file.text();
const document = new DOMParser().parseFromString(xml, "application/xml");
if (document.querySelector("parsererror")) throw new SyntaxError("Invalid MusicXML");

const source = musicXmlToJpFun(document.documentElement, {
  barsPerLine: 4,
});
```

Supports partwise/timewise scores, multiple voices, rhythm, lyrics, dynamics, repeats, and basic layout metadata. `pitchMode` defaults to `"absolute"`; `"relative"` uses the active MusicXML key.

Decompress `.mxl` archives before parsing. Percussion channel 10, pedal, cross-staff arpeggio grouping, and detailed engraving coordinates are omitted.

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

## Development

jpFun is maintained in a pnpm workspace. From the repository root:

```sh
pnpm install
pnpm run build:core
pnpm test
pnpm run dev
```

The development server opens the Playground at <http://127.0.0.1:4173>.

## Documentation

- [Language reference](grammar.md)
- [Repository](https://github.com/madderscientist/jpFun)
- [Issue tracker](https://github.com/madderscientist/jpFun/issues)

## License

[Apache License 2.0](LICENSE)