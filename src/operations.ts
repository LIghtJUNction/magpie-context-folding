import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Snapshot } from './store.js';

const targetSchema = z.object({
  id: z.string(), state: z.enum(['queued', 'applied', 'skipped']), reason: z.string(),
  expected: z.string().optional(), previousFolded: z.string().optional(),
  markRetained: z.boolean().optional(),
});
export const operationSchema = z.object({
  operationId: z.string(), state: z.enum(['queued', 'applied', 'partial', 'skipped']),
  targets: z.array(targetSchema).min(1).max(100), delivered: z.boolean().default(false),
  appliesTo: z.enum(['mark-update', 'request-projection']).default('mark-update'),
});
export type Operation = z.infer<typeof operationSchema>;
export type OperationTarget = z.infer<typeof targetSchema>;
export interface OperationReceipt {
  operationId: string;
  state: Operation['state'];
  appliesTo: Operation['appliesTo'];
  counts: { queued: number; applied: number; skipped: number; folded: number };
  targets: { id: string; state: OperationTarget['state']; reason: string; markRetained?: boolean }[];
}

const MAX_OPERATIONS = 32;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A group replay may rebind its first leaf header when history is repacked.
export const foldedFingerprint = (text: string): string => hash(text.replace(
  /^(\[context-folding group=[^\s\]]+) id=[^\s\]]+ role=(?:assistant|tool)\]/, '$1]'));

/** Keep receipts small and avoid storing a second copy of agent-written summaries. */
export function markFingerprint(snapshot: Snapshot, id: string): string | undefined {
  const entry = snapshot.entries.find(item => item.id === id);
  if (entry) return hash(entry.mark);
  const group = snapshot.groups?.find(item => item.id === id);
  return group && hash([group.enabled, group.summary, group.children]);
}

function stateFor(targets: OperationTarget[]): Operation['state'] {
  if (targets.some(target => target.state === 'queued')) return 'queued';
  if (targets.every(target => target.state === 'applied')) return 'applied';
  if (targets.every(target => target.state === 'skipped')) return 'skipped';
  return 'partial';
}

export function operationReceipt(operation: Operation): OperationReceipt {
  const targets = operation.targets.map(({ id, state, reason, markRetained }) => ({ id, state, reason,
    ...(markRetained !== undefined ? { markRetained } : {}) }));
  return { operationId: operation.operationId, state: operation.state, appliesTo: operation.appliesTo, targets,
    counts: {
      queued: targets.filter(target => target.state === 'queued').length,
      applied: targets.filter(target => target.state === 'applied').length,
      skipped: targets.filter(target => target.state === 'skipped').length,
      folded: targets.filter(target => target.reason === 'folded-in-request').length,
    } };
}

export function recordOperation(snapshot: Snapshot, targets: OperationTarget[]): OperationReceipt {
  const operations = snapshot.operations ?? [];
  // Never erase work or a final receipt that has not reached an acknowledged request.
  const retained = operations.filter(operation => !operation.delivered);
  const state = stateFor(targets);
  if (state === 'queued' && retained.length >= MAX_OPERATIONS) throw new Error('Too many unacknowledged mark operations; complete the next request before marking more');
  // Restoring visibility must not require clearing the notification queue first.
  // At saturation reserve one replaceable, already-delivered terminal receipt.
  const capacity = state !== 'queued' && retained.length === MAX_OPERATIONS ? MAX_OPERATIONS + 1 : MAX_OPERATIONS;
  const historyCount = capacity - retained.length - 1;
  const history = historyCount > 0 ? operations.filter(operation => operation.delivered).slice(-historyCount) : [];
  const operation = { operationId: `op-${randomBytes(12).toString('hex')}`, state, targets,
    delivered: state !== 'queued', appliesTo: 'mark-update' as const };
  snapshot.operations = [...history, ...retained, operation];
  return operationReceipt(operation);
}

export interface OperationOutcome {
  replacements: ReadonlyMap<string, string>;
  protectedReasons: ReadonlyMap<string, string>;
  presentIds: ReadonlySet<string>;
  reason: string;
}

/** Pure preview lets the hook include the exact receipt bytes in its policy gate. */
export function previewOperations(snapshot: Snapshot, outcome: OperationOutcome): OperationReceipt[] {
  const entries = new Map(snapshot.entries.map(entry => [entry.id, entry]));
  const groups = new Map((snapshot.groups ?? []).map(group => [group.id, group]));
  const leaves = (id: string): string[] => groups.get(id)?.children.flatMap(leaves) ?? [id];
  return (snapshot.operations ?? []).filter(operation => operation.state === 'queued').map(operation => {
    const targets = operation.targets.map(target => {
      if (target.state !== 'queued') return target;
      const skip = (reason: string, markRetained = true): OperationTarget => ({ ...target, state: 'skipped', reason, markRetained });
      if (markFingerprint(snapshot, target.id) !== target.expected) return skip('superseded-by-later-mark', false);
      const ids = leaves(target.id);
      const protectedReason = ids.map(id => outcome.protectedReasons.get(id)).find(reason => reason !== undefined);
      if (protectedReason) return skip(protectedReason);
      if (ids.some(id => !outcome.presentIds.has(id))) return skip('not-in-current-request');
      if (ids.every(id => outcome.replacements.has(id) && outcome.replacements.get(id) !== entries.get(id)?.text)) {
        const coveringGroup = ids.map(id => /^\[context-folding group=([^\s\]]+)/.exec(outcome.replacements.get(id)!)?.[1])
          .find(id => id !== undefined && id !== target.id);
        if (coveringGroup) return skip(groups.has(target.id) ? 'covered-by-ancestor-group' : 'covered-by-group');
        // Replaying an older summary does not fulfill a mark requesting a replacement summary.
        if (target.previousFolded && ids.some(id => {
          const replacement = outcome.replacements.get(id);
          return replacement !== undefined && foldedFingerprint(replacement) === target.previousFolded;
        })) {
          return skip(outcome.reason === 'no-marked-smaller-candidates' ? 'replacement-summary-not-smaller' : outcome.reason);
        }
        return { ...target, state: 'applied' as const, reason: 'folded-in-request' };
      }
      return skip(outcome.reason);
    });
    return operationReceipt({ ...operation, targets, state: stateFor(targets), appliesTo: 'request-projection' });
  });
}

/** Commit only the previews for the outgoing projection selected by the hook. */
export function completeOperations(snapshot: Snapshot, receipts: OperationReceipt[]): void {
  const byId = new Map(receipts.map(receipt => [receipt.operationId, receipt]));
  for (const operation of snapshot.operations ?? []) {
    const receipt = byId.get(operation.operationId);
    if (operation.state !== 'queued' || !receipt) continue;
    operation.state = receipt.state;
    operation.appliesTo = receipt.appliesTo;
    operation.targets = receipt.targets;
    operation.delivered = false;
  }
}

export function getUndeliveredOperations(snapshot: Snapshot): OperationReceipt[] {
  return (snapshot.operations ?? []).filter(operation => operation.state !== 'queued' && !operation.delivered).map(operationReceipt);
}

export function acknowledgeOperations(snapshot: Snapshot, operationIds: readonly string[]): void {
  const ids = new Set(operationIds);
  for (const operation of snapshot.operations ?? []) {
    if (operation.state !== 'queued' && ids.has(operation.operationId)) operation.delivered = true;
  }
}

export function renderOperationReceipts(receipts: readonly OperationReceipt[]): string {
  return receipts.length ? `<context-folding-receipts>\n${receipts.map(receipt => JSON.stringify(receipt)).join('\n')}\n</context-folding-receipts>` : '';
}
