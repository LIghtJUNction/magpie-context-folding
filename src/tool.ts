import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { Store, digest } from './store.js';
import { addMetrics } from './metrics.js';
import { statistics } from './statistics.js';

const markSchema = z.discriminatedUnion('disposition', [
  z.object({ id: z.string(), disposition: z.literal('foldable'), summary: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ id: z.string(), disposition: z.enum(['keep', 'unmarked']) }).strict(),
]);
const scope = z.string().regex(/^[a-f0-9]{64}$/);
const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('stats'), scope: scope.optional() }).strict(),
  z.object({ action: z.literal('list'), scope, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(30) }).strict(),
  z.object({ action: z.literal('mark'), scope, marks: z.array(markSchema).min(1).max(100) }).strict(),
  z.object({ action: z.literal('read'), scope, id: z.string(), layer: z.string().default('original'), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(24000).default(12000) }).strict(),
  z.object({ action: z.literal('paste'), scope, id: z.string(), layer: z.string().default('original'),
    path: z.string().refine(isAbsolute, 'Use an absolute destination path'),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(24000).optional() }).strict(),
  z.object({ action: z.literal('status'), scope }).strict(),
  z.object({ action: z.literal('forget'), scope }).strict(),
]);

function splitsPair(text: string, offset: number): boolean {
  return offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[offset] ?? '');
}

export async function execute(input: unknown): Promise<string> {
  const parsed = argsSchema.safeParse(input);
  if (!parsed.success) return JSON.stringify({ error: 'Invalid context_folding arguments', details: parsed.error.issues });
  const args = parsed.data;
  try {
    if (args.action === 'stats') return JSON.stringify(await statistics(args.scope));
    const store = new Store();
    if (args.action === 'read' || args.action === 'paste') {
      const source = await store.transaction(args.scope, false, 64 * 1024 * 1024, snapshot => {
        const entry = snapshot.entries.find(entry => entry.id === args.id);
        if (!entry) throw new Error('Unknown entry');
        const layer = args.layer === 'original' ? undefined : entry.layers.find(layer => layer.id === args.layer);
        if (args.layer !== 'original' && !layer) throw new Error('Unknown layer');
        const text = layer?.text ?? entry.text;
        if (args.offset > text.length) throw new Error('Offset exceeds archived text length');
        const end = args.limit === undefined ? text.length : Math.min(text.length, args.offset + args.limit);
        if (args.action === 'paste' && (splitsPair(text, args.offset) || splitsPair(text, end))) {
          throw new Error('Paste range splits a Unicode character');
        }
        return {
          id: entry.id, layer: args.layer, previousId: layer?.previousId ?? null,
          currentLayer: entry.layers.find(layer => layer.text === entry.folded)?.id ?? 'original',
          text: text.slice(args.offset, end), offset: args.offset,
          nextOffset: end < text.length ? end : null, totalChars: text.length, sha256: digest(text),
        };
      });
      if (args.action === 'paste') {
        // Exclusive creation also refuses symlinks and never truncates an existing destination.
        await writeFile(args.path, source.text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        return JSON.stringify({ id: source.id, layer: source.layer, path: args.path, offset: source.offset,
          nextOffset: source.nextOffset, chars: source.text.length, bytes: Buffer.byteLength(source.text), sha256: digest(source.text) });
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
    const result = await store.transaction(args.scope, false, 64 * 1024 * 1024, (snapshot) => {
      switch (args.action) {
        case 'list': return {
          entries: snapshot.entries.slice(args.offset, args.offset + args.limit).map(entry => ({
            id: entry.id, role: entry.role, chars: entry.text.length,
            disposition: entry.mark.disposition, opening: entry.text.slice(0, 100),
            folded: entry.folded !== undefined,
            layers: entry.layers.map(layer => ({ id: layer.id, previousId: layer.previousId, chars: layer.text.length })),
          })),
          total: snapshot.entries.length,
          nextOffset: args.offset + args.limit < snapshot.entries.length ? args.offset + args.limit : null,
        };
        case 'mark': {
          const updates = args.marks.map(mark => {
            const entry = snapshot.entries.find(entry => entry.id === mark.id);
            if (!entry) throw new Error(`Unknown entry ${mark.id}; no marks changed`);
            return { entry, mark };
          });
          for (const { entry, mark } of updates) {
            if (entry.folded !== undefined && mark.disposition !== 'foldable') {
              snapshot.metrics = addMetrics(snapshot.metrics, { itemsRestored: 1 });
            }
            entry.mark = mark.disposition === 'foldable'
              ? { disposition: 'foldable', summary: mark.summary }
              : { disposition: mark.disposition };
            // Pinning a folded entry explicitly restores its original on the next request.
            if (mark.disposition !== 'foldable') delete entry.folded;
          }
          return { marked: updates.length, message: 'Applied atomically. Eligible entries fold only after threshold and cost proof pass.' };
        }
        case 'status': return { entries: snapshot.entries.length, folded: snapshot.entries.filter(entry => entry.folded).length, decision: snapshot.decision, metrics: snapshot.metrics };
        case 'forget': {
          if (snapshot.entries.some(entry => entry.folded !== undefined)) {
            throw new Error('Restore folded entries with mark keep before forgetting recovery data');
          }
          // Explicit scope disposal; future requests may archive the client's original history again.
          snapshot.entries = [];
          snapshot.decision = { reason: 'explicitly-forgotten' };
          return { forgotten: true };
        }
      }
    });
    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Context archive unavailable' });
  }
}
