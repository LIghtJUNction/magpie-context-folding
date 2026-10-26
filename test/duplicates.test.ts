import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { duplicatePlans } from '../src/duplicates.js';
import { onRequest } from '../src/context.hooks.js';
import { extractSpans } from '../src/protocol.js';
import { Store } from '../src/store.js';
import { execute } from '../src/tool.js';
import type { Entry } from '../src/store.js';
import type { Span } from '../src/protocol.js';

const original = 'Independent exact tool evidence; 原文🙂 "quoted" \\ preserved.\n'.repeat(30);
const span = (id: string, index: number, text = original): Span => ({ id, role: 'tool', text,
  path: ['messages', index, 'content'], messageIndex: index });
const entry = (s: Span): Entry => ({ id: s.id, role: s.role, text: s.text, mark: { disposition: 'unmarked' }, layers: [] });

test('duplicate aliases require exact text, matching provenance and a protected inline anchor', () => {
  const first = span('old', 0), last = span('latest', 4);
  const entries = new Map([first, last].map(s => [s.id, entry(s)]));
  const eligible = new Set(['old']);
  const plans = duplicatePlans([first, last], entries, eligible, 400);
  assert.ok(plans.get('old')!.includes('["messages",4,"content"]'));
  assert.ok(plans.get('old')!.includes('Same text, separate observation'));
  assert.ok(plans.get('old')!.includes(JSON.stringify(original.slice(0, 400))));
  assert.equal(plans.has('latest'), false);
  assert.equal(duplicatePlans([first, { ...last, text: original + 'changed' }], entries, eligible, 400).size, 0);
  assert.equal(duplicatePlans([first, last], entries, new Set(['old', 'latest']), 400).size, 0);
  assert.equal(duplicatePlans([{ ...first, source: { path: '/a', range: 'full' } },
    { ...last, source: { path: '/b', range: 'full' } }], entries, eligible, 400).size, 0);
  entries.get('old')!.manual = true;
  entries.get('old')!.mark = { disposition: 'unmarked' };
  assert.equal(duplicatePlans([first, last], entries, eligible, 400).size, 0);
  entries.get('old')!.mark = { disposition: 'foldable', summary: 'Manual evidence: preserve  exact spelling.\n原文🙂' };
  assert.ok(duplicatePlans([first, last], entries, eligible, 400).get('old')!.includes('Manual evidence: preserve  exact spelling.\n原文🙂'));
});

async function fixture(run: (store: Store, scope: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-duplicates-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  try {
    const store = new Store(directory);
    const scope = await store.scopeFor(JSON.stringify(['duplicate-test', '', '', '']));
    await run(store, scope);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
const body = { model: 'synthetic', tools: [{ type: 'function', function: { name: 'context_folding' } }], messages: [
  { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'inspect', arguments: '{"check":1}' } }] },
  { role: 'tool', tool_call_id: 'old', content: original },
  { role: 'assistant', content: 'Repeated observation follows.' },
  { role: 'assistant', tool_calls: [{ id: 'latest', type: 'function', function: { name: 'inspect', arguments: '{"check":1}' } }] },
  { role: 'tool', tool_call_id: 'latest', content: original },
  { role: 'user', content: 'Current requirements: keep full evidence inline.' },
] };
const ctx = { protocol: 'chat', model: 'synthetic', session: 'duplicate-test', options: {
  mode: 'intelligence', thresholdTokens: 1, keepRecentMessages: 2, headChars: 400,
} };

test('exact duplicates fold without a summary round trip and restore when the inline anchor changes', async () => {
  await fixture(async (store, scope) => {
    const output = await onRequest(body, ctx) as typeof body;
    assert.ok(output.messages[1]!.content!.startsWith('[context-folding duplicate'));
    assert.equal(output.messages[4]!.content, original);
    assert.deepEqual(output.messages[0], body.messages[0]);
    assert.deepEqual(output.messages[3], body.messages[3]);
    assert.deepEqual(output.tools, body.tools);
    assert.equal(output.messages.length, body.messages.length);
    const id = extractSpans(body, 'chat').find(s => s.messageIndex === 1)!.id;
    const read = JSON.parse(await execute({ action: 'read', scope, id, peek: true, limit: 24000 }));
    assert.equal(read.text, original);
    const state = await store.transaction(scope, false, 64 * 1024 * 1024, s => structuredClone(s));
    assert.equal(state.entries.find(e => e.id === id)!.layers.length, 1);
    assert.deepEqual(await onRequest(body, ctx), output);
    const stable = await store.transaction(scope, false, 64 * 1024 * 1024, s => structuredClone(s));
    assert.equal(stable.entries.find(e => e.id === id)!.layers.length, 1);
    const changed = structuredClone(body);
    changed.messages[4]!.content = original + 'New independent evidence.';
    const restored = await onRequest(changed, { ...ctx, options: { ...ctx.options, thresholdTokens: Number.MAX_SAFE_INTEGER } }) as typeof body;
    assert.equal(restored.messages[1]!.content, original, 'No dangling alias when an anchor changes');
  });
});

test('duplicate selection respects explicit keep, disabled automatic selection and strict cost refusal', async () => {
  await fixture(async (store, scope) => {
    const strict = await onRequest(body, { ...ctx, options: { ...ctx.options, policy: { mode: 'cost' } } }) as typeof body;
    assert.equal(strict.messages[1]!.content, original);
    const id = extractSpans(body, 'chat').find(s => s.messageIndex === 1)!.id;
    await execute({ action: 'mark', scope, marks: [{ id, disposition: 'keep' }] });
    assert.equal((await onRequest(body, ctx) as typeof body).messages[1]!.content, original);
    await store.transaction(scope, false, 64 * 1024 * 1024, s => {
      const e = s.entries.find(e => e.id === id)!;
      e.mark = { disposition: 'unmarked' }; delete e.manual;
    });
    const disabled = await onRequest(body, { ...ctx, options: { ...ctx.options, policy: { autoRoles: [] } } }) as typeof body;
    assert.equal(disabled.messages[1]!.content, original);
    const declined = await onRequest(body, { ...ctx, options: { ...ctx.options, policy: {
      minChars: 0, script: { command: [process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({marks:[]})))"] },
    } } }) as typeof body;
    assert.equal(declined.messages[1]!.content, original, 'An external policy may decline an otherwise eligible duplicate');
  });
});
