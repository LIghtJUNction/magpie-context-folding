import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
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


test('SQLite lock waits yield so unrelated sessions and lock release can run', async () => {
  await fixture(async (store, scope) => {
    const blocker = new Database(join(store.directory, 'state.sqlite'));
    blocker.exec('BEGIN EXCLUSIVE');
    let released = false;
    const timer = setTimeout(() => { blocker.exec('ROLLBACK'); released = true; }, 30);
    let calls = 0;
    try {
      await store.transaction(scope, false, limit, snapshot => {
        calls++;
        assert.equal(released, true);
        snapshot.entries.push(entry('after-lock'));
      });
      assert.equal(calls, 1);
      assert.equal((await store.transaction(scope, false, limit, s => s.entries)).length, 2);
    } finally {
      clearTimeout(timer);
      if (blocker.inTransaction) blocker.exec('ROLLBACK');
      blocker.close();
    }
  });
});


test('persistent SQLite contention fails within a bounded wait without running projection', async () => {
  await fixture(async (store, scope) => {
    const blocker = new Database(join(store.directory, 'state.sqlite'));
    blocker.exec('BEGIN EXCLUSIVE');
    let calls = 0;
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    const start = performance.now();
    try {
      await assert.rejects(store.transaction(scope, false, limit, () => { calls++; }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY');
      assert.equal(calls, 0);
      assert.ok(ticks >= 3, 'other hook work must continue during contention');
      assert.ok(performance.now() - start < 1800, 'lock retries must have a deadline');
    } finally {
      clearInterval(timer);
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    assert.equal((await store.transaction(scope, false, limit, s => s.entries)).length, 1);
  });
});


test('existing scope identity does not acquire a writer lock', async () => {
  await fixture(async (store, scope) => {
    const reader = new Database(join(store.directory, 'state.sqlite'));
    reader.exec('BEGIN');
    reader.query('SELECT snapshot FROM sessions WHERE scope = ?').get(scope);
    try {
      assert.equal(await store.scopeFor('synthetic concurrent state'), scope);
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
    }
  });
});
