import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { pollingRepresentation } from '../src/polling.js';
import { extractSpans } from '../src/protocol.js';
import { Store } from '../src/store.js';
import type { Entry } from '../src/store.js';
import { execute } from '../src/tool.js';

const status = (time: string, agent = '"查找交接最早故障"') => `没有新的测试结果。\n\n● Agent ${agent} is waiting on its own background work · ${time}`;
const repeated = Array.from({ length: 30 }, (_, i) => status(`38m ${i + 20}s`)).join('\n\n');
const original = `粘贴的历史状态：\n${repeated}\n\n测试失败：保留失败原因。\n${status('40m 0s', 'other')}\n新的测试结果：42 passed。\n尾部🙂`;
const entry = (text = original): Entry => ({ id: 'history', role: 'assistant', text,
  manual: true, mark: { disposition: 'foldable', summary: '人工摘要 原样保留🙂' }, layers: [] });

test('Chinese polling runs retain agent, elapsed endpoints, count, manual summary and surrounding text', () => {
  const folded = pollingRepresentation(entry())!;
  assert.ok(folded.includes('count=30; Agent "查找交接最早故障"; first elapsed=38m 20s; last elapsed=38m 49s'));
  assert.ok(folded.includes('elapsed readings may differ'));
  assert.ok(folded.includes('人工摘要 原样保留🙂'));
  assert.ok(folded.endsWith(original.slice(original.indexOf('\n\n测试失败'))));
  assert.ok(folded.includes('粘贴的历史状态：\n'));
  assert.equal(pollingRepresentation({ ...entry(), role: 'user', manual: false }), undefined);
  assert.equal(pollingRepresentation({ ...entry(), mark: { disposition: 'keep' } }), undefined);
  assert.equal(pollingRepresentation({ ...entry(), mark: { disposition: 'unmarked' } }), undefined);
});

test('literal pasted sample preserves its unmatched final status line', () => {
  const sample = '没有新的测试结果。\n\n● Agent "查找交接最早故障" is waiting on its own background work · 38m 56s';
  const text = `${Array(30).fill(sample).join('\n\n')}\n\n没有新的测试结果。`;
  const folded = pollingRepresentation(entry(text))!;
  assert.ok(folded.includes('Agent "查找交接最早故障"; first elapsed=38m 56s; last elapsed=38m 56s'));
  assert.ok(folded.endsWith('\n\n没有新的测试结果。'));
});

test('changes, failures, different agents, backwards time and malformed statuses never form runs', () => {
  for (const text of [
    Array.from({ length: 30 }, (_, i) => status('38m 56s', i % 2 ? 'a' : 'b')).join('\n\n'),
    Array.from({ length: 30 }, (_, i) => status(`38m ${59 - i}s`)).join('\n\n'),
    Array(30).fill(status('38m 56s')).join('\n\n新的测试结果：1 failed\n\n'),
    repeated.replaceAll('没有新的测试结果。', '测试失败。'),
    repeated.replaceAll('background work ·', 'background work failed ·'),
    repeated.replaceAll('38m ', 'unknown '),
  ]) assert.equal(pollingRepresentation(entry(text)), undefined);
  const interrupted = `${repeated}\n\n新结果：失败\n\n${repeated}`;
  const folded = pollingRepresentation(entry(interrupted))!;
  assert.equal(folded.match(/count=30/g)?.length, 2);
  assert.ok(folded.includes('\n\n新结果：失败\n\n'));
});

const options = { mode: 'intelligence', thresholdTokens: 1, keepRecentMessages: 1, headChars: 0,
  policy: { mode: 'bytes', autoRoles: [] } };
const context = { protocol: 'chat', model: 'synthetic', session: 'polling-test', options };
const bodyFor = (role: string) => ({ tools: [{ type: 'function', function: { name: 'context_folding' } }],
  messages: [{ role, content: original }, { role: 'user', content: original }] });

async function fixture(run: (store: Store, scope: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-polling-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  try {
    const store = new Store(directory);
    const scope = await store.scopeFor(JSON.stringify(['polling-test', '', '', '']));
    await run(store, scope);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

for (const role of ['assistant', 'user']) test(`real hook folds marked historical ${role}, replays and restores originals`, async () => {
  await fixture(async (store, scope) => {
    const body = bodyFor(role);
    const initial = await onRequest(body, context) as typeof body;
    assert.equal(initial.messages[0]!.content, original, 'Recognition does not automatically mark history');
    const id = extractSpans(body, 'chat')[0]!.id;
    await execute({ action: 'mark', scope, marks: [{ id, disposition: 'foldable', summary: '人工摘要 原样保留🙂' }] });
    const folded = await onRequest(body, context) as typeof body;
    assert.ok(folded.messages[0]!.content.startsWith('[context-folding polling'));
    assert.equal(folded.messages[1]!.content.split('\n\n<context-budget>')[0], original, 'Latest user content stays intact before the existing budget guide');
    assert.equal(folded.messages.length, 2);
    const read = JSON.parse(await execute({ action: 'read', scope, id, peek: true, limit: 24000 }));
    assert.equal(read.text, original);
    assert.deepEqual(await onRequest(body, context), folded);
    const snapshot = await store.transaction(scope, false, 64 * 1024 * 1024, s => structuredClone(s));
    assert.equal(snapshot.entries.find(e => e.id === id)!.layers.length, 1);
    await execute({ action: 'mark', scope, marks: [{ id, disposition: 'keep' }] });
    assert.equal((await onRequest(body, context) as typeof body).messages[0]!.content, original);
  });
});

test('real hook enforces thresholds, recent protection and complete-request cost gate', async () => {
  await fixture(async (store, scope) => {
    const body = bodyFor('assistant');
    await onRequest(body, context);
    const id = extractSpans(body, 'chat')[0]!.id;
    await execute({ action: 'mark', scope, marks: [{ id, disposition: 'foldable', summary: 'Retain status observations.' }] });
    for (const override of [
      { thresholdTokens: Number.MAX_SAFE_INTEGER }, { keepRecentMessages: 2 },
      { policy: { mode: 'cost', autoRoles: [] } },
    ]) {
      const output = await onRequest(body, { ...context, options: { ...options, ...override } }) as typeof body;
      assert.equal(output.messages[0]!.content, original);
    }
    const state = await store.transaction(scope, false, 64 * 1024 * 1024, s => structuredClone(s));
    assert.equal(state.entries.find(e => e.id === id)!.layers.length, 0);
    assert.equal(state.decision?.approved, false);
    assert.equal(state.decision?.beforeBytes, Buffer.byteLength(JSON.stringify(body)));
    assert.ok(Number(state.decision!.afterBytes) > 0);
  });
});

test('small runs cannot bypass the full outgoing request size gate', async () => {
  await fixture(async (store, scope) => {
    const text = Array(6).fill(status('38m 56s')).join('\n\n');
    const body = bodyFor('assistant'); body.messages[0]!.content = text;
    await onRequest(body, context);
    const id = extractSpans(body, 'chat')[0]!.id;
    await execute({ action: 'mark', scope, marks: [{ id, disposition: 'foldable', summary: 'Status' }] });
    assert.ok(pollingRepresentation({ ...entry(text), id }));
    const output = await onRequest(body, context) as typeof body;
    assert.equal(output.messages[0]!.content, text);
    const state = await store.transaction(scope, false, 64 * 1024 * 1024, s => structuredClone(s));
    assert.equal(state.decision?.reason, 'batch-not-smaller');
    assert.equal(state.entries.find(e => e.id === id)!.layers.length, 0);
  });
});
