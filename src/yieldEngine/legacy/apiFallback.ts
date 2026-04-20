import { getRealtimeAprConsensus } from "../../realtimeApr.js";
import { findPoolByTokens } from "../ingestion/defiLlamaYields.js";
import type { DataSourceTag, RobustYieldEstimate } from "../types.js";
import { totalAprToApy } from "../compute/apy.js";

export interface DefiLlamaLookupOpts {
  /** DefiLlama project slug prefix (e.g. "aerodrome", "moonwell") */
  project?: string;
  /** Underlying token0 address for token-based pool lookup */
  token0?: string;
  /** Underlying token1 address for LP pair lookup */
  token1?: string;
}

/**
 * API-layer fallback APR estimate.
 *
 * Strategy (tried in order, first success wins):
 *   1. Multi-source consensus (Gecko + DexScreener + DefiLlama UUID lookup)
 *   2. DefiLlama direct lookup by token addresses (when defiLlamaOpts provided)
 *
 * Returns null when no usable estimate can be produced.
 */
export async function apiFallbackTotalApr(
  poolAddress: string,
  freshnessWindowSec: number,
  minConfidence: number,
  apyCompoundPeriodsPerYear: number,
  defiLlamaOpts?: DefiLlamaLookupOpts
): Promise<{ estimate: RobustYieldEstimate; tags: DataSourceTag[] } | null> {
  // ── Strategy 1: multi-source consensus ─────────────────────────────────
  const consensus = await getRealtimeAprConsensus(poolAddress, freshnessWindowSec, minConfidence);
  if (consensus.apr !== null && consensus.apr > 0) {
    const totalApr = consensus.apr;
    const tags: DataSourceTag[] = ["api:gecko", "api:dexscreener", "api:defillama"];
    return {
      estimate: buildFallbackEstimate(totalApr, 0, 0, consensus.confidence * 0.85, consensus.usable, apyCompoundPeriodsPerYear, tags),
      tags,
    };
  }

  // ── Strategy 2: DefiLlama direct token lookup ───────────────────────────
  if (defiLlamaOpts?.project && defiLlamaOpts?.token0) {
    try {
      const llamaPool = await findPoolByTokens(
        defiLlamaOpts.project,
        defiLlamaOpts.token0,
        defiLlamaOpts.token1
      );
      if (llamaPool && llamaPool.apy > 0) {
        // DefiLlama reports APY in %; convert to APR decimal for internal use.
        // APY ≈ APR for small values; we store as APR and convert to APY later.
        const totalApr = llamaPool.apy / 100;
        const feeApr = (llamaPool.apyBase ?? 0) / 100;
        const rewardApr = (llamaPool.apyReward ?? 0) / 100;
        const tags: DataSourceTag[] = ["api:defillama"];
        return {
          estimate: buildFallbackEstimate(totalApr, feeApr, rewardApr, 0.70, true, apyCompoundPeriodsPerYear, tags),
          tags,
        };
      }
    } catch {
      // non-fatal; fall through to null
    }
  }

  return null;
}

/** Split API total into fee/reward for display only (unknown split). */
export function annotateApiFallbackBreakdown(totalApr: number): { feeApr: number; rewardApr: number } {
  return { feeApr: totalApr * 0.5, rewardApr: totalApr * 0.5 };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function buildFallbackEstimate(
  totalApr: number,
  feeApr: number,
  rewardApr: number,
  confidence: number,
  usable: boolean,
  apyCompoundPeriodsPerYear: number,
  tags: DataSourceTag[]
): RobustYieldEstimate {
  return {
    feeApr,
    rewardApr,
    totalApr,
    estimatedApy: totalAprToApy(totalApr, apyCompoundPeriodsPerYear),
    confidence,
    dataSourcesUsed: tags,
    usable,
    diagnostics: {
      feeUsdWindow: 0,
      windowSec: { fee: 0, rewardSmoothingHalfLifeSec: 0 },
      tvlUsdTwab: 0,
      rewardUsdPerSec: 0,
      swapCount: 0,
      coverageRatio: usable ? 0.6 : 0.3,
    },
  };
}
