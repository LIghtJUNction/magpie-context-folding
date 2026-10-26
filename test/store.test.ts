import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { digest, Store, type Entry, type Snapshot } from '../src/store.js';

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

test('one private SQLite file retains stable scopes and isolated sessions across Store instances', async () => {
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
    assert.deepEqual(await readdir(directory), ['state.sqlite']);
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
    assert.deepEqual(await readdir(directory), ['state.sqlite']);
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
    assert.deepEqual(await readdir(directory), ['state.sqlite']);
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
    await assert.rejects(store.transaction(scope, false, 512, (snapshot) => {
      snapshot.entries.push(entry('large', '中'.repeat(200)));
    }), /Session archive full/);
    assert.deepEqual(await read(store, scope), before);
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
    assert.deepEqual(await readdir(directory), ['state.sqlite']);
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
    assert.deepEqual(await readdir(directory), ['state.sqlite']);
  });
});
