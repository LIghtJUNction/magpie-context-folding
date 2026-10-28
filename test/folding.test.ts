import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { execute } from '../src/tool.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { withoutBudget } from '../src/budget.js';
import { digest } from '../src/store.js';
import { bodyFor, fixture, marked, payload, progress } from './helpers.js';

const folded = (value: unknown) => JSON.stringify(value).includes('[[cf:v2:');
const tool = async (args: unknown) => JSON.parse(await execute(args));

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: markers wait through retries, read preserves folding, and explicit restore keeps originals`, async () => {
    await fixture(async ({ context, store, scope }) => {
      const input = bodyFor(protocol);
      const first = await onRequest(input, context) as Record<string, unknown>;
      assert.equal(folded(first), false);
      assert.deepEqual(withoutBudget(first, protocol), input);
      assert.equal(folded(await onRequest(input, context)), false, 'an identical retry must not consume the grace period');
      const nextInput = progress(input, protocol);
      const next = await onRequest(nextInput, context) as Record<string, unknown>;
      assert.equal(folded(next), true);
      const texts = extractSpans(next, protocol).filter(span => span.role === 'assistant').map(span => span.text).join('');
      assert.ok(texts.includes(`[[cf:v2:${digest(payload).slice(0, 12)}]]`));
      assert.ok(texts.includes('@context-fold begin research'));
      assert.equal((await store.readStats(scope)).metrics.itemsFolded, 1);
      assert.equal(folded(await onRequest(nextInput, context)), true);
      assert.equal((await store.readStats(scope)).metrics.itemsFolded, 1, 'replay is not a new fold');
      const recovered = await tool({ action: 'read', scope, id: digest(payload).slice(0, 12), limit: 24000 });
      assert.equal(recovered.text, payload);
      assert.equal(recovered.sha256, digest(payload));
      assert.equal(recovered.kept, false);
      assert.equal(folded(await onRequest(nextInput, context)), true, 'looking up details does not undo folding');
      const restored = await tool({ action: 'restore', scope, id: recovered.id });
      assert.equal(restored.kept, true);
      assert.equal(folded(await onRequest(nextInput, context)), false, 'explicitly restored content stays visible');
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

test('an open block can close in a later assistant message without consuming tool calls or results', async () => {
  await fixture(async ({ context, scope }) => {
    const call = { role: 'assistant', content: '@context-fold begin job\n' + payload,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'exec', arguments: JSON.stringify({ code: 'run()' }) } }] };
    const result = { role: 'tool', tool_call_id: 'c', content: marked('Tool output must remain literal. '.repeat(300)) };
    const input = { ...bodyFor('chat'), messages: [{ role: 'user', content: 'Start' }, call, result] };
    assert.equal(folded(await onRequest(input, context)), false);
    const closed = { ...input, messages: [...input.messages, { role: 'assistant', content: 'continued\n@context-fold end job' }] };
    assert.equal(folded(await onRequest(closed, context)), false);
    const output = await onRequest(progress(closed, 'chat'), context) as Record<string, unknown>;
    const clean = withoutBudget(output, 'chat').messages as Record<string, unknown>[];
    assert.deepEqual(clean[1]!.tool_calls, call.tool_calls);
    assert.deepEqual(clean[2], result);
    assert.equal(folded(clean[1]!.content), true);
    const original = payload + 'continued';
    const recovered = await tool({ action: 'read', scope, id: digest(original).slice(0, 12), limit: 24000 });
    assert.equal(recovered.text, original);
  });
});

test('a user message is a boundary and cannot be swallowed by an earlier open block', async () => {
  await fixture(async ({ context }) => {
    const input = { ...bodyFor('chat'), messages: [
      { role: 'assistant', content: '@context-fold begin task\n' + payload },
      { role: 'user', content: 'Important new instruction.\n' + marked() },
      { role: 'assistant', content: 'more\n@context-fold end task' },
    ] };
    const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    assert.deepEqual(withoutBudget(output, 'chat'), input);
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

test('without a callable recovery entry point requests remain unchanged unless a known budget is requested', async () => {
  await fixture(async ({ context, store }) => {
    const input = { ...bodyFor('chat'), tools: [] };
    const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    assert.deepEqual(withoutBudget(output, 'chat'), input);
    assert.equal(folded(output), false);
    assert.equal((await store.readStats()).storage.activeSessions, 0);
    assert.doesNotMatch(JSON.stringify(output), /scope=/);
    assert.deepEqual(output, input);
    const budget = await onRequest(input, { ...context, options: { contextWindowTokens: 128000 } }) as Record<string, unknown>;
    assert.deepEqual(withoutBudget(budget, 'chat'), input);
    assert.match(JSON.stringify(budget), /capacity=128000/);
  });
});

test('malformed and tiny annotated blocks remain readable', async () => {
  await fixture(async ({ context }) => {
    for (const text of [marked('x'), '@context-fold begin x\n' + payload,
      '@context-fold begin x\n@context-fold begin y\n' + payload + '\n@context-fold end y\n@context-fold end x']) {
      const input = bodyFor('chat', text);
      const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
      assert.deepEqual(withoutBudget(output, 'chat'), input);
    }
  });
});

test('non-text user input breaks an open block in all four protocols', async () => {
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
    const text = extractSpans(projected, 'chat').find(span => span.role === 'assistant')!.text;
    assert.equal(text.includes('A'.repeat(1200)), false);
    assert.equal(text.includes('B'.repeat(1200)), true);
    const third = await onRequest(progress(projected, 'chat'), context) as Record<string, unknown>;
    const after = extractSpans(third, 'chat').find(span => span.role === 'assistant')!.text;
    assert.equal(after.includes('B'.repeat(1200)), false);
    assert.equal(after.match(/\[\[cf:v2:/g)?.length, 2);
  });
});
