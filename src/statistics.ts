import { Store } from './store.js';
import { formatNanoUsd, formatTokenCount, type Metrics } from './metrics.js';

export function usageByFoldState(m: Metrics) {
  const remainderCount = (total: number, folded: number, unfolded: number, observeOnly: number) =>
    total - folded - unfolded - observeOnly;
  const remainderTokens = (total: string, folded: string, unfolded: string, observeOnly: string) =>
    (BigInt(total) - BigInt(folded) - BigInt(unfolded) - BigInt(observeOnly)).toString();
  return {
    withFoldedContent: {
      requests: m.responseFoldedUsageRequests,
      unavailableRequests: m.responseFoldedUsageUnavailableRequests,
      inputTokens: m.responseFoldedInputTokens,
      outputTokens: m.responseFoldedOutputTokens,
      cacheReadUsageRequests: m.responseFoldedCacheReadUsageRequests,
      cacheReadTokens: m.responseFoldedCacheReadTokens,
      cacheWriteUsageRequests: m.responseFoldedCacheWriteUsageRequests,
      cacheWriteTokens: m.responseFoldedCacheWriteTokens,
    },
    withoutFoldedContent: {
      requests: m.responseUnfoldedUsageRequests,
      unavailableRequests: m.responseUnfoldedUsageUnavailableRequests,
      inputTokens: m.responseUnfoldedInputTokens,
      outputTokens: m.responseUnfoldedOutputTokens,
      cacheReadUsageRequests: m.responseUnfoldedCacheReadUsageRequests,
      cacheReadTokens: m.responseUnfoldedCacheReadTokens,
      cacheWriteUsageRequests: m.responseUnfoldedCacheWriteUsageRequests,
      cacheWriteTokens: m.responseUnfoldedCacheWriteTokens,
    },
    observeOnly: {
      requests: m.responseObserveOnlyUsageRequests,
      unavailableRequests: m.responseObserveOnlyUsageUnavailableRequests,
      inputTokens: m.responseObserveOnlyInputTokens,
      outputTokens: m.responseObserveOnlyOutputTokens,
      cacheReadUsageRequests: m.responseObserveOnlyCacheReadUsageRequests,
      cacheReadTokens: m.responseObserveOnlyCacheReadTokens,
      cacheWriteUsageRequests: m.responseObserveOnlyCacheWriteUsageRequests,
      cacheWriteTokens: m.responseObserveOnlyCacheWriteTokens,
    },
    unclassified: {
      requests: remainderCount(m.responseUsageRequests, m.responseFoldedUsageRequests,
        m.responseUnfoldedUsageRequests, m.responseObserveOnlyUsageRequests),
      unavailableRequests: remainderCount(m.responseUsageUnavailableRequests,
        m.responseFoldedUsageUnavailableRequests, m.responseUnfoldedUsageUnavailableRequests,
        m.responseObserveOnlyUsageUnavailableRequests),
      inputTokens: remainderTokens(m.responseInputTokens, m.responseFoldedInputTokens,
        m.responseUnfoldedInputTokens, m.responseObserveOnlyInputTokens),
      outputTokens: remainderTokens(m.responseOutputTokens, m.responseFoldedOutputTokens,
        m.responseUnfoldedOutputTokens, m.responseObserveOnlyOutputTokens),
      cacheReadUsageRequests: remainderCount(m.responseCacheReadUsageRequests,
        m.responseFoldedCacheReadUsageRequests, m.responseUnfoldedCacheReadUsageRequests,
        m.responseObserveOnlyCacheReadUsageRequests),
      cacheReadTokens: remainderTokens(m.responseCacheReadTokens,
        m.responseFoldedCacheReadTokens, m.responseUnfoldedCacheReadTokens,
        m.responseObserveOnlyCacheReadTokens),
      cacheWriteUsageRequests: remainderCount(m.responseCacheWriteUsageRequests,
        m.responseFoldedCacheWriteUsageRequests, m.responseUnfoldedCacheWriteUsageRequests,
        m.responseObserveOnlyCacheWriteUsageRequests),
      cacheWriteTokens: remainderTokens(m.responseCacheWriteTokens,
        m.responseFoldedCacheWriteTokens, m.responseUnfoldedCacheWriteTokens,
        m.responseObserveOnlyCacheWriteTokens),
    },
  };
}

export async function statistics(scope?: string) {
  // @context-fold begin statistics-2abc6ff4f9
  const result = await new Store().readStats(scope);
  const m = result.metrics;
  return {
    scope: scope === undefined ? 'global-lifetime' : 'session',
    ...result,
    responseUsageByFoldState: usageByFoldState(m),
    netBenefit: {
      status: 'unverified' as const,
      reason: result.metrics.certifiedComparisons === 0 ? 'no-certified-comparisons' as const : 'conditional-bound-only' as const,
      actualTimeSavingMs: null,
      measuredOverheadUsd: null,
    },
    summary: {
      foldCount: result.metrics.foldBatchesApproved,
      detailViewCount: result.metrics.originalReadCalls + result.metrics.layerReadCalls,
      foldedTokensEstimated: result.metrics.foldedTokensEstimated,
      foldedTokensDisplay: formatTokenCount(result.metrics.foldedTokensEstimated),
    },
    money: {
      currency: 'USD',
      certifiedInputSavingLowerUsd: formatNanoUsd(result.metrics.savingNanoUsdLower),
      coveredComparisons: result.metrics.certifiedComparisons,
      actualBillSavingUsd: null,
    },
    notes: [
      'Net benefit is unverified: actual billing savings, elapsed-time savings and measured overhead are unavailable, not zero. Read/restore counts do not measure their cost.',
      'Fold totals count approved batches, including recursive folds, without recounting replays. Tokens use full-request UTF-8 bytes / 4, not a tokenizer. Signed estimatedTokenDelta includes guide overhead on matching successful responses; fold totals are not full-task savings.',
      'Response usage totals come only from successful, matched replies with both input and output token fields. Cache totals include only replies that expose those fields. Cache counts overlap or partition input according to the protocol. These are reported usage, not a bill or proof of folding savings; replies without complete usage are counted separately.',
      'Response usage is grouped by whether the matched request contained folded content or ran in observe-only mode. Observe-only passes requests through without folding or recovery guidance. These groups do not match tasks, models, output quality, or cost; unclassified values may come from older counters and are not assigned to a group.',
      'Certified amounts are conditional incremental lower bounds, not bills. Current certificates require all additional task costs; historical evidence is not upgraded. Uncertified replays and unreserved marking/reading/restoring costs receive no assumed monetary credit or deduction.',
      'Missing or failed responses are not successful. Lifetime aggregates survive archive disposal; missing historical counters are not reconstructed.',
    ],
  };
  // @context-fold end statistics-2abc6ff4f9
}
