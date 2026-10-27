import { Store } from './store.js';
import { formatNanoUsd, formatTokenCount } from './metrics.js';

export async function statistics(scope?: string) {
  const result = await new Store().readStats(scope);
  return {
    scope: scope === undefined ? 'global-lifetime' : 'session',
    ...result,
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
      'Certified amounts are conditional incremental lower bounds, not bills. Current certificates require all additional task costs; historical evidence is not upgraded. Uncertified replays and unreserved marking/reading/restoring costs receive no assumed monetary credit or deduction.',
      'Missing or failed responses are not successful. Lifetime aggregates survive archive disposal; missing historical counters are not reconstructed.',
    ],
  };
}
