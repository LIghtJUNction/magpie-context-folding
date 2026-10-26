import assert from 'node:assert/strict';
import test from 'node:test';
import { addMetrics, emptyMetrics, formatNanoUsd, formatTokenCount, metricsSchema } from '../src/metrics.js';

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

const hookCounters = ['successfulHookRequests', 'failedHookRequests', 'unverifiedHookRequests', 'guideOnlyRequests'] as const;

test('stored metrics without hook counters parse with zero defaults', () => {
  const legacy = JSON.parse(JSON.stringify(addMetrics(emptyMetrics(), {
    successfulFoldedRequests: 3,
    estimatedTokenDelta: '-41',
  })));
  for (const key of hookCounters) delete legacy[key];
  delete legacy.foldedTokensEstimated;
  const parsed = metricsSchema.parse(legacy);
  assert.equal(parsed.foldedTokensEstimated, '0');
  for (const key of hookCounters) assert.equal(parsed[key], 0);
  assert.equal(parsed.successfulFoldedRequests, 3);
  assert.equal(parsed.estimatedTokenDelta, '-41');
  assert.deepEqual(addMetrics(legacy, {}), parsed);
  assert.deepEqual(metricsSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
});

test('hook counters accumulate independently and guide-only overhead can produce a negative token delta', () => {
  const first = addMetrics(emptyMetrics(), {
    successfulHookRequests: 1,
    guideOnlyRequests: 1,
    estimatedTokenDelta: '-80',
  });
  const total = addMetrics(first, {
    successfulHookRequests: 2,
    failedHookRequests: 3,
    unverifiedHookRequests: 4,
    guideOnlyRequests: 5,
    estimatedTokenDelta: '30',
  });
  assert.equal(total.successfulHookRequests, 3);
  assert.equal(total.failedHookRequests, 3);
  assert.equal(total.unverifiedHookRequests, 4);
  assert.equal(total.guideOnlyRequests, 6);
  assert.equal(total.estimatedTokenDelta, '-50');
  assert.equal(total.successfulFoldedRequests, 0);
  assert.equal(total.certifiedComparisons, 0);
  assert.equal(total.savingNanoUsdLower, '0');
  assert.equal(first.successfulHookRequests, 1);
  assert.equal(first.guideOnlyRequests, 1);
  assert.equal(first.failedHookRequests, 0);
  assert.equal(first.unverifiedHookRequests, 0);
  assert.equal(first.estimatedTokenDelta, '-80');
  for (const key of hookCounters) assert.equal(emptyMetrics()[key], 0);
});

test('hook counters reject invalid values and overflow while omitted increments preserve totals', () => {
  for (const key of hookCounters) {
    for (const invalid of [-1, 0.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => metricsSchema.parse({ ...emptyMetrics(), [key]: invalid }));
      assert.throws(() => addMetrics(emptyMetrics(), { [key]: invalid }));
    }
    const full = addMetrics(emptyMetrics(), { [key]: Number.MAX_SAFE_INTEGER });
    assert.deepEqual(addMetrics(full, { itemsFolded: 1 }), { ...full, itemsFolded: 1 });
    assert.throws(() => addMetrics(full, { [key]: 1 }));
    assert.equal(full[key], Number.MAX_SAFE_INTEGER);
  }
});

test('token and fee totals stay exact beyond JavaScript safe integer precision', () => {
  const before = addMetrics(emptyMetrics(), {
    foldedTokensEstimated: '900719925474099312345',
    estimatedTokenDelta: '900719925474099312345',
    certifiedTokenDeltaLower: '-900719925474099312345',
    savingNanoUsdLower: '999999999999999999999999999',
  });
  const total = addMetrics(before, {
    foldedTokensEstimated: '1',
    estimatedTokenDelta: '-900719925474099312344',
    certifiedTokenDeltaLower: '900719925474099312344',
    savingNanoUsdLower: '1',
  });
  assert.equal(total.estimatedTokenDelta, '1');
  assert.equal(total.foldedTokensEstimated, '900719925474099312346');
  assert.throws(() => addMetrics(before, { foldedTokensEstimated: '-1' }));
  assert.equal(total.certifiedTokenDeltaLower, '-1');
  assert.equal(total.savingNanoUsdLower, '1000000000000000000000000000');
});

test('token formatting uses decimal K M B with exact arithmetic and unit promotion', () => {
  for (const [value, expected] of [
    ['0', '0'], ['999', '999'], ['1000', '1K'], ['1250', '1.25K'],
    ['999994', '999.99K'], ['999995', '1M'], ['1000000', '1M'],
    ['1250000', '1.25M'], ['999999999', '1B'], ['1000000000', '1B'],
    ['1250000000', '1.25B'], ['1000000000000', '1000B'],
    ['900719925474099312345', '900719925474.1B'], ['-1250000', '-1.25M'],
  ] as const) assert.equal(formatTokenCount(value), expected);
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
