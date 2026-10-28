import { z } from 'zod';

/** JSON size estimate for folding savings and statistics, never a model context limit. */
export function estimateTokens(body: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4);
}

const counterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const integerTextSchema = z.string().regex(/^-?(?:0|[1-9]\d*)$/)
  .transform(value => BigInt(value).toString());

export const metricsSchema = z.object({
  foldBatchesApproved: counterSchema,
  itemsFolded: counterSchema,
  recursiveItemsFolded: counterSchema,
  successfulHookRequests: counterSchema.default(0),
  failedHookRequests: counterSchema.default(0),
  unverifiedHookRequests: counterSchema.default(0),
  guideOnlyRequests: counterSchema.default(0),
  successfulFoldedRequests: counterSchema,
  failedFoldedRequests: counterSchema,
  unverifiedFoldedRequests: counterSchema,
  replayRequests: counterSchema,
  certifiedComparisons: counterSchema,
  originalReadCalls: counterSchema,
  layerReadCalls: counterSchema,
  readChars: counterSchema,
  itemsRestored: counterSchema,
  foldedTokensEstimated: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  estimatedTokenDelta: integerTextSchema,
  certifiedTokenDeltaLower: integerTextSchema,
  savingNanoUsdLower: integerTextSchema,
}).strict();

export type Metrics = z.infer<typeof metricsSchema>;

export function emptyMetrics(): Metrics {
  // @context-fold begin emptyMetrics-f78670fdef
  return {
    foldBatchesApproved: 0,
    itemsFolded: 0,
    recursiveItemsFolded: 0,
    successfulHookRequests: 0,
    failedHookRequests: 0,
    unverifiedHookRequests: 0,
    guideOnlyRequests: 0,
    successfulFoldedRequests: 0,
    failedFoldedRequests: 0,
    unverifiedFoldedRequests: 0,
    replayRequests: 0,
    certifiedComparisons: 0,
    originalReadCalls: 0,
    layerReadCalls: 0,
    readChars: 0,
    itemsRestored: 0,
    foldedTokensEstimated: '0',
    estimatedTokenDelta: '0',
    certifiedTokenDeltaLower: '0',
    savingNanoUsdLower: '0',
  };
  // @context-fold end emptyMetrics-f78670fdef
}

export function addMetrics(current: Metrics, delta: Partial<Metrics>): Metrics {
  // @context-fold begin addMetrics-18fee8148c
  const value = metricsSchema.parse(current);
  const increment = metricsSchema.partial().parse(delta);
  const addCounter = (before: number, after = 0): number => counterSchema.parse(before + after);
  const addInteger = (before: string, after = '0'): string => (BigInt(before) + BigInt(after)).toString();
  return {
    foldBatchesApproved: addCounter(value.foldBatchesApproved, increment.foldBatchesApproved),
    itemsFolded: addCounter(value.itemsFolded, increment.itemsFolded),
    recursiveItemsFolded: addCounter(value.recursiveItemsFolded, increment.recursiveItemsFolded),
    successfulHookRequests: addCounter(value.successfulHookRequests, increment.successfulHookRequests),
    failedHookRequests: addCounter(value.failedHookRequests, increment.failedHookRequests),
    unverifiedHookRequests: addCounter(value.unverifiedHookRequests, increment.unverifiedHookRequests),
    guideOnlyRequests: addCounter(value.guideOnlyRequests, increment.guideOnlyRequests),
    successfulFoldedRequests: addCounter(value.successfulFoldedRequests, increment.successfulFoldedRequests),
    failedFoldedRequests: addCounter(value.failedFoldedRequests, increment.failedFoldedRequests),
    unverifiedFoldedRequests: addCounter(value.unverifiedFoldedRequests, increment.unverifiedFoldedRequests),
    replayRequests: addCounter(value.replayRequests, increment.replayRequests),
    certifiedComparisons: addCounter(value.certifiedComparisons, increment.certifiedComparisons),
    originalReadCalls: addCounter(value.originalReadCalls, increment.originalReadCalls),
    layerReadCalls: addCounter(value.layerReadCalls, increment.layerReadCalls),
    readChars: addCounter(value.readChars, increment.readChars),
    itemsRestored: addCounter(value.itemsRestored, increment.itemsRestored),
    foldedTokensEstimated: addInteger(value.foldedTokensEstimated, increment.foldedTokensEstimated),
    estimatedTokenDelta: addInteger(value.estimatedTokenDelta, increment.estimatedTokenDelta),
    certifiedTokenDeltaLower: addInteger(value.certifiedTokenDeltaLower, increment.certifiedTokenDeltaLower),
    savingNanoUsdLower: addInteger(value.savingNanoUsdLower, increment.savingNanoUsdLower),
  };
  // @context-fold end addMetrics-18fee8148c
}

export function formatNanoUsd(value: string): string {
  const amount = BigInt(integerTextSchema.parse(value));
  const digits = (amount < 0n ? -amount : amount).toString().padStart(10, '0');
  return `${amount < 0n ? '-' : ''}${digits.slice(0, -9)}.${digits.slice(-9)}`;
}

export function formatTokenCount(value: string): string {
  // @context-fold begin formatTokenCount-5601cdefd5
  const amount = BigInt(integerTextSchema.parse(value));
  const absolute = amount < 0n ? -amount : amount;
  let divisor = 1n;
  let suffix = '';
  for (const [unit, label] of [[1_000n, 'K'], [1_000_000n, 'M'], [1_000_000_000n, 'B']] as const) {
    if (absolute < unit) break;
    divisor = unit;
    suffix = label;
  }
  if (divisor === 1n) return amount.toString();
  const rounded = () => (absolute * 100n + divisor / 2n) / divisor;
  if (rounded() >= 100_000n && suffix !== 'B') {
    divisor *= 1_000n;
    suffix = suffix === 'K' ? 'M' : 'B';
  }
  const hundredths = rounded();
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${amount < 0n ? '-' : ''}${hundredths / 100n}${fraction ? '.' + fraction : ''}${suffix}`;
  // @context-fold end formatTokenCount-5601cdefd5
}
