import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { onRequest } from '../src/context.hooks.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { digest, type Snapshot, type Store } from '../src/store.js';
import { execute } from '../src/tool.js';
import { bodyFor, fixture, progress } from './helpers.js';

const block = (label: string, text: string) => `@context-fold begin ${label}\n${text}\n@context-fold end ${label}`;
const call = async (args: unknown) => JSON.parse(await execute(args));
const load = (store: Store, scope: string) => store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
const textOf = (body: unknown, protocol: Protocol = 'chat') => extractSpans(body as Record<string, unknown>, protocol)
  .filter(span => span.role === 'assistant').map(span => span.text).join('');

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: three nested occurrences preserve originals, tiny children and source positions`, async () => {
    await fixture(async ({ context, store, scope }) => {
      const leaf = 'needle🙂';
      const middle = 'middle\n' + block('leaf', leaf) + '\nmiddle ending';
      const parent = 'long completed evidence '.repeat(400) + '\n' + block('middle', middle);
      const source = block('parent', parent);
      const input = bodyFor(protocol, source);
      const output = await onRequest(input, { ...context, options: { delayRequests: 0 } });
      assert.equal(textOf(output, protocol).match(/\[\[cf:v3:[a-f0-9]{64}\]\]/g)?.length, 1);
      const state = await load(store, scope);
      assert.equal(state.entries.length, 3);
      for (const entry of state.entries) {
        assert.equal(entry.annotation!.sha256, digest(entry.text));
        assert.match(entry.id, /^[a-f0-9]{64}$/);
        assert.notEqual(entry.id, entry.annotation!.sha256);
        const range = entry.annotation!.sourceRanges![0]!;
        assert.equal(range.offsetUnit, 'utf16');
        assert.equal(range.sourceHash, digest(source));
        assert.equal(source.slice(range.start, range.end), entry.text);
        for (const edge of entry.annotation!.children!) {
          const child = state.entries.find(item => item.id === edge.id)!;
          assert.equal(child.annotation!.parentId, entry.id);
          assert.equal(entry.text.slice(edge.start, edge.end), child.text);
        }
      }
      const root = state.entries.find(item => item.annotation!.parentId === null)!;
      const leafNode = state.entries.find(item => item.annotation!.label === 'leaf')!;
      assert.equal((await call({ action: 'list', scope })).entries.length, 1);
      assert.equal((await call({ action: 'list', scope, recursive: true })).entries.length, 3);
      assert.equal((await call({ action: 'list', scope, parentId: root.id })).entries.length, 1);
      assert.equal((await call({ action: 'read', scope, id: root.id, limit: 24000 })).text, parent);
      const found = await call({ action: 'search', scope, query: 'needle' });
      assert.equal(found.total, 1, 'ancestor copies do not duplicate the same source occurrence');
      assert.equal(found.matches[0].id, leafNode.id);
      assert.equal((await call({ action: 'read', scope, id: leafNode.id, offset: found.matches[0].offset, limit: 6 })).text, 'needle');
      const after = await load(store, scope);
      assert.deepEqual(after.entries, state.entries);
      assert.equal(after.metrics.itemsRestored, 0);
      assert.deepEqual(await onRequest(output, { ...context, options: { delayRequests: 0 } }), output);
      assert.equal((await load(store, scope)).entries.length, 3);
    }, protocol);
  });
}

test('identical siblings and children of different parents share one blob but retain all occurrence nodes', async () => {
  await fixture(async ({ context, store, scope }) => {
    const shared = 'same needle ' + 'evidence '.repeat(250);
    const first = block('parent-a', block('one', shared) + '\n' + block('two', shared));
    const second = block('parent-b', 'other parent\n' + block('three', shared));
    await onRequest(bodyFor('chat', first + '\n' + second), { ...context, options: { delayRequests: 0 } });
    const state = await load(store, scope);
    const copies = state.entries.filter(entry => entry.text === shared);
    assert.equal(copies.length, 3);
    assert.equal(new Set(copies.map(entry => entry.id)).size, 3);
    assert.equal(new Set(copies.map(entry => entry.annotation!.sha256)).size, 1);
    assert.equal(new Set(copies.map(entry => entry.annotation!.parentId)).size, 2);
    assert.equal(new Set(copies.map(entry => entry.annotation!.sourceRanges![0]!.start)).size, 3);
    const db = new Database(join(store.directory, 'state.sqlite'), { readonly: true });
    try { assert.equal((db.query('SELECT COUNT(*) AS n FROM blobs WHERE text = ?').get(JSON.stringify(shared)) as { n: number }).n, 1); }
    finally { db.close(); }
    const found = await call({ action: 'search', scope, query: 'same needle', limit: 2 });
    assert.equal(found.total, 3);
    assert.equal(found.matches.length, 2);
    assert.equal(found.nextOffset, 2);
    const last = await call({ action: 'search', scope, query: 'same needle', offset: 2, limit: 2 });
    assert.equal(last.matches.length, 1);
    assert.equal(last.nextOffset, null);
    assert.equal(new Set([...found.matches, ...last.matches].map(hit => hit.id)).size, 3);
    const hash = digest(shared);
    assert.equal((await call({ action: 'read', scope, id: hash, limit: 24000 })).text, shared);
    for (const action of ['meta', 'list', 'search']) {
      assert.match((await call({ action, scope, id: hash, ...(action === 'search' ? { query: 'needle' } : {}) })).error, /multiple occurrences/);
    }
  });
});

test('request retries reuse occurrences; changed text at the same source position creates an immutable version', async () => {
  await fixture(async ({ context, store, scope }) => {
    const original = 'original evidence '.repeat(300);
    const input = bodyFor('chat', block('work', original));
    const options = { ...context, options: { delayRequests: 0 } };
    await onRequest(input, options);
    const first = (await load(store, scope)).entries[0]!;
    await onRequest(input, options);
    assert.equal((await load(store, scope)).entries.length, 1);
    const changed = original.replace('original', 'modified');
    await onRequest(bodyFor('chat', block('work', changed)), options);
    const state = await load(store, scope);
    assert.equal(state.entries.length, 2);
    assert.equal((await call({ action: 'read', scope, id: first.id, limit: 24000 })).text, original);
    assert.equal(state.entries.find(entry => entry.id !== first.id)!.text, changed);
    const other = await store.scopeFor('another conversation');
    await store.transaction(other, true, 64 * 1024 * 1024, () => {});
    assert.match((await call({ action: 'read', scope: other, id: first.id })).error, /Unknown/);
    assert.equal((await call({ action: 'search', scope: other, query: 'evidence' })).total, 0);
  });
});

test('search uses literal Unicode-aware matching and offsets round-trip through the default original reader', async () => {
  await fixture(async ({ context, store, scope }) => {
    const original = 'İ🙂 [Needle].*\r\nneedle again\n' + 'padding '.repeat(350);
    await onRequest(bodyFor('chat', block('unicode', original)), { ...context, options: { delayRequests: 0 } });
    const id = (await load(store, scope)).entries[0]!.id;
    assert.equal((await call({ action: 'search', scope, query: '[needle].*' })).total, 0);
    const found = await call({ action: 'search', scope, query: '[needle].*', caseSensitive: false });
    assert.equal(found.total, 1);
    const hit = found.matches[0];
    assert.equal(hit.offset, original.indexOf('[Needle].*'));
    assert.equal(hit.offsetUnit, 'utf16');
    const page = await call({ action: 'read', scope, id, offset: hit.offset, limit: hit.endOffset - hit.offset });
    assert.equal(page.text, '[Needle].*');
    assert.equal(page.kept, false);
    assert.equal((await call({ action: 'grep', scope, query: 'needle' })).total, 1);
    assert.equal((await call({ action: 'search', scope, query: 'needle', caseSensitive: false })).total, 2);
    assert.equal((await call({ action: 'search', scope, query: 'needle', offset: 99 })).nextOffset, null);
    assert.ok((await call({ action: 'read', scope, id, offset: 2, limit: 2 })).error, 'half an emoji cannot be a page boundary');
  });
});

test('invalid parent, cyclic, overlapping and mismatched child edges roll back without losing originals', async () => {
  await fixture(async ({ context, store, scope }) => {
    const input = bodyFor('chat', block('parent', 'padding '.repeat(400) + '\n' + block('a', 'first child') + '\n' + block('b', 'second child')));
    await onRequest(input, { ...context, options: { delayRequests: 0 } });
    const before = await load(store, scope);
    const mutate = (change: (state: Snapshot) => void) => store.transaction(scope, false, 64 * 1024 * 1024, change);
    const root = (state: Snapshot) => state.entries.find(entry => entry.annotation!.parentId === null)!;
    await assert.rejects(mutate(state => { root(state).annotation!.children![0]!.id = 'missing'; }), /child range/);
    await assert.rejects(mutate(state => { root(state).annotation!.children![1]!.start = 0; }), /child range/);
    await assert.rejects(mutate(state => { state.entries.find(entry => entry.annotation!.parentId !== null)!.annotation!.parentId = 'missing'; }), /parent/);
    await assert.rejects(mutate(state => { const entry = root(state); entry.annotation!.parentId = entry.id; entry.annotation!.children = [{ id: entry.id, start: 0, end: entry.text.length }]; state.entries = [entry]; }), /Cyclic/);
    await assert.rejects(mutate(state => { root(state).text = 'replaced'; }), /identity or content/);
    assert.deepEqual(await load(store, scope), before);
  });
});

test('a later parent archives the complete original behind a known child reference', async () => {
  await fixture(async ({ context, store, scope }) => {
    const leaf = 'child details '.repeat(400);
    const open = '@context-fold begin parent\nheading\n' + block('child', leaf) + '\n';
    const input = { ...bodyFor('chat'), messages: [{ role: 'assistant', content: open }] };
    const first = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    assert.match(textOf(first), /\[\[cf:v3:/);
    const closed = structuredClone(first);
    (closed.messages as unknown[]).push({ role: 'assistant', content: 'ending '.repeat(400) + '\n@context-fold end parent' });
    await onRequest(closed, { ...context, options: { delayRequests: 0 } });
    const state = await load(store, scope);
    const parent = state.entries.find(entry => entry.annotation!.label === 'parent')!;
    assert.ok(parent);
    assert.ok(parent.text.includes(leaf));
    assert.ok(!parent.text.includes('[[cf:'));
    const child = state.entries.find(entry => entry.id === parent.annotation!.children![0]!.id)!;
    assert.equal(parent.text.slice(parent.annotation!.children![0]!.start, parent.annotation!.children![0]!.end), child.text);
    assert.equal(child.annotation!.parentId, parent.id);
  });
});

test('separate content parts in one identified message keep independent equal-text occurrences', async () => {
  await fixture(async ({ context, store, scope }) => {
    const body = 'same part evidence '.repeat(250);
    const input = { ...bodyFor('chat'), messages: [{ id: 'message-one', role: 'assistant', content: [
      { type: 'text', text: block('work', body) }, { type: 'text', text: block('work', body) },
    ] }] };
    const options = { ...context, options: { delayRequests: 0 } };
    await onRequest(input, options);
    const state = await load(store, scope);
    assert.equal(state.entries.length, 2);
    assert.notEqual(state.entries[0]!.id, state.entries[1]!.id);
    assert.notEqual(state.entries[0]!.annotation!.sourceRanges![0]!.sourceId, state.entries[1]!.annotation!.sourceRanges![0]!.sourceId);
    assert.equal((await call({ action: 'search', scope, query: 'same part', limit: 100 })).total, 500);
    await onRequest(input, options);
    assert.equal((await load(store, scope)).entries.length, 2);
  });
});

test('a parent closing around a referenced subtree preserves its grandchildren', async () => {
  await fixture(async ({ context, store, scope }) => {
    const leaf = 'unique grandchild needle';
    const middle = 'middle data '.repeat(350) + '\n' + block('leaf', leaf);
    const input = { ...bodyFor('chat'), messages: [{ role: 'assistant', content:
      '@context-fold begin outer\nstart\n' + block('middle', middle) + '\n' }] };
    const options = { ...context, options: { delayRequests: 0 } };
    const first = await onRequest(input, options) as Record<string, unknown>;
    const closed = structuredClone(first);
    (closed.messages as unknown[]).push({ role: 'assistant', content: 'outer data '.repeat(300) + '\n@context-fold end outer' });
    await onRequest(closed, options);
    const state = await load(store, scope);
    const parent = state.entries.find(entry => entry.annotation!.label === 'outer')!;
    assert.ok(parent);
    const list = await call({ action: 'list', scope, id: parent.id, recursive: true });
    assert.equal(list.entries.length, 3);
    const hit = await call({ action: 'search', scope, id: parent.id, query: 'unique grandchild needle' });
    assert.equal(hit.total, 1);
    assert.equal((await call({ action: 'read', scope, id: hit.matches[0].id })).text, leaf);
  });
});

test('queries preserve legacy ordering, revisions, statistics and exact database bytes', async () => {
  await fixture(async ({ store, scope }) => {
    await store.transaction(scope, true, 64 * 1024 * 1024, state => {
      state.entries = ['b', 'a'].map(id => ({ id, role: 'assistant', text: id + ' needle', layers: [],
        mark: { disposition: 'unmarked' }, folded: 'small' }));
      state.groups = [{ id: 'legacy', summary: 'prefix needle suffix', children: ['a', 'b'], enabled: true, folded: 'group' }];
    });
    const path = join(store.directory, 'state.sqlite');
    const before = await Bun.file(path).arrayBuffer();
    const snapshot = await store.inspect(scope, state => structuredClone(state));
    const children = await call({ action: 'list', scope, parentId: 'legacy' });
    assert.deepEqual(children.entries.map((entry: { id: string }) => entry.id), ['b', 'a']);
    const found = await call({ action: 'search', scope, id: 'legacy', query: 'needle', recursive: false });
    assert.equal(found.total, 1);
    const hit = found.matches[0];
    assert.equal((await call({ action: 'read', scope, id: hit.id, offset: hit.offset, limit: hit.endOffset - hit.offset })).text, 'needle');
    await call({ action: 'read', scope, id: 'a' });
    await call({ action: 'meta', scope, id: 'legacy' });
    assert.deepEqual(await store.inspect(scope, state => structuredClone(state)), snapshot);
    assert.deepEqual(new Uint8Array(await Bun.file(path).arrayBuffer()), new Uint8Array(before));
  });
});

test('reused reference subtrees separate original provenance from each observed reference position', async () => {
  await fixture(async ({ context, store, scope }) => {
    const leaf = 'source leaf needle ' + 'leaf detail '.repeat(100);
    const middle = 'middle detail '.repeat(300) + '\n' + block('leaf', leaf);
    const sourceText = block('middle', middle);
    const options = { ...context, options: { delayRequests: 0 } };
    const first = await onRequest(bodyFor('chat', sourceText), options);
    const middleRef = textOf(first).match(/\[\[cf:v3:[a-f0-9]{64}\]\]/)![0];
    const copied = block('outer', 'outer detail '.repeat(300) + '\n' + block('first-copy', middleRef) + '\n' + block('second-copy', middleRef));
    await onRequest(bodyFor('chat', copied), options);
    const state = await load(store, scope);
    const parent = state.entries.find(entry => entry.annotation!.label === 'outer')!;
    const sources = new Map([[digest(sourceText), sourceText], [digest(copied), copied]]);
    const nodes = (await call({ action: 'list', scope, id: parent.id, recursive: true })).entries as { id: string }[];
    assert.equal(nodes.length, 5);
    for (const node of nodes) {
      const entry = state.entries.find(entry => entry.id === node.id)!;
      const ranges = entry.annotation!.sourceRanges!;
      assert.equal(ranges.reduce((sum, range) => sum + range.end - range.start, 0), entry.text.length);
      assert.equal(ranges.map(range => sources.get(range.sourceHash)!.slice(range.start, range.end)).join(''), entry.text);
    }
    const copies = state.entries.filter(entry => entry.annotation!.parentId === parent.id);
    assert.equal(copies.length, 2);
    const observed = copies.map(entry => entry.annotation!.observedRanges![0]!);
    assert.notEqual(observed[0]!.start, observed[1]!.start);
    for (const range of observed) assert.equal(copied.slice(range.start, range.end), middleRef);
    for (const copy of copies) {
      const child = state.entries.find(entry => entry.id === copy.annotation!.children![0]!.id)!;
      assert.equal(child.annotation!.observedRanges, undefined, 'a hidden grandchild has no separate visible range in this request');
      const meta = await call({ action: 'meta', scope, id: child.id });
      assert.equal(meta.parentRange.parentId, copy.id);
      assert.equal(copy.text.slice(meta.parentRange.start, meta.parentRange.end), child.text);
    }
  });
});
