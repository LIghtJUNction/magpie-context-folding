import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest, Store } from '../src/store.js';
import { execute } from '../src/tool.js';
import { ContextFoldingPlugin } from '../src/index.js';

const call = async (args: unknown) => JSON.parse(await execute(args));
async function fixture(run: (store: Store, scope: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-tool-'));
  const old = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = join(directory, 'state');
  try {
    const store = new Store();
    const scope = await store.scopeFor('tool-test');
    await store.transaction(scope, true, 64 * 1024 * 1024, state => {
      state.entries = ['a', 'b', 'c'].map(id => ({ id, role: 'tool', text: `${id}🙂 original\n`,
        mark: { disposition: 'foldable', summary: 'short' }, folded: 'short',
        layers: [{ id: 'layer', text: 'short', previousId: 'original' }] }));
      state.entries[0]!.version = { series: 'file', number: 1, kind: 'file', automatic: true };
      state.entries[0]!.annotation = { sha256: digest(state.entries[0]!.text), label: 'source' };
      state.entries[0]!.occurrences = { first: { firstSeen: 1, lastSeen: 2, folded: true } };
      state.groups = [{ id: 'inner', children: ['a', 'b'], enabled: true, summary: 'inner', folded: 'inner' },
        { id: 'outer', children: ['inner', 'c'], enabled: true, summary: 'outer', folded: 'outer' }];
    });
    await run(store, scope, directory);
  } finally {
    if (old === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = old;
    await rm(directory, { recursive: true, force: true });
  }
}
const load = (store: Store, scope: string) => store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));

for (const action of ['read', 'paste']) for (const layer of ['original', 'layer']) {
  test(`${action} ${layer} explicit restore keeps content expanded and restores legacy ancestors`, async () => {
    await fixture(async (store, scope, directory) => {
      const path = join(directory, 'out');
      const result = await call({ action, restore: true, scope, id: 'a', layer, ...(action === 'paste' ? { path } : {}) });
      assert.equal(result.error, undefined);
      assert.equal(result.kept, true);
      if (action === 'paste') assert.equal(await readFile(path, 'utf8'), layer === 'original' ? 'a🙂 original\n' : 'short');
      else assert.equal(result.text, layer === 'original' ? 'a🙂 original\n' : 'short');
      const state = await load(store, scope);
      assert.equal(state.entries[0]!.mark.disposition, 'keep');
      assert.equal(state.entries[0]!.manual, true);
      assert.equal(state.entries[0]!.version!.automatic, false);
      assert.equal(state.entries[0]!.folded, undefined);
      assert.equal(state.entries[0]!.occurrences!.first!.folded, undefined);
      assert.equal(state.entries[0]!.layers[0]!.text, 'short');
      assert.ok(state.groups!.every(group => !group.enabled && group.folded === undefined));
      assert.equal(state.metrics.itemsRestored, 3);
    });
  });
}

test('peek read and paste leave annotations, marks, occurrences and folded groups unchanged', async () => {
  await fixture(async (store, scope, directory) => {
    const before = await load(store, scope);
    assert.equal((await call({ action: 'read', scope, id: 'a', layer: 'layer', peek: true })).kept, false);
    assert.equal((await call({ action: 'paste', scope, id: 'a', path: join(directory, 'peek'), peek: true })).kept, false);
    const after = await load(store, scope);
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.groups, before.groups);
    assert.equal(after.metrics.itemsRestored, 0);
    assert.equal(after.metrics.layerReadCalls, 0);
  });
});

test('short and full content hashes resolve exact text and return the actual archive ID', async () => {
  await fixture(async (store, scope, directory) => {
    const hash = (await load(store, scope)).entries[0]!.annotation!.sha256;
    const read = await call({ action: 'read', restore: true, scope, id: hash.slice(0, 12) });
    assert.equal(read.id, 'a');
    assert.equal(read.text, 'a🙂 original\n');
    assert.equal(read.sha256, hash);
    const path = join(directory, 'hash-copy');
    assert.equal((await call({ action: 'paste', scope, id: hash, path })).id, 'a');
    assert.equal(await readFile(path, 'utf8'), read.text);
    for (const id of [hash.slice(0, 11), 'f'.repeat(65), 'unrecognized-private-secret']) {
      const result = await call({ action: 'read', restore: true, scope, id });
      assert.ok(result.error);
      assert.ok(!result.error.includes(id));
    }
  });
});

test('ambiguous hash prefixes are rejected atomically and exact legacy IDs take precedence', async () => {
  await fixture(async (store, scope) => {
    const hash = (await load(store, scope)).entries[0]!.annotation!.sha256;
    const prefix = hash.slice(0, 12);
    // A synthetic shared prefix exercises collision handling without mining a real SHA collision.
    const otherHash = prefix + (hash[12] === '0' ? '1' : '0') + hash.slice(13);
    await store.transaction(scope, false, 64 * 1024 * 1024, state => {
      state.entries.push({ id: 'different', role: 'assistant', text: 'different content', layers: [],
        mark: { disposition: 'foldable', summary: 'different' }, folded: 'short',
        annotation: { sha256: otherHash, label: 'other' } });
    });
    const before = await load(store, scope);
    assert.match((await call({ action: 'read', restore: true, scope, id: prefix })).error, /Ambiguous/);
    assert.deepEqual(await load(store, scope), before);
    assert.equal((await call({ action: 'read', scope, id: hash.slice(0, 13), peek: true })).text, 'a🙂 original\n');
    await store.transaction(scope, false, 64 * 1024 * 1024, state => {
      state.entries.push({ id: prefix, role: 'assistant', text: 'legacy exact ID', layers: [], mark: { disposition: 'unmarked' } });
    });
    assert.equal((await call({ action: 'read', restore: true, scope, id: prefix })).text, 'legacy exact ID');
    assert.equal((await load(store, scope)).entries[0]!.mark.disposition, 'foldable');
  });
});

test('identical hash/content aliases resolve together and remain expanded after recovery', async () => {
  await fixture(async (store, scope) => {
    await store.transaction(scope, false, 64 * 1024 * 1024, state => {
      const alias = structuredClone(state.entries[0]!);
      alias.id = 'alias';
      delete alias.version;
      state.entries.push(alias);
    });
    const hash = (await load(store, scope)).entries[0]!.annotation!.sha256;
    assert.equal((await call({ action: 'read', restore: true, scope, id: hash.slice(0, 12) })).text, 'a🙂 original\n');
    const state = await load(store, scope);
    for (const entry of state.entries.filter(entry => entry.annotation?.sha256 === hash)) {
      assert.equal(entry.mark.disposition, 'keep');
      assert.equal(entry.folded, undefined);
    }
  });
});

test('legacy group manifests and previous layers remain available', async () => {
  await fixture(async (store, scope) => {
    const manifest = await call({ action: 'read', restore: true, scope, id: 'inner' });
    assert.deepEqual(JSON.parse(manifest.text).children, ['a', 'b']);
    const state = await load(store, scope);
    assert.ok(state.groups!.every(group => !group.enabled && group.folded === undefined));
    assert.equal(state.metrics.itemsRestored, 2);
    const layer = await call({ action: 'read', scope, id: 'a', layer: 'layer', peek: true });
    assert.equal(layer.previousId, 'original');
    assert.equal(layer.text, 'short');
    assert.match((await call({ action: 'read', restore: true, scope, id: 'inner', layer: 'layer' })).error, /manifest/);
  });
});

test('forget requires restored entries and groups, then removes recovery data', async () => {
  await fixture(async (store, scope) => {
    assert.match((await call({ action: 'forget', scope })).error, /Restore folded/);
    for (const id of ['a', 'b', 'c']) await call({ action: 'read', restore: true, scope, id });
    const status = await call({ action: 'status', scope });
    assert.equal(status.folded, 0);
    assert.equal(status.operations, undefined);
    assert.equal((await call({ action: 'forget', scope })).forgotten, true);
    await assert.rejects(load(store, scope), /Unknown context scope/);
    assert.ok((await call({ action: 'read', restore: true, scope, id: 'a' })).error);
  });
});

test('invalid reads do not mutate archives; bounds and filesystem failures keep diagnostics private', async () => {
  await fixture(async (store, scope, directory) => {
    const before = await load(store, scope);
    for (const args of [
      { action: 'read', restore: true, scope, id: 'a', layer: 'private-secret' },
      { action: 'read', restore: true, scope, id: 'a', offset: 999 },
      { action: 'paste', scope, id: 'a', offset: 2, path: join(directory, 'unicode') },
    ]) {
      assert.ok((await call(args)).error);
      assert.deepEqual(await load(store, scope), before);
    }
    const bad = await call({ action: 'read', restore: true, scope, id: 'a', privateSecret: 'never-echo-this' });
    assert.ok(!JSON.stringify(bad).includes('never-echo-this'));
    const bound = await call({ action: 'read', restore: true, scope, id: 'a', limit: 24001 });
    assert.deepEqual(bound.details, [{ path: ['limit'], code: 'too_big', limit: 24000, actual: 24001, unit: 'value' }]);
    const dest = join(directory, 'secret-existing-path');
    await writeFile(dest, 'existing');
    const paste = await call({ action: 'paste', scope, id: 'a', path: dest, peek: true });
    assert.ok(paste.error);
    assert.ok(!JSON.stringify(paste).includes(dest));
    assert.equal(await readFile(dest, 'utf8'), 'existing');
  });
});

test('plugin exposes no model tools; internal CLI operations reject removed mode/mark actions', async () => {
  assert.deepEqual(await ContextFoldingPlugin(), {});
  await fixture(async (store, scope) => {
    const before = await load(store, scope);
    for (const action of ['mode', 'mark']) assert.ok((await call({ action, scope })).error);
    assert.deepEqual(await load(store, scope), before);
    const list = await call({ action: 'list', scope, depth: 2, query: 'original' });
    assert.equal(list.total, 5);
    assert.equal((await call({ action: 'stats', scope })).scope, 'session');
  });
});
