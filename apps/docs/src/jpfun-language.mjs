import { analyzeScoreSyntax } from "jpfun";

export const jpfunLanguage = {
  name: "jpfun",
  scopeName: "source.jpfun",
  patterns: [],
};

function tokenAnnotation(kind, columnStart, columnEnd) {
  return {
    name: `jpFun ${kind}`,
    inlineRange: { columnStart, columnEnd },
    renderPhase: "earliest",
    render({ nodesToTransform }) {
      return [{
        type: "element",
        tagName: "span",
        properties: { className: [`token-${kind}`] },
        children: nodesToTransform,
      }];
    },
  };
}

export function jpfunSyntaxPlugin() {
  return {
    name: "jpFun syntax highlighting",
    hooks: {
      postprocessAnnotations({ codeBlock }) {
        if (codeBlock.language !== "jpfun") return;

        const tokens = analyzeScoreSyntax(codeBlock.code).syntax.tokens;
        const lines = codeBlock.getLines();
        let lineStart = 0;
        let tokenIndex = 0;
        for (const line of lines) {
          for (const annotation of line.getAnnotations()) {
            if (annotation.name === "Inline style") line.deleteAnnotation(annotation);
          }

          const lineEnd = lineStart + line.text.length;
          while (tokens[tokenIndex]?.span.end <= lineStart) tokenIndex++;
          for (let index = tokenIndex; index < tokens.length; index++) {
            const token = tokens[index];
            if (token.span.start >= lineEnd) break;
            const start = Math.max(token.span.start, lineStart);
            const end = Math.min(token.span.end, lineEnd);
            if (start < end) line.addAnnotation(tokenAnnotation(token.kind, start - lineStart, end - lineStart));
          }
          lineStart = lineEnd + 1;
        }
      },
    },
  };
}
