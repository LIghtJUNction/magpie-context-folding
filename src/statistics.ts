import { Store } from './store.js';
import { formatNanoUsd } from './metrics.js';

export async function statistics(scope?: string) {
  const result = await new Store().readStats(scope);
  return {
    scope: scope === undefined ? 'global-lifetime' : 'session',
    ...result,
    money: {
      currency: 'USD',
      certifiedInputSavingLowerUsd: formatNanoUsd(result.metrics.savingNanoUsdLower),
      coveredComparisons: result.metrics.certifiedComparisons,
      actualBillSavingUsd: null,
    },
    notes: [
      'Amounts cover certified incremental comparisons on successful matching responses, subject to accounting assumptions; they are not actual billing savings.',
      'Estimated tokens use serialized UTF-8 bytes / 4. Certified token deltas are incremental lower bounds; these two counters have different baselines.',
      'Replays without a new certificate have no monetary credit. Marking, reads, restores and other unreserved costs are not automatically deducted.',
      'Response callbacks can be lost. Missing or failed responses are not assumed successful. Lifetime aggregates survive archive disposal.',
    ],
  };
}
