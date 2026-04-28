// axios removed to reduce bundle size
import { Contract, formatUnits } from "ethers";
import { attachDivergenceGuard, getSpotPricesFromPool } from "./ingestion/prices.js";
import { indexSwapFeesUsd, readPoolFeeBps } from "./indexers/feeIndexer.js";
import { geckoNetworkForChainId } from "./ingestion/geckoPool.js";
import { twabTvlUsd } from "./indexers/liquidityIndexer.js";
import { readGaugeSnapshot } from "./indexers/rewardIndexer.js";
import { annualizedFeeApr } from "./compute/feeApr.js";
import { smoothedRewardApr } from "./compute/rewardApr.js";
import { totalAprToApy } from "./compute/apy.js";
import { compositeConfidence, liquiditySensitivityPenalty } from "./robustness/confidence.js";
import { apiFallbackTotalApr, annotateApiFallbackBreakdown } from "./legacy/apiFallback.js";
import { estimateForwardApr } from "./compute/forwardAerodrome.js";
import type {
  DataSourceTag,
  RewardGaugeSnapshot,
  RobustYieldEngineResult,
  RobustYieldEstimate,
  YieldEngineContext,
  YieldEstimateRequest,
} from "./types.js";

const LP_ABI = [
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const WETH_BASE = "0x4200000000000000000000000000000000000006".toLowerCase();
const AERO_COMMON = "0x940181a94a35a4569e4529a3cdfb74e38fd98631".toLowerCase();

async function fetchTokenUsdBase(contractAddress: string): Promise<number> {
  const addr = contractAddress.toLowerCase();
  try {
    const url = `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${addr}&vs_currencies=usd`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return 0;
    const data: any = await res.json();
    const row = data?.[addr];
    if (row?.usd != null) return Number(row.usd);
  } catch {
    // ignore
  }
  if (addr === WETH_BASE) return 3500;
  if (addr === AERO_COMMON) return 0.5;
  return 0;
}

function estimateBlocksForWindow(chainId: number, windowSec: number): number {
  const secPerBlock = chainId === 8453 || chainId === 84532 ? 2 : 12;
  return Math.ceil(windowSec / secPerBlock);
}

export async function getRobustYieldEstimate(
  ctx: YieldEngineContext,
  req: YieldEstimateRequest,
  opts?: { elapsedSecSinceLastEwma?: number }
): Promise<RobustYieldEngineResult> {
  const { provider } = ctx;
  const latest = await provider.getBlockNumber();
  const windowBlocks = Math.min(req.feeMaxBlocks, estimateBlocksForWindow(req.chainId, req.feeWindowSec));
  const fromBlock = Math.max(1, latest - windowBlocks);

  const dataSourcesUsed: DataSourceTag[] = [];
  const spotRaw = await getSpotPricesFromPool(provider, req.poolAddress, "latest");
  if (spotRaw.priceLookup === "gecko") dataSourcesUsed.push("api:gecko");
  const spot = attachDivergenceGuard(spotRaw, 0.05);
  dataSourcesUsed.push("oracle:spotReserves", "rpc:poolState");

  const poolFeeBps =
    req.poolFeeBps > 0 ? req.poolFeeBps : await readPoolFeeBps(provider, req.poolAddress);

  const twab = await twabTvlUsd(
    provider,
    req.poolAddress,
    fromBlock,
    latest,
    spot,
    geckoNetworkForChainId(req.chainId)
  );
  const tvlUsdTwab = twab.tvlUsd;
  if (twab.source === "gecko" && !dataSourcesUsed.includes("api:gecko")) {
    dataSourcesUsed.push("api:gecko");
  }

  const lpToken = req.lpTokenAddress ?? req.poolAddress;
  let lpDecimals = 18;
  let lpHuman = 0;
  try {
    const lpContract = new Contract(lpToken, LP_ABI, provider);
    const [totalSupplyLp, lpDecRaw] = await Promise.all([
      lpContract.totalSupply(),
      lpContract.decimals(),
    ]);
    lpDecimals = Number(lpDecRaw);
    lpHuman = Number(formatUnits(totalSupplyLp as bigint, lpDecimals));
  } catch {
    // Concentrated-liquidity pool contracts are not ERC-20 LPs — set LP_TOKEN_ADDRESS to the staked share token.
  }
  const lpTokenUsdPerToken = tvlUsdTwab > 0 && lpHuman > 0 ? tvlUsdTwab / lpHuman : 0;

  const feeIndex = await indexSwapFeesUsd(
    provider,
    req.poolAddress,
    fromBlock,
    latest,
    req.logChunkSize,
    poolFeeBps,
    spot
  );
  dataSourcesUsed.push("rpc:swapLogs");

  let feeApr = annualizedFeeApr(feeIndex.feeUsd, tvlUsdTwab, feeIndex.windowSecActual);
  const feeVariancePenalty = feeIndex.swapCount >= 3 ? 1 : Math.max(0.4, feeIndex.swapCount / 3);

  let rewardApr = 0;
  let rewardUsdPerSec = 0;
  let gaugeScore = 1;
  let snapshot: RewardGaugeSnapshot | null = null;
  let rewardAprEwmNext: number | null = null;

  if (req.gaugeAddress) {
    try {
      const gaugeToken = new Contract(
        req.gaugeAddress,
        ["function rewardToken() view returns (address)"],
        provider
      );
      const rt: string = req.rewardTokenAddress ?? ((await gaugeToken.rewardToken()) as string);
      let rewardP = await fetchTokenUsdBase(rt);
      if (rewardP <= 0) rewardP = 0.01;
      snapshot = await readGaugeSnapshot(
        provider,
        req.gaugeAddress,
        lpToken,
        lpTokenUsdPerToken,
        rewardP
      );
      const now = Math.floor(Date.now() / 1000);
      if (Number(snapshot.periodFinish) <= now) gaugeScore = 0.35;
      if (snapshot.totalSupply === 0n) gaugeScore = Math.min(gaugeScore, 0.2);
      rewardUsdPerSec = snapshot.rewardUsdPerSec;
      const elapsed = opts?.elapsedSecSinceLastEwma ?? 300;
      const sm = smoothedRewardApr(snapshot, ctx.rewardAprEwmPrev, req.rewardSmoothingHalfLifeSec, elapsed);
      rewardApr = sm.rewardApr;
      rewardAprEwmNext = sm.ewmNext;
      dataSourcesUsed.push("rpc:gauge");
    } catch {
      gaugeScore = 0.25;
    }
  }

  const oracleScore = spot.price0Usd > 0 && spot.price1Usd > 0 ? 0.92 : 0.55;
  const confidenceRaw = compositeConfidence({
    coverageRatio: feeIndex.coverageRatio,
    feeVariancePenalty,
    oracleScore,
    gaugeScore,
    consistencyScore: 1,
  });
  const liqPen = liquiditySensitivityPenalty(tvlUsdTwab, req.strategyDeltaUsd);
  let confidence = confidenceRaw * liqPen;

  let totalApr = feeApr + rewardApr;
  const compounds = req.apyCompoundPeriodsPerYear ?? 365;
  let estimatedApy = totalAprToApy(totalApr, compounds);

  let forwardAprEstimate: RobustYieldEstimate["forwardAprEstimate"];
  if (req.useForwardProjection && snapshot) {
    const fwd = estimateForwardApr({
      snapshot,
      feeApr,
      epochHorizonSec: 7 * 24 * 3600,
    });
    forwardAprEstimate = {
      rewardApr: fwd.rewardApr,
      totalApr: fwd.totalApr,
      notes: fwd.notes,
      validFrom: Math.floor(Date.now() / 1000),
      validTo: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    };
  }

  let usable = confidence >= req.minExecutionConfidence && (feeIndex.coverageRatio >= 0.5 || totalApr > 0);

  if ((!usable || confidence < req.minExecutionConfidence) && req.fallbackMode !== "off") {
    const apiPool = req.apiPoolAddress ?? req.poolAddress;
    const defiLlamaOpts =
      req.defiLlamaProject || req.defiLlamaToken0
        ? {
            project: req.defiLlamaProject,
            token0: req.defiLlamaToken0,
            token1: req.defiLlamaToken1,
          }
        : undefined;
    const fb = await apiFallbackTotalApr(
      apiPool,
      req.aprFreshnessWindowSec,
      req.minApiConfidence,
      compounds,
      defiLlamaOpts
    );
    if (fb && fb.estimate.totalApr > 0) {
      const blendW = Math.max(0, 1 - confidence);
      const onChain = totalApr;
      totalApr = onChain * (1 - blendW) + fb.estimate.totalApr * blendW;
      const split = annotateApiFallbackBreakdown(fb.estimate.totalApr);
      feeApr = feeApr * (1 - blendW) + split.feeApr * blendW;
      rewardApr = rewardApr * (1 - blendW) + split.rewardApr * blendW;
      estimatedApy = totalAprToApy(totalApr, compounds);
      confidence = Math.max(confidence, fb.estimate.confidence * blendW);
      for (const t of fb.tags) {
        if (!dataSourcesUsed.includes(t)) dataSourcesUsed.push(t);
      }
      usable = usable || fb.estimate.usable;
    }
  }

  const estimate: RobustYieldEstimate = {
    feeApr,
    rewardApr,
    totalApr,
    estimatedApy,
    confidence: Math.min(1, confidence),
    dataSourcesUsed,
    forwardAprEstimate,
    diagnostics: {
      feeUsdWindow: feeIndex.feeUsd,
      windowSec: { fee: feeIndex.windowSecActual, rewardSmoothingHalfLifeSec: req.rewardSmoothingHalfLifeSec },
      tvlUsdTwab,
      rewardUsdPerSec,
      swapCount: feeIndex.swapCount,
      coverageRatio: feeIndex.coverageRatio,
    },
    usable,
  };

  return {
    estimate,
    rewardAprEwmNext,
    indexerCheckpointBlock: latest,
  };
}
