import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest, onResponse } from '../src/context.hooks.js';
import { Store, digest } from '../src/store.js';
import { visibility } from '../src/visibility.js';
import { collectReport } from '../src/report.js';
import type { Protocol } from '../src/protocol.js';
import { bodyFor, fixture, marked, progress } from './helpers.js';

type Decision = {
  reason: string; beforeBytes: number; afterBytes: number;
  foldedRegions: number; replayedReferences: number; waiting: number;
  observation: { requestId: string; observedAt: number; completedAt?: number; status: string; sessionKey: string };
};
async function latest(store: Store, scope: string): Promise<Decision> {
  return store.transaction(scope, false, 64 * 1024 * 1024, state => state.decision as Decision);
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: the default folds on the first complete request and waits for a matching successful response`, async () => {
    await fixture(async ({ store, scope, context }) => {
      const input = bodyFor(protocol);
      const defaultContext = { ...context, options: {} };
      const first = await onRequest(input, defaultContext);
      const immediate = await latest(store, scope);
      assert.equal(immediate.reason, 'annotated-regions-folded');
      assert.equal(immediate.waiting, 0);
      assert.equal(immediate.foldedRegions, 1);
      assert.equal(immediate.beforeBytes, bytes(input));
      assert.equal(immediate.afterBytes, bytes(first));
      assert.ok(immediate.afterBytes < immediate.beforeBytes);
      assert.equal(immediate.observation.status, 'pending');
      assert.equal(immediate.observation.sessionKey, digest(context.session));

      const nextInput = progress(input, protocol);
      const nextContext = { ...defaultContext, state: {} };
      const next = await onRequest(nextInput, nextContext);
      const folded = await latest(store, scope);
      assert.equal(folded.reason, 'annotated-regions-folded');
      assert.equal(folded.foldedRegions, 1);
      assert.equal(folded.beforeBytes, bytes(nextInput));
      assert.equal(folded.afterBytes, bytes(next));
      assert.ok(folded.afterBytes < folded.beforeBytes);
      assert.notEqual(folded.observation.requestId, immediate.observation.requestId);
      assert.equal(folded.observation.status, 'pending');
      assert.ok(!JSON.stringify(next).includes(folded.observation.requestId), 'visibility metadata stays out of model input');
      const reply = { usage: { input_tokens: 1234, output_tokens: 17 }, content: 'original provider reply' };
      const originalReply = structuredClone(reply);
      await onResponse(reply, { ...nextContext, success: true, request: next });
      const completed = (await latest(store, scope)).observation;
      assert.equal(completed.status, 'confirmed');
      assert.ok(completed.completedAt! >= completed.observedAt);
      assert.deepEqual(reply, originalReply, 'observability must not forge response content or usage');

      const replayContext = { ...context, state: {} };
      const replay = await onRequest(next, replayContext);
      assert.deepEqual(replay, next);
      const replayed = await latest(store, scope);
      assert.equal(replayed.beforeBytes, replayed.afterBytes, 'already projected input has no new byte savings');
      assert.equal(replayed.foldedRegions, 0);
      assert.equal(replayed.replayedReferences, 1);
      assert.equal(replayed.observation.status, 'pending');
      assert.equal(replayed.observation.completedAt, undefined, 'a new request cannot inherit old completion freshness');
    }, protocol);
  });
}

const usageFixtures: Array<{
  protocol: Protocol;
  reply: Record<string, unknown>;
  input: string;
  output: string;
  cacheRead?: string;
  cacheWrite?: string;
}> = [
  { protocol: 'chat', reply: { usage: { prompt_tokens: 101, completion_tokens: 17,
    prompt_tokens_details: { cached_tokens: 20 } } }, input: '101', output: '17', cacheRead: '20' },
  { protocol: 'responses', reply: { usage: { input_tokens: 111, output_tokens: 19,
    input_tokens_details: { cached_tokens: 21 } } }, input: '111', output: '19', cacheRead: '21' },
  { protocol: 'anthropic', reply: { usage: { input_tokens: 121, cache_read_input_tokens: 7,
    cache_creation_input_tokens: 9, output_tokens: 23 } }, input: '137', output: '23', cacheRead: '7', cacheWrite: '9' },
  { protocol: 'gemini', reply: { usageMetadata: { promptTokenCount: 131, toolUsePromptTokenCount: 11,
    candidatesTokenCount: 29, thoughtsTokenCount: 13, totalTokenCount: 184, cachedContentTokenCount: 5 } },
    input: '142', output: '42', cacheRead: '5' },
];

for (const sample of usageFixtures) {
  test(`${sample.protocol}: matching successful reply records provider usage in the folded group`, async () => {
    await fixture(async ({ store, scope, context }) => {
      const current = { ...context, options: { delayRequests: 0 }, state: {} };
      const request = await onRequest(bodyFor(sample.protocol), current);
      await onResponse(sample.reply, { ...current, success: true, request });
      const metrics = (await store.readStats(scope)).metrics;
      assert.equal(metrics.responseUsageRequests, 1);
      assert.equal(metrics.responseUsageUnavailableRequests, 0);
      assert.equal(metrics.responseInputTokens, sample.input);
      assert.equal(metrics.responseOutputTokens, sample.output);
      assert.equal(metrics.responseFoldedUsageRequests, 1);
      assert.equal(metrics.responseFoldedInputTokens, sample.input);
      assert.equal(metrics.responseFoldedOutputTokens, sample.output);
      assert.equal(metrics.responseCacheReadTokens, sample.cacheRead ?? '0');
      assert.equal(metrics.responseCacheWriteTokens, sample.cacheWrite ?? '0');
      assert.equal(metrics.responseFoldedCacheReadTokens, sample.cacheRead ?? '0');
      assert.equal(metrics.responseFoldedCacheWriteTokens, sample.cacheWrite ?? '0');
    }, sample.protocol);
  });
}

test('incomplete provider usage is counted as unavailable, not as a partial or zero-token success', async () => {
  await fixture(async ({ store, scope, context }) => {
    const current = { ...context, options: { delayRequests: 0 }, state: {} };
    const request = await onRequest(bodyFor('chat'), current);
    await onResponse({ usage: { prompt_tokens: 123 } }, { ...current, success: true, request });
    const metrics = (await store.readStats(scope)).metrics;
    assert.equal(metrics.responseUsageRequests, 0);
    assert.equal(metrics.responseUsageUnavailableRequests, 1);
    assert.equal(metrics.responseFoldedUsageRequests, 0);
    assert.equal(metrics.responseFoldedUsageUnavailableRequests, 1);
    assert.equal(metrics.responseInputTokens, '0');
    assert.equal(metrics.responseOutputTokens, '0');
  });
});

test('observe-only usage is recorded separately while the request passes through unchanged', async () => {
  await fixture(async ({ store, scope, context }) => {
    const original = bodyFor('chat');
    const current = { ...context, options: { observeOnly: true }, state: {} };
    const request = await onRequest(original, current);
    assert.deepEqual(request, original);
    await onResponse({ usage: { prompt_tokens: 77, completion_tokens: 13 } },
      { ...current, success: true, request });
    const metrics = (await store.readStats(scope)).metrics;
    assert.equal(metrics.observeOnlySuccessfulRequests, 1);
    assert.equal(metrics.responseObserveOnlyUsageRequests, 1);
    assert.equal(metrics.responseObserveOnlyInputTokens, '77');
    assert.equal(metrics.responseObserveOnlyOutputTokens, '13');
    assert.equal(metrics.responseFoldedUsageRequests, 0);
    assert.equal(metrics.itemsFolded, 0);
  });
});

test('old response completion cannot overwrite the latest request even for identical payloads', async () => {
  await fixture(async ({ store, scope, context }) => {
    const input = bodyFor('chat');
    const firstContext = { ...context, options: { delayRequests: 0 }, state: {} };
    const first = await onRequest(input, firstContext);
    const firstId = (await latest(store, scope)).observation.requestId;
    const secondContext = { ...firstContext, state: {} };
    const second = await onRequest(input, secondContext);
    const secondId = (await latest(store, scope)).observation.requestId;
    assert.deepEqual(second, first);
    assert.notEqual(secondId, firstId);
    await onResponse({}, { ...firstContext, success: true, request: first });
    const pending = await latest(store, scope);
    assert.equal(pending.observation.requestId, secondId);
    assert.equal(pending.observation.status, 'pending');
    await onResponse({}, { ...secondContext, success: false, request: second });
    assert.equal((await latest(store, scope)).observation.status, 'failed');
    const metrics = (await store.readStats(scope)).metrics;
    assert.equal(metrics.successfulFoldedRequests, 1);
    assert.equal(metrics.failedFoldedRequests, 1);
    assert.equal(metrics.foldBatchesApproved, 1);
  });
});

test('unknown or mismatched responses remain unverified and consumed callbacks cannot reconfirm them', async () => {
  await fixture(async ({ store, scope, context }) => {
    for (const responseContext of [{ success: true, request: { unrelated: true } }, {}]) {
      const current = { ...context, options: { delayRequests: 0 }, state: {} };
      const projected = await onRequest(bodyFor('chat'), current);
      await onResponse({}, { ...current, ...responseContext });
      assert.equal((await latest(store, scope)).observation.status, 'unverified');
      await onResponse({}, { ...current, success: true, request: projected });
      assert.equal((await latest(store, scope)).observation.status, 'unverified');
    }
  });
});

test('a new request without old history reports no current folds while preserving its recoverable archive', async () => {
  await fixture(async ({ store, scope, context }) => {
    await onRequest(bodyFor('chat'), { ...context, options: { delayRequests: 0 } });
    const input = bodyFor('chat', 'There is no marked history in this request.');
    await onRequest(input, context);
    const decision = await latest(store, scope);
    assert.equal(decision.reason, 'no-eligible-annotations');
    assert.equal(decision.foldedRegions, 0);
    assert.equal(decision.replayedReferences, 0);
    const archived = await store.transaction(scope, false, 64 * 1024 * 1024, state => state.entries);
    assert.equal(archived.length, 1);
    assert.ok(archived[0]!.folded);
  });
});


test('net-savings fallback omits guidance when it would make the candidate uneconomic', async () => {
  await fixture(async ({ store, scope, context }) => {
    const input = bodyFor('chat', marked('x'.repeat(1500)));
    const ctx = { ...context, options: { delayRequests: 0, minSavingsTokens: 0,
      recoveryCommand: 'command-' + 'x'.repeat(3000) }, state: {} };
    const output = await onRequest(input, ctx);
    const decision = await latest(store, scope);
    assert.equal(decision.reason, 'insufficient-net-savings');
    assert.equal(decision.foldedRegions, 0);
    assert.equal(decision.beforeBytes, bytes(input));
    assert.equal(decision.afterBytes, bytes(output));
    assert.equal(decision.afterBytes, decision.beforeBytes, 'a rejected fold does not add fixed guidance overhead');
    assert.deepEqual(output, input);
    assert.ok(!JSON.stringify(output).includes('[[cf:v2:'));
    await onResponse({}, { ...ctx, success: true, request: output });
    const visible = await visibility({ scope });
    assert.equal(visible.selection, 'session');
    if (visible.selection !== 'session') throw new Error('Expected session observation');
    assert.equal(visible.request?.reason, 'insufficient-net-savings');
    assert.equal(visible.request?.status, 'confirmed');
    assert.match((await collectReport(scope)).sessions[0]!.reason, /净收益不足/);
    assert.equal((await store.readStats(scope)).metrics.itemsFolded, 0);
  });
});
