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
  test(`${protocol}: observation compares complete requests and waits for a matching successful response`, async () => {
    await fixture(async ({ store, scope, context }) => {
      const input = bodyFor(protocol);
      const first = await onRequest(input, context);
      const waiting = await latest(store, scope);
      assert.equal(waiting.reason, 'annotation-grace-period');
      assert.equal(waiting.waiting, 1);
      assert.equal(waiting.foldedRegions, 0);
      assert.equal(waiting.beforeBytes, bytes(input));
      assert.equal(waiting.afterBytes, bytes(first));
      assert.ok(waiting.afterBytes > waiting.beforeBytes, 'unfolded guide overhead must remain visible');
      assert.equal(waiting.observation.status, 'pending');
      assert.equal(waiting.observation.sessionKey, digest(context.session));

      const nextInput = progress(input, protocol);
      const nextContext = { ...context, state: {} };
      const next = await onRequest(nextInput, nextContext);
      const folded = await latest(store, scope);
      assert.equal(folded.reason, 'annotated-regions-folded');
      assert.equal(folded.foldedRegions, 1);
      assert.equal(folded.beforeBytes, bytes(nextInput));
      assert.equal(folded.afterBytes, bytes(next));
      assert.ok(folded.afterBytes < folded.beforeBytes);
      assert.notEqual(folded.observation.requestId, waiting.observation.requestId);
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


test('net-savings fallback is observed as the final unfolded request and retains its reason', async () => {
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
    assert.ok(decision.afterBytes > decision.beforeBytes, 'retained guidance overhead is visible');
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
