import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ScopeConflictError, Store, digest } from './store.js';
import type { Snapshot } from './store.js';
import { addMetrics } from './metrics.js';
import { statistics } from './statistics.js';
import { browse, latestVersions, nodeFields, nodeMeta, parentIndex, parentRange, restoreAncestors, search } from './tree.js';

const peek = z.boolean().default(true);
const restore = z.boolean().default(false);
const serialize = (value: object): string => JSON.stringify({ ...value, _contextFolding: 'control-result' });

const scope = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1);
const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('stats'), scope: scope.optional() }).strict(),
  z.object({ action: z.literal('list'), scope, id: id.optional(), parentId: id.optional(), recursive: z.boolean().default(false), depth: z.number().int().min(0).max(64).optional(),
    query: z.string().max(200).optional(), sort: z.enum(['chronological', 'size', 'id', 'version']).default('chronological'),
    order: z.enum(['asc', 'desc']).default('asc'), offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20) }).strict(),
  z.object({ action: z.literal('read'), scope, id, layer: z.string().default('original'), peek, restore, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(24000).default(4000) }).strict(),
  z.object({ action: z.literal('paste'), scope, id, layer: z.string().default('original'), peek, restore,
    path: z.string().refine(isAbsolute, 'Use an absolute destination path'),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(24000).optional() }).strict(),
  z.object({ action: z.enum(['search', 'grep']), scope, id: id.optional(), query: z.string().min(1).max(2000),
    recursive: z.boolean().default(true), caseSensitive: z.boolean().default(true),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).strict(),
  z.object({ action: z.literal('meta'), scope, id, offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20) }).strict(),
  z.object({ action: z.literal('status'), scope }).strict(),
  z.object({ action: z.literal('forget'), scope }).strict(),
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
function resolveEntry(snapshot: Snapshot, id: string, requireNode = false) {
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
  if (requireNode && aliases.length > 1) throw new ToolError('Content hash matches multiple occurrences; use an exact node ID from list');
  return { id: first.id, aliases };
  // @context-fold end resolveEntry-db244eec2c
}

/** Recovery is deliberately independent of current configuration and folding policy. */
function keepExpanded(snapshot: Snapshot, id: string): void {
  // @context-fold begin keepExpanded-21cffb3d7c
  const entry = snapshot.entries.find(entry => entry.id === id);
  const group = snapshot.groups?.find(group => group.id === id);
  let restored = 0;
  if (entry) {
    if (entry.folded !== undefined) restored++;
    entry.mark = { disposition: 'keep' };
    entry.manual = true;
    if (entry.version) entry.version.automatic = false;
    delete entry.folded;
    delete entry.foldedMark;
    for (const occurrence of Object.values(entry.occurrences ?? {})) delete occurrence.folded;
  }
  if (group) {
    if (group.folded !== undefined) restored++;
    group.enabled = false;
    delete group.folded;
    delete group.foldedMark;
  }
  restored += restoreAncestors(snapshot, id);
  snapshot.metrics = addMetrics(snapshot.metrics, { itemsRestored: restored });
  // @context-fold end keepExpanded-21cffb3d7c
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
      const recover = () => {
        const run = (snapshot: Snapshot) => {
          const resolved = resolveEntry(snapshot, args.id);
          const entry = snapshot.entries.find(entry => entry.id === resolved.id);
          const group = snapshot.groups?.find(group => group.id === resolved.id);
          if (!entry && !group) throw new ToolError('Unknown entry or group');
          if (group && args.layer !== 'original') throw new ToolError('Groups expose only the original manifest');
          const layer = args.layer === 'original' ? undefined : entry?.layers.find(layer => layer.id === args.layer);
          if (args.layer !== 'original' && !layer) throw new ToolError('Unknown layer');
          const text = group ? JSON.stringify({ id: group.id, summary: group.summary, children: group.children }) : layer?.text ?? entry!.text;
          if (args.offset > text.length) throw new ToolError('Offset exceeds archived text length');
          let end = args.limit === undefined ? text.length : Math.min(text.length, args.offset + args.limit);
          if (args.action === 'paste' && (splitsPair(text, args.offset) || splitsPair(text, end))) {
            throw new ToolError('Paste range splits a Unicode character');
          }
          if (args.action === 'read') {
            if (splitsPair(text, args.offset)) throw new ToolError('Read offset splits a Unicode character');
            // UTF-16 offsets remain explicit, but each raw page must encode without
            // turning half an emoji into U+FFFD. A one-unit page still makes progress.
            if (splitsPair(text, end)) end += end === args.offset + 1 ? 1 : -1;
          }
          // Protect the source itself and every enclosing group, including historical-layer reads.
          const restoring = args.restore || !args.peek;
          if (restoring) {
            if (resolved.aliases.length) for (const alias of resolved.aliases) keepExpanded(snapshot, alias.id);
            else keepExpanded(snapshot, resolved.id);
          }
          return {
            id: resolved.id, ...nodeFields(entry ?? group!), parentId: resolved.aliases.length > 1 ? null : parentIndex(snapshot).get(resolved.id) ?? null,
            ...(resolved.aliases.length > 1 ? { ambiguousOccurrence: true, sourceRange: null, sourceRanges: [], sourceRangeCount: 0,
              observedRanges: [], observedRangeCount: 0 } : {}),
            matchingNodeIds: resolved.aliases.slice(0, 20).map(alias => alias.id), matchingNodeCount: resolved.aliases.length,
            parentRange: resolved.aliases.length > 1 ? null : parentRange(snapshot, resolved.id),
            layer: args.layer, previousId: layer?.previousId ?? null, kept: restoring,
            currentLayer: !restoring ? entry?.layers.find(layer => layer.text === entry.folded)?.id ?? 'original' : 'original',
            ...(entry?.version ? { version: entry.version, latestVersion: latestVersions(snapshot).has(entry.id) } : {}),
            text: text.slice(args.offset, end), offset: args.offset,
            nextOffset: end < text.length ? end : null, totalChars: text.length, sha256: digest(text),
          };
        };
        return args.restore || !args.peek
          ? store.transaction(args.scope, false, 64 * 1024 * 1024, run, undefined, 'preserve')
          : store.inspect(args.scope, run);
      };
      // Re-read current state and reapply keep; file creation stays outside retries.
      const source = await retryArchiveRead(recover);
      if (args.action === 'paste') {
        // Exclusive creation also refuses symlinks and never truncates an existing destination.
        await writeFile(args.path, source.text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        return serialize({ id: source.id, layer: source.layer, kept: source.kept, path: args.path, offset: source.offset,
          nextOffset: source.nextOffset, chars: source.text.length, bytes: Buffer.byteLength(source.text), sha256: digest(source.text),
          ...(source.version ? { version: source.version, latestVersion: source.latestVersion } : {}) });
      }
      if (args.restore || !args.peek) {
        try {
          await store.recordMetrics(args.scope, {
            ...(args.layer === 'original' ? { originalReadCalls: 1 } : { layerReadCalls: 1 }), readChars: source.text.length,
          });
        } catch {
          // Explicit restoration remains available when statistics cannot commit.
        }
      }
      return serialize(source);
    }
    const run = (snapshot: Snapshot) => {
      switch (args.action) {
        case 'list': {
          if (args.id && args.parentId) throw new ToolError('Use either id or parentId');
          return browse(snapshot, { ...args,
            ...(args.id ? { id: resolveEntry(snapshot, args.id, true).id } : {}),
            ...(args.parentId ? { parentId: resolveEntry(snapshot, args.parentId, true).id } : {}) });
        }
        case 'search': case 'grep': return search(snapshot, { ...args,
          ...(args.id ? { id: resolveEntry(snapshot, args.id, true).id } : {}) });
        case 'meta': {
          const resolved = resolveEntry(snapshot, args.id, true);
          const node = snapshot.entries.find(entry => entry.id === resolved.id) ?? snapshot.groups?.find(group => group.id === resolved.id);
          if (!node) throw new ToolError('Unknown entry or group');
          return nodeMeta(snapshot, node, args.offset, args.limit);
        }
        case 'status': return { entries: snapshot.entries.length, groups: snapshot.groups?.length ?? 0,
          folded: snapshot.entries.filter(entry => entry.folded !== undefined).length + (snapshot.groups ?? []).filter(group => group.folded !== undefined).length,
          decision: snapshot.decision, metrics: snapshot.metrics };
        case 'forget': {
          if (snapshot.entries.some(entry => entry.folded !== undefined) || snapshot.groups?.some(group => group.folded !== undefined)) {
            throw new ToolError('Restore folded entries and group manifests explicitly before forgetting recovery data');
          }
          // Explicit scope disposal; future requests may archive the client's original history again.
          snapshot.entries = [];
          delete snapshot.groups;
          snapshot.decision = { reason: 'explicitly-forgotten' };
          return { forgotten: true };
        }
      }
    };
    const operation = () => args.action === 'forget'
      ? store.transaction(args.scope, false, 64 * 1024 * 1024, run, undefined, 'preserve')
      : store.inspect(args.scope, run);
    const result = args.action !== 'forget'
      ? await retryArchiveRead(operation) : await operation();
    return serialize(result);
  } catch (error) {
    return serialize({ error: diagnostic(error) });
  }
  // @context-fold end execute-29367cef4c
}
