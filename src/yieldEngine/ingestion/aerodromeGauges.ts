import { JsonRpcProvider } from "ethers";
import { readGaugeSnapshot } from "../indexers/rewardIndexer.js";
import { findPoolByTokens, type DefiLlamaPoolYield } from "./defiLlamaYields.js";

/**
 * Combined on-chain + DefiLlama data for a single Aerodrome gauge.
 * Used to validate reward APR estimates and produce a blended confidence score.
 */
export interface AerodromeGaugeResult {
  gaugeAddress: string;
  poolAddress: string;
  /** On-chain: annualized reward APR as a decimal (e.g. 0.12 = 12%) */
  onChainRewardApr: number;
  /** On-chain: USD value of rewards emitted per second */
  rewardUsdPerSec: number;
  /** On-chain: total USD staked in the gauge */
  stakedUsd: number;
  /** On-chain: whether the current epoch has active rewards */
  gaugeActive: boolean;
  /** On-chain: epoch end timestamp (Unix seconds) */
  periodFinish: number;
  /** DefiLlama cross-reference (null if pool not indexed or tokens not provided) */
  defiLlama: DefiLlamaPoolYield | null;
  /**
   * Blended confidence score [0, 1]:
   * - Starts at 1.0 for an active on-chain gauge.
   * - Boosted to ~1.0 when DefiLlama reward APY is within 40% of on-chain value.
   * - Reduced when on-chain gauge is expired, empty, or deviates strongly from DefiLlama.
   */
  confidenceScore: number;
}

/**
 * Fetch Aerodrome gauge data on-chain and cross-reference with DefiLlama.
 *
 * @param provider            Base mainnet JSON-RPC provider
 * @param gaugeAddress        Aerodrome gauge contract address
 * @param lpTokenAddress      LP token address (staked in the gauge)
 * @param lpTokenUsdPerToken  Current price of one LP token in USD
 * @param rewardTokenPriceUsd Current price of the reward token in USD (usually AERO)
 * @param token0              Optional: underlying token0 address for DefiLlama lookup
 * @param token1              Optional: underlying token1 address for DefiLlama lookup
 */
export async function fetchAerodromeGaugeResult(
  provider: JsonRpcProvider,
  gaugeAddress: string,
  lpTokenAddress: string,
  lpTokenUsdPerToken: number,
  rewardTokenPriceUsd: number,
  token0?: string,
  token1?: string
): Promise<AerodromeGaugeResult> {
  // ── On-chain gauge snapshot ──────────────────────────────────────────────
  const snapshot = await readGaugeSnapshot(
    provider,
    gaugeAddress,
    lpTokenAddress,
    lpTokenUsdPerToken,
    rewardTokenPriceUsd
  );

  const now = Math.floor(Date.now() / 1000);
  const gaugeActive = Number(snapshot.periodFinish) > now && snapshot.rewardRate > 0n;
  const onChainRewardApr = snapshot.rewardAprInstant;

  // ── DefiLlama cross-reference ────────────────────────────────────────────
  let defiLlama: DefiLlamaPoolYield | null = null;
  if (token0) {
    try {
      defiLlama = await findPoolByTokens("aerodrome", token0, token1);
    } catch {
      // non-fatal; confidence penalty applied below
    }
  }

  // ── Confidence blending ──────────────────────────────────────────────────
  let confidenceScore = gaugeActive ? 0.85 : 0.30;

  if (snapshot.totalSupply === 0n) {
    // Nothing staked — APR is theoretical, reduce confidence sharply
    confidenceScore = Math.min(confidenceScore, 0.20);
  }

  if (defiLlama !== null) {
    const llamaRewardApr = (defiLlama.apyReward ?? 0) / 100;
    const llamaTotalApr = defiLlama.apy / 100;

    if (llamaRewardApr > 0 && onChainRewardApr > 0) {
      // Relative divergence between on-chain and DefiLlama reward APR
      const divergence = Math.abs(onChainRewardApr - llamaRewardApr) / Math.max(onChainRewardApr, llamaRewardApr);
      if (divergence <= 0.40) {
        // Good agreement — boost confidence
        confidenceScore = Math.min(1.0, confidenceScore + 0.15);
      } else if (divergence > 0.80) {
        // Strong disagreement — penalize (stale epoch or mis-matched pool)
        confidenceScore = Math.max(0.10, confidenceScore - 0.25);
      }
    } else if (llamaTotalApr > 0) {
      // DefiLlama has data but reward breakdown is absent; mild boost
      confidenceScore = Math.min(1.0, confidenceScore + 0.05);
    }
  } else if (token0) {
    // Tokens were provided but DefiLlama had no matching pool; mild penalty
    confidenceScore = Math.max(0.15, confidenceScore - 0.10);
  }

  return {
    gaugeAddress,
    poolAddress: lpTokenAddress,
    onChainRewardApr,
    rewardUsdPerSec: snapshot.rewardUsdPerSec,
    stakedUsd: snapshot.stakedUsd,
    gaugeActive,
    periodFinish: Number(snapshot.periodFinish),
    defiLlama,
    confidenceScore,
  };
}
