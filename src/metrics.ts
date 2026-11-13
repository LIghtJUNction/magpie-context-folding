import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Diagnostic size estimate for folding statistics, never a model context limit. */
export function estimateTokens(body: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4);
}

export interface JsonMeasurement {
  readonly bytes: number;
  readonly estimatedTokens: number;
}

/** Cache measurements for immutable request objects within one hook invocation. */
export function createJsonMeasurementCache(): (value: object) => JsonMeasurement {
  const cache = new WeakMap<object, JsonMeasurement>();
  return value => {
    const previous = cache.get(value);
    if (previous) return previous;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const measurement = { bytes, estimatedTokens: Math.ceil(bytes / 4) };
    cache.set(value, measurement);
    return measurement;
  };
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
  responseUsageRequests: counterSchema.default(0),
  responseUsageUnavailableRequests: counterSchema.default(0),
  responseInputTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseOutputTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseCacheReadUsageRequests: counterSchema.default(0),
  responseCacheReadTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseCacheWriteUsageRequests: counterSchema.default(0),
  responseCacheWriteTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseFoldedUsageRequests: counterSchema.default(0),
  responseFoldedUsageUnavailableRequests: counterSchema.default(0),
  responseFoldedInputTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseFoldedOutputTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseFoldedCacheReadUsageRequests: counterSchema.default(0),
  responseFoldedCacheReadTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseFoldedCacheWriteUsageRequests: counterSchema.default(0),
  responseFoldedCacheWriteTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseUnfoldedUsageRequests: counterSchema.default(0),
  responseUnfoldedUsageUnavailableRequests: counterSchema.default(0),
  responseUnfoldedInputTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseUnfoldedOutputTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseUnfoldedCacheReadUsageRequests: counterSchema.default(0),
  responseUnfoldedCacheReadTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseUnfoldedCacheWriteUsageRequests: counterSchema.default(0),
  responseUnfoldedCacheWriteTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  observeOnlySuccessfulRequests: counterSchema.default(0),
  observeOnlyFailedRequests: counterSchema.default(0),
  observeOnlyUnverifiedRequests: counterSchema.default(0),
  responseObserveOnlyUsageRequests: counterSchema.default(0),
  responseObserveOnlyUsageUnavailableRequests: counterSchema.default(0),
  responseObserveOnlyInputTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseObserveOnlyOutputTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseObserveOnlyCacheReadUsageRequests: counterSchema.default(0),
  responseObserveOnlyCacheReadTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
  responseObserveOnlyCacheWriteUsageRequests: counterSchema.default(0),
  responseObserveOnlyCacheWriteTokens: integerTextSchema.refine(value => BigInt(value) >= 0n).default('0'),
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
    responseUsageRequests: 0,
    responseUsageUnavailableRequests: 0,
    responseInputTokens: '0',
    responseOutputTokens: '0',
    responseCacheReadUsageRequests: 0,
    responseCacheReadTokens: '0',
    responseCacheWriteUsageRequests: 0,
    responseCacheWriteTokens: '0',
    responseFoldedUsageRequests: 0,
    responseFoldedUsageUnavailableRequests: 0,
    responseFoldedInputTokens: '0',
    responseFoldedOutputTokens: '0',
    responseFoldedCacheReadUsageRequests: 0,
    responseFoldedCacheReadTokens: '0',
    responseFoldedCacheWriteUsageRequests: 0,
    responseFoldedCacheWriteTokens: '0',
    responseUnfoldedUsageRequests: 0,
    responseUnfoldedUsageUnavailableRequests: 0,
    responseUnfoldedInputTokens: '0',
    responseUnfoldedOutputTokens: '0',
    responseUnfoldedCacheReadUsageRequests: 0,
    responseUnfoldedCacheReadTokens: '0',
    responseUnfoldedCacheWriteUsageRequests: 0,
    responseUnfoldedCacheWriteTokens: '0',
    observeOnlySuccessfulRequests: 0,
    observeOnlyFailedRequests: 0,
    observeOnlyUnverifiedRequests: 0,
    responseObserveOnlyUsageRequests: 0,
    responseObserveOnlyUsageUnavailableRequests: 0,
    responseObserveOnlyInputTokens: '0',
    responseObserveOnlyOutputTokens: '0',
    responseObserveOnlyCacheReadUsageRequests: 0,
    responseObserveOnlyCacheReadTokens: '0',
    responseObserveOnlyCacheWriteUsageRequests: 0,
    responseObserveOnlyCacheWriteTokens: '0',
  };
  // @context-fold end emptyMetrics-f78670fdef
}

const compactMetricKeys = new Map(Object.keys(metricsSchema.shape).map(key => [
  `m${createHash('sha256').update(key).digest('hex').slice(0, 8)}`, key as keyof Metrics,
]));
if (compactMetricKeys.size !== Object.keys(metricsSchema.shape).length) throw new Error('Metric storage key collision');
const metricNamesByCompactKey = new Map([...compactMetricKeys].map(([compact, name]) => [name, compact]));

/** Compact the on-disk keys; full metric names remain the in-memory and CLI format. */
export function compactMetrics(metrics: Metrics): Record<string, number | string> {
  return Object.fromEntries(Object.entries(metrics).map(([name, value]) => [
    metricNamesByCompactKey.get(name as keyof Metrics)!, value,
  ]));
}

const compactMetricsSchema = z.record(z.string(), z.unknown()).transform((value, context) => {
  const expanded = Object.fromEntries(Object.entries(value).flatMap(([key, count]) => {
    const name = compactMetricKeys.get(key);
    if (name === undefined) {
      context.addIssue({ code: 'custom', message: 'Unknown compact metric' });
      return [];
    }
    return [[name, count]];
  }));
  const parsed = metricsSchema.safeParse(expanded);
  if (!parsed.success) {
    context.addIssue({ code: 'custom', message: 'Invalid compact metrics' });
    return z.NEVER;
  }
  return parsed.data;
});
export const storedMetricsSchema = z.union([metricsSchema, compactMetricsSchema]).default(emptyMetrics);

export function parseStoredMetrics(value: unknown): Metrics {
  return storedMetricsSchema.parse(value);
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
    responseUsageRequests: addCounter(value.responseUsageRequests, increment.responseUsageRequests),
    responseUsageUnavailableRequests: addCounter(value.responseUsageUnavailableRequests, increment.responseUsageUnavailableRequests),
    responseInputTokens: addInteger(value.responseInputTokens, increment.responseInputTokens),
    responseOutputTokens: addInteger(value.responseOutputTokens, increment.responseOutputTokens),
    responseCacheReadUsageRequests: addCounter(value.responseCacheReadUsageRequests, increment.responseCacheReadUsageRequests),
    responseCacheReadTokens: addInteger(value.responseCacheReadTokens, increment.responseCacheReadTokens),
    responseCacheWriteUsageRequests: addCounter(value.responseCacheWriteUsageRequests, increment.responseCacheWriteUsageRequests),
    responseCacheWriteTokens: addInteger(value.responseCacheWriteTokens, increment.responseCacheWriteTokens),
    responseFoldedUsageRequests: addCounter(value.responseFoldedUsageRequests, increment.responseFoldedUsageRequests),
    responseFoldedUsageUnavailableRequests: addCounter(value.responseFoldedUsageUnavailableRequests, increment.responseFoldedUsageUnavailableRequests),
    responseFoldedInputTokens: addInteger(value.responseFoldedInputTokens, increment.responseFoldedInputTokens),
    responseFoldedOutputTokens: addInteger(value.responseFoldedOutputTokens, increment.responseFoldedOutputTokens),
    responseFoldedCacheReadUsageRequests: addCounter(value.responseFoldedCacheReadUsageRequests, increment.responseFoldedCacheReadUsageRequests),
    responseFoldedCacheReadTokens: addInteger(value.responseFoldedCacheReadTokens, increment.responseFoldedCacheReadTokens),
    responseFoldedCacheWriteUsageRequests: addCounter(value.responseFoldedCacheWriteUsageRequests, increment.responseFoldedCacheWriteUsageRequests),
    responseFoldedCacheWriteTokens: addInteger(value.responseFoldedCacheWriteTokens, increment.responseFoldedCacheWriteTokens),
    responseUnfoldedUsageRequests: addCounter(value.responseUnfoldedUsageRequests, increment.responseUnfoldedUsageRequests),
    responseUnfoldedUsageUnavailableRequests: addCounter(value.responseUnfoldedUsageUnavailableRequests, increment.responseUnfoldedUsageUnavailableRequests),
    responseUnfoldedInputTokens: addInteger(value.responseUnfoldedInputTokens, increment.responseUnfoldedInputTokens),
    responseUnfoldedOutputTokens: addInteger(value.responseUnfoldedOutputTokens, increment.responseUnfoldedOutputTokens),
    responseUnfoldedCacheReadUsageRequests: addCounter(value.responseUnfoldedCacheReadUsageRequests, increment.responseUnfoldedCacheReadUsageRequests),
    responseUnfoldedCacheReadTokens: addInteger(value.responseUnfoldedCacheReadTokens, increment.responseUnfoldedCacheReadTokens),
    responseUnfoldedCacheWriteUsageRequests: addCounter(value.responseUnfoldedCacheWriteUsageRequests, increment.responseUnfoldedCacheWriteUsageRequests),
    responseUnfoldedCacheWriteTokens: addInteger(value.responseUnfoldedCacheWriteTokens, increment.responseUnfoldedCacheWriteTokens),
    observeOnlySuccessfulRequests: addCounter(value.observeOnlySuccessfulRequests, increment.observeOnlySuccessfulRequests),
    observeOnlyFailedRequests: addCounter(value.observeOnlyFailedRequests, increment.observeOnlyFailedRequests),
    observeOnlyUnverifiedRequests: addCounter(value.observeOnlyUnverifiedRequests, increment.observeOnlyUnverifiedRequests),
    responseObserveOnlyUsageRequests: addCounter(value.responseObserveOnlyUsageRequests, increment.responseObserveOnlyUsageRequests),
    responseObserveOnlyUsageUnavailableRequests: addCounter(value.responseObserveOnlyUsageUnavailableRequests, increment.responseObserveOnlyUsageUnavailableRequests),
    responseObserveOnlyInputTokens: addInteger(value.responseObserveOnlyInputTokens, increment.responseObserveOnlyInputTokens),
    responseObserveOnlyOutputTokens: addInteger(value.responseObserveOnlyOutputTokens, increment.responseObserveOnlyOutputTokens),
    responseObserveOnlyCacheReadUsageRequests: addCounter(value.responseObserveOnlyCacheReadUsageRequests, increment.responseObserveOnlyCacheReadUsageRequests),
    responseObserveOnlyCacheReadTokens: addInteger(value.responseObserveOnlyCacheReadTokens, increment.responseObserveOnlyCacheReadTokens),
    responseObserveOnlyCacheWriteUsageRequests: addCounter(value.responseObserveOnlyCacheWriteUsageRequests, increment.responseObserveOnlyCacheWriteUsageRequests),
    responseObserveOnlyCacheWriteTokens: addInteger(value.responseObserveOnlyCacheWriteTokens, increment.responseObserveOnlyCacheWriteTokens),
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
