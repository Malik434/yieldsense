import { ethers } from "ethers";
import axios from "axios";
import dotenv from "dotenv";
import { evaluateDecision } from "./decisionEngine.js";
import { getRealtimeAprConsensus } from "./realtimeApr.js";
import { loadState, saveState } from "./runtimeState.js";
import { buildPayloadHash, signHarvestPayload } from "./signature.js";
import { emitTelemetry } from "./telemetry.js";

dotenv.config();

const CONFIG = {
  rpcUrl: process.env.RPC_URL ?? "https://sepolia.base.org",
  keeperAddress: process.env.KEEPER_ADDRESS ?? "0x2BA7c3a0aeD57e13fbaf203C51CD700c8d666137",
  poolAddress: process.env.POOL_ADDRESS ?? "0xd0b53D9277642d899DF5C87A3966A349A798F224",
  strategyTvl: Number(process.env.STRATEGY_TVL_USD ?? 10000),
  efficiencyMultiplier: Number(process.env.EFFICIENCY_MULTIPLIER ?? 1.5),
  poolFee: Number(process.env.POOL_FEE_RATE ?? 0.003),
  estGasUnits: BigInt(process.env.EST_GAS_UNITS ?? "200000"),
  minRewardUsd: Number(process.env.MIN_NET_REWARD_USD ?? 1),
  maxGasUsd: Number(process.env.MAX_GAS_USD ?? 30),
  cooldownSec: Number(process.env.COOLDOWN_SEC ?? 300),
  maxApiFailureStreak: Number(process.env.MAX_API_FAILURE_STREAK ?? 3),
  minAprConfidence: Number(process.env.MIN_APR_CONFIDENCE ?? 0.55),
  aprFreshnessWindowSec: Number(process.env.APR_FRESHNESS_WINDOW_SEC ?? 1200),
  statePath: process.env.STATE_PATH ?? ".yieldsense-state.json",
};

const KEEPER_ABI = [
  "function lastHarvest() view returns (uint256)",
  "function executeHarvest(bytes32 payloadHash, bytes32 r, bytes32 s, uint8 v) external",
];

async function getEthPrice(): Promise<number> {
  try {
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { timeout: 4000 }
    );
    return Number(response.data?.ethereum?.usd ?? 3500);
  } catch {
    return 3500;
  }
}

async function main(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  const keeperRead = new ethers.Contract(CONFIG.keeperAddress, KEEPER_ABI, provider);
  const state = await loadState(CONFIG.statePath);
  const nowSec = Math.floor(Date.now() / 1000);

  const [ethPrice, aprConsensus, lastHarvest, feeData] = await Promise.all([
    getEthPrice(),
    getRealtimeAprConsensus(CONFIG.poolAddress, CONFIG.aprFreshnessWindowSec, CONFIG.minAprConfidence),
    keeperRead.lastHarvest(),
    provider.getFeeData(),
  ]);

  if (aprConsensus.apr === null || !aprConsensus.usable) {
    state.apiFailureStreak += 1;
    state.lastRunAt = nowSec;
    state.lastDecisionReason = "apr_not_usable";
    state.suggestedNextCheckMs = 10 * 60 * 1000;
    await saveState(CONFIG.statePath, state);
    emitTelemetry({
      event: "apr_not_usable",
      timestamp: nowSec,
      confidence: aprConsensus.confidence,
      observations: aprConsensus.observations,
      apiFailureStreak: state.apiFailureStreak,
    });
    return;
  }

  state.apiFailureStreak = 0;
  const gasPrice = feeData.gasPrice ?? BigInt(0);
  const gasCostUsd = Number(ethers.formatEther(gasPrice * CONFIG.estGasUnits)) * ethPrice;
  const elapsedSec = nowSec - Number(lastHarvest);
  const secondsSinceLastExecution = state.lastExecutionAt ? nowSec - state.lastExecutionAt : Number.MAX_SAFE_INTEGER;

  const decision = evaluateDecision({
    apr: aprConsensus.apr,
    tvlUsd: CONFIG.strategyTvl,
    feeRate: CONFIG.poolFee,
    elapsedSec,
    gasCostUsd,
    efficiencyMultiplier: CONFIG.efficiencyMultiplier,
    minNetRewardUsd: CONFIG.minRewardUsd,
    maxGasUsd: CONFIG.maxGasUsd,
    cooldownSec: CONFIG.cooldownSec,
    secondsSinceLastExecution,
    apiFailureStreak: state.apiFailureStreak,
    maxFailureStreak: CONFIG.maxApiFailureStreak,
  });

  emitTelemetry({
    event: "profitability_check",
    timestamp: nowSec,
    apr: aprConsensus.apr,
    confidence: aprConsensus.confidence,
    observations: aprConsensus.observations,
    netRewardUsd: decision.netRewardUsd,
    gasCostUsd,
    thresholdUsd: decision.thresholdUsd,
    reason: decision.reason,
    recommendedNextCheckMs: decision.recommendedNextCheckMs,
  });

  state.previousApr = aprConsensus.apr;
  state.lastDecisionReason = decision.reason;
  state.lastRunAt = nowSec;
  state.suggestedNextCheckMs = decision.recommendedNextCheckMs;

  if (!decision.shouldExecute) {
    await saveState(CONFIG.statePath, state);
    return;
  }

  const privateKey = process.env.ACURAST_WORKER_KEY;
  if (!privateKey) {
    state.lastDecisionReason = "missing_worker_key";
    await saveState(CONFIG.statePath, state);
    emitTelemetry({ event: "execution_skipped", timestamp: nowSec, reason: "missing_worker_key" });
    return;
  }

  const aprBps = Math.round(aprConsensus.apr * 10_000);
  const rewardCents = Math.round(decision.netRewardUsd * 100);
  const payloadHash = buildPayloadHash(CONFIG.keeperAddress, CONFIG.poolAddress, aprBps, rewardCents, nowSec);
  const signed = signHarvestPayload(privateKey, payloadHash);

  const wallet = new ethers.Wallet(privateKey, provider);
  const keeperWrite = new ethers.Contract(CONFIG.keeperAddress, KEEPER_ABI, wallet);
  const tx = await keeperWrite.executeHarvest(signed.payloadHash, signed.r, signed.s, signed.v);
  emitTelemetry({
    event: "harvest_submitted",
    timestamp: nowSec,
    txHash: tx.hash,
    payloadHash: signed.payloadHash,
  });
  await tx.wait();

  state.lastExecutionAt = nowSec;
  state.lastDecisionReason = "executed";
  await saveState(CONFIG.statePath, state);

  emitTelemetry({
    event: "harvest_confirmed",
    timestamp: Math.floor(Date.now() / 1000),
    txHash: tx.hash,
  });
}

main().catch(async (error: any) => {
  const state = await loadState(CONFIG.statePath);
  state.apiFailureStreak += 1;
  state.lastRunAt = Math.floor(Date.now() / 1000);
  state.lastDecisionReason = "runtime_error";
  await saveState(CONFIG.statePath, state);
  emitTelemetry({
    event: "runtime_error",
    timestamp: state.lastRunAt,
    message: error?.message ?? String(error),
  });
  process.exitCode = 1;
});