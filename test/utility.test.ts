import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest, onResponse } from '../src/context.hooks.js';
import { appendBudget, appendRecovery, estimateTokens, withoutBudget } from '../src/budget.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { execute } from '../src/tool.js';
import { digest } from '../src/store.js';
import { bodyFor, fixture, marked, payload, progress } from './helpers.js';

const tool = async (args: unknown) => JSON.parse(await execute(args));
const hasReference = (body: unknown) => JSON.stringify(body).includes('[[cf:v2:');
const protocols: Protocol[] = ['chat', 'responses', 'anthropic', 'gemini'];

for (const protocol of protocols) {
  test(`${protocol}: idle requests and the user's short demonstrations add no dynamic context or archives`, async () => {
    await fixture(async ({ context, store, scope }) => {
      const demonstrations = [
        marked('临时体验笔记：先记录一段过程，再用同名结束标记闭合；原文应能通过哈希引用恢复。'),
        marked('临时体验记录：下一次请求应把这段过程收成哈希引用；之后用 read 验证能否恢复这段原文。')
          .replaceAll('research', 'live-demo'),
      ].join('\n结论继续保留。\n');
      for (const text of ['A normal task, without any completed regions.', demonstrations]) {
        let input = bodyFor(protocol, text);
        for (let turn = 0; turn < 3; turn++) {
          const result = await onRequest(input, context);
          assert.deepEqual(result, input);
          await onResponse({}, { ...context, success: true, request: result });
          input = progress(input, protocol);
        }
      }
      const snapshot = await store.transaction(scope, false, 64 * 1024 * 1024, value => value);
      assert.equal(snapshot.entries.length, 0, 'unprofitable markers do not allocate originals or grace cursors');
      assert.equal(snapshot.decision.reason, 'insufficient-savings');
      assert.equal(snapshot.decision.skippedRegions, 2);
      assert.equal(snapshot.metrics.itemsFolded, 0);
      assert.equal(snapshot.metrics.estimatedTokenDelta, '0');
      assert.equal(snapshot.metrics.guideOnlyRequests, 0);
    }, protocol);
  });

  test(`${protocol}: profitable work stays folded after bounded read and uses stable recovery metadata`, async () => {
    await fixture(async ({ context, store, scope }) => {
      const input = bodyFor(protocol, marked() + '\nKeep the timeout constraint and remaining task visible.');
      assert.deepEqual(await onRequest(input, context), input, 'grace period is silent');
      const nextInput = progress(input, protocol);
      const result = await onRequest(nextInput, context) as Record<string, unknown>;
      assert.ok(estimateTokens(nextInput) - estimateTokens(result) >= 256);
      assert.match(JSON.stringify(result), /<context-folding scope=[a-f0-9]{64} \/>/);
      assert.doesNotMatch(JSON.stringify(result), /<context-budget/);
      const knownHash = digest(payload).slice(0, 12);
      const page = await tool({ action: 'read', scope, id: knownHash, offset: 31, limit: 80 });
      assert.equal(page.text, payload.slice(31, 111));
      assert.equal(page.nextOffset, 111);
      assert.equal(page.kept, false);
      const afterRead = await onRequest(progress(nextInput, protocol), context);
      assert.equal(hasReference(afterRead), true);
      assert.match(JSON.stringify(afterRead), /Keep the timeout constraint and remaining task visible/);
      assert.equal((await store.readStats(scope)).metrics.itemsRestored, 0);
      const clean = withoutBudget(result, protocol);
      assert.deepEqual(await onRequest(result, context), result, 'projected replay preserves routing without requiring new savings');
      const replayStatus = await tool({ action: 'status', scope });
      assert.equal(replayStatus.decision.inputTokensEstimated, estimateTokens(result));
      assert.equal(replayStatus.decision.netTokensEstimated, 0, 'status compares the actual input and output, not the approval baseline');
      assert.deepEqual(appendRecovery(clean, protocol, scope), result);
      const unavailable = { ...result, tools: [] };
      assert.deepEqual(await onRequest(unavailable, context), unavailable, 'temporarily unavailable recovery must not orphan existing scopes');
      const restored = await tool({ action: 'restore', scope, id: knownHash });
      assert.equal(restored.kept, true);
      const afterRestore = await onRequest(nextInput, context);
      assert.deepEqual(afterRestore, nextInput);
    }, protocol);
  });

  test(`${protocol}: explicit known budgets are included in approval and zero never permits a loss`, async () => {
    await fixture(async ({ context, store, scope }) => {
      const input = bodyFor(protocol, marked('a'.repeat(60)));
      const next = await onRequest(input, { ...context, options: { delayRequests: 0, minSavingTokens: 0 } });
      assert.deepEqual(next, input, 'a shorter body can still lose to the recovery metadata');
      const knownBudget = await onRequest(input, { ...context,
        options: { delayRequests: 0, minSavingTokens: 0, contextWindowTokens: 32000 } }) as Record<string, unknown>;
      assert.deepEqual(withoutBudget(knownBudget, protocol), input);
      assert.match(JSON.stringify(knownBudget), /capacity=32000/);
      assert.doesNotMatch(JSON.stringify(knownBudget), /scope=/);
      const snapshot = await store.transaction(scope, false, 64 * 1024 * 1024, value => value);
      assert.equal(snapshot.entries.length, 0);
      assert.equal(snapshot.metrics.itemsFolded, 0);
      assert.equal(snapshot.decision.reason, 'insufficient-savings');
    }, protocol);
  });
}

test('waiting large work cannot pay for a mature small region and rejected projections do not count as folds', async () => {
  await fixture(async ({ context, store, scope }) => {
    const small = marked('small evidence '.repeat(12));
    const large = marked(payload).replaceAll('research', 'old-large');
    const input = { ...bodyFor('chat'), messages: [
      { role: 'assistant', content: small }, { role: 'assistant', content: large },
      { role: 'user', content: 'Next step.' },
    ] };
    await onRequest(input, context);
    const changed = { ...input, messages: input.messages.map((item, index) => index === 1
      ? { ...item, content: marked(payload + '\nNew evidence.').replaceAll('research', 'new-large') } : item) };
    assert.deepEqual(await onRequest(changed, context), changed);
    const snapshot = await store.transaction(scope, false, 64 * 1024 * 1024, value => value);
    assert.equal(snapshot.decision.waiting, 1);
    assert.equal(snapshot.decision.skippedRegions, 1);
    assert.equal(snapshot.decision.reason, 'insufficient-savings');
    assert.equal(snapshot.metrics.foldBatchesApproved, 0);
    assert.equal(snapshot.metrics.itemsFolded, 0);
    assert.ok(snapshot.entries.every(entry => entry.folded === undefined));
    assert.equal(hasReference(await onRequest(progress(changed, 'chat'), context)), true);
    assert.equal((await store.readStats(scope)).metrics.itemsFolded, 2);
  });
});

test('kept large regions and stale budget hints cannot subsidize short new annotations', async () => {
  await fixture(async ({ context, store, scope }) => {
    const immediate = { ...context, options: { delayRequests: 0 } };
    const input = bodyFor('chat');
    await onRequest(input, immediate);
    await tool({ action: 'restore', scope, id: digest(payload) });
    const small = marked('a'.repeat(60)).replaceAll('research', 'short');
    const updated = bodyFor('chat', marked() + '\n' + small);
    const staleBudget = appendBudget(updated, 'chat', { scope, contextWindowTokens: 128000 });
    const result = await onRequest(staleBudget, immediate);
    assert.deepEqual(result, updated);
    const snapshot = await store.transaction(scope, false, 64 * 1024 * 1024, value => value);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0]!.mark.disposition, 'keep');
    assert.equal(snapshot.decision.reason, 'insufficient-savings');
  });
});

test('adding a newly completed region never recounts the gross savings of an older replay', async () => {
  await fixture(async ({ context, store, scope }) => {
    const immediate = { ...context, options: { delayRequests: 0 } };
    const firstInput = bodyFor('chat');
    const first = await onRequest(firstInput, immediate) as Record<string, unknown>;
    const firstGross = BigInt((await store.readStats(scope)).metrics.foldedTokensEstimated);
    const newText = 'New completed work. '.repeat(100);
    const secondInput = { ...firstInput, messages: [...firstInput.messages as unknown[],
      { role: 'assistant', content: marked(newText).replaceAll('research', 'second') }] };
    const second = await onRequest(secondInput, immediate) as Record<string, unknown>;
    const secondOnly = { ...secondInput, messages: [
      ...(secondInput.messages.slice(0, -1)),
      ...(withoutBudget(second, 'chat').messages as unknown[]).slice(-1),
    ] };
    const addedGross = BigInt(estimateTokens(secondInput) - estimateTokens(secondOnly));
    const metrics = (await store.readStats(scope)).metrics;
    assert.equal(BigInt(metrics.foldedTokensEstimated), firstGross + addedGross);
    assert.equal(metrics.itemsFolded, 2);
    assert.equal(metrics.foldBatchesApproved, 2);
    assert.equal(extractSpans(first, 'chat').filter(span => span.text.includes('[[cf:v2:')).length, 1);
  });
});

test('stable recovery hints are replaced after hosts join system messages or a known budget becomes available', () => {
  const scope = 'a'.repeat(64);
  const input = { messages: [{ role: 'system', content: 'Original requirements.' },
    { role: 'user', content: `<context-folding scope=${scope} />` }] };
  const projected = appendRecovery(input, 'chat', scope);
  const merged = { ...projected, messages: [
    { role: 'system', content: (projected.messages as { role: string; content: string }[])
      .filter(message => message.role === 'system').map(message => message.content).join('\n\n') + '\n\nNew requirement.' },
    input.messages[1],
  ] };
  const replaced = appendRecovery(merged, 'chat', scope);
  const clean = withoutBudget(replaced, 'chat');
  assert.deepEqual(clean.messages, [{ role: 'system', content: 'Original requirements.\n\nNew requirement.' }, input.messages[1]]);
  assert.equal(JSON.stringify(replaced).match(/<context-folding /g)?.length, 2, 'one system hint plus a preserved user literal');
  const known = appendBudget(replaced, 'chat', { contextWindowTokens: 32000, scope });
  assert.deepEqual(withoutBudget(known, 'chat'), clean);
  assert.equal(JSON.stringify(known).match(/<context-budget /g)?.length, 1);
});
