import { digest, type Entry, type Snapshot } from './store.js';

type Group = NonNullable<Snapshot['groups']>[number];
export type ArchiveNode = Entry | Group;
type Node = ArchiveNode;
export const childrenOf = (node: Node): string[] => 'children' in node
  ? [...node.children] : (node.annotation?.children ?? []).map(child => child.id);
export const nodeFields = (node: Node) => 'text' in node ? {
  nodeId: node.id, sha256: node.annotation?.sha256 ?? digest(node.text), contentHash: node.annotation?.sha256 ?? digest(node.text),
  sourceRange: node.annotation?.sourceRanges?.length === 1 ? node.annotation.sourceRanges[0]! : null,
  sourceRanges: (node.annotation?.sourceRanges ?? []).slice(0, 20), sourceRangeCount: node.annotation?.sourceRanges?.length ?? 0,
  observedRanges: (node.annotation?.observedRanges ?? []).slice(0, 20), observedRangeCount: node.annotation?.observedRanges?.length ?? 0,
  offsetUnit: 'utf16' as const,
} : { nodeId: node.id, offsetUnit: 'utf16' as const };

export interface BrowseOptions {
  id?: string | undefined;
  parentId?: string | undefined;
  recursive?: boolean | undefined;
  depth?: number | undefined;
  query?: string | undefined;
  sort?: 'chronological' | 'size' | 'id' | 'version';
  order?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

export function parentIndex(snapshot: Snapshot): Map<string, string> {
  const parents = new Map<string, string>();
  for (const node of [...snapshot.entries, ...(snapshot.groups ?? [])]) {
    for (const child of childrenOf(node)) parents.set(child, node.id);
  }
  return parents;
}

/** Explicit restoration must also release every enclosing fold. */
export function restoreAncestors(snapshot: Snapshot, id: string): number {
  // @context-fold begin restoreAncestors-f4581f349a
  const parents = parentIndex(snapshot);
  const nodes = new Map<string, Node>([...snapshot.entries, ...(snapshot.groups ?? [])].map(node => [node.id, node]));
  let restored = 0;
  let parent = parents.get(id);
  while (parent !== undefined) {
    const node = nodes.get(parent)!;
    if (node.folded !== undefined) restored++;
    if ('children' in node) node.enabled = false;
    else { node.mark = { disposition: 'keep' }; node.manual = true; }
    delete node.folded;
    delete node.foldedMark;
    parent = parents.get(parent);
  }
  return restored;
  // @context-fold end restoreAncestors-f4581f349a
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
  // Legacy archives have no observation markers; retain their numeric fallback.
  return new Set(snapshot.entries.filter(entry => entry.version && (observed.has(entry.version.series)
    ? observed.get(entry.version.series) === entry.id : latest.get(entry.version.series) === entry.version.number)).map(entry => entry.id));
  // @context-fold end latestVersions-b4b7f5c895
}

interface SearchMatch {
  source: 'id' | 'path' | 'summary' | 'original' | 'label';
  offset: number;
  endOffset: number;
  excerptOffset: number;
  excerpt: string;
}

/** Literal matching keeps offsets in the original UTF-16 text, even with Unicode case folding. */
function searchMatch(node: Node, pattern: RegExp): SearchMatch | undefined {
  // @context-fold begin searchMatch-3804e5aec6
  const fields: [SearchMatch['source'], string][] = 'children' in node
    ? [['summary', node.summary], ['id', node.id]]
    : [['original', node.text], ['summary', node.mark.disposition === 'foldable' ? node.mark.summary : ''],
      ['label', node.annotation?.label ?? ''], ['path', node.version?.path ?? ''], ['id', node.id]];
  for (const [source, text] of fields) {
    const match = pattern.exec(text);
    if (!match) continue;
    let start = Math.max(0, match.index - 32);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!) && /[\uD800-\uDBFF]/.test(text[start - 1]!)) start--;
    let end = Math.min(text.length, start + 240);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
    return { source, offset: match.index, endOffset: match.index + match[0].length,
      excerptOffset: start, excerpt: text.slice(start, end) };
  }
  return undefined;
  // @context-fold end searchMatch-3804e5aec6
}

/** A bounded, flat preorder traversal; pagination counts groups and entries alike. */
export function browse(snapshot: Snapshot, options: BrowseOptions = {}) {
  // @context-fold begin browse-c3d5e9701b
  const nodes = new Map<string, Node>([...snapshot.entries, ...(snapshot.groups ?? [])].map(node => [node.id, node]));
  if ((options.id !== undefined && !nodes.has(options.id)) || (options.parentId !== undefined && !nodes.has(options.parentId))) {
    throw new Error('Unknown entry or group');
  }
  const parents = parentIndex(snapshot);
  const latest = latestVersions(snapshot);
  const metadata = new Map<string, { position: number; size: number }>();
  snapshot.entries.forEach((entry, position) => metadata.set(entry.id, { position, size: entry.text.length }));
  // Groups reference only earlier groups, so this pass also handles nested groups.
  for (const group of snapshot.groups ?? []) {
    const children = group.children.map(id => metadata.get(id)!);
    metadata.set(group.id, {
      position: Math.min(...children.map(child => child.position)),
      size: children.reduce((sum, child) => sum + child.size, 0),
    });
  }
  const query = options.query;
  const included = query ? new Set<string>() : undefined;
  const matches = new Map<string, SearchMatch>();
  if (included && query) {
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    for (const node of nodes.values()) {
      const match = searchMatch(node, pattern);
      if (!match) continue;
      matches.set(node.id, match);
      let id: string | undefined = node.id;
      while (id !== undefined && !included.has(id)) {
        included.add(id);
        id = parents.get(id);
      }
    }
  }
  const compare = (a: string, b: string): number => {
    const left = nodes.get(a)!;
    const right = nodes.get(b)!;
    const lexical = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
    let difference = 0;
    switch (options.sort ?? 'chronological') {
      case 'size': difference = metadata.get(a)!.size - metadata.get(b)!.size; break;
      case 'id': difference = lexical(a, b); break;
      case 'version': {
        const av = 'version' in left ? left.version : undefined;
        const bv = 'version' in right ? right.version : undefined;
        difference = lexical(av?.series ?? '', bv?.series ?? '') || (av?.number ?? 0) - (bv?.number ?? 0);
        break;
      }
    }
    difference ||= metadata.get(a)!.position - metadata.get(b)!.position || lexical(a, b);
    return options.order === 'desc' ? -difference : difference;
  };
  const roots = options.parentId !== undefined ? childrenOf(nodes.get(options.parentId)!)
    : options.id === undefined ? [...nodes.keys()].filter(id => !parents.has(id)) : [options.id];
  const stack = roots.sort(compare).reverse().map(id => ({ id, depth: 0 }));
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  const entries = [];
  let total = 0;
  while (stack.length) {
    const { id, depth } = stack.pop()!;
    if (included && !included.has(id)) continue;
    const node = nodes.get(id)!;
    if (total >= offset && entries.length < limit) {
      const base = { id, ...nodeFields(node), parentId: parents.get(id) ?? null, depth, childCount: childrenOf(node).length,
        chars: metadata.get(id)!.size, folded: node.folded !== undefined,
        ...(matches.has(id) ? { match: matches.get(id)! } : {}) };
      entries.push('children' in node
        ? { ...base, role: 'group' as const, disposition: node.enabled ? 'foldable' : 'unmarked', summary: node.summary.slice(0, 240) }
        : { ...base, role: node.role, disposition: node.mark.disposition, layers: node.layers.length,
          currentLayer: node.layers.find(layer => layer.text === node.folded)?.id ?? 'original',
          ...(node.mark.disposition === 'foldable' ? { summary: node.mark.summary.slice(0, 240) } : { opening: node.text.slice(0, 100) }),
          ...(node.annotation ? { annotation: { sha256: node.annotation.sha256, label: node.annotation.label.slice(0, 80) } } : {}),
          ...(node.version ? { version: node.version, latestVersion: latest.has(id) } : {}) });
    }
    total++;
    if (depth < (options.parentId !== undefined ? 0 : options.depth ?? (options.recursive ? Infinity : 0))) {
      for (const child of [...childrenOf(node)].sort(compare).reverse()) stack.push({ id: child, depth: depth + 1 });
    }
  }
  return { entries, total, nextOffset: offset + entries.length < total ? offset + entries.length : null };
  // @context-fold end browse-c3d5e9701b
}


export function parentRange(snapshot: Snapshot, id: string) {
  for (const parent of snapshot.entries) {
    const child = parent.annotation?.children?.find(edge => edge.id === id);
    if (child) return { parentId: parent.id, start: child.start, end: child.end, offsetUnit: 'utf16' as const };
  }
  return null;
}

export function nodeMeta(snapshot: Snapshot, node: Node, offset = 0, limit = 20) {
  const children = childrenOf(node);
  const text = 'text' in node ? node.text : JSON.stringify({ id: node.id, summary: node.summary, children });
  return { id: node.id, ...nodeFields(node), parentId: parentIndex(snapshot).get(node.id) ?? null,
    parentRange: parentRange(snapshot, node.id),
    ...('text' in node ? { sourceRanges: (node.annotation?.sourceRanges ?? []).slice(offset, offset + limit),
      nextSourceOffset: offset + limit < (node.annotation?.sourceRanges?.length ?? 0) ? offset + limit : null,
      observedRanges: (node.annotation?.observedRanges ?? []).slice(offset, offset + limit),
      nextObservedOffset: offset + limit < (node.annotation?.observedRanges?.length ?? 0) ? offset + limit : null } : {}),
    chars: text.length, bytes: Buffer.byteLength(text), childCount: children.length,
    children: children.slice(offset, offset + limit), nextOffset: offset + limit < children.length ? offset + limit : null };
}

/** Literal search always reports offsets in read(id)'s original text. */
export function search(snapshot: Snapshot, options: { query: string; id?: string | undefined; recursive?: boolean;
  offset?: number; limit?: number; caseSensitive?: boolean }) {
  const nodes = new Map<string, Node>([...snapshot.entries, ...(snapshot.groups ?? [])].map(node => [node.id, node]));
  const parents = parentIndex(snapshot);
  if (options.id !== undefined && !nodes.has(options.id)) throw new Error('Unknown entry or group');
  const pending = options.id === undefined ? [...nodes.keys()].filter(id => !parents.has(id)).reverse() : [options.id];
  if (!options.query || options.query.length > 2000) throw new Error('Invalid search query');
  const pattern = new RegExp(options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.caseSensitive !== false ? 'gu' : 'giu');
  const offset = options.offset ?? 0; const limit = options.limit ?? 20;
  const matches = []; let total = 0;
  while (pending.length) {
    const node = nodes.get(pending.pop()!)!;
    const text = 'text' in node ? node.text : JSON.stringify({ id: node.id, summary: node.summary, children: node.children });
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const at = match.index; const end = at + match[0].length;
      // An ancestor's full original already contains its children. Prefer the
      // child's hit when that child is also searched, while keeping every occurrence.
      if (options.recursive !== false && 'text' in node
        && node.annotation?.children?.some(child => child.start <= at && end <= child.end)) continue;
      if (total >= offset && matches.length < limit) {
        let start = Math.max(0, at - 40); let stop = Math.min(text.length, start + 200);
        if (start && /[\uDC00-\uDFFF]/.test(text[start]!) && /[\uD800-\uDBFF]/.test(text[start - 1]!)) start--;
        if (stop < text.length && /[\uD800-\uDBFF]/.test(text[stop - 1]!) && /[\uDC00-\uDFFF]/.test(text[stop]!)) stop--;
        matches.push({ id: node.id, ...nodeFields(node), parentId: parents.get(node.id) ?? null,
          offset: at, endOffset: end, excerptOffset: start, excerpt: text.slice(start, stop),
          line: text.slice(0, at).split(/\r\n|\r|\n/).length, layer: 'original' as const });
      }
      total++;
    }
    if (options.recursive !== false) pending.push(...[...childrenOf(node)].reverse());
  }
  return { matches, total, nextOffset: offset + matches.length < total ? offset + matches.length : null, offsetUnit: 'utf16' };
}
