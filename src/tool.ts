import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ScopeConflictError, Store, digest } from './store.js';
import type { Snapshot } from './store.js';
import { addMetrics } from './metrics.js';
import { statistics } from './statistics.js';
import { browse, latestVersions, parentIndex, restoreAncestors } from './tree.js';
import { loadOptions } from './config.js';

const peek = z.boolean().default(false);

const summary = z.string().trim().min(1).max(2000);
const markSchema = z.union([
  z.object({ id: z.string(), disposition: z.literal('foldable'), summary }).strict(),
  z.object({ id: z.string(), disposition: z.enum(['keep', 'unmarked']) }).strict(),
  z.object({ ids: z.array(z.string()).min(2).max(100), disposition: z.literal('foldable'), summary }).strict(),
]);
const scope = z.string().regex(/^[a-f0-9]{64}$/);
const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('stats'), scope: scope.optional() }).strict(),
  z.object({ action: z.literal('list'), scope, id: z.string().optional(), depth: z.number().int().min(0).max(8).default(1),
    query: z.string().max(200).optional(), sort: z.enum(['chronological', 'size', 'id', 'version']).default('chronological'),
    order: z.enum(['asc', 'desc']).default('asc'), offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20) }).strict(),
  z.object({ action: z.literal('mark'), scope, marks: z.array(markSchema).min(1).max(100) }).strict(),
  z.object({ action: z.literal('read'), scope, id: z.string(), layer: z.string().default('original'), peek, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(24000).default(4000) }).strict(),
  z.object({ action: z.literal('paste'), scope, id: z.string(), layer: z.string().default('original'), peek,
    path: z.string().refine(isAbsolute, 'Use an absolute destination path'),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(24000).optional() }).strict(),
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

function applyMarks(snapshot: Snapshot, marks: z.infer<typeof markSchema>[]) {
  // Stage the whole batch, including groups created earlier in this same batch.
  const next = structuredClone(snapshot);
  const entries = new Map(next.entries.map(entry => [entry.id, entry]));
  const groups = new Map((next.groups ?? []).map(group => [group.id, group]));
  const latest = latestVersions(next);
  const created: string[] = [];
  let restored = 0;
  for (const mark of marks) {
    if ('ids' in mark) {
      if (new Set(mark.ids).size !== mark.ids.length) throw new ToolError('Group children must be distinct; no marks changed');
      const id = `g-${digest(JSON.stringify([mark.ids, mark.summary])).slice(0, 24)}`;
      const existing = groups.get(id);
      if (existing && (existing.summary !== mark.summary || JSON.stringify(existing.children) !== JSON.stringify(mark.ids))) {
        throw new ToolError('Group ID collision; no marks changed');
      }
      const parents = parentIndex(next);
      for (const child of mark.ids) {
        if (!entries.has(child) && !groups.has(child)) throw new ToolError('Unknown entry or group; no marks changed');
        if (!existing && parents.has(child)) throw new ToolError('Group member already has a parent; no marks changed');
      }
      const pending = [...mark.ids];
      while (pending.length) {
        const child = pending.pop()!;
        const group = groups.get(child);
        if (group) { pending.push(...group.children); continue; }
        const entry = entries.get(child)!;
        if (entry.role === 'user' || entry.mark.disposition === 'keep' || latest.has(child)) {
          throw new ToolError('Protected entry cannot be grouped; no marks changed');
        }
      }
      if (!existing) {
        const group = { id, children: [...mark.ids], summary: mark.summary, enabled: true };
        (next.groups ??= []).push(group);
        groups.set(id, group);
      } else existing.enabled = true;
      created.push(id);
      continue;
    }
    const entry = entries.get(mark.id);
    const group = groups.get(mark.id);
    if (!entry && !group) throw new ToolError('Unknown entry or group; no marks changed');
    if (entry) {
      entry.manual = true;
      if (entry.version) entry.version.automatic = false;
      entry.mark = mark.disposition === 'foldable'
        ? { disposition: 'foldable', summary: mark.summary }
        : { disposition: mark.disposition };
      if (mark.disposition !== 'foldable') {
        if (entry.folded !== undefined) restored++;
        delete entry.folded;
      }
    } else if (group) {
      group.enabled = mark.disposition === 'foldable';
      if (mark.disposition === 'foldable') group.summary = mark.summary;
      else {
        if (group.folded !== undefined) restored++;
        delete group.folded;
      }
    }
    if (mark.disposition !== 'foldable') restored += restoreAncestors(next, mark.id);
  }
  next.metrics = addMetrics(next.metrics, { itemsRestored: restored });
  snapshot.entries = next.entries;
  if (next.groups !== undefined) snapshot.groups = next.groups;
  snapshot.metrics = next.metrics;
  return { marked: marks.length, ...(created.length ? { groups: created } : {}),
    pending: marks.some(mark => mark.disposition === 'foldable'),
    message: 'Marks saved atomically. Foldable items await the next request: one batch, threshold and full-request shrink check; configured accounting also requires cost approval.' };
}

export async function execute(input: unknown): Promise<string> {
  const parsed = argsSchema.safeParse(input);
  if (!parsed.success) return JSON.stringify({ error: 'Invalid context_folding arguments', details: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })) });
  const args = parsed.data;
  try {
    if (args.action === 'stats') return JSON.stringify(await statistics(args.scope));
    const store = new Store();
    if (args.action === 'read' || args.action === 'paste') {
      const recover = () => store.transaction(args.scope, false, 64 * 1024 * 1024, snapshot => {
        let entry = snapshot.entries.find(entry => entry.id === args.id);
        const group = snapshot.groups?.find(group => group.id === args.id);
        if (!entry && !group) throw new ToolError('Unknown entry or group');
        if (group && args.layer !== 'original') throw new ToolError('Groups expose only the original manifest');
        const layer = args.layer === 'original' ? undefined : entry?.layers.find(layer => layer.id === args.layer);
        if (args.layer !== 'original' && !layer) throw new ToolError('Unknown layer');
        const text = group ? JSON.stringify({ id: group.id, summary: group.summary, children: group.children }) : layer?.text ?? entry!.text;
        if (args.offset > text.length) throw new ToolError('Offset exceeds archived text length');
        const end = args.limit === undefined ? text.length : Math.min(text.length, args.offset + args.limit);
        if (args.action === 'paste' && (splitsPair(text, args.offset) || splitsPair(text, end))) {
          throw new ToolError('Paste range splits a Unicode character');
        }
        // Protect the source itself and every enclosing group, including historical-layer reads.
        if (!args.peek) {
          applyMarks(snapshot, [{ id: args.id, disposition: 'keep' }]);
          entry = snapshot.entries.find(entry => entry.id === args.id);
        }
        return {
          id: args.id, layer: args.layer, previousId: layer?.previousId ?? null, kept: !args.peek,
          currentLayer: args.peek ? entry?.layers.find(layer => layer.text === entry.folded)?.id ?? 'original' : 'original',
          ...(entry?.version ? { version: entry.version, latestVersion: latestVersions(snapshot).has(entry.id) } : {}),
          text: text.slice(args.offset, end), offset: args.offset,
          nextOffset: end < text.length ? end : null, totalChars: text.length, sha256: digest(text),
        };
      });
      // Re-read current state and reapply keep; file creation stays outside retries.
      const source = await retryArchiveRead(recover);
      if (args.action === 'paste') {
        // Exclusive creation also refuses symlinks and never truncates an existing destination.
        await writeFile(args.path, source.text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        return JSON.stringify({ id: source.id, layer: source.layer, kept: source.kept, path: args.path, offset: source.offset,
          nextOffset: source.nextOffset, chars: source.text.length, bytes: Buffer.byteLength(source.text), sha256: digest(source.text),
          ...(source.version ? { version: source.version, latestVersion: source.latestVersion } : {}) });
      }
      try {
        await store.recordMetrics(args.scope, {
          ...(args.layer === 'original' ? { originalReadCalls: 1 } : { layerReadCalls: 1 }), readChars: source.text.length,
        });
      } catch {
        // Recovery must remain available even when statistics cannot grow or commit.
      }
      return JSON.stringify(source);
    }
    const maxBytes = args.action === 'mark' && args.marks.some(mark => mark.disposition === 'foldable')
      ? (await loadOptions()).maxSessionBytes : 64 * 1024 * 1024;
    const operation = () => store.transaction(args.scope, false, maxBytes, (snapshot) => {
      switch (args.action) {
        case 'list': return browse(snapshot, args);
        case 'mark': return applyMarks(snapshot, args.marks);
        case 'status': return { entries: snapshot.entries.length, groups: snapshot.groups?.length ?? 0,
          folded: snapshot.entries.filter(entry => entry.folded !== undefined).length + (snapshot.groups ?? []).filter(group => group.folded !== undefined).length,
          decision: snapshot.decision, metrics: snapshot.metrics };
        case 'forget': {
          if (snapshot.entries.some(entry => entry.folded !== undefined) || snapshot.groups?.some(group => group.folded !== undefined)) {
            throw new ToolError('Restore folded entries and groups with mark keep before forgetting recovery data');
          }
          // Explicit scope disposal; future requests may archive the client's original history again.
          snapshot.entries = [];
          delete snapshot.groups;
          snapshot.decision = { reason: 'explicitly-forgotten' };
          return { forgotten: true };
        }
      }
    });
    const result = args.action === 'list' || args.action === 'status'
      ? await retryArchiveRead(operation) : await operation();
    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({ error: diagnostic(error) });
  }
}
