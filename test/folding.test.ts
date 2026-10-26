import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { execute } from '../src/tool.js';
import { extractSpans } from '../src/protocol.js';
import { Store, digest } from '../src/store.js';

type AccountingRequest = { before: Record<string, unknown>; after: Record<string, unknown> };

function chatSpans(value: unknown) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return extractSpans(value as Record<string, unknown>, 'chat');
}

async function fixture(run: (directory: string, url: string, requests: AccountingRequest[]) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'context-folding-test-'));
  const previousDirectory = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  const requests: AccountingRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      requestHash: body.requestHash, model: body.model, protocol: body.protocol,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      beforeLowerTokens: JSON.stringify(body.before).length,
      afterUpperTokens: JSON.stringify(body.after).length,
      oldMinPricePerMillion: 1, newMaxPricePerMillion: 1, extraCostUpperUsd: 0,
      assumptions: ['Synthetic tokenizer: serialized UTF-16 length. Integration evidence only.'],
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await run(directory, `http://127.0.0.1:${address.port}`, requests); }
  finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousDirectory === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
}

const oldText = '过去的研究结果。✅\n'.repeat(15_000);
const body = {
  model: 'synthetic', stream: false,
  tools: [{ type: 'function', function: { name: 'context_folding', parameters: { type: 'object' } } }],
  messages: [
    { role: 'system', content: 'Important system requirement.' },
    { role: 'user', content: oldText },
    { role: 'assistant', content: 'Finished earlier research.' },
    { role: 'user', content: 'Continue with the current task.' },
  ],
};
const context = { protocol: 'chat', model: 'synthetic', session: 'synthetic-session' };
async function scopeFor(directory: string) {
  return new Store(directory).scopeFor(JSON.stringify([context.session, '', '', '']));
}

test('no MCP tool leaves request untouched and creates no archive', async () => {
  await fixture(async directory => {
    const withoutTool = { ...body, tools: [] };
    assert.equal(await onRequest(withoutTool, context), withoutTool);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('Magpie timeout options are accepted and a cancelled hook leaves no archive', async () => {
  await fixture(async directory => {
    const controller = new AbortController();
    controller.abort();
    assert.equal(await onRequest(body, { ...context, signal: controller.signal }), body);
    assert.deepEqual(await readdir(directory), []);
    const result = await onRequest(body, { ...context, options: { gatewayTimeoutMs: 3000 } });
    assert.ok(JSON.stringify(result).includes('<context-folding scope='));
  });
});

test('marking, threshold, nested folding, exact paginated restoration, keep and dedup', async () => {
  await fixture(async (directory, url) => {
    const ctx = { ...context, options: { thresholdTokens: 1, keepRecentMessages: 1, accounting: { url } } };
    await onRequest(body, ctx);
    const scope = await scopeFor(directory);
    const id = extractSpans(body, 'chat').find(span => span.text === oldText)?.id;
    assert.ok(id);
    assert.equal(JSON.stringify(await onRequest(body, ctx)).includes('[context-folding id='), false);
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'foldable', summary: 'Completed research. '.repeat(100) }] });
    const first = await onRequest(body, ctx);
    assert.ok(JSON.stringify(first).includes('[context-folding id='));
    assert.ok(!JSON.stringify(first).includes(JSON.stringify(oldText).slice(1, -1)));
    assert.ok(JSON.stringify(first).includes('Important system requirement.'));
    assert.ok(JSON.stringify(first).includes('Continue with the current task.'));
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'foldable', summary: 'Research completed. '.repeat(50) }] });
    await onRequest(body, ctx);
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'foldable', summary: 'Research completed.' }] });
    await onRequest(body, ctx);
    await onRequest(body, ctx);
    const snapshot = await new Store(directory).transaction(scope, false, 64 * 1024 * 1024, snapshot => structuredClone(snapshot));
    const entry = snapshot.entries.find(entry => entry.id === id);
    assert.ok(entry);
    assert.equal(entry.layers.length, 3, 'three recursive folds must survive without duplicate layers');
    const latest = entry.layers.at(-1);
    const previous = entry.layers.at(-2);
    assert.ok(latest && previous);
    const latestRead = JSON.parse(await execute({ scope, action: 'read', id, layer: latest.id }));
    assert.equal(latestRead.previousId, previous.id);
    const previousRead = JSON.parse(await execute({ scope, action: 'read', id, layer: latestRead.previousId }));
    assert.equal(previousRead.previousId, entry.layers[0]?.id);
    const firstRead = JSON.parse(await execute({ scope, action: 'read', id, layer: previousRead.previousId }));
    assert.equal(firstRead.previousId, 'original');
    let text = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const result = JSON.parse(await execute({ scope, action: 'read', id, offset, limit: 10000 }));
      text += result.text;
      offset = result.nextOffset;
    }
    assert.equal(text, oldText);
    assert.ok(JSON.parse(await execute({ scope, action: 'forget' })).error, 'active recovery data cannot be discarded');
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'keep' }] });
    assert.ok(JSON.stringify(await onRequest(body, ctx)).includes(JSON.stringify(oldText).slice(1, -1)));
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'foldable', summary: 'Research completed.' }] });
    assert.ok(JSON.stringify(await onRequest(body, ctx)).includes('[context-folding id='));
    const reused = await new Store(directory).transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot.entries.find(entry => entry.id === id));
    assert.equal(reused?.layers.length, 3, 'folding again after keep reuses the saved layer');
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'keep' }] });
    const forgotten = JSON.parse(await execute({ scope, action: 'forget' }));
    assert.equal(forgotten.forgotten, true);
    await assert.rejects(new Store(directory).transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot), /Unknown context scope/);
    const files = await readdir(directory);
    assert.deepEqual(files, ['state.sqlite'], 'no per-request files, copies, or journal leftovers');
  });
});

test('summary-first folds preserve source roles, exact excerpt ranges and the full accounting candidate', async () => {
  for (const [role, headChars, end] of [
    ['user', 0, 0], ['assistant', 2, 1], ['tool', 3, 3], ['assistant', 6, 6],
  ] as const) {
    await fixture(async (directory, url, requests) => {
      const text = 'A😀\n"\\' + oldText;
      const history = role === 'tool' ? [
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role, tool_call_id: 'call_1', content: text },
      ] : [{ role, content: text }];
      const request = { ...body, messages: [body.messages[0]!, ...history, body.messages.at(-1)!] };
      const ctx = { ...context, options: { thresholdTokens: 1, keepRecentMessages: 1, headChars, accounting: { url } } };
      await onRequest(request, ctx);
      const scope = await scopeFor(directory);
      const span = extractSpans(request, 'chat').find(span => span.text === text);
      assert.ok(span);
      const summary = 'Tool evidence: checks passed. Assistant judgment: this step is complete.';
      await execute({ scope, action: 'mark', marks: [{ id: span.id, disposition: 'foldable', summary }] });
      const folded = await onRequest(request, ctx);
      const replacement = chatSpans(folded).find(item => item.messageIndex === span.messageIndex)?.text;
      assert.equal(replacement, `[context-folding id=${span.id} role=${role}]\nSummary (agent-written): ${summary}\nOriginal UTF-16: inline [0,${end}); archived [0,${text.length})\nOpening: ${JSON.stringify(text.slice(0, end))}\nOriginal/layers: context_folding read id=${span.id}`);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0]?.before, request);
      assert.deepEqual(requests[0]?.after, folded, 'metadata and the entire guide must be charged');
      assert.ok(JSON.stringify(requests[0]?.after).includes(`<context-folding scope=${scope}>`));
      assert.equal(JSON.parse(await execute({ scope, action: 'read', id: span.id, limit: 6 })).text, text.slice(0, 6));
    });
  }
});

test('full representation must shrink even when the summary alone is shorter', async () => {
  await fixture(async (directory, url, requests) => {
    const text = 'Short historical text.';
    const request = { ...body, messages: [{ role: 'assistant', content: text }, body.messages.at(-1)!] };
    const ctx = { ...context, options: { thresholdTokens: 1, keepRecentMessages: 1, headChars: 1000, accounting: { url } } };
    await onRequest(request, ctx);
    const scope = await scopeFor(directory);
    const id = extractSpans(request, 'chat')[0]!.id;
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'foldable', summary: 'Done.' }] });
    assert.equal(chatSpans(await onRequest(request, ctx))[0]?.text, text);
    assert.equal(requests.length, 0, 'an expanding representation must not reach accounting');
    assert.equal(JSON.parse(await execute({ scope, action: 'status' })).decision.reason, 'no-marked-smaller-candidates');
    const entry = await new Store(directory).transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot.entries.find(entry => entry.id === id));
    assert.equal(entry?.folded, undefined);
    assert.deepEqual(entry?.layers, []);
  });
});

test('legacy layers replay unchanged and remain recoverable after a new summary-first fold', async () => {
  await fixture(async (directory, url, requests) => {
    await onRequest(body, context);
    const scope = await scopeFor(directory);
    const id = extractSpans(body, 'chat').find(span => span.text === oldText)!.id;
    const summary = 'Legacy completed research. '.repeat(50);
    const legacy = `[context-folding id=${id}]\nOpening: ${oldText.slice(0, 160)}\nSummary: ${summary}\nOriginal/layers: context_folding read id=${id}`;
    const layerId = digest(JSON.stringify(legacy)).slice(0, 24);
    await new Store(directory).transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      const entry = snapshot.entries.find(entry => entry.id === id)!;
      entry.mark = { disposition: 'foldable', summary };
      entry.folded = legacy;
      entry.layers.push({ id: layerId, text: legacy, previousId: 'original' });
    });
    const replay = await onRequest(body, { ...context, options: { keepRecentMessages: 1 } });
    assert.equal(chatSpans(replay)[0]?.text, legacy);
    assert.equal(requests.length, 0);
    assert.equal(JSON.parse(await execute({ scope, action: 'read', id, layer: layerId })).text, legacy);
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'foldable', summary: 'Research complete.' }] });
    const updated = await onRequest(body, { ...context, options: { thresholdTokens: 1, keepRecentMessages: 1, accounting: { url } } });
    assert.ok(chatSpans(updated)[0]?.text.includes('Summary (agent-written): Research complete.'));
    assert.equal(chatSpans(requests[0]?.before)[0]?.text, legacy);
    const entry = await new Store(directory).transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot.entries.find(entry => entry.id === id));
    assert.equal(entry?.layers.length, 2);
    const latest = JSON.parse(await execute({ scope, action: 'read', id, layer: entry!.layers[1]!.id }));
    assert.equal(latest.previousId, layerId);
    assert.equal(JSON.parse(await execute({ scope, action: 'read', id, layer: latest.previousId })).previousId, 'original');
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'keep' }] });
    assert.equal(chatSpans(await onRequest(body, context))[0]?.text, oldText);
  });
});

test('missing accounting refuses folding and unknown marks are atomic', async () => {
  await fixture(async directory => {
    const ctx = { ...context, options: { thresholdTokens: 1, keepRecentMessages: 1 } };
    await onRequest(body, ctx);
    const scope = await scopeFor(directory);
    const id = extractSpans(body, 'chat').find(span => span.text === oldText)?.id;
    assert.ok(id);
    const bad = JSON.parse(await execute({ scope, action: 'mark', marks: [
      { id, disposition: 'foldable', summary: 'summary' }, { id: 'missing', disposition: 'keep' },
    ] }));
    assert.ok(bad.error);
    const before = JSON.parse(await execute({ scope, action: 'list' }));
    assert.equal(before.entries.find((entry: { id: string }) => entry.id === id).disposition, 'unmarked');
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'foldable', summary: 'summary' }] });
    const result = await onRequest(body, ctx);
    assert.ok(JSON.stringify(result).includes(JSON.stringify(oldText).slice(1, -1)));
    const status = JSON.parse(await execute({ scope, action: 'status' }));
    assert.equal(status.decision.reason, 'trusted-accounting-required');
    assert.ok(JSON.parse(await execute({ scope: '0'.repeat(64), action: 'read', id })).error);
  });
});

test('threshold and archive limit keep the original safe', async () => {
  await fixture(async (directory, url) => {
    assert.equal(await onRequest(body, { ...context, options: { maxSessionBytes: 1 } }), body);
    const ctx = { ...context, options: { thresholdTokens: 10_000_000, keepRecentMessages: 1, accounting: { url } } };
    await onRequest(body, ctx);
    const scope = await scopeFor(directory);
    const id = extractSpans(body, 'chat').find(span => span.text === oldText)?.id;
    assert.ok(id);
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'foldable', summary: 'summary' }] });
    assert.ok(JSON.stringify(await onRequest(body, ctx)).includes(JSON.stringify(oldText).slice(1, -1)));
    assert.equal(JSON.parse(await execute({ scope, action: 'status' })).decision.reason, 'below-threshold');
  });
});

test('completed steps in a long turn can fold while the original user request stays protected', async () => {
  await fixture(async (directory, url) => {
    const messages = [
      { role: 'user', content: 'Current task requirements must remain.' },
      { role: 'assistant', content: oldText },
      ...Array.from({ length: 12 }, (_, index) => ({ role: 'assistant', content: `Completed step ${index}` })),
    ];
    const request = { ...body, messages };
    const ctx = { ...context, options: { thresholdTokens: 1, keepRecentMessages: 2, accounting: { url } } };
    await onRequest(request, ctx);
    const scope = await scopeFor(directory);
    const id = extractSpans(request, 'chat').find(span => span.text === oldText)?.id;
    assert.ok(id);
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'foldable', summary: 'Past steps complete.' }] });
    const encoded = JSON.stringify(await onRequest(request, ctx));
    assert.ok(encoded.includes('[context-folding id='));
    assert.ok(encoded.includes('Current task requirements must remain.'));
    assert.ok(encoded.includes('Completed step 11'));
  });
});
