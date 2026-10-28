import { reference, shortHash } from './annotations.js';
import { digest, type Entry, type Group, type Snapshot } from './store.js';

export type ArchiveNode = Entry | Group;
const childEdges = (node: ArchiveNode): string[] => 'children' in node ? node.children : node.annotation?.children?.map(child => child.id) ?? [];
export interface BrowseOptions {
  id?: string | undefined; depth?: number | undefined; recursive?: boolean; query?: string | undefined;
  sort?: 'chronological' | 'size' | 'id' | 'version'; order?: 'asc' | 'desc'; offset?: number; limit?: number;
}

export function childrenOf(node: ArchiveNode): string[] {
  return [...new Set(childEdges(node))];
}

export function queryKey(snapshot: Snapshot, node: ArchiveNode): string {
  if (!('text' in node) || !node.annotation) return node.id;
  return shortHash(node.annotation.sha256, [...snapshot.entries.flatMap(entry => [entry.id,
    ...(entry.annotation ? [entry.annotation.sha256] : [])]), ...(snapshot.groups ?? []).map(group => group.id)]);
}

function allParents(snapshot: Snapshot): Map<string, Set<string>> {
  const parents = new Map<string, Set<string>>();
  for (const node of [...snapshot.entries, ...(snapshot.groups ?? [])]) for (const child of childrenOf(node)) {
    const set = parents.get(child) ?? new Set();
    set.add(node.id); parents.set(child, set);
  }
  return parents;
}

export function parentIndex(snapshot: Snapshot): Map<string, string> {
  return new Map([...allParents(snapshot)].map(([id, parents]) => [id, [...parents][0]!]));
}

export function latestVersions(snapshot: Snapshot): Set<string> {
  // @context-fold begin latestVersions-b4b7f5c895
  const latest = new Map<string, number>();
  const observed = new Map<string, string>();
  for (const entry of snapshot.entries) {
    if (!entry.version) continue;
    latest.set(entry.version.series, Math.max(latest.get(entry.version.series) ?? 0, entry.version.number));
    if (entry.version.latest) observed.set(entry.version.series, entry.id);
  }
  return new Set(snapshot.entries.filter(entry => entry.version && (observed.has(entry.version.series)
    ? observed.get(entry.version.series) === entry.id : latest.get(entry.version.series) === entry.version.number)).map(entry => entry.id));
  // @context-fold end latestVersions-b4b7f5c895
}

export function versionMetadata(version: NonNullable<Entry['version']>) {
  return { series: version.series, number: version.number, kind: version.kind,
    ...(version.previousId ? { previousId: version.previousId } : {}),
    ...(version.path ? { path: version.path.slice(0, 240) } : {}),
    ...(version.range ? { range: version.range.slice(0, 80) } : {}) };
}

/** Queries never recursively expand a reference or alter its owner's folded state. */
export function archiveView(snapshot: Snapshot, node: ArchiveNode): string {
  if ('children' in node) return JSON.stringify({ id: node.id, summary: node.summary, children: node.children });
  let text = node.text;
  const byId = new Map(snapshot.entries.map(entry => [entry.id, entry]));
  const hashes = [...snapshot.entries.flatMap(entry => [entry.id, ...(entry.annotation ? [entry.annotation.sha256] : [])]),
    ...(snapshot.groups ?? []).map(group => group.id)];
  for (const child of [...(node.annotation?.children ?? [])].reverse()) {
    const target = byId.get(child.id);
    if (!target?.annotation) throw new Error('Annotation child unavailable');
    text = text.slice(0, child.start) + reference(shortHash(target.annotation.sha256, hashes)) + text.slice(child.end);
  }
  return text;
}

interface SearchMatch {
  source: 'id' | 'path' | 'summary' | 'original' | 'label';
  offset: number; endOffset: number; excerptOffset: number; excerpt: string;
}

export function literalPattern(query: string, caseSensitive = false): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'u' : 'iu');
}

function excerpt(text: string, at: number, length: number, before = 32) {
  let start = Math.max(0, at - before);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!) && /[\uD800-\uDBFF]/.test(text[start - 1]!)) start--;
  let end = Math.min(text.length, start + length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
  return { start, text: text.slice(start, end) };
}

function searchMatch(snapshot: Snapshot, node: ArchiveNode, pattern: RegExp): SearchMatch | undefined {
  // @context-fold begin searchMatch-3804e5aec6
  const fields: [SearchMatch['source'], string][] = 'children' in node
    ? [['summary', node.summary], ['id', node.id]]
    : [['original', archiveView(snapshot, node)], ['summary', node.mark.disposition === 'foldable' ? node.mark.summary : ''],
      ['label', node.annotation?.label ?? ''], ['path', node.version?.path ?? ''], ['id', node.id]];
  for (const [source, text] of fields) {
    const match = pattern.exec(text);
    if (!match) continue;
    const part = excerpt(text, match.index, 160);
    return { source, offset: match.index, endOffset: match.index + match[0].length,
      excerptOffset: part.start, excerpt: part.text };
  }
  return undefined;
  // @context-fold end searchMatch-3804e5aec6
}

/** Flat preorder, bounded output, one visit per archived node even with shared children. */
export function browse(snapshot: Snapshot, options: BrowseOptions = {}) {
  // @context-fold begin browse-c3d5e9701b
  const nodes = new Map<string, ArchiveNode>([...snapshot.entries, ...(snapshot.groups ?? [])].map(node => [node.id, node]));
  if (options.id !== undefined && !nodes.has(options.id)) throw new Error('Unknown entry or group');
  const parents = allParents(snapshot);
  const latest = latestVersions(snapshot);
  const metadata = new Map<string, { position: number; size: number }>();
  snapshot.entries.forEach((entry, position) => metadata.set(entry.id, { position, size: entry.text.length }));
  const size = (id: string): { position: number; size: number } => {
    if (metadata.has(id)) return metadata.get(id)!;
    const childMeta = childrenOf(nodes.get(id)!).map(size);
    const result = { position: Math.min(...childMeta.map(child => child.position)), size: childMeta.reduce((sum, child) => sum + child.size, 0) };
    metadata.set(id, result); return result;
  };
  for (const group of snapshot.groups ?? []) size(group.id);
  const included = options.query ? new Set<string>() : undefined;
  const matches = new Map<string, SearchMatch>();
  if (included && options.query) {
    const pattern = literalPattern(options.query);
    for (const node of nodes.values()) {
      const match = searchMatch(snapshot, node, pattern);
      if (!match) continue;
      matches.set(node.id, match);
      const pending = [node.id];
      while (pending.length) {
        const id = pending.pop()!;
        if (included.has(id)) continue;
        included.add(id); pending.push(...parents.get(id) ?? []);
      }
    }
  }
  const compare = (a: string, b: string): number => {
    const left = nodes.get(a)!; const right = nodes.get(b)!;
    const lexical = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
    let difference = 0;
    switch (options.sort ?? 'chronological') {
      case 'size': difference = size(a).size - size(b).size; break;
      case 'id': difference = lexical(a, b); break;
      case 'version': {
        const av = 'version' in left ? left.version : undefined;
        const bv = 'version' in right ? right.version : undefined;
        difference = lexical(av?.series ?? '', bv?.series ?? '') || (av?.number ?? 0) - (bv?.number ?? 0); break;
      }
    }
    difference ||= size(a).position - size(b).position || lexical(a, b);
    return options.order === 'desc' ? -difference : difference;
  };
  const roots = options.id === undefined ? [...nodes.keys()].filter(id => !parents.has(id)) : [options.id];
  const stack = roots.sort(compare).reverse().map(id => ({ id, depth: 0, parentId: [...parents.get(id) ?? []][0] ?? null }));
  const offset = options.offset ?? 0; const limit = options.limit ?? 10;
  const depthLimit = options.depth ?? (options.recursive ? 64 : 1);
  const entries = []; const visited = new Set<string>(); let total = 0;
  while (stack.length) {
    const { id, depth, parentId } = stack.pop()!;
    if (visited.has(id) || (included && !included.has(id))) continue;
    visited.add(id);
    const node = nodes.get(id)!;
    if (total >= offset && entries.length < limit) {
      const base = { id, key: queryKey(snapshot, node), parentId, depth, childCount: childEdges(node).length, chars: size(id).size,
        folded: node.folded !== undefined, ...(matches.has(id) ? { match: matches.get(id)! } : {}) };
      entries.push('children' in node
        ? { ...base, role: 'group' as const, label: node.summary.slice(0, 80), disposition: node.enabled ? 'foldable' : 'unmarked' }
        : { ...base, role: node.role, label: (node.annotation?.label ?? '').slice(0, 80), disposition: node.mark.disposition,
          bytes: Buffer.byteLength(node.text), layers: node.layers.length,
          currentLayer: node.layers.find(layer => layer.text === node.folded)?.id ?? 'original',
          ...(node.mark.disposition === 'foldable' ? { summary: node.mark.summary.slice(0, 120) } : {}),
          ...(node.version ? { version: versionMetadata(node.version), latestVersion: latest.has(id) } : {}) });
    }
    total++;
    if (depth < depthLimit) for (const child of childrenOf(node).sort(compare).reverse()) stack.push({ id: child, depth: depth + 1, parentId: id });
  }
  return { entries, total, nextOffset: offset + entries.length < total ? offset + entries.length : null };
  // @context-fold end browse-c3d5e9701b
}

export function nodeMeta(snapshot: Snapshot, node: ArchiveNode, offset = 0, limit = 10) {
  const children = childEdges(node);
  const view = archiveView(snapshot, node);
  const original = 'text' in node ? node.text : view;
  return { id: node.id, key: queryKey(snapshot, node), label: 'text' in node ? (node.annotation?.label ?? '').slice(0, 80) : node.summary.slice(0, 80),
    chars: original.length, bytes: Buffer.byteLength(original), sha256: digest(original),
    viewChars: view.length, viewSha256: digest(view), totalLines: physicalLines(view).length,
    childCount: children.length, children: children.slice(offset, offset + limit),
    nextOffset: offset + limit < children.length ? offset + limit : null,
    layers: 'text' in node ? node.layers.map(layer => layer.id).slice(0, 10) : [], offsetUnit: 'utf16' };
}

export function physicalLines(text: string): { text: string; start: number; end: number }[] {
  const lines = []; let start = 0;
  for (const line of text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []) {
    if (!line) continue;
    lines.push({ text: line.replace(/(?:\r\n|\r|\n)$/, ''), start, end: start + line.length });
    start += line.length;
  }
  return lines;
}

export function grep(snapshot: Snapshot, options: { query: string; id?: string | undefined; recursive?: boolean; offset?: number; limit?: number; caseSensitive?: boolean }) {
  const nodes = new Map<string, ArchiveNode>([...snapshot.entries, ...(snapshot.groups ?? [])].map(node => [node.id, node]));
  if (options.id !== undefined && !nodes.has(options.id)) throw new Error('Unknown entry or group');
  const roots = options.id === undefined ? snapshot.entries.map(entry => entry.id) : [options.id];
  const pending = [...roots].reverse(); const visited = new Set<string>();
  const pattern = literalPattern(options.query, options.caseSensitive);
  const offset = options.offset ?? 0; const limit = options.limit ?? 10;
  const matches: { id: string; key: string; label: string; line: number; text: string; textOffset: number; offset: number; endOffset: number }[] = []; let total = 0;
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id)!;
    const lines = physicalLines(archiveView(snapshot, node));
    lines.forEach((line, index) => {
      const match = pattern.exec(line.text);
      if (!match) return;
      if (total >= offset && matches.length < limit) {
        const part = excerpt(line.text, match.index, 160);
        matches.push({ id, key: queryKey(snapshot, node), label: 'text' in node ? (node.annotation?.label ?? '').slice(0, 80) : node.summary.slice(0, 80),
          line: index + 1, text: part.text, textOffset: part.start,
          offset: line.start + match.index, endOffset: line.start + match.index + match[0].length });
      }
      total++;
    });
    if (options.recursive !== false) pending.push(...childrenOf(node).reverse());
  }
  return { matches, total, nextOffset: offset + matches.length < total ? offset + matches.length : null, offsetUnit: 'utf16' };
}
