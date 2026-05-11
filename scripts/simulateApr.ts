import { JsonRpcProvider } from "ethers";
import { getRobustYieldEstimate } from "../src/yieldEngine/getRobustYieldEstimate.js";
import type { YieldEngineContext, YieldEstimateRequest } from "../src/yieldEngine/types.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://mainnet.base.org";
  console.log(`[Simulator] Using RPC: ${rpcUrl}`);

  const provider = new JsonRpcProvider(rpcUrl);

  const ctx: YieldEngineContext = {
    provider,
    rewardAprEwmPrev: null,
  };

  const req: YieldEstimateRequest = {
    chainId: 8453,
    poolAddress: process.env.POOL_ADDRESS || "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d",
    gaugeAddress: process.env.GAUGE_ADDRESS || "0x4F09bAb2f0E15e2A078A227FE1537665F55b8360",
    lpTokenAddress: process.env.POOL_ADDRESS || "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d",
    rewardTokenAddress: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
    strategyDeltaUsd: 0,
    poolFeeBps: 30,
    feeWindowSec: 24 * 3600,
    feeMaxBlocks: 43200,
    logChunkSize: 5000,
    rewardSmoothingHalfLifeSec: 6 * 3600,
    minExecutionConfidence: 0.6,
    fallbackMode: "api",
    aprFreshnessWindowSec: 24 * 3600,
    minApiConfidence: 0.6,
    useForwardProjection: true,
    apyCompoundPeriodsPerYear: 365,
  };

  console.log(`[Simulator] Fetching Yield Estimate for Pool: ${req.poolAddress}`);
  console.log(`[Simulator] Gauge: ${req.gaugeAddress}`);

  try {
    const start = Date.now();
    const result = await getRobustYieldEstimate(ctx, req);
    const ms = Date.now() - start;

    console.log(`\n[Simulator] Success! Took ${ms}ms\n`);
    console.log(`--- APR BREAKDOWN ---`);
    console.log(`Fee APR:     ${(result.feeApr * 100).toFixed(2)}%`);
    console.log(`Reward APR:  ${(result.rewardApr * 100).toFixed(2)}%`);
    console.log(`Total APR:   ${(result.totalApr * 100).toFixed(2)}%`);
    console.log(`Total APY:   ${(result.estimatedApy * 100).toFixed(2)}%`);
    console.log(`\n--- CONFIDENCE & SOURCES ---`);
    console.log(`Confidence:  ${(result.confidence * 100).toFixed(2)}%`);
    console.log(`Usable:      ${result.usable}`);
    console.log(`Sources:     ${result.dataSourcesUsed.join(', ')}`);
    console.log(`\n--- DIAGNOSTICS ---`);
    console.log(`TVL (USD):   $${result.diagnostics.tvlUsdTwab.toFixed(2)}`);
    console.log(`24h Fees:    $${result.diagnostics.feeUsdWindow.toFixed(2)}`);
    console.log(`AERO/sec:    $${result.diagnostics.rewardUsdPerSec.toFixed(4)}/sec`);
    console.log(`Coverage:    ${(result.diagnostics.coverageRatio * 100).toFixed(1)}%`);

    if (result.forwardAprEstimate) {
      console.log(`\n--- FORWARD PROJECTION (7 Days) ---`);
      console.log(`Total APR:   ${(result.forwardAprEstimate.totalApr * 100).toFixed(2)}%`);
    }

  } catch (error) {
    console.error("[Simulator] Error during estimation:", error);
  }
}

main();
