# @jpfun/editor-tools

Host-independent editor utilities for jpFun. ESM-only, for Node.js 18+ and modern browsers. There is no runtime dependency on DOM globals, CodeMirror, VS Code, storage, or a MIDI library.

```sh
npm install jpfun @jpfun/editor-tools
```

For Node.js or VS Code extension projects, include DOM types in your TypeScript configuration because the core declarations reference `CanvasRenderingContext2D`:

```json
{
	"compilerOptions": {
		"lib": ["ES2022", "DOM"]
	}
}
```

Keep your existing ECMAScript library target if different. This only supplies type declarations; it does not add browser APIs at runtime or require `skipLibCheck`.

## Language Utilities

```ts
import { analyzeScoreSyntax, compileScore } from "jpfun";
import { functionDoc, functionNodeAt, parameterDocAt } from "@jpfun/editor-tools/language";

const source = "@br(2)";
const { syntax } = analyzeScoreSyntax(source);
const parameter = parameterDocAt(source, syntax, 4);
const compiled = compileScore(source);
const node = functionNodeAt(compiled.ast, 1);
const markdown = node?.def ? functionDoc(node.def) : undefined;
```

- `functionDefinitions`: built-in function definitions indexed by lowercase name, including aliases.
- `functionDoc` / `argumentDoc`: Markdown documentation without HTML or editor objects.
- `callAt` / `argumentIndexAt`: query the active call and argument from syntax analysis.
- `parameterDocAt`: returns `{ pos, doc }` or `null`; optionally accepts a custom function-definition map.
- `functionNodeAt`: finds the innermost documented function in a compiled AST.
- `completionsAt`: returns a UTF-16 replacement range, function/symbol/parameter/label candidates, and an optional prefix validation regex. Candidates include core metadata for lazy documentation rendering; the host handles filtering, snippets, and acceptance.
- `parameterCompletionEdit`: returns a core `SourceEdit` for accepting a parameter name, preserving an existing `=` and value. Recompute it against the current document when accepting cached suggestions.
- `labelJumpAt`: resolves a reference to its target's source span, falling back to the declaration when no current AST is available.
- `labelSymbolAt`: returns the label name, declaration name span, and reference name spans for definition/reference providers and renaming. Repeated declarations with the same name remain separate groups; returned name spans exclude `@`.

## Source And Score Navigation

```ts
import { createPreviewNavigationMap, sourceTargetAt, previewHitAt } from "@jpfun/editor-tools/navigation";

const navigation = createPreviewNavigationMap(compiled);
const target = sourceTargetAt(navigation, offset);
const hit = previewHitAt(navigation, scoreX, scoreY, tolerance);
```

`playbackTimeAt` maps score coordinates to a score-time onset; `playbackRegionAt` maps score time to a cursor rectangle. Coordinates are layout coordinates, not browser client coordinates. The host handles zoom, scrolling, selections, and drawing.

All utilities are also exported from the package root.

## License

[Apache-2.0](https://github.com/madderscientist/jpFun/blob/main/LICENSE).