import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
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
        mark: { disposition: 'foldable', summary: 'short' }, folded: 'short', layers: [{ id: 'layer', text: 'short', previousId: 'original' }] }));
      state.entries[0]!.version = { series: 'file', number: 1, kind: 'file', automatic: true };
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
  test(`${action} ${layer} persists keep and protects every ancestor; explicit marks restore eligibility`, async () => {
    await fixture(async (store, scope, directory) => {
      const path = join(directory, 'out');
      const result = await call({ action, scope, id: 'a', layer, ...(action === 'paste' ? { path } : {}) });
      assert.equal(result.error, undefined);
      assert.equal(result.kept, true);
      if (action === 'paste') assert.equal(await readFile(path, 'utf8'), layer === 'original' ? 'a🙂 original\n' : 'short');
      else assert.equal(result.text, layer === 'original' ? 'a🙂 original\n' : 'short');
      const state = await load(store, scope);
      assert.equal(state.entries[0]!.mark.disposition, 'keep');
      assert.equal(state.entries[0]!.manual, true);
      assert.equal(state.entries[0]!.version!.automatic, false);
      assert.equal(state.entries[0]!.folded, undefined);
      assert.ok(state.groups!.every(group => !group.enabled && group.folded === undefined));
      assert.equal(state.metrics.itemsRestored, 3);
      const mark = await call({ action: 'mark', scope, marks: [
        { id: 'a', disposition: 'foldable', summary: 'again' },
        { id: 'inner', disposition: 'foldable', summary: 'inner again' },
        { id: 'outer', disposition: 'foldable', summary: 'outer again' },
      ] });
      assert.equal(mark.error, undefined);
      const after = await load(store, scope);
      assert.equal(after.entries[0]!.mark.disposition, 'foldable');
      assert.ok(after.groups!.every(group => group.enabled));
    });
  });
}

test('peek read and paste leave protection and folded state unchanged', async () => {
  await fixture(async (store, scope, directory) => {
    const before = await load(store, scope);
    assert.equal((await call({ action: 'read', scope, id: 'a', layer: 'layer', peek: true })).kept, false);
    assert.equal((await call({ action: 'paste', scope, id: 'a', path: join(directory, 'peek'), peek: true })).kept, false);
    const after = await load(store, scope);
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.groups, before.groups);
    assert.equal(after.metrics.itemsRestored, 0);
    assert.equal(after.metrics.layerReadCalls, 1);
  });
});

test('group manifest restoration disables the group and all ancestors', async () => {
  await fixture(async (store, scope) => {
    const result = await call({ action: 'read', scope, id: 'inner' });
    assert.deepEqual(JSON.parse(result.text).children, ['a', 'b']);
    const state = await load(store, scope);
    assert.ok(state.groups!.every(group => !group.enabled && group.folded === undefined));
    assert.equal(state.metrics.itemsRestored, 2);
  });
});

test('invalid read is atomic and diagnostics do not include supplied values or OS paths', async () => {
  await fixture(async (store, scope, directory) => {
    const before = await load(store, scope);
    const result = await call({ action: 'read', scope, id: 'a', layer: 'private-secret' });
    assert.ok(result.error);
    assert.deepEqual(await load(store, scope), before);
    const bad = await call({ action: 'read', scope, id: 'a', privateSecret: 'never-echo-this' });
    assert.ok(!JSON.stringify(bad).includes('never-echo-this'));
    const dest = join(directory, 'secret-existing-path');
    await writeFile(dest, 'existing');
    const paste = await call({ action: 'paste', scope, id: 'a', path: dest, peek: true });
    assert.ok(paste.error);
    assert.ok(!JSON.stringify(paste).includes(dest));
  });
});

test('tool schema exposes only explicit peek for read and paste', async () => {
  const { args } = (await ContextFoldingPlugin()).tool.context_folding;
  for (const action of ['read', 'paste']) {
    const schema = args.oneOf.find(schema => schema.properties.action.const === action)!;
    assert.deepEqual((schema.properties as Record<string, unknown>).peek, { type: 'boolean', default: false,
      description: 'Read/export without changing keep marks or folded state. By default read/paste persists keep, restores the item and disables every ancestor group until explicitly marked foldable.' });
    assert.equal(schema.additionalProperties, false);
  }
});
