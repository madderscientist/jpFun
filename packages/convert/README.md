# @jpfun/convert

MIDI JSON and MusicXML conversion to editable jpFun source. ESM-only, for Node.js 18+ and modern browsers.

```sh
npm install jpfun @jpfun/convert
```

```ts
import { midiJsonToJpFun, type MidiJson } from "@jpfun/convert/midi";
import { musicXmlToJpFun } from "@jpfun/convert/musicxml";

const source = midiJsonToJpFun(parsedMidiJson, { barsPerLine: 0 });
const { script, diagnostics } = musicXmlToJpFun(xmlDocument.documentElement);
```

Both functions and their types are also exported by `@jpfun/convert`.

## Input Boundary

- MIDI input must match `MidiJson`, the structure produced by midi.js `JSON()`. Any parser or adapter producing that structure can be used. This package does not depend on midi.js, parse MIDI bytes, fetch remote scripts, or read files.
- MusicXML input is an already parsed root implementing `MusicXmlElement`. The host chooses its XML parser and handles malformed XML and `.mxl` decompression.
- MIDI defaults to width-based line breaking (`barsPerLine: 0`); a positive value fixes the number of bars per line.
- MusicXML returns `{ script, diagnostics }`. Inspect the diagnostics for omissions and approximations; an empty array is not a lossless guarantee.
- `jpfun` is a peer dependency. Conversion never imports another package's private source files.

## Browser Scripts

`dist/jpfun.from-midi.min.js` and `dist/jpfun.from-musicxml.min.js` register conversion functions on `globalThis.jpfun`.

```html
<script src="https://unpkg.com/jpfun/dist/jpfun.min.js"></script>
<script src="https://unpkg.com/@jpfun/convert/dist/jpfun.from-midi.min.js"></script>
<script src="https://unpkg.com/@jpfun/convert/dist/jpfun.from-musicxml.min.js"></script>
```

Pin compatible package versions in production. MusicXML conversion can run without the core script; MIDI can also run independently when `barsPerLine` is positive. Automatic MIDI line breaking requires the core script's layout API.

## License

[Apache-2.0](https://github.com/madderscientist/jpFun/blob/main/LICENSE).