import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRegions } from '../src/annotations.js';
import { appendGuidance, appendGuidanceToCleanBody, containsGuidance, guidanceText, shellQuote, withoutGuidance } from '../src/guidance.js';
import { onRequest, onResponse } from '../src/context.hooks.js';
import { estimateTokens } from '../src/metrics.js';
import { appendRecoveryMetadata } from '../src/recovery.js';
import { cleanRequestBody } from '../src/request-clean.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { bodyFor, fixture, marked, progress } from './helpers.js';

const options = { command: 'magpie-context-folding' };
const countGuides = (value: unknown) => JSON.stringify(value).match(/<context-folding>/g)?.length ?? 0;
const folded = (body: Record<string, unknown>, protocol: Protocol) => extractSpans(body, protocol)
  .some(span => span.text.includes('[[cf:v2:'));
function appendUserTurn(body: Record<string, unknown>, protocol: Protocol, text: string): Record<string, unknown> {
  const next = structuredClone(body);
  if (protocol === 'chat' || protocol === 'anthropic') {
    (next.messages as unknown[]).push({ role: 'user', content: text });
  } else if (protocol === 'responses') {
    (next.input as unknown[]).push({ role: 'user', content: [{ type: 'input_text', text }] });
  } else {
    (next.contents as unknown[]).push({ role: 'user', parts: [{ text }] });
  }
  return next;
}

test('guidance preserves useful context and avoids folding details still in use', () => {
  const text = guidanceText(options);
  assert.match(text, /After a substantial step, keep its result, constraints, failures, active work, and next step visible/);
  assert.match(text, /Mark only completed supporting detail that future turns can recover/);
  assert.match(text, /Never mark user text or exact-format answers/);
  assert.deepEqual(parseRegions([{ id: 'guidance', text }]).map(region => region.text), ['...'], 'the sample marker block must satisfy the real parser');
  assert.doesNotMatch(text, /CLI recovery|--scope|grep/i, 'unscoped guidance must not mention unavailable archive commands');
  assert.match(text, /Do not demo/i);
  assert.match(text, /Report known facts only/);
  assert.match(guidanceText({ ...options, minSavingsTokens: 512 }), />=512 tokens/);
  assert.ok(Buffer.byteLength(text) <= 410, 'unscoped guidance omits archive commands until a recovery scope exists');
});

test('scoped recovery guidance searches archived text before reading pages', () => {
  const scope = 'a'.repeat(64);
  const text = guidanceText({ ...options, scope, stateDirectory: '/tmp/archive state' });
  assert.ok(text.includes(`grep --state-dir '/tmp/archive state' --scope ${scope} --id HASH --query 'TEXT'`));
  assert.ok(text.includes(`read --state-dir '/tmp/archive state' --scope ${scope} --id HASH only if needed`));
});

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: request cleanup shares conversation data and keeps the host request unchanged`, () => {
    const original = bodyFor(protocol);
    const dirty = appendRecoveryMetadata(appendGuidance(original, protocol, options), protocol, 'a'.repeat(64));
    const before = structuredClone(dirty);
    const clean = cleanRequestBody(dirty, protocol);
    assert.deepEqual(clean, original);
    assert.deepEqual(dirty, before);
    if (protocol === 'chat') {
      const firstUser = (messages: unknown[]) => messages.find(item => typeof item === 'object' && item !== null
        && (item as Record<string, unknown>).role === 'user');
      assert.strictEqual(firstUser(clean.messages as unknown[]), firstUser(dirty.messages as unknown[]), 'unchanged history messages are shared');
    } else {
      const historyKey = protocol === 'responses' ? 'input' : protocol === 'gemini' ? 'contents' : 'messages';
      assert.strictEqual(clean[historyKey], dirty[historyKey], 'large conversation fields are structurally shared');
    }
  });

  test(`${protocol}: stale scope-only metadata is removed without adding guidance to short history`, async () => {
    await fixture(async ({ context }) => {
      const original = bodyFor(protocol, 'A short completed answer.');
      const legacy = appendRecoveryMetadata(original, protocol, 'a'.repeat(64));
      const output = await onRequest(legacy, context) as Record<string, unknown>;
      assert.equal(countGuides(output), 0);
      assert.doesNotMatch(JSON.stringify(output), /<context-budget|<context-folding scope=/);
      assert.deepEqual(withoutGuidance(output, protocol), original);
      assert.deepEqual(await onRequest(output, context), output);
    }, protocol);
  });

  test(`${protocol}: automatic system guidance is stable and preserves host instructions/tools`, () => {
    const input = bodyFor(protocol);
    const original = structuredClone(input);
    const userLiteral = bodyFor(protocol, guidanceText(options));
    const once = appendGuidance(input, protocol, options);
    assert.equal(countGuides(once), 1);
    assert.equal(containsGuidance(input, protocol), false);
    assert.equal(containsGuidance(once, protocol), true);
    assert.equal(containsGuidance(userLiteral, protocol), false, 'user text is never mistaken for prior system guidance');
    assert.deepEqual(appendGuidance(once, protocol, options), once);
    assert.deepEqual(withoutGuidance(once, protocol), input);
    assert.deepEqual(input, original);
    assert.deepEqual(once.tools, input.tools, 'the host tool schema is never altered');
    if (protocol === 'chat') assert.deepEqual((once.messages as unknown[])[0], (input.messages as unknown[])[0]);
  });

  test(`${protocol}: skips fixed guidance on short context and keeps it once useful or already present`, async () => {
    await fixture(async ({ context, store, scope }) => {
      const short = bodyFor(protocol, 'A short answer.');
      const skipped = await onRequest(short, context) as Record<string, unknown>;
      assert.deepEqual(skipped, short);
      assert.equal(countGuides(skipped), 0);
      await onResponse({}, { ...context, request: skipped, success: true });
      const shortStats = await store.readStats(scope);
      assert.equal(shortStats.metrics.successfulHookRequests, 1);
      assert.equal(shortStats.metrics.guideOnlyRequests, 0);
      assert.equal(shortStats.metrics.estimatedTokenDelta, '0');

      const large = bodyFor(protocol, 'Completed investigation details.\n'.repeat(250));
      const guided = await onRequest(large, context) as Record<string, unknown>;
      assert.equal(countGuides(guided), 1);
      assert.deepEqual(withoutGuidance(guided, protocol), large);

      const previouslyGuided = appendGuidance(short, protocol, options);
      const retained = await onRequest(previouslyGuided, context) as Record<string, unknown>;
      assert.equal(countGuides(retained), 1);
      assert.deepEqual(withoutGuidance(retained, protocol), short);
    }, protocol);
  });

  test(`${protocol}: archived recovery instructions appear for a relevant follow-up only`, async () => {
    await fixture(async ({ context, store, scope }) => {
      const fastContext = { ...context, options: { delayRequests: 0 } };
      const source = 'export function operation341() { return 341; }\n'.repeat(250);
      let request = bodyFor(protocol, marked(source));
      let output = await onRequest(request, fastContext) as Record<string, unknown>;
      assert.equal(folded(output, protocol), true);
      assert.equal(countGuides(output), 1, 'a new fold includes its recovery instructions');
      const retry = await onRequest(request, fastContext) as Record<string, unknown>;
      assert.equal(countGuides(retry), 1, 'a retried request keeps its recovery instructions');
      const afterRetry = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot);
      assert.equal(afterRetry.guidance?.noFoldPrompts, 0, 'a host retry must not consume another prompt cycle');
      request = cleanRequestBody(output, protocol);

      let unnecessaryGuideBytes = 0;
      for (const question of [
        'What about the schedule?',
        'What was the result of the election?',
        'What about the same schedule?',
        'What was the previous election result?',
        'What is the function of the election committee?',
        'Can you explain the implementation schedule for the event?',
      ]) {
        request = appendUserTurn(request, protocol, question);
        output = await onRequest(request, fastContext) as Record<string, unknown>;
        assert.equal(folded(output, protocol), true, 'unrelated follow-ups keep only the archive reference');
        assert.equal(countGuides(output), 0, 'unrelated follow-ups do not carry archive commands');
        const withForcedGuide = appendGuidanceToCleanBody(output, protocol, {
          command: 'magpie-context-folding', minSavingsTokens: 256, scope, stateDirectory: store.directory,
        });
        unnecessaryGuideBytes += Buffer.byteLength(JSON.stringify(withForcedGuide)) - Buffer.byteLength(JSON.stringify(output));
        request = cleanRequestBody(output, protocol);
      }
      assert.ok(unnecessaryGuideBytes > 0, 'the omitted recovery guide has a positive JSON-byte counterfactual');

      request = appendUserTurn(request, protocol, 'What does operation341() return?');
      output = await onRequest(request, fastContext) as Record<string, unknown>;
      assert.equal(countGuides(output), 1, 'a source-specific follow-up receives recovery instructions on demand');
      assert.match(JSON.stringify(output), new RegExp(`--scope ${scope}`));
      assert.doesNotMatch(JSON.stringify(output), /export function operation341\(\)/,
        'the archived source stays folded while its recovery path is exposed');
    }, protocol);
  });

  test(`${protocol}: general guidance backoff counts distinct request cycles only`, async () => {
    await fixture(async ({ context, store, scope }) => {
      const fastContext = { ...context, options: { delayRequests: 0 } };
      let request = bodyFor(protocol, 'Completed investigation details.\n'.repeat(250));
      let output = await onRequest(request, fastContext) as Record<string, unknown>;
      assert.equal(countGuides(output), 1);
      const retry = await onRequest(request, fastContext) as Record<string, unknown>;
      assert.equal(countGuides(retry), 1);
      const afterRetry = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot);
      assert.equal(afterRetry.guidance?.noFoldPrompts, 1, 'a retry cannot consume another reminder slot');

      request = cleanRequestBody(output, protocol);
      const guideCounts = [1, 1];
      for (let turn = 0; turn < 6; turn++) {
        request = progress(request, protocol);
        output = await onRequest(request, fastContext) as Record<string, unknown>;
        guideCounts.push(countGuides(output));
        request = cleanRequestBody(output, protocol);
      }
      assert.deepEqual(guideCounts, [1, 1, 1, 0, 0, 0, 1, 0]);
    }, protocol);
  });

  test(`${protocol}: clean-body insertion matches normal guidance without mutating its input`, () => {
    const original = bodyFor(protocol);
    const withGuide = appendGuidance(original, protocol, options);
    const clean = withoutGuidance(withGuide, protocol);
    const cleanBefore = structuredClone(clean);
    const fast = appendGuidanceToCleanBody(clean, protocol, options);
    assert.deepEqual(fast, withGuide);
    assert.deepEqual(clean, cleanBefore);
    assert.deepEqual(appendGuidance(fast, protocol, options), fast);
  });

  test(`${protocol}: short demo notes stay readable, long blocks repay all injected metadata`, async () => {
    await fixture(async ({ context, store, scope }) => {
      const short = bodyFor(protocol, marked('临时体验笔记：保存过程，需要时再读回原文。'));
      const shortOutput = await onRequest(short, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
      assert.equal(folded(shortOutput, protocol), false);
      assert.equal(countGuides(shortOutput), 0, 'a short rejected annotation does not pay fixed guidance cost');
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
      const replay = await onRequest(output, largeContext) as Record<string, unknown>;
      assert.equal(folded(replay, protocol), true);
      assert.deepEqual(replay, output, 'a retry of the exact projected request remains byte-for-byte stable');

      const unrelated = appendUserTurn(cleanRequestBody(output, protocol), protocol, 'Continue.');
      const next = await onRequest(unrelated, largeContext) as Record<string, unknown>;
      assert.equal(folded(next, protocol), true);
      assert.equal(countGuides(next), 0, 'an unrelated new turn does not repeat scoped recovery instructions');
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

test('removed budget metadata stays absent and long guide-only overhead remains visible in statistics', async () => {
  await fixture(async ({ context, store, scope }) => {
    const input = bodyFor('chat', 'Completed long stage details.\n'.repeat(200));
    const output = await onRequest(input, context) as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(output), /<context-budget/);
    await onResponse({}, { ...context, request: output, success: true });
    const stats = await store.readStats(scope);
    assert.equal(stats.metrics.guideOnlyRequests, 1);
    assert.equal(stats.metrics.estimatedTokenDelta, String(estimateTokens(input) - estimateTokens(output)));
    assert.ok(BigInt(stats.metrics.estimatedTokenDelta) < 0n, 'fixed guidance overhead is not hidden');
  });
});

test('empty and missing system containers retain their shape and Gemini metadata on replay', () => {
  const cases: { protocol: Protocol; body: Record<string, unknown> }[] = [
    { protocol: 'anthropic', body: { system: '', messages: [] } },
    { protocol: 'gemini', body: { systemInstruction: '', contents: [] } },
    { protocol: 'gemini', body: { systemInstruction: { role: 'system', parts: [] }, contents: [] } },
    { protocol: 'gemini', body: { system_instruction: { parts: [] }, contents: [] } },
    { protocol: 'gemini', body: { config: { system_instruction: { parts: [] } }, contents: [] } },
    { protocol: 'gemini', body: { systemInstruction: { parts: [] }, config: {}, contents: [] } },
    { protocol: 'gemini', body: { systemInstruction: { parts: [] }, config: { temperature: 0.2 }, contents: [] } },
    { protocol: 'gemini', body: { contents: [] } },
    { protocol: 'gemini', body: { config: {}, contents: [] } },
    { protocol: 'gemini', body: { config: { temperature: 0.2 }, contents: [] } },
    { protocol: 'gemini', body: { config: { temperature: 0.2,
      system_instruction: { role: 'system', parts: [] } }, contents: [] } },
  ];
  for (const { body, protocol } of cases) {
    const once = appendGuidance(body, protocol, options);
    assert.deepEqual(withoutGuidance(once, protocol), body);
    assert.deepEqual(appendGuidance(once, protocol, options), once);
  }
});
