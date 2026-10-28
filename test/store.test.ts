import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { digest, Store, type Entry, type Snapshot } from '../src/store.js';
import { addMetrics, emptyMetrics } from '../src/metrics.js';

const sessionLimit = 64 * 1024 * 1024;
const entry = (id: string, text: string): Entry => ({ id, text, role: 'user', mark: { disposition: 'unmarked' }, layers: [] });

async function fixture(run: (store: Store, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-context-store-'));
  try { await run(new Store(directory), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function inspect<T>(directory: string, run: (database: Database) => T): T {
  const database = new Database(join(directory, 'state.sqlite'), { readonly: true });
  try { return run(database); } finally { database.close(); }
}

async function read(store: Store, scope: string): Promise<Snapshot> {
  return store.transaction(scope, false, sessionLimit, (snapshot) => structuredClone(snapshot));
}

test('cancelled asynchronous work cannot commit a new folding layer', async () => {
  await fixture(async store => {
    const scope = await store.scopeFor('cancelled fold');
    await store.transaction(scope, true, sessionLimit, snapshot => { snapshot.entries.push(entry('one', 'original')); });
    const controller = new AbortController();
    await assert.rejects(store.transaction(scope, false, sessionLimit, async snapshot => {
      const first = snapshot.entries[0];
      assert.ok(first);
      first.folded = 'new fold';
      first.layers.push({ id: 'layer', text: 'new fold', previousId: 'original' });
      controller.abort();
      await Promise.resolve();
    }, controller.signal), /abort/i);
    assert.equal((await read(store, scope)).entries[0]?.folded, undefined);
    assert.deepEqual((await read(store, scope)).entries[0]?.layers, []);
  });
});

test('SQLite round trips arbitrary JSON strings without losing lone UTF-16 surrogates', async () => {
  await fixture(async store => {
    const scope = await store.scopeFor('surrogate round trip');
    const texts = ['\ud800', '\ud801', '\udc00', '\u0000', 'normal ✅'];
    await store.transaction(scope, true, sessionLimit, snapshot => {
      snapshot.entries = texts.map((text, index) => entry(String(index), text));
    });
    assert.deepEqual((await read(store, scope)).entries.map(entry => entry.text), texts);
  });
});

test('private SQLite index and files retain stable scopes and isolated sessions across Store instances', async () => {
  await fixture(async (store, directory) => {
    const scope = await store.scopeFor('session one');
    const secondScope = await store.scopeFor('session two');
    assert.match(scope, /^[a-f0-9]{64}$/);
    assert.notEqual(scope, digest('session one'));
    assert.notEqual(scope, secondScope);
    await store.transaction(scope, true, sessionLimit, (snapshot) => { snapshot.entries.push(entry('one', 'original')); });
    const reopened = new Store(directory);
    assert.equal(await reopened.scopeFor('session one'), scope);
    assert.equal((await read(reopened, scope)).entries[0]?.text, 'original');
    await assert.rejects(read(reopened, secondScope), /Unknown context scope/);
    assert.deepEqual((await readdir(directory)).sort(), ['archives', 'state.sqlite']);
    assert.equal((await stat(join(directory, 'state.sqlite'))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.deepEqual(inspect(directory, (database) => database.query('PRAGMA journal_mode').get()), { journal_mode: 'delete' });
    assert.deepEqual(inspect(directory, (database) => database.query('PRAGMA auto_vacuum').get()), { auto_vacuum: 1 });
  });
});

test('originals, recursive layers and current folded text share content-addressed blobs', async () => {
  await fixture(async (store, directory) => {
    const first = await store.scopeFor('one');
    const second = await store.scopeFor('two');
    for (const scope of [first, second]) {
      await store.transaction(scope, true, sessionLimit, (snapshot) => {
        snapshot.entries.push({ ...entry('a', 'same original'), folded: 'second fold', layers: [
          { id: 'l1', text: 'first fold', previousId: 'original' },
          { id: 'l2', text: 'second fold', previousId: 'l1' },
        ] }, entry('b', 'same original'));
      });
    }
    assert.deepEqual(inspect(directory, (database) => database.query('SELECT COUNT(*) AS count FROM blobs').get()), { count: 3 });
    assert.deepEqual((await read(store, first)).entries[0]?.layers, [
      { id: 'l1', text: 'first fold', previousId: 'original' },
      { id: 'l2', text: 'second fold', previousId: 'l1' },
    ]);
    await store.transaction(first, false, sessionLimit, (snapshot) => { snapshot.decision = { updated: true }; });
    assert.deepEqual(inspect(directory, (database) => database.query('SELECT COUNT(*) AS count FROM blobs').get()), { count: 3 });
    assert.deepEqual((await readdir(directory)).sort(), ['archives', 'state.sqlite']);
  });
});

test('GC removes only blobs no longer referenced by any session', async () => {
  await fixture(async (store, directory) => {
    const first = await store.scopeFor('first');
    const second = await store.scopeFor('second');
    for (const scope of [first, second]) {
      await store.transaction(scope, true, sessionLimit, (snapshot) => { snapshot.entries.push(entry('shared', 'shared original')); });
    }
    await store.transaction(first, false, sessionLimit, (snapshot) => { snapshot.entries = []; });
    assert.equal((await read(store, second)).entries[0]?.text, 'shared original');
    assert.deepEqual(inspect(directory, (database) => database.query('SELECT COUNT(*) AS count FROM blobs').get()), { count: 1 });
    await store.transaction(second, false, sessionLimit, (snapshot) => { snapshot.entries = []; });
    assert.deepEqual(inspect(directory, (database) => database.query('SELECT COUNT(*) AS count FROM blobs').get()), { count: 0 });
  });
});

test('read-only and unchanged callbacks do not add archive revisions or history', async () => {
  await fixture(async (store, directory) => {
    const scope = await store.scopeFor('one');
    await store.transaction(scope, true, sessionLimit, (snapshot) => { snapshot.entries.push(entry('one', 'original')); });
    const before = inspect(directory, (database) => database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope));
    await read(store, scope);
    await store.transaction(scope, false, sessionLimit, () => {});
    const after = inspect(directory, (database) => database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope));
    assert.deepEqual(after, before);
    assert.deepEqual((await readdir(directory)).sort(), ['archives', 'state.sqlite']);
  });
});

test('callback failure and UTF-8 session quota failure preserve the entire prior snapshot', async () => {
  await fixture(async (store) => {
    const scope = await store.scopeFor('one');
    await store.transaction(scope, true, sessionLimit, (snapshot) => { snapshot.entries.push(entry('one', 'original')); });
    const before = await read(store, scope);
    await assert.rejects(store.transaction(scope, false, sessionLimit, async (snapshot) => {
      snapshot.entries[0] = entry('changed', 'must not be committed');
      await Promise.resolve();
      throw new Error('callback failed');
    }), /callback failed/);
    assert.deepEqual(await read(store, scope), before);
    await assert.rejects(store.transaction(scope, false, 2048, (snapshot) => {
      snapshot.entries.push(entry('large', '中'.repeat(1000)));
    }), /Session archive full/);
    assert.deepEqual(await read(store, scope), before);
  });
});

test('global and per-session counters accumulate exact committed deltas', async () => {
  await fixture(async (store, directory) => {
    const first = await store.scopeFor('stats one');
    const second = await store.scopeFor('stats two');
    await store.transaction(first, true, sessionLimit, snapshot => {
      snapshot.entries.push(entry('one', 'shared original'));
      snapshot.metrics = addMetrics(snapshot.metrics, {
        foldBatchesApproved: 1, itemsFolded: 3, successfulFoldedRequests: 1,
        estimatedTokenDelta: '900719925474099300000', savingNanoUsdLower: '12345678901234567890',
      });
    });
    await store.transaction(second, true, sessionLimit, snapshot => {
      snapshot.entries.push(entry('two', 'shared original'));
      snapshot.metrics = addMetrics(snapshot.metrics, {
        foldBatchesApproved: 2, itemsFolded: 5, certifiedComparisons: 2,
        estimatedTokenDelta: '-900719925474099299999', savingNanoUsdLower: '10',
      });
    });
    const total = await store.readStats();
    assert.equal(total.metrics.foldBatchesApproved, 3);
    assert.equal(total.metrics.itemsFolded, 8);
    assert.equal(total.metrics.successfulFoldedRequests, 1);
    assert.equal(total.metrics.certifiedComparisons, 2);
    assert.equal(total.metrics.estimatedTokenDelta, '1');
    assert.equal(total.metrics.savingNanoUsdLower, '12345678901234567900');
    assert.equal(total.storage.activeSessions, 2);
    assert.equal(total.storage.blobs, 1);
    assert.equal(total.storage.databaseBytes, (await stat(join(directory, 'state.sqlite'))).size);
    assert.equal((await store.readStats(first)).metrics.foldBatchesApproved, 1);
    assert.equal((await store.readStats(second)).metrics.foldBatchesApproved, 2);
  });
});

test('statistics reads are read-only, do not count again, and do not create a fresh archive', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'magpie-context-no-stats-'));
  const missing = join(parent, 'never-created');
  try {
    const store = new Store(missing);
    assert.deepEqual(await store.readStats(), {
      metrics: emptyMetrics(), storage: { activeSessions: 0, blobs: 0, databaseBytes: 0 },
    });
    assert.deepEqual(await readdir(parent), []);
    await assert.rejects(store.readStats('0'.repeat(64)), /Unknown context scope/);
    await assert.rejects(store.recordMetrics('0'.repeat(64), { originalReadCalls: 1 }), /Unknown context scope/);
    assert.deepEqual(await readdir(parent), []);
  } finally { await rm(parent, { recursive: true, force: true }); }
  await fixture(async (store, directory) => {
    const scope = await store.scopeFor('stats read');
    await store.transaction(scope, true, sessionLimit, snapshot => {
      snapshot.metrics = addMetrics(snapshot.metrics, { originalReadCalls: 1, readChars: 42 });
    });
    const before = inspect(directory, database => ({
      session: database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope),
      global: database.query("SELECT value FROM meta WHERE key = 'lifetime-metrics'").get(),
    }));
    for (let index = 0; index < 3; index++) {
      assert.equal((await store.readStats()).metrics.readChars, 42);
      assert.equal((await store.readStats(scope)).metrics.originalReadCalls, 1);
    }
    const after = inspect(directory, database => ({
      session: database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope),
      global: database.query("SELECT value FROM meta WHERE key = 'lifetime-metrics'").get(),
    }));
    assert.deepEqual(after, before);
    assert.deepEqual(await readdir(directory), ['state.sqlite']);
  });
});

test('clearing a scope frees indexed originals while exported files and lifetime totals survive', async () => {
  await fixture(async (store, directory) => {
    const scope = await store.scopeFor('stats lifetime');
    await store.transaction(scope, true, sessionLimit, snapshot => {
      snapshot.entries.push(entry('one', 'lifetime original'));
      snapshot.metrics = addMetrics(snapshot.metrics, { foldBatchesApproved: 1, itemsFolded: 2, savingNanoUsdLower: '1' });
    });
    await store.transaction(scope, false, sessionLimit, snapshot => {
      snapshot.entries = [];
      snapshot.decision = { reason: 'explicitly-forgotten' };
    });
    const afterForget = await store.readStats();
    assert.equal(afterForget.metrics.foldBatchesApproved, 1);
    assert.equal(afterForget.metrics.savingNanoUsdLower, '1');
    assert.equal(afterForget.storage.activeSessions, 0);
    assert.equal(afterForget.storage.blobs, 0);
    await assert.rejects(store.readStats(scope), /Unknown context scope/);
    await assert.rejects(store.recordMetrics(scope, { originalReadCalls: 1 }), /Unknown context scope/);
    await store.transaction(scope, true, sessionLimit, snapshot => {
      assert.deepEqual(snapshot.metrics, emptyMetrics());
      snapshot.metrics = addMetrics(snapshot.metrics, { foldBatchesApproved: 1, savingNanoUsdLower: '2' });
    });
    assert.equal((await store.readStats()).metrics.foldBatchesApproved, 2);
    assert.equal((await store.readStats()).metrics.savingNanoUsdLower, '3');
    assert.equal((await store.readStats(scope)).metrics.foldBatchesApproved, 1);
    assert.deepEqual((await readdir(directory)).sort(), ['archives', 'state.sqlite']);
  });
});

test('legacy v1 snapshots without metrics remain readable and gain no invented history', async () => {
  await fixture(async (store, directory) => {
    const scope = await store.scopeFor('legacy stats');
    const original = 'legacy original ✅\ud800';
    await store.transaction(scope, true, sessionLimit, snapshot => {
      snapshot.entries.push({ ...entry('one', original), folded: 'old fold', layers: [
        { id: 'old layer', text: 'old fold', previousId: 'original' },
      ] });
    });
    const database = new Database(join(directory, 'state.sqlite'), { strict: true });
    try {
      database.query("UPDATE sessions SET snapshot = json_remove(snapshot, '$.metrics', '$.payloadBytes', '$.sessionLimitBytes') WHERE scope = ?").run(scope);
    } finally { database.close(); }
    assert.deepEqual((await read(store, scope)).metrics, emptyMetrics());
    assert.deepEqual((await store.readStats(scope)).metrics, emptyMetrics());
    assert.deepEqual((await store.readStats()).metrics, emptyMetrics());
    await store.recordMetrics(scope, { originalReadCalls: 1, readChars: 10 });
    assert.equal((await store.readStats()).metrics.originalReadCalls, 1);
    assert.equal((await read(store, scope)).entries[0]?.text, original);
    assert.deepEqual(inspect(directory, db => db.query("SELECT json_extract(snapshot, '$.payloadBytes') AS value FROM sessions WHERE scope = ?").get(scope)),
      { value: Buffer.byteLength(JSON.stringify(await read(store, scope))) });
  });
});

test('legacy snapshots exactly at their original quota remain readable after metrics defaults are added', async () => {
  await fixture(async (store, directory) => {
    const scope = await store.scopeFor('legacy at quota');
    await store.transaction(scope, true, sessionLimit, snapshot => {
      snapshot.entries.push(entry('one', 'legacy original '.repeat(100)));
    });
    const { metrics: _metrics, ...legacy } = await read(store, scope);
    const limit = Buffer.byteLength(JSON.stringify(legacy));
    const database = new Database(join(directory, 'state.sqlite'), { strict: true });
    try {
      database.query("UPDATE sessions SET snapshot = json_remove(snapshot, '$.metrics', '$.payloadBytes', '$.sessionLimitBytes') WHERE scope = ?").run(scope);
    } finally { database.close(); }
    const before = inspect(directory, db => db.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope));
    const recovered = await store.transaction(scope, false, limit, snapshot => structuredClone(snapshot), undefined, 'preserve');
    assert.equal(recovered.entries[0]?.text, legacy.entries[0]?.text);
    assert.deepEqual(recovered.metrics, emptyMetrics());
    assert.ok(Buffer.byteLength(JSON.stringify(recovered)) > limit);
    assert.deepEqual(inspect(directory, db => db.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope)), before);
    await assert.rejects(store.transaction(scope, false, limit, snapshot => {
      snapshot.entries[0]!.text += 'x';
    }), /Session archive full/);
    await store.transaction(scope, false, limit, snapshot => {
      snapshot.entries = [];
      snapshot.decision = { reason: 'explicitly-forgotten' };
    });
    await assert.rejects(store.readStats(scope), /Unknown context scope/);
    assert.equal((await store.readStats()).storage.blobs, 0);
  });
});

test('lowered quotas allow existing snapshots to stay the same size or shrink, but never grow above quota', async () => {
  await fixture(async (store, directory) => {
    const scope = await store.scopeFor('lowered quota');
    const limit = 1024;
    await store.transaction(scope, true, sessionLimit, snapshot => {
      snapshot.entries.push(entry('one', 'x'.repeat(2048)));
    });
    const before = inspect(directory, db => db.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope));
    assert.equal(await store.transaction(scope, false, limit, snapshot => snapshot.entries[0]?.text.length,
      undefined, 'preserve'), 2048);
    assert.deepEqual(inspect(directory, db => db.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope)), before);
    await store.transaction(scope, false, limit, snapshot => { snapshot.entries[0]!.text = 'y'.repeat(2048); });
    await store.transaction(scope, false, limit, snapshot => { snapshot.entries[0]!.text = 'z'.repeat(2000); });
    const shrunk = await store.transaction(scope, false, limit, snapshot => structuredClone(snapshot));
    assert.ok(Buffer.byteLength(JSON.stringify(shrunk)) > limit);
    assert.equal(shrunk.entries[0]?.text, 'z'.repeat(2000));
    await assert.rejects(store.transaction(scope, false, limit, snapshot => {
      snapshot.entries[0]!.text += 'x';
    }), /Session archive full/);
    assert.deepEqual(await store.transaction(scope, false, limit, snapshot => structuredClone(snapshot)), shrunk);
    await store.transaction(scope, false, limit, snapshot => { snapshot.entries[0]!.text = ''; });
    await store.transaction(scope, false, limit, snapshot => { snapshot.entries[0]!.text = 'within quota'; });
    await assert.rejects(store.transaction(scope, false, limit, snapshot => {
      snapshot.entries[0]!.text = 'x'.repeat(2048);
    }), /Session archive full/);
    const fresh = await store.scopeFor('new over quota');
    await assert.rejects(store.transaction(fresh, true, limit, snapshot => {
      snapshot.entries.push(entry('new', 'x'.repeat(2048)));
    }), /Session archive full/);
    await assert.rejects(store.readStats(fresh), /Unknown context scope/);
  });
});

test('stale same-session metric writes and rejected quotas never inflate lifetime totals', async () => {
  await fixture(async (store) => {
    const scope = await store.scopeFor('stats conflict');
    await store.transaction(scope, true, sessionLimit, snapshot => {
      snapshot.entries.push(entry('one', 'original'));
      snapshot.metrics = addMetrics(snapshot.metrics, { foldBatchesApproved: 1 });
    });
    let release: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let entered: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const stale = store.transaction(scope, false, sessionLimit, async snapshot => {
      snapshot.metrics = addMetrics(snapshot.metrics, { foldBatchesApproved: 100 });
      entered?.();
      await waiting;
    });
    await ready;
    await store.recordMetrics(scope, { foldBatchesApproved: 2 });
    release?.();
    await assert.rejects(stale, /changed concurrently/);
    assert.equal((await store.readStats()).metrics.foldBatchesApproved, 3);
    await assert.rejects(store.transaction(scope, false, 2048, snapshot => {
      snapshot.metrics = addMetrics(snapshot.metrics, { foldBatchesApproved: 1000 });
      snapshot.entries.push(entry('large', '中'.repeat(1000)));
    }), /Session archive full/);
    assert.equal((await store.readStats()).metrics.foldBatchesApproved, 3);
    await assert.rejects(store.transaction(scope, false, sessionLimit, snapshot => {
      snapshot.metrics.foldBatchesApproved = 0;
    }));
    assert.equal((await store.readStats()).metrics.foldBatchesApproved, 3);
  });
});

test('metadata-only metrics updates do not need to decode archived blobs', async () => {
  await fixture(async (store, directory) => {
    const scope = await store.scopeFor('metadata metrics');
    await store.transaction(scope, true, sessionLimit, snapshot => { snapshot.entries.push(entry('one', 'original')); });
    const database = new Database(join(directory, 'state.sqlite'), { strict: true });
    try { database.query('UPDATE blobs SET text = ?').run('"corrupt replacement"'); }
    finally { database.close(); }
    await store.recordMetrics(scope, { originalReadCalls: 1, readChars: 8, savingNanoUsdLower: '1' });
    assert.equal((await store.readStats()).metrics.readChars, 8);
    assert.equal((await store.readStats(scope)).metrics.originalReadCalls, 1);
    assert.equal((await store.readStats()).metrics.savingNanoUsdLower, '1');
    await assert.rejects(read(store, scope), /Archive content hash mismatch/);
    assert.deepEqual((await readdir(directory)).sort(), ['archives', 'state.sqlite']);
  });
});

test('metadata-only metrics updates honor session capacity, cancellation, and global physical quota', async () => {
  await fixture(async (store, directory) => {
    const scope = await store.scopeFor('metadata quota');
    await store.transaction(scope, true, sessionLimit, snapshot => { snapshot.entries.push(entry('one', 'original')); });
    const payloadBytes = Buffer.byteLength(JSON.stringify(await read(store, scope)));
    await store.transaction(scope, false, payloadBytes + 16, snapshot => { snapshot.decision = { sized: 1 }; });
    await assert.rejects(store.recordMetrics(scope, { savingNanoUsdLower: '1'.repeat(100) }), /Session archive full/);
    assert.equal((await store.readStats()).metrics.savingNanoUsdLower, '0');
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(store.recordMetrics(scope, { originalReadCalls: 20 }, cancelled.signal), /abort/i);
    assert.equal((await store.readStats()).metrics.originalReadCalls, 0);
    const physicalStore = new Store(directory, { maxTotalBytes: 128 * 1024 });
    const other = await physicalStore.scopeFor('global metrics quota');
    await physicalStore.transaction(other, true, sessionLimit, snapshot => { snapshot.entries.push(entry('other', 'small')); });
    await assert.rejects(physicalStore.recordMetrics(other, { savingNanoUsdLower: '1'.repeat(200 * 1024) }), /Global archive full/);
    assert.equal((await store.readStats()).metrics.savingNanoUsdLower, '0');
    assert.ok((await stat(join(directory, 'state.sqlite'))).size <= 128 * 1024);
  });
});

test('global physical quota rejects growth and rolls back without losing earlier originals', async () => {
  await fixture(async (_store, directory) => {
    const store = new Store(directory, { maxTotalBytes: 128 * 1024 });
    const scope = await store.scopeFor('one');
    await store.transaction(scope, true, sessionLimit, (snapshot) => { snapshot.entries.push(entry('one', 'original')); });
    const before = await read(store, scope);
    await assert.rejects(store.transaction(scope, false, sessionLimit, (snapshot) => {
      snapshot.entries.push(entry('large', 'x'.repeat(256 * 1024)));
    }), /Global archive full/);
    assert.deepEqual(await read(store, scope), before);
    assert.ok((await stat(join(directory, 'state.sqlite'))).size <= 128 * 1024);
    assert.deepEqual((await readdir(directory)).sort(), ['archives', 'state.sqlite']);
  });
});

test('overlapping asynchronous callbacks on different sessions hold no SQLite write lock', async () => {
  await fixture(async (store) => {
    const first = await store.scopeFor('first');
    const second = await store.scopeFor('second');
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let entered: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const firstWrite = store.transaction(first, true, sessionLimit, async (snapshot) => {
      entered?.();
      await waiting;
      snapshot.entries.push(entry('first', 'one'));
    });
    await ready;
    await store.transaction(second, true, sessionLimit, (snapshot) => { snapshot.entries.push(entry('second', 'two')); });
    release?.();
    await firstWrite;
    assert.equal((await read(store, first)).entries[0]?.text, 'one');
    assert.equal((await read(store, second)).entries[0]?.text, 'two');
  });
});

test('same-session optimistic concurrency rejects stale work without rerunning the callback', async () => {
  await fixture(async (store) => {
    const scope = await store.scopeFor('one');
    await store.transaction(scope, true, sessionLimit, (snapshot) => { snapshot.entries.push(entry('one', 'original')); });
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let entered: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const stale = store.transaction(scope, false, sessionLimit, async (snapshot) => {
      calls += 1;
      entered?.();
      await waiting;
      snapshot.entries[0] = entry('stale', 'should not overwrite');
    });
    await ready;
    await store.transaction(scope, false, sessionLimit, (snapshot) => { snapshot.entries[0] = entry('winner', 'newest'); });
    release?.();
    await assert.rejects(stale, /changed concurrently/);
    assert.equal(calls, 1);
    assert.equal((await read(store, scope)).entries[0]?.text, 'newest');
  });
});

test('invalid recursive chains and duplicate entry IDs cannot corrupt recovery state', async () => {
  await fixture(async (store) => {
    const scope = await store.scopeFor('one');
    await store.transaction(scope, true, sessionLimit, (snapshot) => { snapshot.entries.push(entry('one', 'original')); });
    const before = await read(store, scope);
    await assert.rejects(store.transaction(scope, false, sessionLimit, (snapshot) => {
      const first = snapshot.entries[0];
      if (first) first.layers.push({ id: 'cycle', text: 'fold', previousId: 'cycle' });
    }), /earlier layer/);
    await assert.rejects(store.transaction(scope, false, sessionLimit, (snapshot) => { snapshot.entries.push(entry('one', 'duplicate')); }), /Duplicate archive entry/);
    assert.deepEqual(await read(store, scope), before);
  });
});

test('full auto-vacuum releases pages after unreferenced archive content is removed', async () => {
  await fixture(async (store, directory) => {
    const scope = await store.scopeFor('one');
    await store.transaction(scope, true, sessionLimit, (snapshot) => { snapshot.entries.push(entry('large', 'z'.repeat(1024 * 1024))); });
    const before = (await stat(join(directory, 'state.sqlite'))).size;
    await store.transaction(scope, false, sessionLimit, (snapshot) => { snapshot.entries = []; });
    const after = (await stat(join(directory, 'state.sqlite'))).size;
    assert.ok(after < before / 2, `${after} should be smaller than ${before / 2}`);
    assert.deepEqual((await readdir(directory)).sort(), ['archives', 'state.sqlite']);
  });
});

test('unchanged legacy export cannot bypass the combined database and file quota', async () => {
  await fixture(async (store, directory) => {
    const scope = await store.scopeFor('legacy-file-quota');
    const original = entry('content', 'archived evidence '.repeat(2000));
    await store.transaction(scope, true, sessionLimit, snapshot => { snapshot.entries.push(original); });
    const before = inspect(directory, database => database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope));
    const path = store.paths(scope, original).path;
    await unlink(path);
    const databaseBytes = (await stat(join(directory, 'state.sqlite'))).size;
    const limited = new Store(directory, { maxTotalBytes: databaseBytes + Buffer.byteLength(original.text) - 1 });
    await assert.rejects(read(limited, scope), /Global archive full/);
    await assert.rejects(stat(path), { code: 'ENOENT' });
    assert.deepEqual(inspect(directory, database => database.query('SELECT revision, snapshot FROM sessions WHERE scope = ?').get(scope)), before);
    assert.equal((await read(store, scope)).entries[0]!.text, original.text);
  });
});
