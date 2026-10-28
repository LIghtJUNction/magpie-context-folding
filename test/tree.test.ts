import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import type { Entry, Snapshot } from '../src/store.js';
import { emptyMetrics } from '../src/metrics.js';
import { execute } from '../src/tool.js';
import { browse, latestVersions } from '../src/tree.js';
import { ContextFoldingPlugin } from '../src/index.js';

const entry = (id: string, text = id): Entry => ({ id, text, role: 'tool', mark: { disposition: 'unmarked' }, layers: [] });
const call = async (args: unknown) => JSON.parse(await execute(args));
const group = (id: string, children: string[], summary = id) => ({ id, children, summary, enabled: true });
const snapshot = (): Snapshot => ({ version: 1, entries: [entry('a', 'alpha Needle'), entry('b', 'beta'), entry('c', 'gamma'), entry('d')],
  groups: [group('g-one', ['a', 'b']), group('g-two', ['g-one', 'c'])], decision: {}, metrics: emptyMetrics() });

async function fixture(run: (store: Store, scope: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-tree-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  try {
    const store = new Store();
    const scope = await store.scopeFor('tree-test');
    await store.transaction(scope, true, 64 * 1024 * 1024, state => {
      state.entries = ['a', 'b', 'c', 'd'].map(id => entry(id, `${id} original `.repeat(1000)));
    });
    await run(store, scope, directory);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const load = (store: Store, scope: string) => store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));

test('legacy grouped historical versions retain their exact version links', async () => {
  await fixture(async (store, scope) => {
    await store.transaction(scope, false, 64 * 1024 * 1024, state => {
      state.entries[0]!.version = { series: 'file', number: 1, kind: 'file', path: '/source.ts' };
      state.entries[2]!.version = { series: 'file', number: 2, kind: 'file', previousId: 'a' };
      state.entries[3]!.role = 'user';
    });
    await store.transaction(scope, false, 64 * 1024 * 1024, state => {
      state.groups = [group('legacy-group', ['a', 'b'], 'old version')];
    });
    const read = await call({ action: 'read', scope, id: 'a' });
    assert.equal(read.version.path, '/source.ts');
    assert.equal(read.latestVersion, false);
    const latest = await call({ action: 'read', scope, id: 'c' });
    assert.equal(latest.version.previousId, 'a');
    assert.equal(latest.latestVersion, true);
  });
});

test('explicit latest observation overrides numeric versions and legacy series keep their fallback', () => {
  const state = snapshot();
  state.entries[0]!.version = { series: 'observed', kind: 'file', number: 1, latest: true };
  state.entries[1]!.version = { series: 'observed', kind: 'file', number: 2, latest: false, previousId: 'a' };
  state.entries[2]!.version = { series: 'legacy', kind: 'file', number: 1 };
  state.entries[3]!.version = { series: 'legacy', kind: 'file', number: 2, previousId: 'c' };
  assert.deepEqual([...latestVersions(state)], ['a', 'd']);
  const nodes = browse(state, { depth: 8 }).entries.flatMap(node => 'latestVersion' in node ? [[node.id, node.latestVersion]] : []);
  assert.deepEqual(nodes, [['a', true], ['b', false], ['c', false], ['d', true]]);
});

test('archive rejects multiple latest markers and cyclic or reversed revision chains atomically', async () => {
  await fixture(async (store, scope) => {
    await store.transaction(scope, false, 64 * 1024 * 1024, state => {
      state.entries[0]!.version = { series: 'file', kind: 'file', number: 1, latest: true };
      state.entries[1]!.version = { series: 'file', kind: 'file', number: 2, latest: false, previousId: 'a' };
    });
    const before = await load(store, scope);
    await assert.rejects(store.transaction(scope, false, 64 * 1024 * 1024, state => {
      state.entries[1]!.version!.latest = true;
    }), /Multiple latest/);
    await assert.rejects(store.transaction(scope, false, 64 * 1024 * 1024, state => {
      state.entries[0]!.version!.previousId = 'b';
    }), /earlier member/);
    assert.deepEqual(await load(store, scope), before);
  });
});

test('reading a nested legacy member preserves every ancestor and historical metadata', async () => {
  await fixture(async (store, scope) => {
    await store.transaction(scope, false, 64 * 1024 * 1024, state => {
      state.groups = [group('g-one', ['a', 'b']), group('g-two', ['g-one', 'c'])];
      for (const node of state.groups) node.folded = 'folded';
      state.entries[0]!.folded = 'entry folded';
      state.entries[0]!.version = { series: 'series', number: 1, kind: 'similar', automatic: true };
    });
    const result = await call({ action: 'read', scope, id: 'a' });
    assert.equal(result.error, undefined);
    const state = await load(store, scope);
    assert.equal(state.entries[0]?.folded, 'entry folded');
    assert.equal(state.entries[0]?.version?.automatic, true);
    assert.equal(state.metrics.itemsRestored, 0);
    assert.ok(state.groups?.every(node => node.enabled && node.folded === 'folded'));
  });
});

test('group read/paste return only the manifest and forget protects folded groups', async () => {
  await fixture(async (store, scope, directory) => {
    const id = 'legacy-group';
    await store.transaction(scope, false, 64 * 1024 * 1024, state => {
      state.groups = [group(id, ['a', 'b'], 'bounded summary')];
    });
    const manifest = { id, summary: 'bounded summary', children: ['a', 'b'] };
    const read = await call({ action: 'read', scope, id });
    assert.deepEqual(JSON.parse(read.text), manifest);
    assert.ok(read.totalChars < 500);
    assert.ok((await call({ action: 'read', scope, id, layer: 'missing' })).error);
    const path = join(directory, 'manifest.json');
    assert.equal((await call({ action: 'paste', scope, id, path })).error, undefined);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), manifest);
    await store.transaction(scope, false, 64 * 1024 * 1024, state => { state.groups![0]!.folded = 'active'; });
    assert.ok((await call({ action: 'forget', scope })).error);
    assert.equal((await load(store, scope)).groups?.length, 1);
    const outsideScope = await call({ action: 'read', scope: '0'.repeat(64), id });
    assert.match(outsideScope.error, /Unknown context scope/);
    assert.equal(outsideScope.text, undefined);
    await call({ action: 'read', scope, id });
    assert.equal((await call({ action: 'forget', scope, force: true })).forgotten, true);
    await assert.rejects(load(store, scope), /Unknown context scope/);
  });
});

test('tree depth, subtree and pagination bound every returned node', () => {
  const state = snapshot();
  assert.deepEqual(browse(state, { depth: 0 }).entries.map(node => node.id), ['g-two', 'd']);
  assert.deepEqual(browse(state).entries.map(node => [node.id, node.depth]), [['g-two', 0], ['g-one', 1], ['c', 1], ['d', 0]]);
  assert.deepEqual(browse(state, { depth: 8 }).entries.map(node => node.id), ['g-two', 'g-one', 'a', 'b', 'c', 'd']);
  const subtree = browse(state, { id: 'g-one' });
  assert.deepEqual(subtree.entries.map(node => [node.id, node.parentId, node.depth]), [['g-one', 'g-two', 0], ['a', 'g-one', 1], ['b', 'g-one', 1]]);
  const page = browse(state, { depth: 8, limit: 2 });
  assert.equal(page.entries.length, 2);
  assert.equal(page.total, 6);
  assert.equal(page.nextOffset, 2);
  assert.deepEqual(browse(state, { depth: 8, offset: 2, limit: 2 }).entries.map(node => node.id), ['a', 'b']);
  assert.equal(browse(state, { offset: 100 }).nextOffset, null);
  assert.throws(() => browse(state, { id: 'missing' }), /Unknown/);
});

test('literal search keeps matching ancestors and searches paths, summaries and IDs', () => {
  const state = snapshot();
  state.entries[1]!.version = { series: 'x', number: 1, kind: 'file', path: '/Repo/File.ts' };
  state.entries[2]!.mark = { disposition: 'foldable', summary: 'Evidence (exact)' };
  assert.deepEqual(browse(state, { query: 'NEEDLE', depth: 8 }).entries.map(node => node.id), ['g-two', 'g-one', 'a']);
  assert.deepEqual(browse(state, { query: 'file.TS', depth: 8 }).entries.map(node => node.id), ['g-two', 'g-one', 'b']);
  assert.deepEqual(browse(state, { query: '(exact)', depth: 8 }).entries.map(node => node.id), ['g-two', 'c']);
  assert.deepEqual(browse(state, { query: 'g-one', depth: 8 }).entries.map(node => node.id), ['g-two', 'g-one']);
  assert.deepEqual(browse(state, { query: 'NEEDLE', depth: 0 }).entries.map(node => node.id), ['g-two']);
  assert.deepEqual(browse(state, { query: 'NEEDLE', id: 'd', depth: 8 }).entries, []);
});

test('search returns exact original offsets and bounded evidence without changing folded state', async () => {
  await fixture(async (store, scope) => {
    const text = `İ${'x'.repeat(270)}🙂needle ${'tail '.repeat(100)}`;
    await store.transaction(scope, false, 64 * 1024 * 1024, state => {
      state.entries[0]!.text = text;
      state.entries[0]!.mark = { disposition: 'foldable', summary: 'Completed work; details archived.' };
      state.entries[0]!.folded = 'short';
      state.entries[0]!.layers = [{ id: 'saved', previousId: 'original', text: 'short' }];
      state.groups = [group('g-hidden-id', ['a', 'b'], 'No matching identifier in summary')];
    });
    const before = await load(store, scope);
    const result = await call({ action: 'list', scope, query: 'NEEDLE', depth: 8 });
    assert.deepEqual(result.entries.map((node: { id: string }) => node.id), ['g-hidden-id', 'a']);
    assert.equal(result.entries[0].match, undefined);
    const hit = result.entries[1].match;
    assert.equal(hit.source, 'original');
    assert.equal(hit.offset, text.indexOf('needle'));
    assert.equal(text.slice(hit.offset, hit.endOffset), 'needle');
    assert.equal(hit.excerpt, text.slice(hit.excerptOffset, hit.excerptOffset + hit.excerpt.length));
    assert.ok(hit.excerpt.includes('needle'));
    assert.ok(hit.excerpt.length <= 240);
    const read = await call({ action: 'read', scope, id: 'a', offset: hit.offset, limit: 6, peek: true });
    assert.equal(read.text, 'needle');
    const after = await load(store, scope);
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.groups, before.groups);
    const groupHit = await call({ action: 'list', scope, query: 'hidden-id', depth: 8 });
    assert.equal(groupHit.entries[0].match.source, 'id');
    assert.equal(groupHit.entries[0].id, 'g-hidden-id');
  });
});

test('search treats patterns literally, labels metadata sources and preserves Unicode excerpt boundaries', () => {
  const state = snapshot();
  state.entries[0]!.text = `İ${'x'.repeat(50)}🙂${'b'.repeat(31)}[Needle].*${'y'.repeat(197)}🙂tail`;
  const text = state.entries[0]!.text;
  const hit = browse(state, { query: '[needle].*', depth: 8 }).entries.find(node => node.id === 'a')!.match!;
  assert.equal(hit.offset, text.indexOf('[Needle].*'));
  assert.equal(hit.excerptOffset, hit.offset - 33);
  assert.ok(hit.excerpt.startsWith('🙂'));
  assert.ok(!/[\uD800-\uDBFF]$/.test(hit.excerpt));
  assert.ok(hit.excerpt.length <= 240);
  state.entries[1]!.version = { series: 'file', kind: 'file', number: 1, path: '/Repo/Unique.ts' };
  state.entries[2]!.mark = { disposition: 'foldable', summary: 'Summary-only evidence' };
  assert.equal(browse(state, { query: 'unique.TS', depth: 8 }).entries.at(-1)!.match!.source, 'path');
  assert.equal(browse(state, { query: 'summary-only', depth: 8 }).entries.at(-1)!.match!.source, 'summary');
  assert.ok(browse(state).entries.every(node => node.match === undefined));
  assert.ok(browse(state, { query: '', depth: 8 }).entries.every(node => node.match === undefined));
});

test('siblings sort deterministically and compact nodes expose version status without layer content', () => {
  const state = snapshot();
  state.entries[0]!.version = { series: 'x', number: 2, kind: 'file', path: '/file' };
  state.entries[1]!.version = { series: 'x', number: 1, kind: 'file', previousId: 'before' };
  state.entries[0]!.mark = { disposition: 'foldable', summary: 'summary'.repeat(100) };
  state.entries[0]!.layers = [{ id: 'layer', previousId: 'original', text: 'private layer' }];
  state.entries[0]!.folded = 'private layer';
  assert.deepEqual(browse(state, { id: 'g-one', sort: 'id', order: 'desc' }).entries.map(node => node.id), ['g-one', 'b', 'a']);
  assert.deepEqual(browse(state, { id: 'g-one', sort: 'size' }).entries.map(node => node.id), ['g-one', 'b', 'a']);
  const version = browse(state, { id: 'g-one', sort: 'version' });
  assert.deepEqual(version.entries.map(node => node.id), ['g-one', 'b', 'a']);
  const a = version.entries.find(node => node.id === 'a')!;
  assert.ok('layers' in a);
  assert.equal(a.layers, 1);
  assert.equal(a.currentLayer, 'layer');
  assert.equal(a.latestVersion, true);
  assert.equal(a.version?.path, '/file');
  assert.ok('summary' in a);
  assert.equal(a.summary.length, 120);
  assert.ok(!JSON.stringify(a).includes('private layer'));
  const b = version.entries.find(node => node.id === 'b')!;
  assert.ok('latestVersion' in b);
  assert.equal(b.latestVersion, false);
});

test('runtime list bounds and read default stay explicit without model tools', async () => {
  await fixture(async (_store, scope) => {
    for (const extra of [{ depth: -1 }, { depth: 65 }, { limit: 101 }, { offset: -1 }, { query: 'x'.repeat(201) }, { sort: 'invalid' }]) {
      assert.ok((await call({ action: 'list', scope, ...extra })).error);
    }
    const read = await call({ action: 'read', scope, id: 'a' });
    assert.equal(read.text.length, 1200);
    assert.equal(read.nextOffset, 1200);
    const plugin = await ContextFoldingPlugin();
    assert.deepEqual(plugin, {});
  });
});
