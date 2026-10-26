import { z } from 'zod';

const counterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const integerTextSchema = z.string().regex(/^-?(?:0|[1-9]\d*)$/)
  .transform(value => BigInt(value).toString());

export const metricsSchema = z.object({
  foldBatchesApproved: counterSchema,
  itemsFolded: counterSchema,
  recursiveItemsFolded: counterSchema,
  successfulFoldedRequests: counterSchema,
  failedFoldedRequests: counterSchema,
  unverifiedFoldedRequests: counterSchema,
  replayRequests: counterSchema,
  certifiedComparisons: counterSchema,
  originalReadCalls: counterSchema,
  layerReadCalls: counterSchema,
  readChars: counterSchema,
  itemsRestored: counterSchema,
  estimatedTokenDelta: integerTextSchema,
  certifiedTokenDeltaLower: integerTextSchema,
  savingNanoUsdLower: integerTextSchema,
}).strict();

export type Metrics = z.infer<typeof metricsSchema>;

export function emptyMetrics(): Metrics {
  return {
    foldBatchesApproved: 0,
    itemsFolded: 0,
    recursiveItemsFolded: 0,
    successfulFoldedRequests: 0,
    failedFoldedRequests: 0,
    unverifiedFoldedRequests: 0,
    replayRequests: 0,
    certifiedComparisons: 0,
    originalReadCalls: 0,
    layerReadCalls: 0,
    readChars: 0,
    itemsRestored: 0,
    estimatedTokenDelta: '0',
    certifiedTokenDeltaLower: '0',
    savingNanoUsdLower: '0',
  };
}

export function addMetrics(current: Metrics, delta: Partial<Metrics>): Metrics {
  const value = metricsSchema.parse(current);
  const increment = metricsSchema.partial().parse(delta);
  const addCounter = (before: number, after = 0): number => counterSchema.parse(before + after);
  const addInteger = (before: string, after = '0'): string => (BigInt(before) + BigInt(after)).toString();
  return {
    foldBatchesApproved: addCounter(value.foldBatchesApproved, increment.foldBatchesApproved),
    itemsFolded: addCounter(value.itemsFolded, increment.itemsFolded),
    recursiveItemsFolded: addCounter(value.recursiveItemsFolded, increment.recursiveItemsFolded),
    successfulFoldedRequests: addCounter(value.successfulFoldedRequests, increment.successfulFoldedRequests),
    failedFoldedRequests: addCounter(value.failedFoldedRequests, increment.failedFoldedRequests),
    unverifiedFoldedRequests: addCounter(value.unverifiedFoldedRequests, increment.unverifiedFoldedRequests),
    replayRequests: addCounter(value.replayRequests, increment.replayRequests),
    certifiedComparisons: addCounter(value.certifiedComparisons, increment.certifiedComparisons),
    originalReadCalls: addCounter(value.originalReadCalls, increment.originalReadCalls),
    layerReadCalls: addCounter(value.layerReadCalls, increment.layerReadCalls),
    readChars: addCounter(value.readChars, increment.readChars),
    itemsRestored: addCounter(value.itemsRestored, increment.itemsRestored),
    estimatedTokenDelta: addInteger(value.estimatedTokenDelta, increment.estimatedTokenDelta),
    certifiedTokenDeltaLower: addInteger(value.certifiedTokenDeltaLower, increment.certifiedTokenDeltaLower),
    savingNanoUsdLower: addInteger(value.savingNanoUsdLower, increment.savingNanoUsdLower),
  };
}

export function formatNanoUsd(value: string): string {
  const amount = BigInt(integerTextSchema.parse(value));
  const digits = (amount < 0n ? -amount : amount).toString().padStart(10, '0');
  return `${amount < 0n ? '-' : ''}${digits.slice(0, -9)}.${digits.slice(-9)}`;
}
