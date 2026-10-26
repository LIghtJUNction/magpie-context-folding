import type { Entry, Snapshot } from './store.js';

type Group = NonNullable<Snapshot['groups']>[number];
type Node = Entry | Group;

export interface BrowseOptions {
  id?: string | undefined;
  depth?: number;
  query?: string | undefined;
  sort?: 'chronological' | 'size' | 'id' | 'version';
  order?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

export function parentIndex(snapshot: Snapshot): Map<string, string> {
  const parents = new Map<string, string>();
  for (const group of snapshot.groups ?? []) {
    for (const child of group.children) parents.set(child, group.id);
  }
  return parents;
}

/** Explicit restoration must also release every enclosing fold. */
export function restoreAncestors(snapshot: Snapshot, id: string): number {
  const parents = parentIndex(snapshot);
  const groups = new Map((snapshot.groups ?? []).map(group => [group.id, group]));
  let restored = 0;
  let parent = parents.get(id);
  while (parent !== undefined) {
    const group = groups.get(parent)!;
    if (group.folded !== undefined) restored++;
    group.enabled = false;
    delete group.folded;
    parent = parents.get(parent);
  }
  return restored;
}

export function latestVersions(snapshot: Snapshot): Set<string> {
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
}

/** A bounded, flat preorder traversal; pagination counts groups and entries alike. */
export function browse(snapshot: Snapshot, options: BrowseOptions = {}) {
  const nodes = new Map<string, Node>([...snapshot.entries, ...(snapshot.groups ?? [])].map(node => [node.id, node]));
  if (options.id !== undefined && !nodes.has(options.id)) throw new Error(`Unknown entry or group ${options.id}`);
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
  const query = options.query?.toLowerCase();
  const included = query ? new Set<string>() : undefined;
  if (included) {
    for (const node of nodes.values()) {
      const text = 'children' in node ? node.summary : [node.id, node.version?.path ?? '',
        node.mark.disposition === 'foldable' ? node.mark.summary : '', node.text].join('\n');
      if (!text.toLowerCase().includes(query!)) continue;
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
  const roots = options.id === undefined ? [...nodes.keys()].filter(id => !parents.has(id)) : [options.id];
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
      const base = { id, parentId: parents.get(id) ?? null, depth, childCount: 'children' in node ? node.children.length : 0,
        chars: metadata.get(id)!.size, folded: node.folded !== undefined };
      entries.push('children' in node
        ? { ...base, role: 'group' as const, disposition: node.enabled ? 'foldable' : 'unmarked', summary: node.summary.slice(0, 240) }
        : { ...base, role: node.role, disposition: node.mark.disposition, layers: node.layers.length,
          currentLayer: node.layers.find(layer => layer.text === node.folded)?.id ?? 'original',
          ...(node.mark.disposition === 'foldable' ? { summary: node.mark.summary.slice(0, 240) } : { opening: node.text.slice(0, 100) }),
          ...(node.version ? { version: node.version, latestVersion: latest.has(id) } : {}) });
    }
    total++;
    if ('children' in node && depth < (options.depth ?? 1)) {
      for (const child of [...node.children].sort(compare).reverse()) stack.push({ id: child, depth: depth + 1 });
    }
  }
  return { entries, total, nextOffset: offset + entries.length < total ? offset + entries.length : null };
}
