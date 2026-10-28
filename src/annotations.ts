import { createHash } from 'node:crypto';

/** The same whole-line directive works in prose and in source comments. */
const styles = [
  ['<!--', '-->'], ['/*', '*/'], ['(*', '*)'], ['{-', '-}'], ['#|', '|#'], ['<#', '#>'],
  ['//', ''], ['#', ''], ['--', ''], [';', ''], ['%', ''], ['!', ''], ["'", ''], ['"', ''], ['REM', ''], ['', ''],
] as const;

export interface TextPart { id: string; text: string; markerOffsets?: ReadonlySet<number> }
export interface Slice { id: string; start: number; end: number }
export interface Region { label: string; text: string; sha256: string; slices: Slice[]; origin: { id: string; ordinal: number } }

function marker(line: string): { kind: 'begin' | 'end'; label: string; style: string } | 'invalid' | undefined {
  const value = line.trim();
  for (const [start, end] of styles) {
    if (!value.startsWith(start) || (end && !value.endsWith(end))) continue;
    const inner = value.slice(start.length, end ? -end.length : undefined).trim();
    const match = /^@context-fold[\t ]+(begin|end)[\t ]+(\S+)[\t ]*$/.exec(inner);
    if (match) return { kind: match[1] as 'begin' | 'end', label: match[2]!, style: `${start}\0${end}` };
    if (inner.startsWith('@context-fold')) return 'invalid';
  }
  return;
}

/**
 * Scan only editable text, never serialized tool calls. Parts may be separate
 * assistant messages. Callers split the stream at author/trust boundaries.
 * Ambiguous or nested regions stay readable; independent earlier regions remain eligible.
 */
export function parseRegions(parts: readonly TextPart[]): Region[] {
  const regions: Region[] = [];
  const byId = new Map(parts.map(part => [part.id, part]));
  let opened: { label: string; style: string; slices: Slice[]; invalid: boolean; depth: number; origin: Region['origin'] } | undefined;
  for (const part of parts) {
    let offset = 0;
    let ordinal = 0;
    const lines = part.text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
    for (const line of lines) {
      if (!line) continue;
      const directive = part.markerOffsets && !part.markerOffsets.has(offset) ? undefined : marker(line);
      if (directive === 'invalid') { if (opened) opened.invalid = true; offset += line.length; continue; }
      if (directive) {
        if (directive.kind === 'begin') {
          ordinal++;
          if (opened) { opened.invalid = true; opened.depth++; }
          else opened = { label: directive.label, style: directive.style, slices: [], invalid: false, depth: 1,
            origin: { id: part.id, ordinal } };
        } else {
          if (!opened) { offset += line.length; continue; }
          if (opened.depth > 1) { opened.depth--; offset += line.length; continue; }
          if (opened.label !== directive.label || opened.style !== directive.style) {
            opened.invalid = true; offset += line.length; continue;
          }
          if (opened.invalid) { opened = undefined; offset += line.length; continue; }
          const slices = opened.slices;
          const last = slices.at(-1);
          if (last) {
            const lastPart = byId.get(last.id)!;
            const ending = /(?:\r\n|\r|\n)$/.exec(lastPart.text.slice(last.start, last.end));
            if (ending) last.end -= ending[0].length;
          }
          const selected = slices.filter(slice => slice.end > slice.start);
          const text = selected.map(slice => byId.get(slice.id)!.text.slice(slice.start, slice.end)).join('');
          // References are literal recovery data, never a request to fold again.
          // UTF-8 hashing must not conflate distinct lone UTF-16 surrogates.
          if (text && !/\[\[cf:v[12]:/.test(text) && Buffer.from(text, 'utf8').toString('utf8') === text) {
            regions.push({ label: opened.label, text, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), slices: selected,
              origin: opened.origin });
          }
          opened = undefined;
        }
      } else if (opened) {
        const last = opened.slices.at(-1);
        if (last?.id === part.id && last.end === offset) last.end += line.length;
        else opened.slices.push({ id: part.id, start: offset, end: offset + line.length });
      }
      offset += line.length;
    }
  }
  return regions;
}

/** A prefix is a display/lookup key, never an authority or a substitute for SHA-256. */
export function shortHash(sha256: string, hashes: Iterable<string>): string {
  const others = [...new Set(hashes)].filter(hash => hash !== sha256);
  let length = 12;
  while (length < 64 && others.some(hash => hash.startsWith(sha256.slice(0, length)))) length += 2;
  return sha256.slice(0, length);
}

export const reference = (hash: string): string => `[[cf:v2:${hash}]]`;

/** Apply disjoint text ranges from the end so original offsets stay valid. */
export function replaceRegions(parts: readonly TextPart[], selected: readonly { region: Region; reference: string }[]): Map<string, string> {
  const edits = new Map<string, { start: number; end: number; text: string }[]>();
  for (const { region, reference: text } of selected) {
    for (const slice of region.slices) {
      const list = edits.get(slice.id) ?? [];
      list.push({ start: slice.start, end: slice.end, text });
      edits.set(slice.id, list);
    }
  }
  const replacements = new Map<string, string>();
  for (const part of parts) {
    let text = part.text;
    for (const edit of (edits.get(part.id) ?? []).sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    if (text !== part.text) replacements.set(part.id, text);
  }
  return replacements;
}
