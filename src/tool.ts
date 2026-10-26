import { z } from 'zod';
import { Store, digest } from './store.js';

const markSchema = z.discriminatedUnion('disposition', [
  z.object({ id: z.string(), disposition: z.literal('foldable'), summary: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ id: z.string(), disposition: z.enum(['keep', 'unmarked']) }).strict(),
]);
const scope = z.string().regex(/^[a-f0-9]{64}$/);
const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), scope, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(30) }).strict(),
  z.object({ action: z.literal('mark'), scope, marks: z.array(markSchema).min(1).max(100) }).strict(),
  z.object({ action: z.literal('read'), scope, id: z.string(), layer: z.string().default('original'), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(24000).default(12000) }).strict(),
  z.object({ action: z.literal('status'), scope }).strict(),
  z.object({ action: z.literal('forget'), scope }).strict(),
]);

export async function execute(input: unknown): Promise<string> {
  const parsed = argsSchema.safeParse(input);
  if (!parsed.success) return JSON.stringify({ error: 'Invalid context_folding arguments', details: parsed.error.issues });
  const args = parsed.data;
  try {
    const result = await new Store().transaction(args.scope, false, 64 * 1024 * 1024, (snapshot) => {
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
            entry.mark = mark.disposition === 'foldable'
              ? { disposition: 'foldable', summary: mark.summary }
              : { disposition: mark.disposition };
            // Pinning a folded entry explicitly restores its original on the next request.
            if (mark.disposition !== 'foldable') delete entry.folded;
          }
          return { marked: updates.length, message: 'Applied atomically. Eligible entries fold only after threshold and cost proof pass.' };
        }
        case 'read': {
          const entry = snapshot.entries.find(entry => entry.id === args.id);
          if (!entry) throw new Error('Unknown entry');
          const layer = args.layer === 'original' ? undefined : entry.layers.find(layer => layer.id === args.layer);
          if (args.layer !== 'original' && !layer) throw new Error('Unknown layer');
          const text = layer?.text ?? entry.text;
          return {
            id: entry.id, layer: args.layer, previousId: layer?.previousId ?? null,
            currentLayer: entry.layers.find(layer => layer.text === entry.folded)?.id ?? 'original',
            text: text.slice(args.offset, args.offset + args.limit), offset: args.offset,
            nextOffset: args.offset + args.limit < text.length ? args.offset + args.limit : null,
            totalChars: text.length, sha256: digest(text),
          };
        }
        case 'status': return { entries: snapshot.entries.length, folded: snapshot.entries.filter(entry => entry.folded).length, decision: snapshot.decision };
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
