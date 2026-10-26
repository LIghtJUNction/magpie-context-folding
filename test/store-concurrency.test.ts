import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ScopeConflictError, Store, type Snapshot } from '../src/store.js';

const limit = 64 * 1024 * 1024;
const entry = (id: string) => ({ id, text: `original ${id}`, role: 'assistant' as const,
  mark: { disposition: 'unmarked' as const }, layers: [] });
const gate = () => Promise.withResolvers<void>();

async function fixture(run: (store: Store, scope: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-concurrency-'));
  try {
    const store = new Store(directory);
    const scope = await store.scopeFor('synthetic concurrent state');
    await store.transaction(scope, true, limit, snapshot => { snapshot.entries.push(entry('old')); });
    await run(store, scope);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('unchanged callbacks cannot return a fold after concurrent keep or forget', async () => {
  for (const forget of [false, true]) await fixture(async (store, scope) => {
    await store.transaction(scope, false, limit, snapshot => {
      snapshot.entries[0]!.mark = { disposition: 'foldable', summary: 'old fold' };
      snapshot.entries[0]!.folded = 'old fold';
    });
    const entered = gate(), resume = gate();
    let calls = 0;
    const pending = store.transaction(scope, false, limit, async snapshot => {
      calls++;
      entered.resolve();
      await resume.promise;
      return snapshot.entries[0]!.folded;
    });
    await entered.promise;
    await store.transaction(scope, false, limit, snapshot => {
      snapshot.entries[0]!.mark = { disposition: 'keep' };
      delete snapshot.entries[0]!.folded;
      if (forget) { snapshot.entries = []; snapshot.decision = { reason: 'explicitly-forgotten' }; }
    });
    resume.resolve();
    await assert.rejects(pending, ScopeConflictError);
    assert.equal(calls, 1);
    if (forget) await assert.rejects(store.readStats(scope), /Unknown context scope/);
    else {
      const kept = await store.transaction(scope, false, limit, snapshot => snapshot.entries[0]);
      assert.equal(kept?.mark.disposition, 'keep');
      assert.equal(kept?.folded, undefined);
    }
  });
});

test('deleting and recreating the same revision cannot admit a stale write', async () => {
  await fixture(async (store, scope) => {
    const entered = gate(), resume = gate();
    let calls = 0;
    const pending = store.transaction(scope, false, limit, async snapshot => {
      calls++;
      entered.resolve();
      await resume.promise;
      snapshot.entries.push(entry('stale'));
    });
    await entered.promise;
    await store.transaction(scope, false, limit, snapshot => {
      snapshot.entries = []; snapshot.decision = { reason: 'explicitly-forgotten' };
    });
    await store.transaction(scope, true, limit, snapshot => { snapshot.entries.push(entry('new')); });
    resume.resolve();
    await assert.rejects(pending, ScopeConflictError);
    assert.equal(calls, 1);
    const current = await store.transaction(scope, false, limit, snapshot => snapshot.entries);
    assert.deepEqual(current, [entry('new')]);
  });
});

test('unchanged snapshots reject intervening statistics writes without losing their totals', async () => {
  await fixture(async (store, scope) => {
    const entered = gate(), resume = gate();
    const pending = store.transaction(scope, false, limit, async (snapshot: Snapshot) => {
      entered.resolve();
      await resume.promise;
      return snapshot.metrics.successfulHookRequests;
    });
    await entered.promise;
    await store.recordMetrics(scope, { successfulHookRequests: 1 });
    resume.resolve();
    await assert.rejects(pending, ScopeConflictError);
    assert.equal((await store.readStats(scope)).metrics.successfulHookRequests, 1);
    assert.equal((await store.readStats()).metrics.successfulHookRequests, 1);
  });
});
