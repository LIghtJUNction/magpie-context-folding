import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { onRequest, onResponse } from '../src/context.hooks.js';
import { extractSpans } from '../src/protocol.js';
import type { Protocol } from '../src/protocol.js';
import { Store } from '../src/store.js';
import { execute } from '../src/tool.js';
import { latestVersions } from '../src/tree.js';

type Body = Record<string, unknown>;
type Comparison = { before: Body; after: Body };
const context = { protocol: 'chat' as const, model: 'synthetic', session: 'versions-groups', cwd: tmpdir() };
const tools = [{ type: 'function', function: { name: 'context_folding', parameters: { type: 'object' } } }];
const text = (prefix: string) => Array.from({ length: 120 }, (_, i) => `${prefix} line ${i}: ${prefix.repeat(25)}`).join('\n');
const a = text('alpha'), b = text('bravo'), c = text('charlie');
const chat = (...contents: string[]): Body => ({ model: 'synthetic', tools, messages: [
  ...contents.map(content => ({ role: 'assistant', content })), { role: 'user', content: 'Current requirements.' },
] });
const readChat = (reads: { text: string; path?: string; range?: object; callId?: string }[]): Body => ({ model: 'synthetic', tools, messages: [
  ...reads.flatMap((read, i) => [{ role: 'assistant', content: null, tool_calls: [{ id: read.callId ?? `read-${i}`, type: 'function',
    function: { name: 'Read', arguments: JSON.stringify({ file_path: read.path ?? './file.ts', ...read.range }) } }] },
  { role: 'tool', tool_call_id: read.callId ?? `read-${i}`, content: read.text }]),
  { role: 'user', content: 'Current requirements.' },
] });
const stripGuide = (text: string) => text.replace(/(?:\n\n)?<context-budget>[\s\S]*?<\/context-budget>(?:\n\n<context-folding scope=[a-f0-9]{64}>[\s\S]*?<\/context-folding>)?$/, '');
const content = (body: unknown, protocol: Protocol = 'chat') => extractSpans(body as Body, protocol)
  .map(span => stripGuide(span.text)).filter(Boolean);
const mark = async (scope: string, marks: unknown[]) => {
  const result = JSON.parse(await execute({ action: 'mark', scope, marks }));
  assert.equal(result.error, undefined, JSON.stringify(result));
  return result;
};

async function fixture(run: (f: {
  store: Store; scope: string; ctx: typeof context & { options: object; state: Record<string, unknown> };
  comparisons: Comparison[]; reject: () => void;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-version-groups-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  const comparisons: Comparison[] = [];
  let rejected = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    comparisons.push(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ requestHash: body.requestHash, model: body.model, protocol: body.protocol,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), beforeLowerTokens: JSON.stringify(body.before).length,
      afterUpperTokens: rejected ? JSON.stringify(body.before).length + 1 : JSON.stringify(body.after).length,
      oldMinPricePerMillion: 1, newMaxPricePerMillion: 1, extraCostUpperUsd: 0,
      incremental: { toolCalls: 0, modelRoundTrips: 0, inputTokens: 0, outputTokens: 0,
        inputPricePerMillion: 0, outputPricePerMillion: 0, toolFeesUsd: 0 },
      assumptions: ['Synthetic serialized UTF-16 length; integration test only.'] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const store = new Store(directory);
    const scope = await store.scopeFor(JSON.stringify([context.session, '', '', context.cwd]));
    const ctx = { ...context, state: {}, options: { policy: { autoRoles: [] }, thresholdTokens: 1, keepRecentMessages: 1, headChars: 0,
      accounting: { url: `http://127.0.0.1:${address.port}` } } };
    await run({ store, scope, ctx, comparisons, reject: () => { rejected = true; } });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
const load = (store: Store, scope: string) => store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));

test('hook versions explicit reads, protects latest and certifies the entire automatic representation', async () => {
  await fixture(async ({ store, scope, ctx, comparisons }) => {
    const newer = a.replace('alpha line 0:', 'revised line 0:');
    const body = readChat([{ text: a }, { text: newer }]);
    const ids = extractSpans(body, 'chat').filter(span => span.role === 'tool').map(span => span.id);
    const result = await onRequest(body, ctx);
    assert.ok(content(result).some(value => value.includes('File observation')));
    assert.ok(content(result).includes(newer));
    assert.deepEqual(comparisons[0]?.before, body);
    assert.deepEqual(comparisons[0]?.after, result);
    const state = await load(store, scope);
    const old = state.entries.find(entry => entry.id === ids[0])!;
    const latest = state.entries.find(entry => entry.id === ids[1])!;
    assert.equal(old.version?.path, join(ctx.cwd, 'file.ts'));
    assert.equal(latest.version?.previousId, old.id);
    assert.equal(latest.version?.number, 2);
    assert.equal(old.layers.length, 1);
    await mark(scope, [{ id: latest.id, disposition: 'foldable', summary: 'Must stay visible.' }]);
    assert.ok(content(await onRequest(body, ctx)).includes(newer));
    assert.equal((await load(store, scope)).entries.find(entry => entry.id === latest.id)?.folded, undefined);
    const replay = await onRequest(body, { ...ctx, options: { keepRecentMessages: 1, headChars: 0 } });
    assert.deepEqual(replay, result);
    assert.equal(comparisons.length, 1);
    await onResponse({}, { state: ctx.state, success: true, request: replay });
    assert.equal((await store.readStats(scope)).metrics.replayRequests, 1);
  });
});

test('same-file A→B→A keeps the last occurrence expanded and folds both older observations', async () => {
  await fixture(async ({ store, scope, ctx, comparisons }) => {
    const changed = a.replace('alpha line 0:', 'revised line 0:');
    const body = readChat([{ text: a }, { text: changed }, { text: a }]);
    const ids = extractSpans(body, 'chat').filter(span => span.role === 'tool').map(span => span.id);
    assert.notEqual(ids[0], ids[2], 'Repeated content has a distinct occurrence suffix in one request.');
    const output = await onRequest(body, ctx);
    assert.ok(content(output)[0]?.includes('File observation'));
    assert.ok(content(output)[1]?.includes('File observation'));
    assert.equal(content(output)[2], a);
    const state = await load(store, scope);
    assert.deepEqual(ids.map(id => state.entries.find(entry => entry.id === id)?.version?.number), [1, 2, 3]);
    assert.equal(comparisons.length, 1);
    assert.deepEqual(await onRequest(body, { ...ctx, options: { keepRecentMessages: 1, headChars: 0 } }), output);
  });
});

test('a reobserved original hash ID restores A, folds B, and retains valid version recovery', async () => {
  await fixture(async ({ store, scope, ctx, comparisons }) => {
    const changed = a.replace('alpha line 0:', 'revised line 0:');
    const initial = readChat([{ text: a }, { text: changed }]);
    const originalId = extractSpans(initial, 'chat').find(span => span.text === a)!.id;
    assert.ok(content(await onRequest(initial, ctx))[0]?.includes('File observation'));
    const returned = readChat([{ text: changed, callId: 'read-1' }, { text: a, callId: 'read-again' }]);
    assert.equal(extractSpans(returned, 'chat').find(span => span.text === a)!.id, originalId);
    const output = await onRequest(returned, ctx);
    assert.ok(content(output)[0]?.includes('File observation'));
    assert.equal(content(output)[1], a);
    const state = await load(store, scope);
    const original = state.entries.find(entry => entry.id === originalId)!;
    const revision = state.entries.find(entry => entry.text === changed)!;
    assert.equal(original.folded, undefined);
    assert.equal(original.mark.disposition, 'unmarked');
    assert.equal(original.layers.length, 1, 'Restoration retains the archived fold layer.');
    assert.equal(revision.version?.previousId, original.id);
    assert.equal(original.version?.number, 1);
    assert.equal(revision.version?.number, 2);
    assert.equal(comparisons.length, 2);
    assert.deepEqual(comparisons[1]?.before, returned);
    assert.deepEqual(comparisons[1]?.after, output);
    assert.deepEqual(await onRequest(returned, { ...ctx, options: { keepRecentMessages: 1, headChars: 0 } }), output);
    assert.deepEqual([...latestVersions(state)], [original.id]);
    const read = JSON.parse(await execute({ action: 'read', scope, id: original.id }));
    assert.equal(read.latestVersion, true);
    // Replaying the original A→B history must not move the persisted head back to B.
    const replay = await onRequest(initial, ctx);
    assert.equal(content(replay)[0], a);
    assert.ok(content(replay)[1]?.includes('File observation'));
    const afterReplay = await load(store, scope);
    assert.deepEqual([...latestVersions(afterReplay)], [original.id]);
    assert.ok(afterReplay.entries.filter(entry => entry.version?.latest).length === 1);
    // Even a new unrelated message does not turn an old result into a fresh read.
    const olderOnly = readChat([{ text: changed, callId: 'read-1' }]);
    (olderOnly.messages as Body[]).push({ role: 'assistant', content: 'New unrelated note.' });
    await onRequest(olderOnly, ctx);
    assert.deepEqual([...latestVersions(await load(store, scope))], [original.id]);
    // Tool grouping shares the same head decision: historical B is now eligible.
    const unrelated = chat(b);
    await onRequest(unrelated, ctx);
    const unrelatedId = extractSpans(unrelated, 'chat')[0]!.id;
    await mark(scope, [{ ids: [revision.id, unrelatedId], disposition: 'foldable', summary: 'Historical work.' }]);
    const newRead = readChat([{ text: changed, callId: 'fresh-revision-read' }]);
    assert.ok(content(await onRequest(newRead, ctx)).includes(changed));
    assert.deepEqual([...latestVersions(await load(store, scope))], [revision.id]);
  });
});

test('trimming repeated results preserves observation identity and protects the current occurrence', async () => {
  await fixture(async ({ store, scope, ctx }) => {
    const changed = a.replace('alpha line 0:', 'revised line 0:');
    const initial = readChat([{ text: a, callId: 'first-a' }, { text: changed, callId: 'first-b' },
      { text: a, callId: 'second-a' }]);
    await onRequest(initial, ctx);
    const trimmedA = readChat([{ text: a, callId: 'second-a' }]);
    const trimmedAId = extractSpans(trimmedA, 'chat')[0]!.id;
    assert.ok(content(await onRequest(trimmedA, ctx)).includes(a));
    assert.deepEqual([...latestVersions(await load(store, scope))], [trimmedAId]);
    const freshB = readChat([{ text: changed, callId: 'second-b' }]);
    await onRequest(freshB, ctx);
    const freshBId = extractSpans(freshB, 'chat')[0]!.id;
    await onRequest(trimmedA, ctx);
    await onRequest(initial, ctx);
    assert.deepEqual([...latestVersions(await load(store, scope))], [freshBId]);
  });
});

test('repacking tool results and editing sibling blocks cannot revive old observations', async () => {
  for (const protocol of ['anthropic', 'gemini'] as const) {
    await fixture(async ({ store, scope, ctx }) => {
      const changed = a.replace('alpha line 0:', 'revised line 0:');
      const body = (reads: { text: string; id: string }[], note = 'Original note.'): Body => protocol === 'anthropic'
        ? { tools, messages: [...reads.flatMap(read => [
          { role: 'assistant', content: [{ type: 'tool_use', id: read.id, name: 'Read', input: { file_path: './file.ts' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: read.id, content: read.text }, { type: 'text', text: note }] },
        ]), { role: 'user', content: 'Current requirements.' }] }
        : { tools, contents: [...reads.flatMap(read => [
          { role: 'model', parts: [{ functionCall: { id: read.id, name: 'Read', args: { file_path: './file.ts' } } }] },
          { role: 'user', parts: [{ functionResponse: { id: read.id, name: 'Read', response: { text: read.text } } }, { text: note }] },
        ]), { role: 'user', parts: [{ text: 'Current requirements.' }] }] };
      const localCtx = { ...ctx, protocol };
      await onRequest(body([{ text: a, id: 'first-a' }, { text: changed, id: 'first-b' }]), localCtx);
      const freshA = body([{ text: a, id: 'second-a' }]);
      await onRequest(freshA, localCtx);
      const latestId = extractSpans(freshA, protocol).find(span => span.text === a)!.id;
      const replay = body([{ text: changed, id: 'first-b' }], 'A newly appended sibling note.');
      const items = (protocol === 'anthropic' ? replay.messages : replay.contents) as Body[];
      const parts = (protocol === 'anthropic' ? items[1]!.content : items[1]!.parts) as Body[];
      parts.reverse();
      await onRequest(replay, localCtx);
      assert.deepEqual([...latestVersions(await load(store, scope))], [latestId]);
      const freshB = body([{ text: changed, id: 'second-b' }]);
      await onRequest(freshB, localCtx);
      assert.deepEqual([...latestVersions(await load(store, scope))], [extractSpans(freshB, protocol).find(span => span.text === changed)!.id]);
    });
  }
});

test('legacy version archives seed seen history without demoting their numeric head', async () => {
  await fixture(async ({ store, scope, ctx }) => {
    const changed = a.replace('alpha line 0:', 'revised line 0:');
    const initial = readChat([{ text: a }, { text: changed }]);
    await onRequest(initial, ctx);
    await store.transaction(scope, false, 64 * 1024 * 1024, state => {
      for (const entry of state.entries) if (entry.version) {
        delete entry.version.latest;
        delete entry.version.observations;
      }
    });
    // Seed the current head first; an unseen legacy predecessor is still old.
    await onRequest(readChat([{ text: changed, callId: 'read-1' }]), ctx);
    const oldOnly = readChat([{ text: a }]);
    await onRequest(oldOnly, ctx);
    let state = await load(store, scope);
    const revisedId = state.entries.find(entry => entry.text === changed)!.id;
    assert.deepEqual([...latestVersions(state)], [revisedId]);
    await onRequest(initial, ctx);
    assert.deepEqual([...latestVersions(await load(store, scope))], [revisedId]);
    const fresh = readChat([{ text: a, callId: 'fresh-after-legacy' }]);
    assert.ok(content(await onRequest(fresh, ctx)).includes(a));
    state = await load(store, scope);
    assert.deepEqual([...latestVersions(state)], [extractSpans(fresh, 'chat')[0]!.id]);
  });
});

test('manual keep and unmarked survive A→B→A reobservation and later history replay', async () => {
  for (const disposition of ['keep', 'unmarked'] as const) {
    await fixture(async ({ store, scope, ctx, comparisons }) => {
      const changed = a.replace('alpha line 0:', 'revised line 0:');
      const initial = readChat([{ text: a }, { text: changed }]);
      await onRequest(initial, { ...ctx, options: { keepRecentMessages: 1 } });
      const ids = extractSpans(initial, 'chat').filter(span => span.role === 'tool').map(span => span.id);
      await mark(scope, ids.map(id => ({ id, disposition })));
      const returned = readChat([{ text: changed, callId: 'read-1' }, { text: a, callId: 'read-again' }]);
      assert.deepEqual(content(await onRequest(returned, ctx)), content(returned));
      assert.deepEqual(content(await onRequest(initial, ctx)), content(initial));
      const state = await load(store, scope);
      for (const id of ids) {
        const entry = state.entries.find(entry => entry.id === id)!;
        assert.equal(entry.manual, true);
        assert.equal(entry.version?.automatic, false);
        assert.equal(entry.mark.disposition, disposition);
        assert.equal(entry.folded, undefined);
      }
      assert.equal(comparisons.length, 0);
    });
  }
});

test('read ranges and unrelated paths stay in separate series', async () => {
  await fixture(async ({ store, scope, ctx, comparisons }) => {
    const body = readChat([{ text: a }, { text: a + '\nextra', range: { offset: 1, limit: 20 } },
      { text: b, path: './another.ts' }]);
    assert.deepEqual(content(await onRequest(body, ctx)), content(body));
    const versions = (await load(store, scope)).entries.flatMap(entry => entry.version ? [entry.version] : []);
    assert.equal(new Set(versions.map(version => version.series)).size, 3);
    assert.equal(comparisons.length, 0);
  });
});

test('manual unmarked and keep before version assignment override automatic folding', async () => {
  for (const disposition of ['unmarked', 'keep'] as const) {
    await fixture(async ({ store, scope, ctx, comparisons }) => {
      const initial = readChat([{ text: a }]);
      // Archive before source identification is possible, as with a legacy snapshot.
      await onRequest(initial, { ...ctx, cwd: undefined });
      const legacyScope = await store.scopeFor(JSON.stringify([context.session, '', '', '']));
      const id = extractSpans(initial, 'chat').find(span => span.role === 'tool')!.id;
      await mark(legacyScope, [{ id, disposition }]);
      const body = readChat([{ text: a }, { text: a + '\nnew line' }]);
      const result = await onRequest(body, { ...ctx, cwd: undefined });
      // Relative paths need cwd, so use an absolute path to assign versions after the mark.
      const absolute = readChat([{ text: a, path: '/project/file.ts' }, { text: a + '\nnew line', path: '/project/file.ts' }]);
      assert.deepEqual(content(await onRequest(absolute, { ...ctx, cwd: undefined })), content(absolute));
      assert.ok(content(result).includes(a));
      const entry = (await load(store, legacyScope)).entries.find(entry => entry.id === id)!;
      assert.equal(entry.manual, true);
      assert.equal(entry.version?.automatic, false);
      assert.equal(entry.mark.disposition, disposition);
      assert.equal(comparisons.length, 0);
      void scope;
    });
  }
});

test('similarity needs a real match, preserves old-only evidence and protects the latest fragment', async () => {
  await fixture(async ({ store, scope, ctx }) => {
    const body = chat(a, b, a.replace('alpha line 0:', 'changed line 0:'));
    const result = await onRequest(body, ctx);
    const state = await load(store, scope);
    const old = state.entries.find(entry => entry.text === a)!;
    assert.equal(old.version?.kind, 'similar');
    assert.ok(old.mark.disposition === 'foldable' && old.mark.summary.includes('Similarity is not supersession'));
    assert.ok(old.mark.disposition === 'foldable' && old.mark.summary.includes('alpha line 0:'));
    assert.equal(state.entries.find(entry => entry.text === b)?.version, undefined);
    assert.equal(content(result).at(-2), content(body).at(-2));
  });
});

test('group replay preserves leaf roles, wire envelopes, durable children and complete accounting', async () => {
  await fixture(async ({ store, scope, ctx, comparisons }) => {
    const body = chat(a, b);
    await onRequest(body, ctx);
    const ids = extractSpans(body, 'chat').slice(0, 2).map(span => span.id);
    const { groups } = await mark(scope, [{ ids, disposition: 'foldable', summary: 'Two completed investigations.' }]);
    const output = await onRequest(body, ctx);
    assert.ok(content(output)[0]?.includes(`group=${groups[0]}`));
    assert.ok(content(output)[0]?.includes('Two completed investigations.'));
    assert.ok(!content(output)[1]?.includes('Two completed investigations.'));
    assert.ok(content(output)[1]?.includes(ids[1]!));
    assert.deepEqual(comparisons[0]?.before, body);
    assert.deepEqual(comparisons[0]?.after, output);
    assert.deepEqual((output as typeof body).tools, body.tools);
    const state = await load(store, scope);
    assert.ok(state.groups?.[0]?.folded);
    assert.ok(state.entries.every(entry => entry.layers.length === 0));
    const replay = await onRequest(body, { ...ctx, options: { keepRecentMessages: 1 } });
    assert.deepEqual(replay, output);
    assert.equal(comparisons.length, 1);
    await onRequest(chat(c), ctx);
    const retained = await load(store, scope);
    assert.ok(ids.every(id => retained.entries.some(entry => entry.id === id)));
    assert.ok(retained.groups?.[0]?.folded);
  });
});

test('partial or protected groups never replay; manual restoration releases ancestors', async () => {
  await fixture(async ({ scope, ctx }) => {
    const body = chat(a, b);
    await onRequest(body, ctx);
    const ids = extractSpans(body, 'chat').slice(0, 2).map(span => span.id);
    await mark(scope, [{ ids, disposition: 'foldable', summary: 'Completed.' }]);
    await onRequest(body, ctx);
    assert.ok(content(await onRequest(chat(a), ctx)).includes(a));
    assert.deepEqual(content(await onRequest(body, { ...ctx, options: { keepRecentMessages: 2 } })), content(body));
    await mark(scope, [{ id: ids[0], disposition: 'unmarked' }]);
    assert.deepEqual(content(await onRequest(body, ctx)), content(body));
  });
});

test('a newly identified latest file version disables an already folded group', async () => {
  await fixture(async ({ store, scope, ctx, comparisons }) => {
    const body = toolBody('chat');
    await onRequest(body, ctx);
    const ids = extractSpans(body, 'chat').filter(span => span.role === 'tool').map(span => span.id);
    const group = (await mark(scope, [{ ids, disposition: 'foldable', summary: 'Completed searches.' }])).groups[0];
    assert.ok(content(await onRequest(body, ctx))[0]?.includes(`group=${group}`));
    // Same archived text, now explicitly observed through Read rather than a search tool.
    const reads = readChat([{ text: a }, { text: b, path: './other.ts' }]);
    assert.deepEqual(content(await onRequest(reads, ctx)), content(reads));
    const state = await load(store, scope);
    assert.ok(state.groups?.find(item => item.id === group)?.folded);
    assert.ok(ids.every(id => state.entries.find(entry => entry.id === id)?.version?.number === 1));
    assert.equal(comparisons.length, 1);
  });
});

test('nested groups replay deterministically and parent summary replaces existing child replay only with proof', async () => {
  await fixture(async ({ store, scope, ctx, comparisons }) => {
    const body = chat(a, b, c);
    await onRequest(body, ctx);
    const ids = extractSpans(body, 'chat').slice(0, 3).map(span => span.id);
    const inner = (await mark(scope, [{ ids: ids.slice(0, 2), disposition: 'foldable', summary: 'Inner finished.' }])).groups[0];
    const innerOutput = await onRequest(body, ctx);
    const outer = (await mark(scope, [{ ids: [inner, ids[2]], disposition: 'foldable', summary: 'Everything finished.' }])).groups[0];
    const output = await onRequest(body, ctx);
    assert.ok(content(output).slice(0, 3).every(value => value.includes(`group=${outer}`)));
    assert.ok(!content(output).some(value => value.includes('Inner finished.')));
    assert.equal(content(comparisons[1]?.before)[0], content(innerOutput)[0]);
    assert.deepEqual(await onRequest(body, { ...ctx, options: { keepRecentMessages: 1 } }), output);
    assert.equal(comparisons.length, 2);
    const state = await load(store, scope);
    assert.ok(state.groups?.every(group => group.folded));
    // New request protects only the third leaf; inner group is still eligible.
    const partial = await onRequest(body, { ...ctx, options: { keepRecentMessages: 2 } });
    assert.ok(content(partial)[0]?.includes(`group=${inner}`));
    assert.equal(content(partial)[2], c);
    const restored = JSON.parse(await execute({ action: 'read', scope, id: ids[0] }));
    assert.equal(restored.error, undefined);
    const afterRead = await load(store, scope);
    assert.ok(afterRead.groups?.every(group => group.enabled === false && group.folded === undefined));
    assert.deepEqual(content(await onRequest(body, ctx)), content(body));
    assert.deepEqual(content(await onRequest(body, ctx)), content(body));
  });
});

test('groups require aggregate shrink and cost approval; rejected candidates never persist folded state', async () => {
  await fixture(async ({ store, scope, ctx, comparisons, reject }) => {
    const tiny = chat('tiny one', 'tiny two');
    await onRequest(tiny, ctx);
    await mark(scope, [{ ids: extractSpans(tiny, 'chat').slice(0, 2).map(span => span.id), disposition: 'foldable', summary: 'Done.' }]);
    assert.deepEqual(content(await onRequest(tiny, ctx)), content(tiny));
    assert.equal(comparisons.length, 0);
    const body = chat(a, b);
    await onRequest(body, ctx);
    const id = (await mark(scope, [{ ids: extractSpans(body, 'chat').slice(0, 2).map(span => span.id), disposition: 'foldable', summary: 'Done.' }])).groups[0];
    reject();
    assert.deepEqual(content(await onRequest(body, ctx)), content(body));
    assert.equal(comparisons.length, 1);
    assert.equal((await load(store, scope)).groups?.find(group => group.id === id)?.folded, undefined);
    const withoutAccounting = await onRequest(body, { ...ctx, options: { thresholdTokens: 1, keepRecentMessages: 1, policy: { mode: 'cost', autoRoles: [] } } });
    assert.deepEqual(content(withoutAccounting), content(body));
    assert.equal((await load(store, scope)).decision.reason, 'policy-cost-bounds-missing');
    const byteApproved = await onRequest(body, { ...ctx, options: { thresholdTokens: 1, keepRecentMessages: 1, policy: { mode: 'bytes' } } });
    assert.ok(content(byteApproved)[0]?.includes(`group=${id}`));
    assert.equal(comparisons.length, 1, 'missing proof refuses by default; explicit bytes mode needs no accounting round trip');
  });
});

test('version predecessors survive requests with only the newer revision present', async () => {
  await fixture(async ({ store, scope, ctx }) => {
    // Large old-only differences prevent automatic folding; the unmarked predecessor still must survive GC.
    const body = readChat([{ text: a }, { text: b }]);
    await onRequest(body, ctx);
    const old = extractSpans(body, 'chat').find(span => span.text === a)!.id;
    await onRequest(readChat([{ text: b }]), ctx);
    const state = await load(store, scope);
    assert.ok(state.entries.some(entry => entry.id === old));
    assert.equal(state.entries.find(entry => entry.text === b)?.version?.previousId, old);
  });
});

function toolBody(protocol: Protocol): Body {
  const calls = [a, b].map((output, i) => ({ output, id: `call-${i}` }));
  const tool = { name: 'context_folding' };
  if (protocol === 'chat') return { tools, messages: [...calls.flatMap(({ output, id }) => [
    { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content: output }]), { role: 'user', content: 'Now.' }] };
  if (protocol === 'responses') return { tools: [tool], input: [...calls.flatMap(({ output, id }) => [
    { type: 'function_call', call_id: id, name: 'search', arguments: '{}' },
    { type: 'function_call_output', call_id: id, output }]), { role: 'user', content: 'Now.' }] };
  if (protocol === 'anthropic') return { tools: [tool], messages: [...calls.flatMap(({ output, id }) => [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'search', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] }]), { role: 'user', content: 'Now.' }] };
  return { tools: [{ functionDeclarations: [tool] }], contents: [...calls.flatMap(({ output, id }) => [
    { role: 'model', parts: [{ functionCall: { id, name: 'search', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { id, name: 'search', response: { output } } }] }]),
  { role: 'user', parts: [{ text: 'Now.' }] }] };
}

test('group replacements preserve tool call/result structure across all protocols', async () => {
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as const) {
    await fixture(async ({ scope, ctx }) => {
      const body = toolBody(protocol);
      await onRequest(body, { ...ctx, protocol });
      const spans = extractSpans(body, protocol).filter(span => span.role === 'tool');
      await mark(scope, [{ ids: spans.map(span => span.id), disposition: 'foldable', summary: 'Searches completed.' }]);
      const output = await onRequest(body, { ...ctx, protocol });
      const stripped = structuredClone(output) as Body;
      const original = structuredClone(body);
      const scrub = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
          if (typeof item === 'string') (value as Body)[key] = item === a || item === b || item.includes('[context-folding group=') ? 'TEXT' : stripGuide(item);
          else scrub(item);
        }
      };
      // Responses/Gemini append a guide-only user item; Chat/Anthropic append to the final user text.
      if (protocol === 'responses') (stripped.input as Body[]).pop();
      if (protocol === 'gemini') (stripped.contents as Body[]).pop();
      scrub(stripped); scrub(original);
      assert.deepEqual(stripped, original);
      assert.ok(content(output, protocol).filter(value => value.includes('[context-folding group=')).length === 2);
    });
  }
});
