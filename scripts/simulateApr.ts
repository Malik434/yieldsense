import { getRobustYieldEstimate } from "../src/yieldEngine/getRobustYieldEstimate.js";
import type { YieldEngineContext, YieldEstimateRequest } from "../src/yieldEngine/types.js";
import dotenv from "dotenv";
import { createJsonRpcProvider } from "../src/rpcProvider.js";

dotenv.config();

function displayRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    for (const key of parsed.searchParams.keys()) {
      if (/key|token|secret|auth|apikey/i.test(key)) parsed.searchParams.set(key, "***");
    }
    const pathParts = parsed.pathname.split("/");
    const last = pathParts[pathParts.length - 1];
    if (/[A-Za-z0-9_-]{20,}/.test(last)) {
      pathParts[pathParts.length - 1] = "***";
      parsed.pathname = pathParts.join("/");
    }
    return parsed.toString();
  } catch {
    return url.replace(/[A-Za-z0-9_-]{20,}/g, "***");
  }
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://mainnet.base.org";
  console.log(`[Simulator] Using RPC: ${displayRpcUrl(rpcUrl)}`);

  const provider = createJsonRpcProvider(rpcUrl, 8453);

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
    feeWindowSec: Number(process.env.FEE_WINDOW_SEC ?? 24 * 3600),
    feeMaxBlocks: Number(process.env.FEE_MAX_BLOCKS ?? 43200),
    logChunkSize: Number(process.env.LOG_CHUNK_SIZE ?? 5000),
    rewardSmoothingHalfLifeSec: 6 * 3600,
    minExecutionConfidence: 0.6,
    fallbackMode: "api",
    aprFreshnessWindowSec: 24 * 3600,
    minApiConfidence: 0.6,
    useForwardProjection: true,
    apyCompoundPeriodsPerYear: 365,
    defiLlamaProject: "aerodrome-v1",
    defiLlamaToken0: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    defiLlamaToken1: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
  };
  const feeWindowHours = req.feeWindowSec / 3600;

  console.log(`[Simulator] Fetching Yield Estimate for Pool: ${req.poolAddress}`);
  console.log(`[Simulator] Gauge: ${req.gaugeAddress}`);

  try {
    const start = Date.now();
    const result = await getRobustYieldEstimate(ctx, req);
    const estimate = result.estimate || (result as any); // fallback if it was changed
    const ms = Date.now() - start;

    console.log(`\n[Simulator] Success! Took ${ms}ms\n`);
    console.log(`--- APR BREAKDOWN ---`);
    console.log(`Fee APR:     ${(estimate.feeApr * 100).toFixed(2)}%`);
    console.log(`Reward APR:  ${(estimate.rewardApr * 100).toFixed(2)}%`);
    console.log(`Total APR:   ${(estimate.totalApr * 100).toFixed(2)}%`);
    console.log(`Total APY:   ${(estimate.estimatedApy * 100).toFixed(2)}%`);
    console.log(`\n--- CONFIDENCE & SOURCES ---`);
    console.log(`Confidence:  ${(estimate.confidence * 100).toFixed(2)}%`);
    console.log(`Usable:      ${estimate.usable}`);
    console.log(`Sources:     ${estimate.dataSourcesUsed?.join(', ')}`);
    console.log(`\n--- DIAGNOSTICS ---`);
    console.log(`TVL (USD):   $${estimate.diagnostics?.tvlUsdTwab?.toFixed(2)}`);
    console.log(`${feeWindowHours.toFixed(1)}h Fees:   $${estimate.diagnostics?.feeUsdWindow?.toFixed(2)}`);
    console.log(`AERO/sec:    $${estimate.diagnostics?.rewardUsdPerSec?.toFixed(4)}/sec`);
    console.log(`Coverage:    ${((estimate.diagnostics?.coverageRatio ?? 0) * 100).toFixed(1)}%`);

    if (estimate.forwardAprEstimate) {
      console.log(`\n--- FORWARD PROJECTION (7 Days) ---`);
      console.log(`Total APR:   ${((estimate.forwardAprEstimate.totalApr ?? 0) * 100).toFixed(2)}%`);
    }

    console.log(`\n--- ON-CHAIN BLEND DIAGNOSTICS ---`);
    console.log(`Fallback Mode Active: ${estimate.confidence < req.minExecutionConfidence}`);

  } catch (error) {

    console.error("[Simulator] Error during estimation:", error);
    process.exitCode = 1;
  } finally {
    provider.destroy();
  }
}

main();
