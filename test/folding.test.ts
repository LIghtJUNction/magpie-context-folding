import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { onRequest, onResponse } from '../src/context.hooks.js';
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
      incremental: { toolCalls: 0, modelRoundTrips: 0, inputTokens: 0, outputTokens: 0,
        inputPricePerMillion: 0, outputPricePerMillion: 0, toolFeesUsd: 0 },
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

test('no MCP tool still reports budget without creating an archive', async () => {
  await fixture(async directory => {
    const withoutTool = { ...body, tools: [] };
    const result = await onRequest(withoutTool, context);
    assert.ok(JSON.stringify(result).includes('<context-budget>'));
    assert.ok(!JSON.stringify(result).includes('Capacity:'));
    assert.ok(!JSON.stringify(result).includes('<context-folding scope='));
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
    const latestRead = JSON.parse(await execute({ scope, action: 'read', id, layer: latest.id, peek: true }));
    assert.equal(latestRead.previousId, previous.id);
    const previousRead = JSON.parse(await execute({ scope, action: 'read', id, layer: latestRead.previousId, peek: true }));
    assert.equal(previousRead.previousId, entry.layers[0]?.id);
    const firstRead = JSON.parse(await execute({ scope, action: 'read', id, layer: previousRead.previousId, peek: true }));
    assert.equal(firstRead.previousId, 'original');
    let text = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const result = JSON.parse(await execute({ scope, action: 'read', id, offset, limit: 10000, peek: true }));
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
      const ctx = { ...context, options: { thresholdTokens: 1, keepRecentMessages: 1, headChars, accounting: { url }, policy: { autoRoles: [] } } };
      await onRequest(request, ctx);
      const scope = await scopeFor(directory);
      const span = extractSpans(request, 'chat').find(span => span.text === text);
      assert.ok(span);
      const summary = 'Tool evidence: checks passed.\n助手判断：已完成 😀；保留 "引号"、\\路径和双  空格。';
      await execute({ scope, action: 'mark', marks: [{ id: span.id, disposition: 'foldable', summary }] });
      const folded = await onRequest(request, ctx);
      const replacement = chatSpans(folded).find(item => item.messageIndex === span.messageIndex)?.text;
      assert.equal(replacement, `[context-folding id=${span.id} role=${role}]\nSummary (agent-written): ${summary}\nOriginal UTF-16: inline [0,${end}); archived [0,${text.length})\nOpening: ${JSON.stringify(text.slice(0, end))}`);
      assert.equal(replacement!.split(span.id).length - 1, 1, 'entry ID occurs only in the header');
      assert.ok(!replacement!.includes('context_folding read'));
      assert.deepEqual((folded as typeof request).tools, request.tools);
      assert.equal((folded as typeof request).messages.length, request.messages.length);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0]?.before, request);
      assert.deepEqual(requests[0]?.after, folded, 'metadata and the entire guide must be charged');
      assert.ok(JSON.stringify(requests[0]?.after).includes(`<context-folding scope=${scope}>`));
      assert.ok(JSON.stringify(requests[0]?.after).includes('Need source-folding guidance? Copy the whole skill directory https://github.com/LIghtJUNction/magpie-context-folding/tree/main/context-folding/skills/context-folding into a skills directory your host already discovers.'));
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
    assert.equal(JSON.parse(await execute({ scope, action: 'read', id, layer: layerId, peek: true })).text, legacy);
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'foldable', summary: 'Research complete.' }] });
    const updated = await onRequest(body, { ...context, options: { thresholdTokens: 1, keepRecentMessages: 1, headChars: 0, accounting: { url }, policy: { autoRoles: [] } } });
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

test('legacy group replay stays exact until compact group and child identities pass the cost gate', async () => {
  await fixture(async (directory, url, requests) => {
    const history = Array.from({ length: 24 }, (_, index) => index % 2 === 0
      ? { role: 'assistant', content: `Completed reasoning ${index}. `.repeat(100) }
      : { role: 'tool', tool_call_id: `call_${index}`, content: `Tool evidence ${index}. `.repeat(100) });
    const messages = history.flatMap((message, index) => message.role === 'tool'
      ? [{ role: 'assistant', content: null, tool_calls: [{ id: `call_${index}`, type: 'function', function: { name: 'read', arguments: '{}' } }] }, message]
      : [message]);
    const request = { ...body, messages: [...messages, body.messages.at(-1)!] };
    const options = { thresholdTokens: 1, keepRecentMessages: 1, policy: { mode: 'cost', autoRoles: [] } };
    await onRequest(request, { ...context, options });
    const scope = await scopeFor(directory);
    const spans = extractSpans(request, 'chat').slice(0, history.length);
    const inner = JSON.parse(await execute({ scope, action: 'mark', marks: [{ ids: spans.slice(0, 2).map(span => span.id), disposition: 'foldable', summary: 'Inner evidence.' }] })).groups[0];
    const summary = 'Group evidence: 原样 😀\n"quotes", \\path and double  spaces.';
    const children = [inner, ...spans.slice(2).map(span => span.id)];
    const groupId = JSON.parse(await execute({ scope, action: 'mark', marks: [{ ids: children, disposition: 'foldable', summary }] })).groups[0];
    const legacy = `[context-folding group=${groupId}]\nSummary (agent-written): ${summary}\nOriginals: context_folding read id=${groupId}; read each child ID for exact original/layers.`;
    const store = new Store(directory);
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => { snapshot.groups!.find(group => group.id === groupId)!.folded = legacy; });
    const previous = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => structuredClone(snapshot));
    const denied = await onRequest(request, { ...context, options });
    assert.deepEqual(chatSpans(denied).slice(0, spans.length).map(span => span.text), spans.map((span, index) => index === 0 ? legacy
      : `[context-folding group=${groupId} id=${span.id} role=${span.role}; summary above; original: context_folding read id=${span.id}]`));
    assert.equal(JSON.parse(await execute({ scope, action: 'status' })).decision.reason, 'policy-cost-bounds-missing');
    assert.deepEqual(await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot.groups), previous.groups);
    const ctx = { ...context, options: { ...options, accounting: { url } } };
    const folded = await onRequest(request, ctx);
    assert.equal(requests.length, 1);
    assert.deepEqual(chatSpans(requests[0]!.before).slice(0, spans.length).map(span => span.text), chatSpans(denied).slice(0, spans.length).map(span => span.text));
    assert.deepEqual(requests[0]!.after, folded);
    for (const [index, span] of spans.entries()) {
      assert.equal(chatSpans(folded)[index]!.text, index === 0
        ? `[context-folding group=${groupId} id=${span.id} role=${span.role}]\nSummary (agent-written): ${summary}`
        : `[context-folding group=${groupId} id=${span.id} role=${span.role}; summary above]`);
      assert.equal(JSON.parse(await execute({ scope, action: 'read', id: span.id, limit: 24000, peek: true })).text, history[index]!.content);
    }
    const manifest = JSON.parse(JSON.parse(await execute({ scope, action: 'read', id: groupId, peek: true })).text);
    assert.deepEqual(manifest, { id: groupId, summary, children });
    assert.deepEqual(JSON.parse(JSON.parse(await execute({ scope, action: 'read', id: inner, peek: true })).text).children, spans.slice(0, 2).map(span => span.id));
    assert.deepEqual((folded as typeof request).tools, request.tools);
    assert.equal((folded as typeof request).messages.length, request.messages.length);
    assert.deepEqual(await onRequest(request, ctx), folded);
    assert.equal(requests.length, 1, 'compact group replay must not create another batch');
    const reordered = { ...request, messages: [messages[1]!, messages[2]!, messages[0]!, ...messages.slice(3), body.messages.at(-1)!] };
    const rebound = chatSpans(await onRequest(reordered, ctx));
    assert.equal(rebound[0]!.text, `[context-folding group=${groupId} id=${spans[1]!.id} role=tool]\nSummary (agent-written): ${summary}`);
    assert.equal(rebound[1]!.text, `[context-folding group=${groupId} id=${spans[0]!.id} role=assistant; summary above]`);
    assert.equal(requests.length, 1, 'reordering group members only rebinds leaf metadata');
    assert.deepEqual(await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot.entries), previous.entries);
  });
});

test('explicit byte policy folds without accounting and unknown marks are atomic', async () => {
  await fixture(async directory => {
    const ctx = { ...context, options: { thresholdTokens: 1, keepRecentMessages: 1, policy: { mode: 'bytes' } } };
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
    assert.ok(!JSON.stringify(result).includes(JSON.stringify(oldText).slice(1, -1)));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(JSON.stringify(body)));
    const status = JSON.parse(await execute({ scope, action: 'status' }));
    assert.equal(status.decision.reason, 'bytes-smaller-no-cost-proof');
    assert.equal(status.folded, 1);
    assert.ok(JSON.parse(await execute({ scope: '0'.repeat(64), action: 'read', id })).error);
  });
});

test('explicit cost gate refuses marked folds without evidence while recovery remains usable when disabled', async () => {
  await fixture(async directory => {
    const ctx = { ...context, options: { thresholdTokens: 1, keepRecentMessages: 0, policy: { mode: 'cost' } } };
    await onRequest(body, ctx);
    const scope = await scopeFor(directory);
    const id = extractSpans(body, 'chat').find(span => span.text === oldText)!.id;
    await execute({ scope, action: 'mark', marks: [{ id, disposition: 'foldable', summary: 'Completed research.' }] });
    const output = await onRequest(body, ctx);
    assert.equal(chatSpans(output).find(span => span.id === id)?.text, oldText);
    assert.equal(JSON.parse(await execute({ scope, action: 'status' })).decision.reason, 'policy-cost-bounds-missing');
    assert.equal(await onRequest(body, { ...context, options: { enabled: false } }), body);
    const recovered = JSON.parse(await execute({ scope, action: 'read', id, limit: 10 }));
    assert.equal(recovered.text, oldText.slice(0, 10));
    assert.equal(recovered.kept, true);
  });
});

test('script gets only eligible originals and a missing summary uses truthful recovery fallback', async () => {
  await fixture(async directory => {
    const request = { ...body, messages: [
      { role: 'user', content: 'Current user requirements.' },
      { role: 'assistant', content: oldText },
      { role: 'assistant', content: 'Keep this explicit decision.' },
      { role: 'assistant', content: 'Leave this explicitly unmarked.' },
    ] };
    await onRequest(request, context);
    const scope = await scopeFor(directory);
    const spans = extractSpans(request, 'chat');
    const id = spans[1]!.id;
    await execute({ scope, action: 'mark', marks: [
      { id: spans[2]!.id, disposition: 'keep' },
      { id: spans[3]!.id, disposition: 'unmarked' },
    ] });
    const source = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
      const request=JSON.parse(input);
      if(request.spans.length!==1||request.spans[0].id!==${JSON.stringify(id)})process.exit(2);
      process.stdout.write(JSON.stringify({marks:[{id:request.spans[0].id,disposition:'foldable'}]}));
    });`;
    const output = await onRequest(request, { ...context, options: {
      thresholdTokens: 1, keepRecentMessages: 0,
      policy: { mode: 'bytes', minChars: 0, autoRoles: ['user', 'assistant'],
        script: { command: [process.execPath, '-e', source] } },
    } });
    const result = chatSpans(output);
    assert.ok(result[1]!.text.includes('Summary (automatic policy): Archived assistant text'));
    assert.ok(result[1]!.text.includes('read the original for details'));
    for (const index of [0, 2, 3]) assert.equal(result[index]!.text, spans[index]!.text);
    const saved = await new Store(directory).transaction(scope, false, 64 * 1024 * 1024,
      snapshot => snapshot.entries.find(entry => entry.id === id));
    assert.equal(saved?.text, oldText);
    assert.equal(saved?.manual, false);
    assert.equal(saved?.layers.length, 1);
  });
});

test('switching models keeps a self-inclusive estimate without plugin-owned capacity or archiving', async () => {
  await fixture(async directory => {
    for (const model of ['small-window-model', 'large-window-model']) {
      const request = { ...body, model, messages: [] };
      const output = await onRequest(request, { ...context, model });
      const text = JSON.stringify(output);
      const used = Number(text.match(/length estimate: (\d+) tokens/)?.[1]);
      assert.equal(used, Math.ceil(Buffer.byteLength(text) / 4));
      assert.ok(!text.includes('Capacity:'));
      assert.ok(!text.includes('used ratio'));
      assert.ok(!text.includes('remaining'));
      assert.ok(!text.includes('<context-folding scope='));
    }
    assert.deepEqual(await readdir(directory), []);
  });
});

test('hook configuration errors return the original and redact unknown secret names and values', async () => {
  await fixture(async directory => {
    const messages: string[] = [];
    const previous = console.error;
    console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
    try {
      assert.equal(await onRequest(body, { ...context, options: { 'secret-key-token': 'secret-value' } }), body);
    } finally { console.error = previous; }
    assert.equal(messages.length, 1);
    assert.ok(messages[0]!.includes('[context-folding]'));
    assert.ok(!messages[0]!.includes('secret-key-token'));
    assert.ok(!messages[0]!.includes('secret-value'));
    assert.deepEqual(await readdir(directory), []);
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

test('disabled folding preserves recovery and clears stale request statistics', async () => {
  await fixture(async directory => {
    await onRequest(body, context);
    const scope = await scopeFor(directory);
    const id = extractSpans(body, 'chat').find(span => span.text === oldText)!.id;
    const state: Record<string, unknown> = { contextFoldingStatistics: { stale: true } };
    assert.equal(await onRequest(body, { ...context, state, options: { enabled: false } }), body);
    assert.equal(state.contextFoldingStatistics, undefined);
    const recovered = JSON.parse(await execute({ action: 'read', scope, id, peek: true, limit: 100 }));
    assert.equal(recovered.text, oldText.slice(0, 100));
  });
});

test('automatic scripts see only safe undecided spans and missing summaries retain truthful attribution', async () => {
  await fixture(async directory => {
    const texts = ['historical assistant A ', 'manual kept B ', 'manual unmarked C ', 'current user D ', 'recent assistant E ']
      .map(text => text.repeat(500));
    const request = { ...body, messages: texts.map((content, index) => ({ role: index === 3 ? 'user' : 'assistant', content })) };
    await onRequest(request, context);
    const scope = await scopeFor(directory);
    const spans = extractSpans(request, 'chat');
    await execute({ action: 'mark', scope, marks: [
      { id: spans[1]!.id, disposition: 'keep' }, { id: spans[2]!.id, disposition: 'unmarked' },
    ] });
    const capture = join(directory, 'candidate-input.json');
    const script = { command: [process.execPath, '--eval',
      `let input='';for await(const chunk of process.stdin)input+=chunk;const value=JSON.parse(input);await Bun.write(${JSON.stringify(capture)},input);console.log(JSON.stringify({marks:value.spans.map(span=>({id:span.id,disposition:'foldable'}))}));`] };
    const options = { thresholdTokens: 1, keepRecentMessages: 1, policy: { mode: 'bytes', minChars: 1,
      autoRoles: ['user', 'assistant'], script } };
    const output = await onRequest(request, { ...context, options });
    const candidates = JSON.parse(await readFile(capture, 'utf8')).spans;
    assert.deepEqual(candidates.map((span: { id: string }) => span.id), [spans[0]!.id]);
    assert.ok(chatSpans(output)[0]!.text.includes('Summary (automatic policy): Archived assistant text'));
    for (let index = 1; index < texts.length; index++) assert.ok(chatSpans(output)[index]!.text.startsWith(texts[index]!));
    await execute({ action: 'mark', scope, marks: [{ id: spans[0]!.id, disposition: 'keep' }] });
    assert.ok(chatSpans(await onRequest(request, { ...context, options }))[0]!.text.startsWith(texts[0]!));
    const pendingCall = { ...request, messages: [...request.messages, { role: 'assistant', content: '',
      tool_calls: [{ id: 'pending', type: 'function', function: { name: 'read', arguments: '{}' } }] }] };
    await rm(capture);
    assert.deepEqual(await onRequest(pendingCall, { ...context, options }), pendingCall);
    assert.ok(!(await readdir(directory)).includes('candidate-input.json'));
  });
});

test('zero recent messages allows the final completed assistant span while retaining current user text', async () => {
  await fixture(async () => {
    const request = { ...body, messages: [{ role: 'user', content: 'Current task.' }, { role: 'assistant', content: oldText }] };
    const output = await onRequest(request, { ...context, options: { thresholdTokens: 1, keepRecentMessages: 0,
      policy: { mode: 'bytes', autoRoles: ['user', 'assistant'], minChars: 1 } } });
    assert.ok(chatSpans(output)[0]!.text.startsWith('Current task.'));
    assert.ok(chatSpans(output)[1]!.text.includes('Summary (automatic policy):'));
  });
});

test('accounting endpoint wins over script and configured cost; a failing selected script refuses fallback', async () => {
  await fixture(async (directory, url, requests) => {
    const policy = { autoRoles: ['user'], minChars: 1,
      certificateScript: { command: ['/nonexistent-context-folding-certificate'] },
      cost: { bytesPerTokenLower: 4, bytesPerTokenUpper: 4,
        input: { lower: 1, upper: 1 }, cacheRead: { lower: 1, upper: 1 }, cacheWrite: { lower: 1, upper: 1 } } };
    const options = { thresholdTokens: 1, keepRecentMessages: 1, policy };
    const refused = await onRequest(body, { ...context, options });
    assert.equal(chatSpans(refused)[0]!.text, oldText);
    const scope = await scopeFor(directory);
    assert.equal(JSON.parse(await execute({ action: 'status', scope })).decision.reason, 'policy-certificate-script-failed');
    const output = await onRequest(body, { ...context, options: { ...options, accounting: { url } } });
    assert.ok(chatSpans(output)[0]!.text.includes('Summary (automatic policy):'));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]!.before, body);
    assert.deepEqual(requests[0]!.after, output);
  });
});

test('byte approvals update estimates but never certify token or fee savings', async () => {
  await fixture(async directory => {
    const state = {};
    const output = await onRequest(body, { ...context, state, options: { thresholdTokens: 1, keepRecentMessages: 1,
      policy: { mode: 'bytes', autoRoles: ['user'], minChars: 1 } } });
    await onResponse({}, { state, success: true, request: output });
    const metrics = (await new Store(directory).readStats(await scopeFor(directory))).metrics;
    assert.equal(metrics.successfulFoldedRequests, 1);
    assert.ok(BigInt(metrics.estimatedTokenDelta) > 0n);
    assert.equal(metrics.certifiedComparisons, 0);
    assert.equal(metrics.certifiedTokenDeltaLower, '0');
    assert.equal(metrics.savingNanoUsdLower, '0');
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
