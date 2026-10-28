import { extname } from 'node:path';

/**
 * A conservative lexical filter, not a function/AST discovery engine. It only
 * allows whole comment lines outside literals. Complex ambiguous literals stay
 * visible; the standalone language-aware source adapter can handle those.
 */
export function sourceMarkerOffsets(text: string, path: string): ReadonlySet<number> | undefined {
  // @context-fold begin sourceMarkerOffsets-0f40430b3b
  const extension = extname(path).toLowerCase();
  const python = ['.py', '.pyi'].includes(extension);
  const javascript = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'].includes(extension);
  if (!python && !javascript) return undefined; // Explicit text syntax for other languages.
  if (['.jsx', '.tsx'].includes(extension) && /<[A-Za-z/>]/.test(text)) return new Set();
  const offsets = new Set<number>();
  const comment = (at: number) => {
    const start = Math.max(text.lastIndexOf('\n', at - 1), text.lastIndexOf('\r', at - 1)) + 1;
    if (!text.slice(start, at).trim()) offsets.add(start);
  };
  const endOfLine = (at: number) => {
    const end = /[\r\n]/.exec(text.slice(at));
    return end ? at + end.index : text.length;
  };

  function quoted(at: number): number | undefined {
    const quote = text[at]!;
    if (javascript && quote === '`') return template(at + 1);
    // Correctly parsing f-string expressions requires the Python grammar. Keep
    // this request's source literal instead of guessing where its comments are.
    if (python && /[fF][rR]?$/.test(text.slice(Math.max(0, at - 2), at))) return;
    const delimiter = python && text.slice(at, at + 3) === quote.repeat(3) ? quote.repeat(3) : quote;
    for (let i = at + delimiter.length; i < text.length; i++) {
      if (text[i] === '\\') { i++; if (text[i] === '\r' && text[i + 1] === '\n') i++; continue; }
      if (text.startsWith(delimiter, i)) return i + delimiter.length;
      if (delimiter.length === 1 && /[\r\n]/.test(text[i]!)) return;
    }
    return;
  }

  function template(at: number): number | undefined {
    for (let i = at; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (text[i] === '`') return i + 1;
      if (text[i] === '$' && text[i + 1] === '{') {
        const end = expression(i + 2);
        if (end === undefined) return;
        i = end - 1;
      }
    }
    return;
  }

  function expression(at: number): number | undefined {
    let depth = 1;
    for (let i = at; i < text.length; i++) {
      const char = text[i]!;
      if (char === '"' || char === "'" || char === '`') {
        const end = quoted(i);
        if (end === undefined) return;
        i = end - 1;
      } else if (text.startsWith('//', i)) i = endOfLine(i) - 1;
      else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) return;
        i = end + 1;
      } else if (char === '/') return; // Regex/division inside interpolation is ambiguous here.
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) return i + 1;
    }
    return;
  }

  for (let i = 0; i < text.length;) {
    const char = text[i]!;
    if (python && char === '#' || javascript && text.startsWith('//', i)) {
      comment(i); i = endOfLine(i); continue;
    }
    if (javascript && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return new Set();
      comment(i); i = end + 2; continue;
    }
    if (char === '"' || char === "'" || javascript && char === '`') {
      const end = quoted(i);
      if (end === undefined) return new Set();
      i = end; continue;
    }
    if (javascript && char === '/') {
      // A regular expression is one physical line; skip its quotes/brackets so
      // they cannot manufacture a multiline string or a false comment boundary.
      const regex = /^\/(?:\\.|\[(?:\\.|[^\]\\\r\n])*\]|[^/\\\r\n])+\/[a-z]*/.exec(text.slice(i));
      if (regex) { i += regex[0].length; continue; }
    }
    i++;
  }
  return offsets;
  // @context-fold end sourceMarkerOffsets-0f40430b3b
}
