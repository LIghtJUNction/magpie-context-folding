import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendGuidance, guidanceText, shellQuote, withoutGuidance } from '../src/guidance.js';
import { onRequest, onResponse } from '../src/context.hooks.js';
import { estimateTokens } from '../src/metrics.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { bodyFor, fixture, marked } from './helpers.js';

const options = { command: 'magpie-context-folding' };
const countGuides = (value: unknown) => JSON.stringify(value).match(/<context-folding>/g)?.length ?? 0;
const folded = (body: Record<string, unknown>, protocol: Protocol) => extractSpans(body, protocol)
  .some(span => span.text.includes('[[cf:v2:'));

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: automatic system guidance is stable and preserves host instructions/tools`, () => {
    const input = bodyFor(protocol);
    const original = structuredClone(input);
    const once = appendGuidance(input, protocol, options);
    assert.equal(countGuides(once), 1);
    assert.deepEqual(appendGuidance(once, protocol, options), once);
    assert.deepEqual(withoutGuidance(once, protocol), input);
    assert.deepEqual(input, original);
    assert.deepEqual(once.tools, input.tools, 'the host tool schema is never altered');
    if (protocol === 'chat') assert.deepEqual((once.messages as unknown[])[0], (input.messages as unknown[])[0]);
  });

  test(`${protocol}: short demo notes stay readable, long blocks repay all injected metadata`, async () => {
    await fixture(async ({ context, store, scope }) => {
      const short = bodyFor(protocol, marked('临时体验笔记：保存过程，需要时再读回原文。'));
      const shortOutput = await onRequest(short, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
      assert.equal(folded(shortOutput, protocol), false);
      assert.deepEqual(withoutGuidance(shortOutput, protocol), short);
      assert.doesNotMatch(JSON.stringify(shortOutput), /<context-budget|--scope/);
      const snapshot = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot);
      assert.equal(snapshot.entries.length, 0);
      assert.equal(snapshot.metrics.itemsFolded, 0);

      const large = bodyFor(protocol, marked('Completed findings with exact evidence.\n'.repeat(500)));
      const largeContext = { ...context, options: { delayRequests: 0 }, state: {} };
      const output = await onRequest(large, largeContext) as Record<string, unknown>;
      assert.equal(folded(output, protocol), true);
      assert.ok(estimateTokens(large) - estimateTokens(output) >= 256);
      assert.equal(countGuides(output), 1);
      assert.match(JSON.stringify(output), new RegExp(`--scope ${scope}`));
      assert.match(JSON.stringify(output), /--state-dir/);
      assert.deepEqual(output.tools, large.tools);
      await onResponse({}, { ...largeContext, success: true, request: output });
      assert.equal((await store.readStats(scope)).metrics.estimatedTokenDelta,
        String(estimateTokens(large) - estimateTokens(output)));
      assert.deepEqual(await onRequest(output, largeContext), output, 'a replay does not accumulate instructions');
    }, protocol);
  });
}

test('system string prefixes keep all original trailing newlines across repeated injection', () => {
  for (const ending of ['', '\n', '\n\n', '\n\n\n', '\r\n', '\r\n\r\n']) {
    for (const protocol of ['responses', 'anthropic', 'gemini'] as Protocol[]) {
      const text = 'Original instructions.' + ending;
      const body = protocol === 'responses' ? { instructions: text, input: [] }
        : protocol === 'anthropic' ? { system: text, messages: [] }
        : { config: { systemInstruction: text }, contents: [] };
      const once = appendGuidance(body, protocol, options);
      assert.deepEqual(appendGuidance(once, protocol, options), once);
      assert.deepEqual(withoutGuidance(once, protocol), body);
    }
  }
});

test('host-flattened CRLF guidance is replaced without accumulating copies', () => {
  const text = 'Original instruction.\r\n\r\n' + guidanceText(options) + '\r\n';
  for (const body of [{ system: text, messages: [] }, { system: [{ type: 'text', text }], messages: [] }]) {
    const once = appendGuidance(body, 'anthropic', options);
    assert.equal(countGuides(once), 1);
    assert.deepEqual(appendGuidance(once, 'anthropic', options), once);
  }
  const chat = appendGuidance({ messages: [{ role: 'system', content: text }, { role: 'user', content: text }] }, 'chat', options);
  assert.equal(countGuides(chat), 2, 'the user literal remains data');
  assert.deepEqual(appendGuidance(chat, 'chat', options), chat);
});

test('developer messages retain their role and Gemini uses the existing instruction holder', () => {
  const chat = appendGuidance({ messages: [{ role: 'developer', content: 'Keep this.' }, { role: 'user', content: 'Hello.' }] }, 'chat', options);
  assert.equal((chat.messages as { role: string }[])[1]!.role, 'developer');
  const gemini = { contents: [], systemInstruction: { parts: [{ text: 'Keep this.' }] }, config: { temperature: 0.2 } };
  const output = appendGuidance(gemini, 'gemini', options);
  assert.deepEqual(output.config, gemini.config);
  assert.deepEqual(withoutGuidance(output, 'gemini'), gemini);
  assert.throws(() => appendGuidance({ ...gemini, config: { systemInstruction: 'Conflicting field.' } }, 'gemini', options));
});

test('unsafe command line shapes fail open; shell quoting preserves literal path characters', async () => {
  assert.equal(shellQuote("/path/it's $(data)/cli.ts"), "'/path/it'\\''s $(data)/cli.ts'");
  for (const path of ['unsafe\npath', 'unsafe\rpath', 'unsafe\0path']) {
    assert.throws(() => guidanceText({ ...options, scope: 'a'.repeat(64), stateDirectory: path }));
    assert.throws(() => guidanceText({ command: path }));
  }
  await fixture(async ({ context }) => {
    const input = { ...bodyFor('responses'), instructions: { unsupported: true } };
    assert.equal(await onRequest(input, { ...context, protocol: 'responses', options: { delayRequests: 0 } }), input);
  });
});

test('a zero savings floor still rejects a batch that cannot cover its actual CLI guidance', async () => {
  await fixture(async ({ context, scope, store }) => {
    const input = bodyFor('chat', marked('x'.repeat(1500)));
    const output = await onRequest(input, { ...context, options: { delayRequests: 0, minSavingsTokens: 0,
      recoveryCommand: 'command-' + 'x'.repeat(3000) } }) as Record<string, unknown>;
    assert.deepEqual(withoutGuidance(output, 'chat'), input);
    const snapshot = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot);
    assert.equal(snapshot.entries.length, 0);
    assert.equal(snapshot.metrics.itemsFolded, 0);
    assert.equal(snapshot.decision.reason, 'insufficient-net-savings');
    assert.equal(snapshot.decision.foldedRegions, 0);
  });
});

test('removed budgets stay absent and guide-only overhead remains visible in successful statistics', async () => {
  await fixture(async ({ context, store, scope }) => {
    const input = bodyFor('chat', 'Just a normal short answer.');
    const output = await onRequest(input, context) as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(output), /<context-budget/);
    await onResponse({}, { ...context, request: output, success: true });
    const stats = await store.readStats(scope);
    assert.equal(stats.metrics.guideOnlyRequests, 1);
    assert.equal(stats.metrics.estimatedTokenDelta, String(estimateTokens(input) - estimateTokens(output)));
    assert.ok(BigInt(stats.metrics.estimatedTokenDelta) < 0n, 'fixed guidance overhead is not hidden');
  });
});

test('empty supported system containers retain their type and Gemini metadata on replay', () => {
  const cases: { protocol: Protocol; body: Record<string, unknown> }[] = [
    { protocol: 'anthropic', body: { system: '', messages: [] } },
    { protocol: 'gemini', body: { systemInstruction: '', contents: [] } },
    { protocol: 'gemini', body: { systemInstruction: { role: 'system', parts: [] }, contents: [] } },
    { protocol: 'gemini', body: { config: { temperature: 0.2,
      system_instruction: { role: 'system', parts: [] } }, contents: [] } },
  ];
  for (const { body, protocol } of cases) {
    const once = appendGuidance(body, protocol, options);
    assert.deepEqual(withoutGuidance(once, protocol), body);
    assert.deepEqual(appendGuidance(once, protocol, options), once);
  }
});
