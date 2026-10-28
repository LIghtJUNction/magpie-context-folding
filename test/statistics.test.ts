import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { onRequest, onResponse } from '../src/context.hooks.js';
import { estimateTokens, withoutBudget } from '../src/budget.js';
import { withoutGuidance } from '../src/guidance.js';
import { execute } from '../src/tool.js';
import { Store, digest } from '../src/store.js';

async function fixture(run: (directory: string, cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'folding-statistics-'));
  const directory = join(cwd, 'archive');
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  process.env.XDG_CONFIG_HOME = join(cwd, 'config');
  await mkdir(join(cwd, '.git'));
  try { await run(directory, cwd); }
  finally {
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    await rm(cwd, { recursive: true, force: true });
  }
}

const call = async (args: unknown) => JSON.parse(await execute(args));
const annotated = (label: string, text: string) => `@context-fold begin ${label}\n${text}\n@context-fold end ${label}`;

test('annotation batches count once; successful, failed and uncertain responses remain distinct', async () => {
  await fixture(async (directory, cwd) => {
    const originals = ['First completed result. '.repeat(2000), 'Second completed result. '.repeat(2000)];
    const body = { model: 'synthetic', tools: [{ type: 'function', function: { name: 'exec_command' } }],
      messages: [{ role: 'user', content: 'Historical requirements.' },
        ...originals.map((text, index) => ({ role: 'assistant', content: annotated(`part-${index}`, text) })),
        { role: 'user', content: 'Current request stays visible.' }] };
    const base = { protocol: 'chat', model: 'synthetic', session: 'stats-test', cwd, options: { delayRequests: 0 } };
    const store = new Store(directory);
    const scope = await store.scopeFor(JSON.stringify(['stats-test', '', '', cwd]));
    const ids = originals.map(digest);
    const firstContext = { ...base, state: {} };
    const first = await onRequest(body, firstContext) as Record<string, unknown>;
    let metrics = (await store.readStats()).metrics;
    assert.equal(metrics.foldBatchesApproved, 1);
    assert.equal(metrics.itemsFolded, 2);
    assert.equal(metrics.recursiveItemsFolded, 0);
    const firstFoldedTokens = metrics.foldedTokensEstimated;
    assert.equal(firstFoldedTokens, String(estimateTokens(body) - estimateTokens(withoutGuidance(withoutBudget(first, 'chat'), 'chat'))));
    assert.ok(BigInt(firstFoldedTokens) > 0n);
    assert.equal(metrics.successfulFoldedRequests, 0, 'a planned fold is not a verified successful request');
    await onResponse({}, { ...firstContext, success: false, request: first });
    await onResponse({}, { ...firstContext, success: false, request: first });
    assert.equal((await store.readStats()).metrics.failedFoldedRequests, 1, 'a receipt is consumed exactly once');

    const replayContext = { ...base, state: {} };
    const replay = await onRequest(body, replayContext);
    await onResponse({}, { ...replayContext, success: true, request: replay });
    metrics = (await store.readStats()).metrics;
    assert.equal(metrics.replayRequests, 1);
    assert.equal(metrics.foldBatchesApproved, 1);
    assert.equal(metrics.foldedTokensEstimated, firstFoldedTokens, 'replay is not a new fold');

    const mismatchContext = { ...base, state: {} };
    const mismatch = await onRequest(body, mismatchContext) as Record<string, unknown>;
    await onResponse({}, { ...mismatchContext, success: true, request: { ...mismatch, temperature: 0.7 } });
    const unknownContext = { ...base, state: {} };
    const unknown = await onRequest(body, unknownContext);
    await onResponse({}, { ...unknownContext, request: unknown });
    assert.equal((await store.readStats()).metrics.unverifiedFoldedRequests, 2);

    const reorderedContext = { ...base, state: {} };
    const reorderedOutput = await onRequest(body, reorderedContext) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(reorderedOutput).reverse());
    await onResponse({}, { ...reorderedContext, success: true, request: reordered });
    await onResponse({}, { ...reorderedContext, success: true, request: reordered });
    metrics = (await store.readStats()).metrics;
    assert.equal(metrics.foldBatchesApproved, 1);
    assert.equal(metrics.itemsFolded, 2);
    assert.equal(metrics.successfulFoldedRequests, 2);
    assert.equal(metrics.replayRequests, 2);
    assert.equal(metrics.certifiedComparisons, 0);
    assert.equal(metrics.savingNanoUsdLower, '0');
    assert.equal(metrics.certifiedTokenDeltaLower, '0');

    await execute({ scope, action: 'read', id: ids[0], limit: 10 });
    await execute({ scope, action: 'read', id: ids[1], limit: 5 });
    const session = await call({ scope, action: 'stats' });
    assert.equal(session.metrics.originalReadCalls, 2);
    assert.equal(session.metrics.layerReadCalls, 0);
    assert.equal(session.metrics.readChars, 15);
    assert.equal(session.summary.foldCount, 1);
    assert.equal(session.summary.detailViewCount, 2);
    assert.equal(session.summary.foldedTokensEstimated, firstFoldedTokens);
    assert.match(session.summary.foldedTokensDisplay, /^\d+(?:\.\d+)?K$/);
    assert.equal(session.money.actualBillSavingUsd, null);
    assert.equal(session.netBenefit.status, 'unverified');

    const bytesBefore = (await stat(join(directory, 'state.sqlite'))).size;
    await execute({ action: 'stats' });
    await execute({ action: 'stats' });
    await execute({ scope, action: 'read', id: 'missing-entry' });
    assert.equal((await call({ scope, action: 'stats' })).summary.detailViewCount, 2);
    assert.equal((await stat(join(directory, 'state.sqlite'))).size, bytesBefore);
    assert.equal((await call({ scope, action: 'forget' })).forgotten, true);
    const lifetime = await call({ action: 'stats' });
    assert.equal(lifetime.metrics.foldBatchesApproved, 1);
    assert.equal(lifetime.metrics.itemsRestored, 2);
    assert.deepEqual(lifetime.summary, session.summary);
    assert.equal(lifetime.storage.activeSessions, 0);
    assert.equal(lifetime.storage.blobs, 0);
    assert.deepEqual(await readdir(directory), ['state.sqlite']);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'stats', '--json'], {
      encoding: 'utf8', env: { ...process.env, MAGPIE_CONTEXT_FOLDING_STATE_DIR: directory },
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).metrics.itemsFolded, 2);
  });
});

test('large estimates and legacy conditional amounts never imply measured savings', async () => {
  await fixture(async directory => {
    const store = new Store(directory);
    const scope = await store.scopeFor('benefit-evidence');
    await store.transaction(scope, true, 64 * 1024 * 1024, snapshot => {
      snapshot.metrics.foldedTokensEstimated = '99999999999999999999';
      snapshot.metrics.estimatedTokenDelta = '-100';
      snapshot.metrics.originalReadCalls = 2;
    });
    const estimated = await call({ scope, action: 'stats' });
    assert.deepEqual(estimated.netBenefit, {
      status: 'unverified', reason: 'no-certified-comparisons', actualTimeSavingMs: null, measuredOverheadUsd: null,
    });
    assert.equal(estimated.money.actualBillSavingUsd, null);
    assert.equal(estimated.metrics.estimatedTokenDelta, '-100', 'budget-message overhead remains visible in the signed estimate');
    assert.equal(estimated.summary.detailViewCount, 2);
    assert.equal(estimated.summary.foldedTokensEstimated, '99999999999999999999');

    // Existing archives may contain amounts recorded by the retired cost-gate implementation.
    await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => {
      snapshot.metrics.certifiedComparisons = 1;
      snapshot.metrics.savingNanoUsdLower = '1250000000';
    });
    const legacy = await call({ scope, action: 'stats' });
    assert.deepEqual(legacy.netBenefit, {
      status: 'unverified', reason: 'conditional-bound-only', actualTimeSavingMs: null, measuredOverheadUsd: null,
    });
    assert.equal(legacy.money.coveredComparisons, 1);
    assert.equal(legacy.money.certifiedInputSavingLowerUsd, '1.250000000');
    assert.equal(legacy.money.actualBillSavingUsd, null);
  });
});

test('reusing an already folded projection counts as a folded replay, not guide-only', async () => {
  await fixture(async (directory, cwd) => {
    const body = { tools: [{ type: 'function', function: { name: 'exec_command' } }],
      messages: [{ role: 'assistant', content: annotated('done', 'completed work '.repeat(500)) }, { role: 'user', content: 'next' }] };
    const context = { protocol: 'chat', model: 'fixture', session: 'projected-replay', cwd, options: { delayRequests: 0 }, state: {} };
    const first = await onRequest(body, context);
    await onResponse({}, { ...context, success: true, request: first });
    const next = await onRequest(first, context);
    assert.deepEqual(next, first);
    await onResponse({}, { ...context, success: true, request: next });
    const metrics = (await new Store(directory).readStats()).metrics;
    assert.equal(metrics.successfulHookRequests, 2);
    assert.equal(metrics.successfulFoldedRequests, 2);
    assert.equal(metrics.guideOnlyRequests, 0);
    assert.equal(metrics.replayRequests, 1);
  });
});
