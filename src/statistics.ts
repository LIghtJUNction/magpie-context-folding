import { Store } from './store.js';
import { formatNanoUsd, formatTokenCount } from './metrics.js';

export async function statistics(scope?: string) {
  const result = await new Store().readStats(scope);
  return {
    scope: scope === undefined ? 'global-lifetime' : 'session',
    ...result,
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
      'Fold count and cumulative folded tokens cover newly approved batches, including recursive folds, without recounting replays. Detail views count successful original/layer read calls. Folded tokens are estimated from complete before/after request UTF-8 bytes / 4; historical totals from before this counter was added are not reconstructed.',
      'Amounts cover certified incremental comparisons on successful matching responses, subject to accounting assumptions; they are not actual billing savings. Current certificates require bounds for all additional work on the same task, including tool calls and model round trips. Historical totals retain their original evidence limits and are not upgraded to full-task savings proofs.',
      'Estimated token deltas cover all hook-transformed requests with successful matching responses, including guide-only requests, using serialized UTF-8 bytes / 4; guide overhead can make the delta negative. Certified token deltas are incremental lower bounds with a different baseline; neither is actual billing savings.',
      'Replays without a new certificate have no monetary credit. Marking, reads, restores and other unreserved costs are not automatically deducted.',
      'Response callbacks can be lost. Missing or failed responses are not assumed successful. Lifetime aggregates survive archive disposal.',
    ],
  };
}
