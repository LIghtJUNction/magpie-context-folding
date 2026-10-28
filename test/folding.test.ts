import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { onRequest } from '../src/context.hooks.js';
import { execute } from '../src/tool.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { withoutBudget } from '../src/budget.js';
import { digest } from '../src/store.js';
import { conversationRangesFromMarkers, selectConversationRange } from '../src/ranges.js';
import { conversationId } from '../src/fold.js';
import { bodyFor, fixture, marked, payload, progress } from './helpers.js';

const folded = (value: unknown) => /\[\[cf:v[23]:/.test(JSON.stringify(value));
const tool = async (args: unknown) => JSON.parse(await execute(args));
const selectionFor = (body: Record<string, unknown>, protocol: Protocol) => {
  const range = conversationRangesFromMarkers(body, protocol)[0];
  assert.ok(range, 'fixture has a valid explicit conversation range');
  return selectConversationRange(body, protocol, range.range);
};

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: markers fold after a distinct request, retries keep the grace period, and exact read keeps originals`, async () => {
    await fixture(async ({ context, store, scope }) => {
      const input = bodyFor(protocol);
      const selection = selectionFor(input, protocol);
      const first = await onRequest(input, context) as Record<string, unknown>;
      assert.equal(folded(first), false);
      assert.deepEqual(withoutBudget(first, protocol), input);
      assert.equal(folded(await onRequest(input, context)), false, 'an identical retry must not consume the grace period');
      const nextInput = progress(input, protocol);
      const next = await onRequest(nextInput, context) as Record<string, unknown>;
      assert.equal(folded(next), true);
      const refs = extractSpans(next, protocol).filter(span => folded(span.text));
      assert.equal(refs.length, 1);
      assert.equal(refs[0]!.role, 'user');
      assert.ok(refs[0]!.text.includes(`[[cf:v3:${conversationId(selection).slice(0, 12)} path=`));
      assert.match(refs[0]!.text, /lightweight subagent/);
      assert.match(refs[0]!.text, /rg\/grep/);
      assert.doesNotMatch(refs[0]!.text, /@context-fold begin/);
      assert.equal((await store.readStats(scope)).metrics.itemsFolded, 1);
      assert.equal(folded(await onRequest(nextInput, context)), true);
      assert.equal((await store.readStats(scope)).metrics.itemsFolded, 1, 'replay is not a new fold');
      const recovered = await tool({ action: 'read', scope, id: conversationId(selection).slice(0, 12), limit: 24000 });
      assert.equal(recovered.text, selection.text);
      assert.equal(recovered.sha256, digest(selection.text), 'read checksum describes its text, while the reference identifies the canonical transcript');
      assert.equal(await readFile(recovered.path, 'utf8'), selection.text);
      assert.equal(await readFile(recovered.transcriptPath, 'utf8'), selection.transcript);
      assert.ok(refs[0]!.text.includes(JSON.stringify(recovered.path)));
      assert.equal(recovered.kept, true);
      assert.equal(folded(await onRequest(nextInput, context)), false, 'recovered content stays visible');
    }, protocol);
  });
}

test('large unmarked history stays byte-for-byte intact even with no available budget', async () => {
  await fixture(async ({ context, scope, store }) => {
    const input = bodyFor('chat', payload.repeat(10));
    const output = await onRequest(input, { ...context, options: { contextWindowTokens: 10, reserveOutputTokens: 10, delayRequests: 0 } }) as Record<string, unknown>;
    assert.equal(folded(output), false);
    assert.deepEqual(withoutBudget(output, 'chat'), input);
    const snapshot = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot);
    assert.equal(snapshot.entries.length, 0, 'unmarked text does not incur archive work');
    assert.match(JSON.stringify(output), /available_estimate=0/);
  });
});

test('an open block can archive a complete tool exchange as one user reference', async () => {
  await fixture(async ({ context, scope }) => {
    const call = { role: 'assistant', content: '@context-fold begin job\n' + payload,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'exec', arguments: JSON.stringify({ code: 'run()' }) } }] };
    const result = { role: 'tool', tool_call_id: 'c', content: marked('Tool output must remain literal. '.repeat(300)) };
    const input = { ...bodyFor('chat'), messages: [{ role: 'user', content: 'Start' }, call, result] };
    assert.equal(folded(await onRequest(input, context)), false);
    const closed = { ...input, messages: [...input.messages, { role: 'assistant', content: 'continued\n@context-fold end job' }] };
    const selection = selectionFor(closed, 'chat');
    assert.equal(folded(await onRequest(closed, context)), false);
    const output = await onRequest(progress(closed, 'chat'), context) as Record<string, unknown>;
    const clean = withoutBudget(output, 'chat').messages as Record<string, unknown>[];
    assert.equal(clean.length, 3);
    assert.equal(clean[1]!.role, 'user');
    assert.equal(folded(clean[1]!.content), true);
    assert.deepEqual(clean[0], input.messages[0]);
    assert.equal(clean[2]!.content, 'A new step.');
    const recovered = await tool({ action: 'read', scope, id: conversationId(selection).slice(0, 12), limit: 24000 });
    assert.equal(recovered.text, selection.text);
    const records = (await readFile(recovered.transcriptPath, 'utf8')).trimEnd().split('\n').slice(1).map(line => JSON.parse(line));
    assert.deepEqual(records.map(item => item.original), closed.messages.slice(1));
    assert.deepEqual(records[0].original.tool_calls, call.tool_calls);
    assert.deepEqual(records[1].original, result);
  });
});

test('an explicitly closed range crosses user turns and records their original role', async () => {
  await fixture(async ({ context, scope }) => {
    const input = { ...bodyFor('chat'), messages: [
      { role: 'assistant', content: '@context-fold begin task\n' + payload },
      { role: 'user', content: 'Historical user constraint.\n' + payload },
      { role: 'assistant', content: 'more\n@context-fold end task' },
    ] };
    const selection = selectionFor(input, 'chat');
    const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    const messages = withoutBudget(output, 'chat').messages as Record<string, unknown>[];
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.role, 'user');
    assert.equal(folded(messages[0]), true);
    const recovered = await tool({ action: 'read', scope, id: conversationId(selection).slice(0, 12), limit: 24000, peek: true });
    const originals = (await readFile(recovered.transcriptPath, 'utf8')).trimEnd().split('\n').slice(1).map(line => JSON.parse(line).original);
    assert.deepEqual(originals, input.messages);
  });
});

test('disabled, cancelled, oversized or ambiguous requests retain the exact input', async () => {
  await fixture(async ({ context }) => {
    const input = bodyFor('chat');
    assert.equal(await onRequest(input, { ...context, options: { enabled: false } }), input);
    assert.equal(await onRequest(input, { ...context, signal: AbortSignal.abort() }), input);
    assert.equal(await onRequest(input, { ...context, options: { delayRequests: 0, maxSessionBytes: 10 } }), input);
    const pending = { ...input, messages: [{ role: 'assistant', content: marked(),
      tool_calls: [{ id: 'pending', type: 'function', function: { name: 'exec', arguments: '{}' } }] }] };
    assert.equal(await onRequest(pending, { ...context, options: { delayRequests: 0 } }), pending);
  });
});

test('filesystem recovery works without MCP tools, including tool_choice none', async () => {
  await fixture(async ({ context, scope }) => {
    const input = { ...bodyFor('chat'), tools: [] };
    const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    assert.equal(folded(output), true);
    assert.deepEqual(output.tools, []);
    const id = conversationId(selectionFor(input, 'chat'));
    const recovered = await tool({ action: 'read', scope, id, peek: true });
    assert.match(await readFile(recovered.path, 'utf8'), /role assistant/);
    assert.equal(folded(await onRequest({ ...input, tool_choice: 'none' }, { ...context, options: { delayRequests: 0 } })), true);
  });
});

test('hosts that cannot access archive files get only budget metadata', async () => {
  await fixture(async ({ context, store }) => {
    const input = bodyFor('chat');
    const output = await onRequest(input, { ...context, options: { delayRequests: 0, fileAccess: false } }) as Record<string, unknown>;
    assert.deepEqual(withoutBudget(output, 'chat'), input);
    assert.equal((await store.readStats()).storage.activeSessions, 0);
    assert.doesNotMatch(JSON.stringify(output), /scope=/);
  });
});

test('malformed and tiny annotated blocks remain readable', async () => {
  await fixture(async ({ context }) => {
    for (const text of [marked('x'), marked('😀é'), '@context-fold begin x\n' + payload,
      '@context-fold begin x\n@context-fold begin y\n' + payload + '\n@context-fold end y\n@context-fold end x']) {
      const input = bodyFor('chat', text);
      const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
      assert.deepEqual(withoutBudget(output, 'chat'), input);
    }
  });
});

test('ranges crossing non-text attachments remain intact in all four protocols', async () => {
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) await fixture(async ({ context }) => {
    const input = bodyFor(protocol);
    if (protocol === 'gemini') input.contents = [
      { role: 'model', parts: [{ text: '@context-fold begin x\n' + payload }] },
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] },
      { role: 'model', parts: [{ text: 'more\n@context-fold end x' }] }, { role: 'user', parts: [] },
    ];
    else {
      const key = protocol === 'responses' ? 'input' : 'messages';
      input[key] = [
        { role: 'assistant', content: '@context-fold begin x\n' + payload },
        { role: 'user', content: [{ type: protocol === 'anthropic' ? 'image' : 'input_image', data: 'AA==' }] },
        { role: 'assistant', content: 'more\n@context-fold end x' }, { role: 'user', content: '' },
      ];
    }
    const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    assert.deepEqual(withoutBudget(output, protocol), input);
  }, protocol);
});

test('a new open block does not revive previously completed work', async () => {
  await fixture(async ({ context }) => {
    const text = marked() + '\n@context-fold begin active\nStill working.';
    const input = bodyFor('chat', text);
    const output = await onRequest(input, { ...context, options: { delayRequests: 0 } });
    assert.equal(folded(output), true);
    assert.match(JSON.stringify(output), /Still working/);
  });
});

test('earlier folding in the same message cannot restart a later block grace period', async () => {
  await fixture(async ({ context }) => {
    const a = marked('A'.repeat(1200));
    const b = marked('B'.repeat(1200)).replaceAll('research', 'later');
    const first = bodyFor('chat', a);
    await onRequest(first, context);
    const second = bodyFor('chat', a + '\n' + b);
    const projected = await onRequest(second, context) as Record<string, unknown>;
    const text = extractSpans(projected, 'chat').map(span => span.text).join('');
    assert.equal(text.includes('A'.repeat(1200)), false);
    assert.equal(text.includes('B'.repeat(1200)), true);
    const third = await onRequest(progress(projected, 'chat'), context) as Record<string, unknown>;
    const after = extractSpans(third, 'chat').map(span => span.text).join('');
    assert.equal(after.includes('B'.repeat(1200)), false);
    assert.equal(after.match(/\[\[cf:v3:/g)?.length, 2);
  });
});

test('multiple marked slices inside one message preserve all unselected Unicode text', async () => {
  await fixture(async ({ context, store, scope }) => {
    const input = bodyFor('chat', '前😀\n' + marked(payload) + '\n中间é\n' + marked(payload + 'second').replaceAll('research', 'second') + '\n最后');
    const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    const spans = extractSpans(output, 'chat');
    assert.deepEqual(spans.filter(span => span.role === 'assistant').map(span => span.text), ['前😀\n', '中间é\n', '最后']);
    assert.equal(spans.filter(span => folded(span.text)).length, 2);
    assert.equal((await store.readStats(scope)).metrics.itemsFolded, 2);
  });
});

test('archive publication failure never releases a changed conversation', async () => {
  await fixture(async ({ context, directory }) => {
    await mkdir(join(directory, 'state'), { recursive: true });
    await writeFile(join(directory, 'state', 'archives'), 'not a directory');
    const input = bodyFor('chat');
    assert.equal(await onRequest(input, { ...context, options: { delayRequests: 0 } }), input);
  });
});

test('a reappearing annotated occurrence gets a fresh observation period', async () => {
  await fixture(async ({ context }) => {
    const input = bodyFor('chat');
    await onRequest(input, context);
    assert.equal(folded(await onRequest(progress(input, 'chat'), context)), true);
    const absent = bodyFor('chat', 'unmarked work');
    await onRequest(absent, context);
    await onRequest(progress(absent, 'chat'), context);
    const returned = progress(progress(input, 'chat'), 'chat');
    assert.equal(folded(await onRequest(returned, context)), false);
    assert.equal(folded(await onRequest(progress(returned, 'chat'), context)), true);
  });
});
