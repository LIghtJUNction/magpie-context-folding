export interface FocusedSourceExcerpt {
  text: string;
  startLine: number;
  endLine: number;
  dependencies?: FocusedSourceDependency[];
}

export interface FocusedSourceDependency {
  name: string;
  text: string;
  startLine: number;
  endLine: number;
}

interface Token { value: string; start: number; end: number }
interface Candidate { name: number; start: number; arrow?: number }

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const controlParenKeywords = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
const regexStartPrevious = /^(?:|[([{=,:;!?&|+*%~^-]|=>|return|throw|case|delete|void|typeof|yield|await|in|of|else|do|try|finally|control-close)$/;

function skipQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue; }
    if (source[index] === quote) return index + 1;
    index++;
  }
  return source.length;
}

function skipTemplateExpression(source: string, start: number): number {
  let depth = 1;
  let index = start;
  let previous = '';
  const controlParens: boolean[] = [];
  let controlParenPending = false;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (char === '"' || char === "'") { index = skipQuoted(source, index, char); previous = 'literal'; controlParenPending = false; continue; }
    if (char === '`') { index = skipTemplate(source, index); previous = 'literal'; controlParenPending = false; continue; }
    if (char === '/' && regexStartPrevious.test(previous)) {
      const end = skipRegex(source, index);
      if (end !== index + 1) { index = end; previous = 'literal'; controlParenPending = false; continue; }
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/.test(source[end] ?? '')) end++;
      const value = source.slice(index, end);
      controlParenPending = controlParenKeywords.has(value) && previous !== '.' && previous !== '?.'
        || controlParenPending && value === 'await';
      previous = value;
      index = end;
      continue;
    }
    if (char === '(') { controlParens.push(controlParenPending); controlParenPending = false; }
    else if (char === ')') {
      previous = controlParens.pop() ? 'control-close' : ')';
      controlParenPending = false;
      index++;
      continue;
    } else controlParenPending = false;
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return index + 1;
    const pair = source.slice(index, index + 3) === '...' ? '...'
      : ['=>', '->', '::', '?.', '&&', '||', '??', '==', '!=', '<=', '>=', '++', '--']
        .find(value => source.slice(index, index + value.length) === value);
    previous = pair ?? char;
    index += (pair ?? char).length;
  }
  return source.length;
}

function skipTemplate(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue; }
    if (source[index] === '`') return index + 1;
    if (source[index] === '$' && source[index + 1] === '{') {
      index = skipTemplateExpression(source, index + 2);
      continue;
    }
    index++;
  }
  return source.length;
}

function skipRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '\\') { index += 2; continue; }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      index++;
      while (/[A-Za-z]/.test(source[index] ?? '')) index++;
      return index;
    }
    if (char === '\n' || char === '\r') return start + 1;
    index++;
  }
  return start + 1;
}

function tokens(source: string, python = false): Token[] {
  const result: Token[] = [];
  let previous = '';
  const controlParens: boolean[] = [];
  let controlParenPending = false;
  for (let index = 0; index < source.length;) {
    const char = source[index]!;
    const next = source[index + 1];
    if (/\s/.test(char)) { index++; continue; }
    if (python && char === '#') {
      const newline = source.indexOf('\n', index + 1);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (char === '/' && next === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      if (python && source.slice(index, index + 3) === char.repeat(3)) {
        const close = source.indexOf(char.repeat(3), index + 3);
        index = close < 0 ? source.length : close + 3;
      } else index = skipQuoted(source, index, char);
      previous = 'literal';
      controlParenPending = false;
      continue;
    }
    if (char === '`') { index = skipTemplate(source, index); previous = 'literal'; controlParenPending = false; continue; }
    if (!python && char === '/' && regexStartPrevious.test(previous)) {
      const end = skipRegex(source, index);
      if (end !== index + 1) { index = end; previous = 'literal'; controlParenPending = false; continue; }
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/.test(source[end] ?? '')) end++;
      const value = source.slice(index, end);
      result.push({ value, start: index, end });
      controlParenPending = controlParenKeywords.has(value) && previous !== '.' && previous !== '?.'
        || controlParenPending && value === 'await';
      previous = value;
      index = end;
      continue;
    }
    const pair = source.slice(index, index + 3) === '...'
      ? '...' : ['=>', '->', '::', '?.', '&&', '||', '??', '==', '!=', '<=', '>=', '++', '--']
        .find(value => source.slice(index, index + value.length) === value);
    const value = pair ?? char;
    result.push({ value, start: index, end: index + value.length });
    if (value === '(') { controlParens.push(controlParenPending); controlParenPending = false; }
    else if (value === ')') {
      previous = controlParens.pop() ? 'control-close' : value;
      controlParenPending = false;
      index += value.length;
      continue;
    } else controlParenPending = false;
    previous = value;
    index += value.length;
  }
  return result;
}

function matching(tokens: readonly Token[], open: number, left = '{', right = '}'): number | undefined {
  if (tokens[open]?.value !== left) return undefined;
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    if (tokens[index]!.value === left) depth++;
    else if (tokens[index]!.value === right && --depth === 0) return index;
  }
  return undefined;
}

function lineStarts(source: string): number[] {
  const result = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') result.push(index + 1);
  return result;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function lineEnd(source: string, start: number): number {
  const newline = source.indexOf('\n', start);
  return newline < 0 ? source.length : newline + 1;
}

const scalarInitializer = /^(?:[-+]?(?:(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?|0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+)|true|false|null|undefined|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\$])*`)$/;

function fileLevelLiteralDependencies(
  source: string,
  extension: string,
  code: readonly Token[],
  candidate: Candidate,
  bodyOpen: number,
  bodyClose: number,
): FocusedSourceDependency[] {
  if (!['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.sol'].includes(extension)) return [];
  const starts = lineStarts(source);
  const declarations: FocusedSourceDependency[] = [];
  let depth = 0;
  for (let index = 0; index < code.length; index++) {
    const token = code[index]!;
    if (depth === 0 && token.value === 'const') {
      const nameToken = code[index + 1];
      if (nameToken && identifier.test(nameToken.value)) {
        const startLineIndex = lineAt(starts, token.start);
        const startOffset = starts[startLineIndex]!;
        const rawLine = source.slice(startOffset, lineEnd(source, startOffset)).replace(/\r?\n$/, '');
        const declaration = /^\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(.*?)\s*;?\s*(?:\/\/.*)?$/.exec(rawLine);
        const initializer = declaration?.[2]?.trim();
        if (declaration?.[1] === nameToken.value && initializer && scalarInitializer.test(initializer)) {
          declarations.push({ name: nameToken.value, text: rawLine.trim(),
            startLine: startLineIndex + 1, endLine: startLineIndex + 1 });
        }
      }
    }
    if (token.value === '{') depth++;
    else if (token.value === '}') depth = Math.max(0, depth - 1);
  }

  return declarations.filter(dependency => {
    const name = dependency.name;
    // Treat any same-name parameter/type in the selected signature as a local
    // binding. This may omit a usable global, but never inserts a shadowed value.
    if (code.slice(candidate.name + 1, bodyOpen).some(token => token.value === name)) return false;

    for (let index = bodyOpen + 1; index < bodyClose; index++) {
      const token = code[index]!;
      if (['const', 'let', 'var'].includes(token.value)) {
        for (let probe = index + 1; probe < bodyClose && !['=', ';'].includes(code[probe]!.value); probe++) {
          if (code[probe]!.value === name) return false;
        }
      }
      if (['function', 'class'].includes(token.value)) {
        const nameIndex = code[index + 1]?.value === '*' ? index + 2 : index + 1;
        if (code[nameIndex]?.value === name) return false;
      }
      if (token.value === name && code[index + 1]?.value === '=>') return false;
      if (token.value !== '(') continue;
      const parameterClose = matching(code, index, '(', ')');
      if (parameterClose === undefined || parameterClose >= bodyClose || code[parameterClose + 1]?.value !== '=>'
        && code[parameterClose + 1]?.value !== '{') continue;
      const previous = code[index - 1]?.value ?? '';
      if (controlParenKeywords.has(previous) || previous === 'catch') continue;
      if (code.slice(index + 1, parameterClose).some(parameter => parameter.value === name)) return false;
    }

    for (let index = bodyOpen + 1; index < bodyClose; index++) {
      if (code[index]!.value !== name) continue;
      const previous = code[index - 1]?.value;
      const next = code[index + 1]?.value;
      if (previous === '.' || previous === '?.' || next === ':') continue;
      return true;
    }
    return false;
  });
}

export function renderFocusedSourceExcerpt(excerpt: FocusedSourceExcerpt): string {
  const dependencies = excerpt.dependencies ?? [];
  if (!dependencies.length) return excerpt.text;
  const lines = dependencies.map(item => `line ${item.startLine}: ${item.text}`).join('\n');
  return `[File-scope literal dependencies]\n${lines}\n\n${excerpt.text}`;
}

function pythonExcerpt(source: string, name: string): FocusedSourceExcerpt | undefined {
  const code = tokens(source, true);
  const starts = lineStarts(source);
  const matches: number[] = [];
  for (let index = 0; index < code.length - 2; index++) {
    if (code[index]!.value !== 'def' || code[index + 1]!.value !== name || code[index + 2]!.value !== '(') continue;
    matches.push(code[index]!.start);
  }
  if (matches.length !== 1) return undefined;
  const declarationStart = matches[0]!;
  const declarationLine = lineAt(starts, declarationStart);
  const rawLines = source.split(/\n/);
  const baseIndent = /^\s*/.exec(rawLines[declarationLine]!)![0].replace(/\t/g, '        ').length;
  let startLine = declarationLine;
  while (startLine > 0) {
    const previous = rawLines[startLine - 1]!;
    if (!/^\s*@/.test(previous) || /^\s*/.exec(previous)![0].replace(/\t/g, '        ').length !== baseIndent) break;
    startLine--;
  }

  let triple: string | undefined;
  let bracketDepth = 0;
  let endLine = rawLines.length - 1;
  for (let line = 0; line < rawLines.length; line++) {
    const value = rawLines[line]!;
    const depthBefore = bracketDepth;
    let visible = '';
    for (let index = 0; index < value.length;) {
      if (triple) {
        const close = value.indexOf(triple, index);
        if (close < 0) break;
        index = close + 3;
        triple = undefined;
        continue;
      }
      const char = value[index]!;
      if (char === '#') break;
      if (char === '"' || char === "'") {
        if (value.slice(index, index + 3) === char.repeat(3)) { triple = char.repeat(3); index += 3; continue; }
        let next = index + 1;
        while (next < value.length) {
          if (value[next] === '\\') { next += 2; continue; }
          if (value[next] === char) { next++; break; }
          next++;
        }
        index = next;
        continue;
      }
      if ('([{'.includes(char)) bracketDepth++;
      else if (')]}'.includes(char)) bracketDepth = Math.max(0, bracketDepth - 1);
      visible += char;
      index++;
    }
    if (line > declarationLine && depthBefore === 0 && visible.trim()) {
      const indentation = /^\s*/.exec(value)![0].replace(/\t/g, '        ').length;
      if (indentation <= baseIndent) { endLine = line - 1; break; }
    }
  }
  while (endLine > declarationLine && !rawLines[endLine]!.trim()) endLine--;
  const start = starts[startLine]!;
  const end = lineEnd(source, starts[endLine]!);
  return { text: source.slice(start, end), startLine: startLine + 1, endLine: endLine + 1 };
}

function classRanges(code: readonly Token[]): Array<{ open: number; close: number }> {
  const ranges: Array<{ open: number; close: number }> = [];
  for (let index = 0; index < code.length; index++) {
    if (!['class', 'struct', 'record'].includes(code[index]!.value)) continue;
    let open = index + 1;
    while (open < code.length && !['{', ';'].includes(code[open]!.value)) open++;
    if (code[open]?.value !== '{') continue;
    const close = matching(code, open);
    if (close !== undefined) ranges.push({ open, close });
  }
  return ranges;
}

function functionCandidates(source: string, code: readonly Token[], name: string, extension: string): Candidate[] {
  const result: Candidate[] = [];
  const isJs = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.sol'].includes(extension);
  const isGo = extension === '.go';
  const isRust = extension === '.rs';
  const isCFamily = ['.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'].includes(extension);
  const functionKeyword = isJs || extension === '.php' ? 'function'
    : extension === '.swift' ? 'func' : extension === '.kt' ? 'fun' : extension === '.scala' ? 'def'
      : undefined;

  for (let index = 0; index < code.length; index++) {
    const value = code[index]!.value;
    if (functionKeyword && value === functionKeyword) {
      let nameIndex = index + 1;
      if (code[nameIndex]?.value === '*') nameIndex++;
      if (code[nameIndex]?.value === name) result.push({ name: nameIndex, start: index });
    }
    if (isGo && value === 'func') {
      let nameIndex = index + 1;
      if (code[nameIndex]?.value === '(') {
        const receiverEnd = matching(code, nameIndex, '(', ')');
        if (receiverEnd === undefined) continue;
        nameIndex = receiverEnd + 1;
      }
      if (code[nameIndex]?.value === name) result.push({ name: nameIndex, start: index });
    }
    if (isRust && value === 'fn' && code[index + 1]?.value === name) result.push({ name: index + 1, start: index });
  }

  if (isCFamily) {
    const lineStart = (offset: number) => Math.max(source.lastIndexOf('\n', offset - 1) + 1, 0);
    for (let index = 0; index < code.length; index++) {
      if (code[index]!.value !== name) continue;
      let parameterStart = index + 1;
      if (code[parameterStart]?.value === '<') {
        const genericEnd = matching(code, parameterStart, '<', '>');
        if (genericEnd === undefined) continue;
        parameterStart = genericEnd + 1;
      }
      if (code[parameterStart]?.value !== '(') continue;
      const start = lineStart(code[index]!.start);
      const prefix = source.slice(start, code[index]!.start);
      if (!/^\s*(?:(?:static|inline|constexpr|extern|virtual|friend|explicit)\s+)*(?:[A-Za-z_$][A-Za-z0-9_$.:<>,?&*\[\]]*\s+)+$/.test(prefix)) continue;
      if (/\b(?:return|throw|case|new|delete|await|yield)\s+$/.test(prefix)) continue;
      const firstOnLine = code.findIndex(token => token.start >= start && token.start < code[index]!.start);
      result.push({ name: index, start: firstOnLine < 0 ? index : firstOnLine });
    }
  }

  if (isJs) {
    for (let index = 0; index < code.length; index++) {
      if (code[index]!.value !== name || !['const', 'let', 'var'].includes(code[index - 1]?.value ?? '')) continue;
      let assignment = index + 1;
      while (assignment < code.length && code[assignment]!.value !== '=' && ![';', ','].includes(code[assignment]!.value)) assignment++;
      if (code[assignment]?.value !== '=') continue;
      let arrow = assignment + 1;
      if (code[arrow]?.value === '(') {
        const parameterEnd = matching(code, arrow, '(', ')');
        if (parameterEnd === undefined) continue;
        arrow = parameterEnd + 1;
        while (arrow < code.length && !['=>', ';', ','].includes(code[arrow]!.value)) arrow++;
      } else {
        while (arrow < code.length && !['=>', ';', ','].includes(code[arrow]!.value)) arrow++;
      }
      if (code[arrow]?.value === '=>') result.push({ name: index, start: index - 1, arrow });
    }
  }

  const ranges = classRanges(code);
  const depths: number[] = [];
  let depth = 0;
  for (const token of code) {
    depths.push(depth);
    if (token.value === '{') depth++;
    else if (token.value === '}') depth = Math.max(0, depth - 1);
  }
  const lineStart = (offset: number) => Math.max(source.lastIndexOf('\n', offset - 1) + 1, 0);
  for (let index = 0; index < code.length; index++) {
    if (code[index]!.value !== name) continue;
    if (!ranges.some(range => range.open < index && index < range.close
      && depths[index] === depths[range.open]! + 1)) continue;
    let parameterStart = index + 1;
    if (code[parameterStart]?.value === '<') {
      let genericDepth = 0;
      while (parameterStart < code.length) {
        if (code[parameterStart]!.value === '<') genericDepth++;
        else if (code[parameterStart]!.value === '>' && --genericDepth === 0) { parameterStart++; break; }
        parameterStart++;
      }
    }
    if (code[parameterStart]?.value !== '(') continue;
    const prefix = source.slice(lineStart(code[index]!.start), code[index]!.start);
    if (!/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|inline|constexpr|extern|friend|virtual|override|async|readonly|get|set|export|default|declare|new)\s+)*(?:[A-Za-z_$][A-Za-z0-9_$.:<>,?&*\[\]]*\s+)*$/.test(prefix)) continue;
    result.push({ name: index, start: index });
  }
  return result;
}

function bracedExcerpt(source: string, path: string, name: string): FocusedSourceExcerpt | undefined {
  const extension = /\.[^./\\]+$/.exec(path)?.[0].toLowerCase() ?? '';
  const code = tokens(source);
  const candidates = functionCandidates(source, code, name, extension);
  const results: FocusedSourceExcerpt[] = [];
  const starts = lineStarts(source);
  for (const candidate of candidates) {
    let open: number | undefined;
    if (candidate.arrow !== undefined) {
      if (code[candidate.arrow + 1]?.value === '{') open = candidate.arrow + 1;
    } else {
      let paren = candidate.name + 1;
      if (['<', '['].includes(code[paren]?.value ?? '')) {
        const left = code[paren]!.value;
        const right = left === '<' ? '>' : ']';
        const genericEnd = matching(code, paren, left, right);
        if (genericEnd === undefined) continue;
        paren = genericEnd + 1;
      }
      while (paren < code.length && !['(', ';', '{'].includes(code[paren]!.value)) paren++;
      const close = matching(code, paren, '(', ')');
      if (close === undefined) continue;
      let typedReturn = false;
      for (let index = close + 1; index < code.length; index++) {
        const value = code[index]!.value;
        if (value === ':') typedReturn = true;
        if (value === ';') break;
        if (value === '{') {
          const after = code[index + 1]?.value;
          const typeShape = typedReturn && (after === '}' || after === '[' || after === 'readonly'
            || identifier.test(after ?? '') && code[index + 2]?.value === ':');
          if (typeShape) {
            const typeEnd = matching(code, index);
            if (typeEnd === undefined) break;
            index = typeEnd;
            continue;
          }
          open = index;
          break;
        }
      }
    }
    if (open === undefined) continue;
    const close = matching(code, open);
    if (close === undefined) continue;
    const declaration = code[candidate.start]!;
    const nameToken = code[candidate.name]!;
    let startOffset = declaration.start;
    const lineStartOffset = starts[lineAt(starts, declaration.start)]!;
    const prefix = source.slice(lineStartOffset, declaration.start);
    if (/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|inline|constexpr|extern|friend|virtual|override|async|readonly|get|set|export|default|declare|new)\s+)*(?:[A-Za-z_$][A-Za-z0-9_$.:<>,?&*\[\]]*\s+)*$/.test(prefix)) startOffset = lineStartOffset;
    if (['.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'].includes(extension)) {
      let probe = lineStartOffset;
      while (probe > 0) {
        const previousStart = source.lastIndexOf('\n', probe - 2) + 1;
        const previousLine = source.slice(previousStart, probe);
        if (/^\s*template\s*</.test(previousLine)) { startOffset = previousStart; break; }
        if (!previousLine.trim() || /[{};]/.test(previousLine)) break;
        probe = previousStart;
      }
    }
    let startLine = lineAt(starts, startOffset);
    const indentation = /^\s*/.exec(source.slice(starts[startLine]!, lineEnd(source, starts[startLine]!)))![0];
    while (startLine > 0) {
      const priorLine = source.slice(starts[startLine - 1]!, lineEnd(source, starts[startLine - 1]!));
      if (!/^\s*@/.test(priorLine) || /^\s*/.exec(priorLine)![0] !== indentation) break;
      startLine--;
    }
    startOffset = starts[startLine]!;
    const endOffset = lineEnd(source, code[close]!.end);
    const endLine = lineAt(starts, code[close]!.end);
    if (!nameToken || endOffset <= startOffset) continue;
    const dependencies = fileLevelLiteralDependencies(source, extension, code, candidate, open, close);
    results.push({ text: source.slice(startOffset, endOffset), startLine: startLine + 1, endLine: endLine + 1,
      ...(dependencies.length ? { dependencies } : {}) });
  }
  const unique = new Map(results.map(result => [`${result.startLine}:${result.endLine}:${result.text}`, result]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

export function focusedSourceExcerpt(source: string, path: string, name: string): FocusedSourceExcerpt | undefined {
  if (!identifier.test(name) || !source.trim()) return undefined;
  const extension = /\.[^./\\]+$/.exec(path)?.[0].toLowerCase() ?? '';
  if (['.py', '.pyw'].includes(extension)) return pythonExcerpt(source, name);
  return bracedExcerpt(source, path, name);
}
