import assert from 'node:assert/strict';
import test from 'node:test';
import { addMetrics, emptyMetrics, formatNanoUsd, metricsSchema } from '../src/metrics.js';

test('empty totals are independent and serialize without BigInt JSON support', () => {
  const first = emptyMetrics();
  const second = emptyMetrics();
  first.itemsFolded = 9;
  assert.equal(second.itemsFolded, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(second)), second);
});

test('a batch and later request can accumulate counters without modifying prior totals', () => {
  const first = addMetrics(emptyMetrics(), { foldBatchesApproved: 1, itemsFolded: 3, recursiveItemsFolded: 2 });
  const second = addMetrics(first, { successfulFoldedRequests: 1, certifiedComparisons: 1, originalReadCalls: 1, readChars: 500 });
  assert.equal(second.foldBatchesApproved, 1);
  assert.equal(second.itemsFolded, 3);
  assert.equal(second.recursiveItemsFolded, 2);
  assert.equal(second.successfulFoldedRequests, 1);
  assert.equal(second.certifiedComparisons, 1);
  assert.equal(second.originalReadCalls, 1);
  assert.equal(second.readChars, 500);
  assert.equal(first.successfulFoldedRequests, 0);
  assert.equal(first.readChars, 0);
});

test('token and fee totals stay exact beyond JavaScript safe integer precision', () => {
  const before = addMetrics(emptyMetrics(), {
    estimatedTokenDelta: '900719925474099312345',
    certifiedTokenDeltaLower: '-900719925474099312345',
    savingNanoUsdLower: '999999999999999999999999999',
  });
  const total = addMetrics(before, {
    estimatedTokenDelta: '-900719925474099312344',
    certifiedTokenDeltaLower: '900719925474099312344',
    savingNanoUsdLower: '1',
  });
  assert.equal(total.estimatedTokenDelta, '1');
  assert.equal(total.certifiedTokenDeltaLower, '-1');
  assert.equal(total.savingNanoUsdLower, '1000000000000000000000000000');
});

test('invalid, decreasing, and overflowing counters cannot create misleading totals', () => {
  for (const invalid of [-1, 0.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => addMetrics(emptyMetrics(), { itemsFolded: invalid }));
  }
  const full = addMetrics(emptyMetrics(), { readChars: Number.MAX_SAFE_INTEGER });
  assert.throws(() => addMetrics(full, { readChars: 1 }));
  assert.equal(full.readChars, Number.MAX_SAFE_INTEGER);
  assert.equal(metricsSchema.partial().safeParse({ unknownCounter: 4 }).success, false);
});

test('integer strings reject ambiguous formats and normalize negative zero', () => {
  for (const invalid of ['', '+1', '01', '-01', '1.0', '1e9', ' 1', '1 ', 'Infinity']) {
    assert.throws(() => addMetrics(emptyMetrics(), { savingNanoUsdLower: invalid }));
    assert.throws(() => formatNanoUsd(invalid));
  }
  assert.equal(addMetrics(emptyMetrics(), { certifiedTokenDeltaLower: '-0' }).certifiedTokenDeltaLower, '0');
  assert.equal(formatNanoUsd('-0'), '0.000000000');
});

test('USD formatting preserves nano amounts, signs, and arbitrarily large whole dollars', () => {
  assert.equal(formatNanoUsd('0'), '0.000000000');
  assert.equal(formatNanoUsd('1'), '0.000000001');
  assert.equal(formatNanoUsd('-1'), '-0.000000001');
  assert.equal(formatNanoUsd('1000000000'), '1.000000000');
  assert.equal(formatNanoUsd('-1234567890'), '-1.234567890');
  assert.equal(formatNanoUsd('12345678901234567890123456789'), '12345678901234567890.123456789');
});
