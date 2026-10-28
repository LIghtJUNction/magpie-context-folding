import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ScopeConflictError, Store, digest } from './store.js';
import type { Snapshot } from './store.js';
import { addMetrics } from './metrics.js';
import { statistics } from './statistics.js';
import { archiveView, browse, grep, latestVersions, nodeMeta, physicalLines, versionMetadata } from './tree.js';

const peek = z.boolean().default(true); // Explicit false remains an opt-in restore.
const serialize = (value: object): string => JSON.stringify({ ...value, _contextFolding: 'control-result' });

const scope = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1);
const lineRange = { startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() };
const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('stats'), scope: scope.optional() }).strict(),
  z.object({ action: z.literal('list'), scope, id: id.optional(), depth: z.number().int().min(0).max(64).optional(),
    recursive: z.boolean().default(false), query: z.string().max(200).optional(), sort: z.enum(['chronological', 'size', 'id', 'version']).default('chronological'),
    order: z.enum(['asc', 'desc']).default('asc'), offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(10) }).strict(),
  z.object({ action: z.literal('grep'), scope, id: id.optional(), query: z.string().min(1).max(200),
    recursive: z.boolean().default(true), caseSensitive: z.boolean().default(false),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(10) }).strict(),
  z.object({ action: z.literal('meta'), scope, id, offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(10) }).strict(),
  z.object({ action: z.literal('read'), scope, id, layer: z.string().default('view'), peek, ...lineRange,
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(24000).default(1200) }).strict(),
  z.object({ action: z.literal('paste'), scope, id, layer: z.string().default('view'), peek, ...lineRange,
    path: z.string().refine(isAbsolute, 'Use an absolute destination path'),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(24000).optional() }).strict(),
  z.object({ action: z.literal('status'), scope }).strict(),
  z.object({ action: z.literal('forget'), scope, force: z.boolean().default(false) }).strict(),
]);

class ToolError extends Error {}

async function retryArchiveRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      if (!(error instanceof ScopeConflictError) || attempt >= 2) throw error;
    }
  }
}

/** Never expose OS paths, capabilities, parser input or archived text in diagnostics. */
export function diagnostic(error: unknown): string {
  if (error instanceof ToolError) return error.message;
  if (error instanceof Error && [
    'Unknown context scope', 'Context scope changed concurrently; retry request',
    'Session archive full; original request retained', 'Global archive full; original request retained',
  ].includes(error.message)) return error.message;
  return 'Context archive unavailable; check settings, archive access and destination permissions';
}

function splitsPair(text: string, offset: number): boolean {
  return offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[offset] ?? '');
}

/** Exact legacy IDs win over hash prefixes. Identical content aliases are one result. */
function resolveEntry(snapshot: Snapshot, id: string) {
  // @context-fold begin resolveEntry-db244eec2c
  const exact = snapshot.entries.find(entry => entry.id === id);
  if (exact || snapshot.groups?.some(group => group.id === id)) return { id, aliases: exact ? [exact] : [] };
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new ToolError('Unknown entry or group; hash prefixes require at least 12 hex digits');
  const aliases = snapshot.entries.filter(entry => entry.annotation?.sha256.startsWith(id));
  const first = aliases[0];
  if (!first) throw new ToolError('Unknown entry or group');
  if (aliases.some(entry => entry.annotation!.sha256 !== first.annotation!.sha256 || entry.text !== first.text)) {
    throw new ToolError('Ambiguous content hash prefix; provide more hex digits or an exact archive ID');
  }
  return { id: first.id, aliases };
  // @context-fold end resolveEntry-db244eec2c
}

/** Explicit restoration protects the selected subtree and every enclosing fold. */
function keepExpanded(snapshot: Snapshot, id: string): void {
  // @context-fold begin keepExpanded-validated-subtree
  const entries = new Map(snapshot.entries.map(entry => [entry.id, entry]));
  const groups = new Map((snapshot.groups ?? []).map(group => [group.id, group]));
  const selected = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const current = pending.pop()!;
    if (selected.has(current)) continue;
    selected.add(current);
    pending.push(...entries.get(current)?.annotation?.children?.map(child => child.id) ?? []);
    pending.push(...groups.get(current)?.children ?? []);
  }
  const descendants = new Set(selected);
  const parents = new Map<string, string[]>();
  for (const node of [...snapshot.entries, ...(snapshot.groups ?? [])]) {
    const children = 'children' in node ? node.children : node.annotation?.children?.map(child => child.id) ?? [];
    for (const child of children) parents.set(child, [...parents.get(child) ?? [], node.id]);
  }
  pending.push(...selected);
  while (pending.length) for (const parent of parents.get(pending.pop()!) ?? []) {
    if (!selected.has(parent)) { selected.add(parent); pending.push(parent); }
  }
  let restored = 0;
  for (const selectedId of selected) {
    const entry = entries.get(selectedId);
    if (entry && (descendants.has(selectedId) || !groups.has(id))) {
      if (entry.folded !== undefined) restored++;
      entry.mark = { disposition: 'keep' };
      entry.manual = true;
      if (entry.version) entry.version.automatic = false;
      delete entry.folded;
      delete entry.foldedMark;
      for (const occurrence of Object.values(entry.occurrences ?? {})) delete occurrence.folded;
    }
    const group = groups.get(selectedId);
    if (group) {
      if (group.folded !== undefined) restored++;
      group.enabled = false;
      delete group.folded;
      delete group.foldedMark;
    }
  }
  snapshot.metrics = addMetrics(snapshot.metrics, { itemsRestored: restored });
  // @context-fold end keepExpanded-validated-subtree
}

/** Report numeric bounds without exposing supplied text or arbitrary Zod messages. */
function validationDetails(error: z.ZodError, input: unknown) {
  // @context-fold begin validationDetails-22f687fb19
  const details: { path: PropertyKey[]; code: string; limit?: number | bigint; actual?: number;
    unit?: string }[] = [];
  const visit = (issues: readonly z.core.$ZodIssue[], prefix: PropertyKey[] = []) => {
    for (const issue of issues) {
      const path = [...prefix, ...issue.path];
      if (issue.code === 'invalid_union') {
        for (const branch of issue.errors) visit(branch, path);
        continue;
      }
      const detail: typeof details[number] = { path, code: issue.code };
      if (issue.code === 'too_big' || issue.code === 'too_small') {
        let value = input;
        for (const key of path) value = value !== null && typeof value === 'object'
          ? (value as Record<PropertyKey, unknown>)[key] : undefined;
        const limit = issue.code === 'too_big' ? issue.maximum : issue.minimum;
        detail.limit = limit;
        if (typeof value === 'string') {
          detail.actual = [...value].length;
          detail.unit = 'Unicode code points';
        } else if (Array.isArray(value)) {
          detail.actual = value.length;
          detail.unit = 'items';
        } else if (typeof value === 'number') {
          detail.actual = value;
          detail.unit = 'value';
        }
      }
      if (!details.some(previous => JSON.stringify(previous) === JSON.stringify(detail))) details.push(detail);
    }
  };
  visit(error.issues);
  return details;
  // @context-fold end validationDetails-22f687fb19
}

export async function execute(input: unknown): Promise<string> {
  // @context-fold begin execute-29367cef4c
  const parsed = argsSchema.safeParse(input);
  if (!parsed.success) return serialize({ error: 'Invalid context_folding arguments', details: validationDetails(parsed.error, input) });
  const args = parsed.data;
  try {
    if (args.action === 'stats') return serialize(await statistics(args.scope));
    const store = new Store();
    if (args.action === 'read' || args.action === 'paste') {
      const recover = () => store.transaction(args.scope, false, 64 * 1024 * 1024, snapshot => {
        const resolved = resolveEntry(snapshot, args.id);
        const entry = snapshot.entries.find(entry => entry.id === resolved.id);
        const group = snapshot.groups?.find(group => group.id === resolved.id);
        if (!entry && !group) throw new ToolError('Unknown entry or group');
        if (group && args.layer !== 'original' && args.layer !== 'view') throw new ToolError('Groups expose only the original manifest');
        const layer = args.layer === 'original' || args.layer === 'view' ? undefined : entry?.layers.find(layer => layer.id === args.layer);
        if (args.layer !== 'original' && args.layer !== 'view' && !layer) throw new ToolError('Unknown layer');
        const original = group ? archiveView(snapshot, group) : layer?.text ?? entry!.text;
        const text = args.layer === 'view' ? archiveView(snapshot, entry ?? group!) : original;
        const lines = physicalLines(text);
        let offset = args.offset;
        let stop = text.length;
        if (args.startLine !== undefined || args.endLine !== undefined) {
          if (Object.hasOwn(input as object, 'offset')) throw new ToolError('Use either offset or a line range');
          const first = args.startLine ?? 1;
          const last = args.endLine ?? Math.max(1, lines.length);
          if (first > Math.max(1, lines.length) || last < first) throw new ToolError('Invalid view line range');
          offset = lines[first - 1]?.start ?? 0;
          stop = lines[Math.min(last, lines.length) - 1]?.end ?? 0;
        }
        if (offset > text.length) throw new ToolError('Offset exceeds archived text length');
        let end = args.limit === undefined ? stop : Math.min(stop, offset + args.limit);
        if (splitsPair(text, offset) || (args.action === 'paste' && splitsPair(text, end))) throw new ToolError('Query range splits a Unicode character');
        if (splitsPair(text, end)) end += end === offset + 1 ? 1 : -1;
        if (end === offset && stop > offset) throw new ToolError('Limit is too small for the next Unicode character');
        if (!args.peek) {
          if (resolved.aliases.length) for (const alias of resolved.aliases) keepExpanded(snapshot, alias.id);
          else keepExpanded(snapshot, resolved.id);
        }
        return {
          id: resolved.id, kept: !args.peek, label: (entry?.annotation?.label ?? '').slice(0, 80), layer: args.layer,
          ...(layer ? { previousId: layer.previousId } : {}),
          ...(entry?.version ? { version: versionMetadata(entry.version), latestVersion: latestVersions(snapshot).has(entry.id) } : {}),
          text: text.slice(offset, end), offset, nextOffset: end < stop ? end : null, totalChars: text.length,
          totalLines: lines.length,
          startLine: end > offset ? Math.max(0, lines.findIndex(line => line.end > offset)) + 1 : 0,
          endLine: end > offset ? Math.max(0, lines.findIndex(line => line.end >= end)) + 1 : 0,
          sha256: digest(original), viewSha256: digest(text), offsetUnit: 'utf16',
        };
      }, undefined, 'preserve');
      const source = await retryArchiveRead(recover);
      if (args.action === 'paste') {
        await writeFile(args.path, source.text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        return serialize({ id: source.id, layer: source.layer, path: args.path, offset: source.offset,
          nextOffset: source.nextOffset, chars: source.text.length, bytes: Buffer.byteLength(source.text), sha256: digest(source.text) });
      }
      try {
        await store.recordMetrics(args.scope, {
          ...(args.layer === 'original' || args.layer === 'view' ? { originalReadCalls: 1 } : { layerReadCalls: 1 }), readChars: source.text.length,
        });
      } catch { /* Queries remain available when usage statistics cannot commit. */ }
      return serialize(source);
    }
    const operation = () => store.transaction(args.scope, false, 64 * 1024 * 1024, (snapshot) => {
      switch (args.action) {
        case 'list': return browse(snapshot, { ...args, ...(args.id ? { id: resolveEntry(snapshot, args.id).id } : {}) });
        case 'grep': return grep(snapshot, { ...args, ...(args.id ? { id: resolveEntry(snapshot, args.id).id } : {}) });
        case 'meta': {
          const id = resolveEntry(snapshot, args.id).id;
          const node = snapshot.entries.find(entry => entry.id === id) ?? snapshot.groups?.find(group => group.id === id);
          if (!node) throw new ToolError('Unknown entry or group');
          return nodeMeta(snapshot, node, args.offset, args.limit);
        }
        case 'status': return { entries: snapshot.entries.length, groups: snapshot.groups?.length ?? 0,
          folded: snapshot.entries.filter(entry => entry.folded !== undefined).length + (snapshot.groups ?? []).filter(group => group.folded !== undefined).length,
          cycle: snapshot.cycle ?? 0 };
        case 'forget': {
          if (!args.force && (snapshot.entries.some(entry => entry.folded !== undefined) || snapshot.groups?.some(group => group.folded !== undefined))) {
            throw new ToolError('Folded references still depend on this archive; force=true explicitly discards their originals');
          }
          // Explicit scope disposal; future requests may archive the client's original history again.
          snapshot.entries = [];
          delete snapshot.groups;
          snapshot.decision = { reason: 'explicitly-forgotten' };
          return { forgotten: true };
        }
      }
    }, undefined, 'preserve');
    const result = args.action !== 'forget'
      ? await retryArchiveRead(operation) : await operation();
    return serialize(result);
  } catch (error) {
    return serialize({ error: diagnostic(error) });
  }
  // @context-fold end execute-29367cef4c
}
