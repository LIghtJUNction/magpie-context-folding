import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import type { Snapshot } from '../src/store.js';
import { execute } from '../src/tool.js';
import { acknowledgeOperations, completeOperations, getUndeliveredOperations, markFingerprint, previewOperations } from '../src/operations.js';
import { onRequest, onResponse } from '../src/context.hooks.js';
import { extractSpans } from '../src/protocol.js';

const call = async (input: unknown) => JSON.parse(await execute(input));
const load = (store: Store, scope: string) => store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
async function fixture(run: (store: Store, scope: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-receipts-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  try {
    const store = new Store();
    const scope = await store.scopeFor('receipts');
    await store.transaction(scope, true, 64 * 1024 * 1024, snapshot => {
      snapshot.entries = ['a', 'b', 'c'].map(id => ({ id, role: 'tool', text: `${id} original\n`.repeat(1000),
        mark: { disposition: 'unmarked' }, layers: [] }));
    });
    await run(store, scope);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
const outcome = (snapshot: Snapshot, replacements = new Map<string, string>(), reason = 'below-threshold',
  protectedReasons = new Map<string, string>()) => ({ replacements, protectedReasons,
  presentIds: new Set(snapshot.entries.map(entry => entry.id)), reason });

test('summary errors expose the exact trimmed UTF-16 bound and actual length without echoing text', async () => {
  await fixture(async (store, scope) => {
    for (const summary of ['中'.repeat(2001), '🙂'.repeat(1001), `  ${'x'.repeat(2001)}\n`]) {
      const before = await load(store, scope);
      const result = await call({ action: 'mark', scope, marks: [{ id: 'a', disposition: 'foldable', summary }] });
      assert.deepEqual(result.details, [{ path: ['marks', 0, 'summary'], code: 'too_big', limit: 2000,
        actual: summary.trim().length, unit: 'UTF-16 code units',
        hint: 'Shorten summary to at most 2000 UTF-16 code units after trimming.' }]);
      assert.ok(!JSON.stringify(result).includes(summary.trim()));
      assert.deepEqual(await load(store, scope), before);
    }
    const exact = await call({ action: 'mark', scope, marks: [{ id: 'a', disposition: 'foldable', summary: '🙂'.repeat(1000) }] });
    assert.equal(exact.error, undefined);
  });
});

test('nested union validation keeps a usable full path and deduplicates summary limits', async () => {
  const result = await call({ action: 'mark', scope: 'a'.repeat(64), marks: [{ disposition: 'foldable', summary: 'private'.repeat(400) }] });
  const limits = result.details.filter((detail: { code: string }) => detail.code === 'too_big');
  assert.equal(limits.length, 1);
  assert.deepEqual(limits[0].path, ['marks', 0, 'summary']);
  assert.equal(limits[0].limit, 2000);
  assert.equal(limits[0].actual, 2800);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('queued mark gets a durable ID and exact projection receipt; delivery needs acknowledgment', async () => {
  await fixture(async (store, scope) => {
    const initial = await call({ action: 'mark', scope, marks: [{ id: 'a', disposition: 'foldable', summary: 'Finished.' }] });
    assert.equal(initial.state, 'queued');
    assert.equal(initial.pending, true);
    assert.equal(initial.counts.folded, 0);
    assert.equal(initial.counts.queued, 1);
    assert.match(initial.operationId, /^op-[a-f0-9]{24}$/);
    let state = await load(new Store(), scope);
    assert.equal(state.entries[0]!.folded, undefined);
    const before = structuredClone(state);
    const receipts = previewOperations(state, outcome(state, new Map([['a', 'compact representation']]), 'bytes-smaller-no-cost-proof'));
    assert.deepEqual(state, before, 'Preview must not publish a success before the request gate commits');
    assert.deepEqual(receipts[0], { operationId: initial.operationId, state: 'applied', appliesTo: 'request-projection',
      targets: [{ id: 'a', state: 'applied', reason: 'folded-in-request' }],
      counts: { queued: 0, applied: 1, skipped: 0, folded: 1 } });
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => completeOperations(snapshot, receipts));
    state = await load(new Store(), scope);
    assert.deepEqual(getUndeliveredOperations(state), receipts);
    assert.deepEqual(previewOperations(state, outcome(state)), []);
    const status = await call({ action: 'status', scope });
    assert.deepEqual(status.operations, receipts);
    assert.ok(!JSON.stringify(status.operations).includes('expected'));
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => acknowledgeOperations(snapshot, [initial.operationId]));
    state = await load(new Store(), scope);
    assert.deepEqual(getUndeliveredOperations(state), []);
    assert.equal(state.operations![0]!.state, 'applied');
  });
});

test('keep and unmarked finish immediately; active marks explain skips without delayed hidden work', async () => {
  await fixture(async (store, scope) => {
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      snapshot.entries[0]!.protectionReason = 'authorization-required';
      snapshot.entries[1]!.folded = 'old fold';
    });
    const result = await call({ action: 'mark', scope, marks: [
      { id: 'a', disposition: 'foldable', summary: 'Should remain active.' },
      { id: 'b', disposition: 'keep' }, { id: 'c', disposition: 'unmarked' },
    ] });
    assert.equal(result.state, 'partial');
    assert.equal(result.pending, false);
    assert.equal(result.marked, 2);
    assert.deepEqual(result.targets, [
      { id: 'a', state: 'skipped', reason: 'authorization-required', markRetained: false },
      { id: 'b', state: 'applied', reason: 'kept-expanded' },
      { id: 'c', state: 'applied', reason: 'unmarked-expanded' },
    ]);
    const state = await load(store, scope);
    assert.equal(state.entries[0]!.mark.disposition, 'unmarked');
    assert.equal(state.entries[1]!.mark.disposition, 'keep');
    assert.equal(state.entries[1]!.folded, undefined);
    assert.deepEqual(getUndeliveredOperations(state), []);
  });
});

test('next-request receipts distinguish threshold, protection, absence and superseding intent', async () => {
  await fixture(async (store, scope) => {
    await call({ action: 'mark', scope, marks: ['a', 'b', 'c'].map(id => ({ id, disposition: 'foldable', summary: 'Finished.' })) });
    let state = await load(store, scope);
    let receipts = previewOperations(state, { ...outcome(state, new Map(), 'below-threshold', new Map([['a', 'current-user-turn']])),
      presentIds: new Set(['a', 'b']) });
    assert.deepEqual(receipts[0]!.targets.map(target => target.reason), ['current-user-turn', 'below-threshold', 'not-in-current-request']);
    await call({ action: 'mark', scope, marks: [{ id: 'a', disposition: 'keep' }] });
    state = await load(store, scope);
    receipts = previewOperations(state, outcome(state));
    assert.equal(receipts[0]!.targets[0]!.reason, 'superseded-by-later-mark');
  });
});

test('group receipts require every leaf in the outgoing projection and respect nested protection', async () => {
  await fixture(async (store, scope) => {
    const initial = await call({ action: 'mark', scope, marks: [{ ids: ['a', 'b'], disposition: 'foldable', summary: 'Finished together.' }] });
    const state = await load(store, scope);
    const partial = previewOperations(state, outcome(state, new Map([['a', 'compact']]), 'no-marked-smaller-candidates'));
    assert.equal(partial[0]!.state, 'skipped');
    const protectedResult = previewOperations(state, outcome(state, new Map([['a', 'compact'], ['b', 'child']]),
      'bytes-smaller-no-cost-proof', new Map([['b', 'control-result']])));
    assert.equal(protectedResult[0]!.targets[0]!.reason, 'control-result');
    const applied = previewOperations(state, outcome(state, new Map([['a', 'compact'], ['b', 'child']]), 'bytes-smaller-no-cost-proof'));
    assert.equal(applied[0]!.operationId, initial.operationId);
    assert.equal(applied[0]!.counts.folded, 1);
  });
});

test('replayed old summary does not falsely fulfill a new summary mark', async () => {
  await fixture(async (store, scope) => {
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      snapshot.entries[0]!.mark = { disposition: 'foldable', summary: 'Previous summary' };
      snapshot.entries[0]!.folded = 'previous representation';
      snapshot.entries[0]!.foldedMark = markFingerprint(snapshot, 'a')!;
    });
    await call({ action: 'mark', scope, marks: [{ id: 'a', disposition: 'foldable', summary: 'New summary' }] });
    const state = await load(store, scope);
    const replay = previewOperations(state, outcome(state, new Map([['a', 'previous representation']]), 'below-threshold'));
    assert.equal(replay[0]!.state, 'skipped');
    assert.equal(replay[0]!.targets[0]!.reason, 'below-threshold');
    assert.equal(replay[0]!.targets[0]!.markRetained, true);
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => completeOperations(snapshot, replay));
    await call({ action: 'mark', scope, marks: [{ id: 'a', disposition: 'foldable', summary: 'New summary' }] });
    const repeated = await load(store, scope);
    const retry = previewOperations(repeated, outcome(repeated, new Map([['a', 'previous representation']]), 'below-threshold'));
    assert.equal(retry[0]!.state, 'skipped', 'Repeating the rejected summary must not turn an old replay into success');
    const changed = previewOperations(repeated, outcome(repeated, new Map([['a', 'new representation']]), 'bytes-smaller-no-cost-proof'));
    assert.equal(changed[0]!.state, 'applied');
  });
});

test('an old group replay does not fulfill a changed group summary', async () => {
  await fixture(async (store, scope) => {
    const group = (await call({ action: 'mark', scope, marks: [{ ids: ['a', 'b'], disposition: 'foldable', summary: 'Old group summary' }] })).groups[0];
    const original = `[context-folding group=${group} id=a role=tool]\nOld group summary`;
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => { snapshot.groups![0]!.folded = original; });
    await call({ action: 'mark', scope, marks: [{ id: group, disposition: 'foldable', summary: 'New group summary' }] });
    const state = await load(store, scope);
    const replay = previewOperations(state, outcome(state, new Map([['a', 'child marker'],
      ['b', original.replace(' id=a role=tool]', ' id=b role=tool]')]]), 'below-threshold'));
    assert.equal(replay.at(-1)!.state, 'skipped');
    assert.equal(replay.at(-1)!.targets[0]!.reason, 'below-threshold');
    const replacement = previewOperations(state, outcome(state, new Map([['a', 'new group representation'], ['b', 'child marker']]), 'bytes-smaller-no-cost-proof'));
    assert.equal(replacement.at(-1)!.state, 'applied');
  });
});

test('an enclosing group replay cannot claim that a new leaf summary was applied', async () => {
  await fixture(async (store, scope) => {
    const group = (await call({ action: 'mark', scope, marks: [{ ids: ['a', 'b'], disposition: 'foldable', summary: 'Earlier grouping' }] })).groups[0];
    await call({ action: 'mark', scope, marks: [{ id: 'a', disposition: 'foldable', summary: 'New leaf summary' }] });
    const state = await load(store, scope);
    const receipts = previewOperations(state, outcome(state, new Map([
      ['a', `[context-folding group=${group} id=a role=tool]\nSummary (agent-written): Earlier grouping`],
      ['b', `[context-folding group=${group} id=b role=tool; summary above]`],
    ]), 'no-marked-smaller-candidates'));
    assert.equal(receipts.at(-1)!.state, 'skipped');
    assert.equal(receipts.at(-1)!.targets[0]!.reason, 'covered-by-group');
    assert.equal(receipts.at(-1)!.targets[0]!.markRetained, true);
  });
});

test('legacy Unicode summaries remain readable and every tool path identifies its control result', async () => {
  await fixture(async (store, scope) => {
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      snapshot.entries[0]!.mark = { disposition: 'foldable', summary: '🙂'.repeat(1001) };
    });
    for (const args of [
      { action: 'list', scope }, { action: 'status', scope }, { action: 'stats', scope },
      { action: 'mode', scope }, { action: 'read', scope, id: 'a' },
      { action: 'mark', scope, marks: [{ id: 'a', disposition: 'unmarked' }] },
      { action: 'read', scope, id: 'missing' }, { action: 'invalid' }, { action: 'forget', scope },
    ]) {
      const result = await call(args);
      assert.equal(result._contextFolding, 'control-result');
    }
  });
});

test('saturated queue preserves unfinished receipts, rejects new work atomically, and permits keep/unmarked/read', async () => {
  await fixture(async (store, scope) => {
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      snapshot.entries[1]!.folded = 'earlier folded representation';
    });
    for (let index = 0; index < 32; index++) {
      const result = await call({ action: 'mark', scope, marks: [{ id: 'a', disposition: 'foldable', summary: `Finished ${index}` }] });
      assert.equal(result.error, undefined);
    }
    const before = await load(store, scope);
    assert.equal(before.operations!.length, 32);
    const rejected = await call({ action: 'mark', scope, marks: [{ id: 'a', disposition: 'foldable', summary: 'Must not replace' }] });
    assert.match(rejected.error, /Too many unacknowledged mark operations/);
    assert.deepEqual(await load(store, scope), before);
    for (const disposition of ['keep', 'unmarked'] as const) {
      const restored = await call({ action: 'mark', scope, marks: [{ id: 'b', disposition }] });
      assert.equal(restored.error, undefined);
      assert.equal(restored.state, 'applied');
      assert.equal(restored.pending, false);
      const state = await load(store, scope);
      assert.equal(state.entries[1]!.mark.disposition, disposition);
      assert.equal(state.entries[1]!.folded, undefined);
      assert.equal(state.operations!.length, 33);
      assert.deepEqual(state.operations!.filter(operation => !operation.delivered), before.operations);
      assert.deepEqual(state.entries.map(entry => entry.text), before.entries.map(entry => entry.text));
      assert.equal(state.operations!.filter(operation => operation.delivered).length, 1);
    }
    const read = await call({ action: 'read', scope, id: 'a' });
    assert.equal(read.error, undefined);
    assert.equal(read.kept, true);
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      const receipts = previewOperations(snapshot, outcome(snapshot));
      completeOperations(snapshot, receipts);
      acknowledgeOperations(snapshot, receipts.map(receipt => receipt.operationId));
    });
    const next = await call({ action: 'mark', scope, marks: [{ id: 'a', disposition: 'unmarked' }] });
    assert.equal(next.error, undefined);
    assert.equal((await load(store, scope)).operations!.length, 32);
  });
});

test('invalid mark batch persists neither a receipt nor partial marks', async () => {
  await fixture(async (store, scope) => {
    const before = await load(store, scope);
    const result = await call({ action: 'mark', scope, marks: [
      { id: 'a', disposition: 'keep' }, { id: 'missing', disposition: 'foldable', summary: 'Unknown' },
    ] });
    assert.ok(result.error);
    assert.deepEqual(await load(store, scope), before);
  });
});

test('mark resolves in the next existing hook, retries a lost receipt, and stops announcing after matching success', async () => {
  await fixture(async store => {
    const text = 'Historical search evidence. '.repeat(2000);
    const body = { tools: [{ type: 'function', function: { name: 'context_folding', parameters: { type: 'object' } } }],
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'search-1', type: 'function', function: { name: 'search', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'search-1', content: text },
        { role: 'assistant', content: 'Search complete.' }, { role: 'user', content: 'Begin the next task.' },
      ] };
    const context = { protocol: 'chat', model: 'fixture', session: 'operation-hook', state: {},
      options: { thresholdTokens: 1, keepRecentMessages: 0, policy: { autoRoles: [] } } };
    const scope = await store.scopeFor(JSON.stringify([context.session, '', '', '']));
    await onRequest(body, context);
    const id = extractSpans(body, 'chat').find(span => span.text === text)!.id;
    const mark = await call({ action: 'mark', scope, marks: [{ id, disposition: 'foldable', summary: 'Search evidence completed.' }] });
    assert.equal(mark.state, 'queued');
    const outgoing = await onRequest(body, context);
    assert.ok(JSON.stringify(outgoing).includes(mark.operationId));
    assert.ok(JSON.stringify(outgoing).includes('folded-in-request'));
    assert.equal((await load(store, scope)).operations![0]!.state, 'applied');
    await onResponse({}, { state: context.state, success: false, request: outgoing });
    assert.equal(getUndeliveredOperations(await load(store, scope)).length, 1);
    const retry = await onRequest(body, context);
    assert.ok(JSON.stringify(retry).includes(mark.operationId));
    await onResponse({}, { state: context.state, success: true, request: { different: true } });
    assert.equal(getUndeliveredOperations(await load(store, scope)).length, 1);
    const delivered = await onRequest(body, context);
    await onResponse({}, { state: context.state, success: true, request: delivered });
    assert.deepEqual(getUndeliveredOperations(await load(store, scope)), []);
    const later = await onRequest(body, context);
    assert.ok(!JSON.stringify(later).includes(mark.operationId));
    assert.ok(!JSON.stringify(later).includes('<context-folding-receipts>'));
  });
});

test('next existing hook reports below-threshold with the operation ID and leaves original content visible', async () => {
  await fixture(async store => {
    const text = 'Historical completed output. '.repeat(300);
    const body = { tools: [{ type: 'function', function: { name: 'context_folding', parameters: { type: 'object' } } }],
      messages: [{ role: 'assistant', content: text }, { role: 'user', content: 'New work.' }] };
    const context = { protocol: 'chat', model: 'fixture', session: 'operation-threshold', state: {},
      options: { thresholdTokens: 1_000_000, keepRecentMessages: 0, policy: { autoRoles: [] } } };
    const scope = await store.scopeFor(JSON.stringify([context.session, '', '', '']));
    await onRequest(body, context);
    const id = extractSpans(body, 'chat').find(span => span.text === text)!.id;
    const mark = await call({ action: 'mark', scope, marks: [{ id, disposition: 'foldable', summary: 'Done.' }] });
    const outgoing = await onRequest(body, context);
    assert.ok(JSON.stringify(outgoing).includes(mark.operationId));
    assert.ok(JSON.stringify(outgoing).includes('below-threshold'));
    assert.ok(extractSpans(outgoing as Record<string, unknown>, 'chat').some(span => span.text === text));
    const operation = (await load(store, scope)).operations![0]!;
    assert.equal(operation.state, 'skipped');
    assert.equal(operation.targets[0]!.reason, 'below-threshold');
  });
});
