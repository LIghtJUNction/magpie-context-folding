import { createHash } from 'node:crypto';

/** The same whole-line directive works in prose and in source comments. */
const styles = [
  ['<!--', '-->'], ['/*', '*/'], ['(*', '*)'], ['{-', '-}'], ['#|', '|#'], ['<#', '#>'],
  ['//', ''], ['#', ''], ['--', ''], [';', ''], ['%', ''], ['!', ''], ["'", ''], ['"', ''], ['REM', ''], ['', ''],
] as const;

export interface TextPart { id: string; text: string; markerOffsets?: ReadonlySet<number> }
export interface Slice { id: string; start: number; end: number }
interface Origin { id: string; ordinal: number }
export interface Region {
  label: string; text: string; sha256: string; slices: Slice[];
  origin: Origin & { path: Origin[] };
  children: { region: Region; start: number; end: number }[];
  /** Existing references require scope validation before they can form a parent. */
  hasReferences: boolean;
  referenceHash?: string;
}

function marker(line: string): { kind: 'begin' | 'end'; label: string; style: string } | 'invalid' | undefined {
  // @context-fold begin marker-68a6064dd3
  const value = line.trim();
  for (const [start, end] of styles) {
    if (!value.startsWith(start) || (end && !value.endsWith(end))) continue;
    const inner = value.slice(start.length, end ? -end.length : undefined).trim();
    const match = /^@context-fold[\t ]+(begin|end)[\t ]+(\S+)[\t ]*$/.exec(inner);
    if (match) return { kind: match[1] as 'begin' | 'end', label: match[2]!, style: start + '\0' + end };
    if (inner.startsWith('@context-fold')) return 'invalid';
  }
  return;
  // @context-fold end marker-68a6064dd3
}

/** Scan editable text only. User/trust boundaries are split by the caller. */
export function parseRegions(parts: readonly TextPart[]): Region[] {
  interface Frame {
    label: string; style: string; slices: Slice[]; invalid: boolean;
    origin: Region['origin']; order: number; children: Region[]; ordinals: Map<string, number>;
  }
  // @context-fold begin parseRegions-9a007b50ac
  const regions: Region[] = [];
  const orders = new Map<Region, number>();
  const byId = new Map(parts.map(part => [part.id, part]));
  const stack: Frame[] = [];
  const rootOrdinals = new Map<string, number>();
  let order = 0;
  const append = (frames: Frame[], part: TextPart, offset: number, line: string) => {
    for (const frame of frames) {
      const last = frame.slices.at(-1);
      if (last?.id === part.id && last.end === offset) last.end += line.length;
      else frame.slices.push({ id: part.id, start: offset, end: offset + line.length });
    }
  };
  const close = (frame: Frame) => {
    if (frame.invalid) return;
    const last = frame.slices.at(-1);
    if (last) {
      const ending = /(?:\r\n|\r|\n)$/.exec(byId.get(last.id)!.text.slice(last.start, last.end));
      if (ending) last.end -= ending[0].length;
    }
    const slices = frame.slices.filter(slice => slice.end > slice.start);
    const text = slices.map(slice => byId.get(slice.id)!.text.slice(slice.start, slice.end)).join('');
    if (!text || Buffer.from(text, 'utf8').toString('utf8') !== text) return;
    const positions = slices.map((slice, index) => ({ ...slice,
      offset: slices.slice(0, index).reduce((sum, previous) => sum + previous.end - previous.start, 0) }));
    const children = frame.children.flatMap(region => {
      const first = region.slices[0]!;
      const last = region.slices.at(-1)!;
      const start = positions.find(slice => slice.id === first.id && slice.start <= first.start && slice.end >= first.end);
      const end = positions.find(slice => slice.id === last.id && slice.start <= last.start && slice.end >= last.end);
      return start && end ? [{ region, start: start.offset + first.start - start.start,
        end: end.offset + last.end - end.start }] : [];
    });
    const referenceHash = /^\[\[cf:v2:([a-f0-9]{12,64})\]\]$/.exec(text.replace(/^[ \t]+|[ \t]+$/g, ''))?.[1];
    const region: Region = { label: frame.label, text, sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      slices, origin: frame.origin, children, hasReferences: /\[\[cf:/.test(text),
      ...(referenceHash ? { referenceHash } : {}) };
    regions.push(region);
    orders.set(region, frame.order);
    stack.at(-1)?.children.push(region);
  };
  for (const part of parts) {
    let offset = 0;
    for (const line of part.text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []) {
      if (!line) continue;
      const directive = part.markerOffsets && !part.markerOffsets.has(offset) ? undefined : marker(line);
      if (!directive || directive === 'invalid') {
        if (directive === 'invalid') for (const frame of stack) frame.invalid = true;
        append(stack, part, offset, line);
      } else if (directive.kind === 'begin') {
        append(stack, part, offset, line);
        const parent = stack.at(-1);
        const ordinals = parent?.ordinals ?? rootOrdinals;
        const ordinal = (ordinals.get(part.id) ?? 0) + 1;
        ordinals.set(part.id, ordinal);
        const origin = { id: part.id, ordinal };
        stack.push({ label: directive.label, style: directive.style, slices: [], invalid: false,
          origin: { ...origin, path: [...(parent?.origin.path ?? []), origin] },
          order: order++, children: [], ordinals: new Map() });
      } else {
        let matching = stack.length - 1;
        while (matching >= 0 && (stack[matching]!.label !== directive.label || stack[matching]!.style !== directive.style)) matching--;
        if (matching < 0) {
          for (const frame of stack) frame.invalid = true;
          append(stack, part, offset, line);
        } else if (matching !== stack.length - 1) {
          // A mismatched nested range cannot hide under an apparently valid parent.
          for (const frame of stack) frame.invalid = true;
          stack.splice(matching);
          append(stack, part, offset, line);
        } else {
          const frame = stack.pop()!;
          append(stack, part, offset, line);
          close(frame);
        }
      }
      offset += line.length;
    }
  }
  // A later damaged/open parent does not discard independently closed children.
  return regions.filter(region => !region.referenceHash).sort((a, b) => orders.get(a)! - orders.get(b)!);
  // @context-fold end parseRegions-9a007b50ac
}

/** A prefix is a display/lookup key, never an authority or a substitute for SHA-256. */
export function shortHash(sha256: string, hashes: Iterable<string>): string {
  const others = [...new Set(hashes)].filter(hash => hash !== sha256);
  let length = 12;
  while (length < 64 && others.some(hash => hash.startsWith(sha256.slice(0, length)))) length += 2;
  return sha256.slice(0, length);
}

export const reference = (hash: string): string => '[[cf:v2:' + hash + ']]';

export function containsRegion(outer: Region, inner: Region): boolean {
  return outer !== inner && inner.slices.every(child => outer.slices.some(parent => parent.id === child.id
    && parent.start <= child.start && parent.end >= child.end));
}

/** Nested selections publish only their outermost body ranges. */
export function outermost<T extends { region: Region }>(selected: readonly T[]): T[] {
  return selected.filter(item => !selected.some(other => containsRegion(other.region, item.region)));
}

/** Apply disjoint text ranges from the end so original offsets stay valid. */
export function replaceRegions(parts: readonly TextPart[], selected: readonly { region: Region; reference: string }[]): Map<string, string> {
  // @context-fold begin replaceRegions-0085c09ff4
  const edits = new Map<string, { start: number; end: number; text: string }[]>();
  for (const { region, reference: text } of outermost(selected)) {
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
  // @context-fold end replaceRegions-0085c09ff4
}
