import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { z } from 'zod';
import { onRequest, onResponse } from '../src/context.hooks.js';
import { execute } from '../src/tool.js';
import { extractSpans } from '../src/protocol.js';
import { Store } from '../src/store.js';

async function fixture(run: (directory: string, url: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-statistics-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  const server = createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += String(chunk);
    const body = JSON.parse(data);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ requestHash: body.requestHash, model: body.model, protocol: body.protocol,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      beforeLowerTokens: JSON.stringify(body.before).length, afterUpperTokens: JSON.stringify(body.after).length,
      oldMinPricePerMillion: 1, newMaxPricePerMillion: 1, extraCostUpperUsd: 0,
      incremental: { toolCalls: 0, modelRoundTrips: 0, inputTokens: 0, outputTokens: 0,
        inputPricePerMillion: 0, outputPricePerMillion: 0, toolFeesUsd: 0 },
      assumptions: ['Synthetic character-token and equal-price tariff for statistics integration only.'] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await run(directory, `http://127.0.0.1:${address.port}`); }
  finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('batch and recursive counters, response-confirmed money, deduplication, reads and lifetime cleanup', async () => {
  await fixture(async (directory, url) => {
    const body = { model: 'synthetic', tools: [{ type: 'function', function: { name: 'context_folding' } }],
      messages: [{ role: 'user', content: 'Historical requirements.' },
        { role: 'assistant', content: 'First completed result. '.repeat(2000) },
        { role: 'assistant', content: 'Second completed result. '.repeat(2000) },
        { role: 'user', content: 'Current request stays visible.' }] };
    const base = { protocol: 'chat', model: 'synthetic', session: 'stats-test',
      options: { thresholdTokens: 1, keepRecentMessages: 1, accounting: { url } } };
    await onRequest(body, { ...base, state: {} });
    const store = new Store(directory);
    const scope = await store.scopeFor(JSON.stringify(['stats-test', '', '', '']));
    const ids = extractSpans(body, 'chat').filter(span => span.role === 'assistant').map(span => span.id);
    assert.equal(ids.length, 2);
    const mark = async (summary: string) => {
      const result = JSON.parse(await execute({ scope, action: 'mark', marks: ids.map(id => ({ id, disposition: 'foldable', summary })) }));
      assert.ok(!result.error);
    };
    await mark('Completed checks. '.repeat(110).slice(0, 2000));
    const firstContext = { ...base, state: {} };
    const first = await onRequest(body, firstContext);
    let metrics = (await store.readStats()).metrics;
    assert.equal(metrics.foldBatchesApproved, 1);
    assert.equal(metrics.itemsFolded, 2, 'one approval folds both items in the same batch');
    const firstFoldedTokens = metrics.foldedTokensEstimated;
    assert.equal(firstFoldedTokens, String(Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4)
      - Math.ceil(Buffer.byteLength(JSON.stringify(first)) / 4)));
    assert.ok(BigInt(firstFoldedTokens) > 0n);
    assert.equal(metrics.certifiedComparisons, 0, 'a planned fold must not earn money before completion');
    await onResponse({}, { ...firstContext, success: false, request: first });
    await onResponse({}, { ...firstContext, success: false, request: first });
    assert.equal((await store.readStats()).metrics.failedFoldedRequests, 1);

    const replayContext = { ...base, state: {} };
    const replay = await onRequest(body, replayContext);
    await onResponse({}, { ...replayContext, success: true, request: replay });
    metrics = (await store.readStats()).metrics;
    assert.equal(metrics.replayRequests, 1);
    assert.equal(metrics.foldedTokensEstimated, firstFoldedTokens, 'replaying a fold is not a new fold');
    assert.equal(metrics.certifiedComparisons, 0, 'a replay cannot reuse the old certificate as a fresh monetary gain');

    await mark('Checks passed. '.repeat(70).slice(0, 1000));
    const secondContext = { ...base, state: {} };
    const second = z.record(z.string(), z.unknown()).parse(await onRequest(body, secondContext));
    await onResponse({}, { ...secondContext, success: true, request: { ...second, temperature: 0.7 } });
    assert.equal((await store.readStats()).metrics.unverifiedFoldedRequests, 1);

    await mark('All checks passed.');
    const thirdContext = { ...base, state: {} };
    const third = z.record(z.string(), z.unknown()).parse(await onRequest(body, thirdContext));
    // Go's JSON encoder can reorder keys. A matching body must still be recognized.
    const reordered = Object.fromEntries(Object.entries(third).reverse());
    await onResponse({}, { ...thirdContext, success: true, request: reordered });
    await onResponse({}, { ...thirdContext, success: true, request: reordered });
    metrics = (await store.readStats()).metrics;
    assert.equal(metrics.foldBatchesApproved, 3);
    assert.equal(metrics.itemsFolded, 6);
    assert.equal(metrics.recursiveItemsFolded, 4);
    assert.ok(BigInt(metrics.foldedTokensEstimated) > BigInt(firstFoldedTokens));
    assert.equal(metrics.successfulFoldedRequests, 2);
    assert.equal(metrics.certifiedComparisons, 1);
    assert.ok(BigInt(metrics.savingNanoUsdLower) > 0n);
    assert.ok(BigInt(metrics.certifiedTokenDeltaLower) > 0n);
    const snapshot = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => structuredClone(snapshot));
    assert.equal(metrics.savingNanoUsdLower, snapshot.decision.savingLowerNanoUsd);
    const item = snapshot.entries.find(entry => entry.id === ids[0]);
    assert.ok(item);
    assert.equal(item.layers.length, 3);
    await execute({ scope, action: 'read', id: item.id, limit: 10 });
    await execute({ scope, action: 'read', id: item.id, layer: item.layers[1]?.id, limit: 5 });
    const session = JSON.parse(await execute({ scope, action: 'stats' }));
    assert.equal(session.metrics.originalReadCalls, 1);
    assert.equal(session.metrics.layerReadCalls, 1);
    assert.equal(session.metrics.readChars, 15);
    assert.equal(session.summary.foldCount, 3);
    assert.equal(session.summary.detailViewCount, 2);
    assert.equal(session.summary.foldedTokensEstimated, metrics.foldedTokensEstimated);
    assert.match(session.summary.foldedTokensDisplay, /^\d+(?:\.\d+)?K$/);
    assert.equal(session.money.actualBillSavingUsd, null);
    const bytesBefore = (await stat(join(directory, 'state.sqlite'))).size;
    await execute({ action: 'stats' });
    await execute({ action: 'stats' });
    await execute({ scope, action: 'read', id: 'missing-entry' });
    const afterFailedRead = JSON.parse(await execute({ scope, action: 'stats' }));
    assert.equal(afterFailedRead.summary.detailViewCount, 2);
    assert.equal((await stat(join(directory, 'state.sqlite'))).size, bytesBefore);
    await execute({ scope, action: 'mark', marks: ids.map(id => ({ id, disposition: 'keep' })) });
    await execute({ scope, action: 'forget' });
    const lifetime = JSON.parse(await execute({ action: 'stats' }));
    assert.equal(lifetime.metrics.foldBatchesApproved, 3);
    assert.equal(lifetime.metrics.itemsRestored, 2);
    assert.deepEqual(lifetime.summary, session.summary);
    assert.equal(lifetime.money.certifiedInputSavingLowerUsd, session.money.certifiedInputSavingLowerUsd);
    assert.equal(lifetime.storage.activeSessions, 0);
    assert.equal(lifetime.storage.blobs, 0);
    assert.deepEqual(await readdir(directory), ['state.sqlite']);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'stats', '--json'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).metrics.itemsFolded, 6);
  });
});
