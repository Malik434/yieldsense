import { getRealtimeAprConsensus } from "../../realtimeApr.js";
import type { DataSourceTag, RobustYieldEstimate } from "../types.js";
import { totalAprToApy } from "../compute/apy.js";

export async function apiFallbackTotalApr(
  poolAddress: string,
  freshnessWindowSec: number,
  minConfidence: number,
  apyCompoundPeriodsPerYear: number
): Promise<{ estimate: RobustYieldEstimate; tags: DataSourceTag[] } | null> {
  const consensus = await getRealtimeAprConsensus(poolAddress, freshnessWindowSec, minConfidence);
  if (consensus.apr === null) return null;

  const totalApr = consensus.apr;
  const tags: DataSourceTag[] = ["api:gecko", "api:dexscreener", "api:defillama"];
  return {
    estimate: {
      feeApr: 0,
      rewardApr: 0,
      totalApr,
      estimatedApy: totalAprToApy(totalApr, apyCompoundPeriodsPerYear),
      confidence: consensus.confidence * 0.85,
      dataSourcesUsed: tags,
      usable: consensus.usable,
      diagnostics: {
        feeUsdWindow: 0,
        windowSec: { fee: 0, rewardSmoothingHalfLifeSec: 0 },
        tvlUsdTwab: 0,
        rewardUsdPerSec: 0,
        swapCount: 0,
        coverageRatio: consensus.usable ? 0.6 : 0.3,
      },
    },
    tags,
  };
}

/** Split API total into fee/reward for display only (unknown split). */
export function annotateApiFallbackBreakdown(totalApr: number): { feeApr: number; rewardApr: number } {
  return { feeApr: totalApr * 0.5, rewardApr: totalApr * 0.5 };
}
