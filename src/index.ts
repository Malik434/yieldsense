import {
  ethers,
  JsonRpcProvider,
  Contract,
  formatEther,
  getAddress,
  verifyTypedData,
  solidityPackedKeccak256,
  hashMessage,
  getBytes,
  recoverAddress,
  hexlify,
  AbiCoder,
  Wallet
} from "ethers";
// Removed axios import in favor of native fetch for TEE compatibility
// dotenv is intentionally not imported: on Acurast TEE, env vars are injected
// by the platform before script start. dotenv.config() is a no-op there and
// adds ~150KB of dotenvx to the bundle.
import { evaluateDecision } from "./decisionEngine.js";
import { getRobustYieldEstimate } from "./yieldEngine/getRobustYieldEstimate.js";
import type { FallbackMode, YieldEstimateRequest } from "./yieldEngine/types.js";
import { loadState, saveState } from "./runtimeState.js";
import { buildPayloadHash, signHarvestPayload } from "./signature.js";
import {
  fulfillEthereumHarvest,
  getAcurastStd,
  signHarvestPayloadWithAcurastHardware,
} from "./acurastHardware.js";
import { emitTelemetry } from "./telemetry.js";
import { monitorAndExecuteGrid } from "./processor.js";

const CONFIG = {
  /**
   * RPC for keeper reads, gas, and harvest transactions.
   * Defaults to Base Sepolia because the default KEEPER_ADDRESS is deployed there.
   * For mainnet execution set: RPC_URL=https://mainnet.base.org and deploy a mainnet keeper.
   */
  rpcUrl: process.env.RPC_URL ?? "https://sepolia.base.org",
  /**
   * Optional: RPC for yield math only (logs, pool, gauge). When set, APR uses live mainnet data
   * while `RPC_URL` still controls execution — read-only hybrid (no mainnet gas for harvest).
   * Default: mainnet.base.org (real yield data even when executing on Sepolia).
   * To use Sepolia data too: DATA_RPC_URL=https://sepolia.base.org
   */
  dataRpcUrl: process.env.DATA_RPC_URL?.trim() || process.env.MAINNET_DATA_RPC_URL?.trim() || "https://mainnet.base.org",
  /** Optional fixed chain id for yield engine (e.g. 8453); else inferred from `dataRpcUrl` provider. */
  yieldChainId: process.env.YIELD_CHAIN_ID ? Number(process.env.YIELD_CHAIN_ID) : undefined,
  keeperAddress: (() => {
    const addr = process.env.KEEPER_ADDRESS?.trim();
    // Testnet fallback: keeper uses attestedProcessors set — any attested TEE can harvest.
    return addr || "0x488147C822b364a940630075f9EACD080Cc16234";
  })(),
  /** Pool (and gauge) addresses for yield indexing — use real mainnet pool when `dataRpcUrl` is mainnet. */
  poolAddress: (() => {
    const addr = process.env.POOL_ADDRESS?.trim();
    // Aerodrome SlipStream WETH/USDC on Base mainnet (used with dataRpcUrl=mainnet).
    return addr || "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
  })(),
  strategyTvl: Number(process.env.STRATEGY_TVL_USD ?? 10000),
  efficiencyMultiplier: Number(process.env.EFFICIENCY_MULTIPLIER ?? 1.5),
  poolFee: Number(process.env.POOL_FEE_RATE ?? 0.0005),
  estGasUnits: BigInt(process.env.EST_GAS_UNITS ?? "400000"),
  minRewardUsd: Number(process.env.MIN_NET_REWARD_USD ?? 1),
  maxGasUsd: Number(process.env.MAX_GAS_USD ?? 30),
  cooldownSec: Number(process.env.COOLDOWN_SEC ?? 300),
  maxApiFailureStreak: Number(process.env.MAX_API_FAILURE_STREAK ?? 3),
  minAprConfidence: Number(process.env.MIN_APR_CONFIDENCE ?? 0.55),
  aprFreshnessWindowSec: Number(process.env.APR_FRESHNESS_WINDOW_SEC ?? 1200),
  statePath: process.env.STATE_PATH ?? ".yieldsense-state.json",
  feeWindowSec: Number(process.env.FEE_WINDOW_SEC ?? 604800),
  feeMaxBlocks: Number(process.env.FEE_MAX_BLOCKS ?? 80000),
  logChunkSize: Number(process.env.LOG_CHUNK_SIZE ?? 3000),
  rewardEwmaHalfLifeSec: Number(process.env.REWARD_EWMA_HALF_LIFE_SEC ?? 259200),
  minYieldConfidence: Number(process.env.MIN_YIELD_CONFIDENCE ?? process.env.MIN_APR_CONFIDENCE ?? 0.55),
  yieldFallbackMode: (process.env.YIELD_FALLBACK_MODE as FallbackMode) || "auto",
  yieldForwardProjection: process.env.YIELD_FORWARD_PROJECTION === "true",
  gaugeAddress: process.env.GAUGE_ADDRESS || undefined,
  lpTokenAddress: process.env.LP_TOKEN_ADDRESS || undefined,
  rewardTokenAddress: process.env.REWARD_TOKEN_ADDRESS || undefined,
  strategyDeltaUsd: process.env.STRATEGY_DELTA_USD
    ? Number(process.env.STRATEGY_DELTA_USD)
    : undefined,
  apyCompoundsPerYear: Number(process.env.APY_COMPOUNDS_PER_YEAR ?? 365),
  /**
   * When true: skip yield-usable + profitability checks and submit executeHarvest on the execution RPC
   * immediately (for signing/broadcast integration tests). Blocked on mainnet unless
   * FORCE_TEST_ALLOW_MAINNET=true.
   */
  forceTestHarvest: process.env.FORCE_TEST_HARVEST === "true",
  forceTestAllowMainnet: process.env.FORCE_TEST_ALLOW_MAINNET === "true",
  forceTestAprBps:
    process.env.FORCE_TEST_APR_BPS != null && process.env.FORCE_TEST_APR_BPS !== ""
      ? Number(process.env.FORCE_TEST_APR_BPS)
      : undefined,
  forceTestRewardCents:
    process.env.FORCE_TEST_REWARD_CENTS != null && process.env.FORCE_TEST_REWARD_CENTS !== ""
      ? Number(process.env.FORCE_TEST_REWARD_CENTS)
      : undefined,
  /**
   * Minimum USDC (6 decimals) to accept from the AERO→USDC swap inside the autocompounder.
   * Passed as `minAssetOut` to executeHarvest. 0 = rely on the compounder's internal slippage.
   * Example: 1000000 = accept at least 1.00 USDC per harvest.
   */
  harvestMinAssetOut: Number(process.env.HARVEST_MIN_ASSET_OUT ?? 0),
  /**
   * When true: build and sign the payload but do NOT submit the on-chain transaction.
   * Useful for local testing to verify the full pipeline without spending gas or hitting
   * keeper attestation checks. Set DRY_RUN=true in .env to enable.
   */
  dryRun: process.env.DRY_RUN === "true",
};

function buildYieldRequest(chainId: number, poolAddress: string): YieldEstimateRequest {
  return {
    chainId,
    poolAddress,
    gaugeAddress: CONFIG.gaugeAddress,
    lpTokenAddress: CONFIG.lpTokenAddress,
    rewardTokenAddress: CONFIG.rewardTokenAddress,
    feeWindowSec: CONFIG.feeWindowSec,
    feeMaxBlocks: CONFIG.feeMaxBlocks,
    logChunkSize: CONFIG.logChunkSize,
    poolFeeBps: Number(process.env.POOL_FEE_BPS ?? 0),
    rewardSmoothingHalfLifeSec: CONFIG.rewardEwmaHalfLifeSec,
    minExecutionConfidence: CONFIG.minYieldConfidence,
    useForwardProjection: CONFIG.yieldForwardProjection,
    fallbackMode: CONFIG.yieldFallbackMode,
    apiPoolAddress: poolAddress,
    aprFreshnessWindowSec: CONFIG.aprFreshnessWindowSec,
    minApiConfidence: CONFIG.minAprConfidence,
    strategyDeltaUsd: CONFIG.strategyDeltaUsd,
    apyCompoundPeriodsPerYear: CONFIG.apyCompoundsPerYear,
  };
}

const KEEPER_ABI = [
  "function lastHarvest() view returns (uint256)",
  // New: minAssetOut added as 5th param for slippage guard on AERO→USDC swap
  "function executeHarvest(bytes32 payloadHash, bytes32 r, bytes32 s, uint8 v, uint256 minAssetOut) external",
];

const LEGACY_KEEPER_ABI = [
  // Older deployed keeper without autocompounder — no minAssetOut
  "function executeHarvest(bytes32 payloadHash, bytes32 r, bytes32 s, uint8 v) external",
  "function executeHarvest(bytes r, bytes s) external",
];

async function getEthPrice(): Promise<number> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
    if (!response.ok) return 3500;
    const data: any = await response.json();
    return Number(data?.ethereum?.usd ?? 3500);
  } catch {
    return 3500;
  }
}

/**
 * Empty eth_call + lastHarvest decode failure almost always means KEEPER_ADDRESS is not
 * YieldSenseKeeper on the execution chain (e.g. Sepolia keeper while RPC_URL is mainnet).
 */
async function ensureKeeperOnExecutionChain(
  provider: ethers.JsonRpcProvider,
  keeperAddress: string,
  rpcUrl: string
): Promise<void> {
  const code = await provider.getCode(keeperAddress);
  if (code === "0x") {
    throw new Error(
      `KEEPER_ADDRESS ${keeperAddress} has no contract on execution RPC (${rpcUrl}). ` +
      `Deploy the keeper there or set RPC_URL to that network. ` +
      `Hybrid (mainnet data, Sepolia harvest): RPC_URL=https://sepolia.base.org DATA_RPC_URL=https://mainnet.base.org ` +
      `with mainnet POOL_ADDRESS/GAUGE_ADDRESS and KEEPER_ADDRESS = Sepolia keeper.`
    );
  }
}

async function main(): Promise<void> {
  const startNow = Math.floor(Date.now() / 1000);

  // 1. Send Heartbeat
  await emitTelemetry({
    event: "processor_heartbeat",
    message: "Worker starting...",
    timestamp: startNow
  });

  // 2. Run Grid/Stop-Loss Check
  try {
    await monitorAndExecuteGrid();
  } catch (gridError) {
    console.error(JSON.stringify({ event: "grid_check_error", message: String(gridError) }));
  }

  // 2. Continue with Harvest Profitability Check
  const executionProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  const dataProvider =
    CONFIG.dataRpcUrl.length > 0
      ? new ethers.JsonRpcProvider(CONFIG.dataRpcUrl)
      : executionProvider;

  await ensureKeeperOnExecutionChain(executionProvider, CONFIG.keeperAddress, CONFIG.rpcUrl);


  const keeperRead = new ethers.Contract(CONFIG.keeperAddress, KEEPER_ABI, executionProvider);
  const state = await loadState(CONFIG.statePath);
  const nowSec = Math.floor(Date.now() / 1000);

  const executionChainId = Number((await executionProvider.getNetwork()).chainId);
  let yieldChainId = CONFIG.yieldChainId;
  if (yieldChainId == null || !Number.isFinite(yieldChainId)) {
    yieldChainId = Number((await dataProvider.getNetwork()).chainId);
  }
  const hybridMainnetRead = CONFIG.dataRpcUrl.length > 0;

  const elapsedEwma =
    state.lastRunAt != null ? Math.max(60, nowSec - state.lastRunAt) : 300;

  const ethPricePromise = getEthPrice();
  const lastHarvestPromise = keeperRead.lastHarvest();
  const feeDataPromise = executionProvider.getFeeData();

  let yieldResult;
  if (CONFIG.forceTestHarvest) {
    yieldResult = {
      estimate: { usable: true, totalApr: 0.1, feeApr: 0.05, rewardApr: 0.05, confidence: 1, dataSourcesUsed: [], diagnostics: {}, estimatedApy: 0.1, forwardAprEstimate: null },
      indexerCheckpointBlock: null,
      rewardAprEwmNext: null
    };
  } else {
    yieldResult = await getRobustYieldEstimate(
      {
        provider: dataProvider,
        indexerCheckpointBlock: state.yieldIndexerCheckpointBlock ?? undefined,
        rewardAprEwmPrev: state.rewardAprEwm ?? undefined,
      },
      buildYieldRequest(yieldChainId, CONFIG.poolAddress),
      { elapsedSecSinceLastEwma: elapsedEwma }
    );
  }

  const [ethPrice, lastHarvest, feeData] = await Promise.all([
    ethPricePromise,
    lastHarvestPromise,
    feeDataPromise,
  ]);

  const aprConsensus = yieldResult.estimate;
  state.yieldIndexerCheckpointBlock = yieldResult.indexerCheckpointBlock;
  if (yieldResult.rewardAprEwmNext != null) {
    state.rewardAprEwm = yieldResult.rewardAprEwmNext;
  }

  if (!aprConsensus.usable && !CONFIG.forceTestHarvest) {
    state.apiFailureStreak += 1;
    state.lastRunAt = nowSec;
    state.lastDecisionReason = "yield_not_usable";
    state.suggestedNextCheckMs = 10 * 60 * 1000;
    await saveState(CONFIG.statePath, state);
    await emitTelemetry({
      event: "yield_not_usable",
      timestamp: nowSec,
      hybridReadMainnetExecuteTestnet: hybridMainnetRead,
      yieldChainId,
      executionChainId,
      confidence: aprConsensus.confidence,
      feeApr: aprConsensus.feeApr,
      rewardApr: aprConsensus.rewardApr,
      totalApr: aprConsensus.totalApr,
      dataSourcesUsed: aprConsensus.dataSourcesUsed,
      diagnostics: aprConsensus.diagnostics,
      apiFailureStreak: state.apiFailureStreak,
    });
    return;
  }


  const BASE_SEPOLIA_CHAIN_ID = 84532;
  if (CONFIG.forceTestHarvest) {
    const onSepolia = executionChainId === BASE_SEPOLIA_CHAIN_ID;
    if (!onSepolia && !CONFIG.forceTestAllowMainnet) {
      state.lastRunAt = nowSec;
      state.lastDecisionReason = "force_test_wrong_chain";
      state.suggestedNextCheckMs = 60_000;
      await saveState(CONFIG.statePath, state);
      await emitTelemetry({
        event: "force_test_blocked",
        timestamp: nowSec,
        executionChainId,
        reason: "execution_chain_not_base_sepolia",
        hint: "Set RPC_URL to https://sepolia.base.org or set FORCE_TEST_ALLOW_MAINNET=true (dangerous).",
      });
      return;
    }
  }

  let decision: ReturnType<typeof evaluateDecision> | null = null;

  if (!CONFIG.forceTestHarvest) {
    state.apiFailureStreak = 0;
    const gasPrice = feeData.gasPrice ?? BigInt(0);
    const gasCostUsd = Number(ethers.formatEther(gasPrice * CONFIG.estGasUnits)) * ethPrice;
    const elapsedSec = nowSec - Number(lastHarvest);
    const secondsSinceLastExecution = state.lastExecutionAt ? nowSec - state.lastExecutionAt : Number.MAX_SAFE_INTEGER;

    decision = evaluateDecision({
      apr: aprConsensus.totalApr,
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

    await emitTelemetry({
      event: "profitability_check",
      timestamp: nowSec,
      hybridReadMainnetExecuteTestnet: hybridMainnetRead,
      yieldChainId,
      executionChainId,
      apr: aprConsensus.totalApr,
      feeApr: aprConsensus.feeApr,
      rewardApr: aprConsensus.rewardApr,
      estimatedApy: aprConsensus.estimatedApy,
      confidence: aprConsensus.confidence,
      dataSourcesUsed: aprConsensus.dataSourcesUsed,
      forwardAprEstimate: aprConsensus.forwardAprEstimate,
      diagnostics: aprConsensus.diagnostics,
      netRewardUsd: decision.netRewardUsd,
      grossRewardUsd: decision.grossRewardUsd,
      gasCostUsd,
      thresholdUsd: decision.thresholdUsd,
      reason: decision.reason,
      recommendedNextCheckMs: decision.recommendedNextCheckMs,
    });

    state.previousApr = aprConsensus.totalApr;
    state.lastDecisionReason = decision.reason;
    state.lastRunAt = nowSec;
    state.suggestedNextCheckMs = decision.recommendedNextCheckMs;

    if (!decision.shouldExecute) {
      await saveState(CONFIG.statePath, state);
      return;
    }
  } else {
    state.apiFailureStreak = 0;
    state.previousApr = aprConsensus.totalApr;
    state.lastDecisionReason = "force_test_harvest";
    state.lastRunAt = nowSec;
    state.suggestedNextCheckMs = 60_000;
    await emitTelemetry({
      event: "force_test_bypass",
      timestamp: nowSec,
      hybridReadMainnetExecuteTestnet: hybridMainnetRead,
      yieldChainId,
      executionChainId,
      yieldUsable: aprConsensus.usable,
      totalApr: aprConsensus.totalApr,
      note: "Profitability and yield-usable gates skipped; submitting executeHarvest.",
    });
  }

  const acurastStd = getAcurastStd();
  const privateKey = process.env.ACURAST_WORKER_KEY;
  if (!acurastStd && !privateKey) {
    state.lastDecisionReason = "missing_worker_key";
    await saveState(CONFIG.statePath, state);
    await emitTelemetry({
      event: "execution_skipped",
      timestamp: nowSec,
      reason: "missing_worker_key",
      hint: "Run on an Acurast processor (hardware _STD_ signing) or set ACURAST_WORKER_KEY for local execution.",
    });
    return;
  }

  // When running locally with a plain private key (not Acurast hardware), the keeper
  // contract will always revert because that address is not in attestedProcessors.
  // DRY_RUN=true lets you validate the full pipeline locally without a real on-chain submit.
  if (!acurastStd && privateKey && !CONFIG.dryRun) {
    console.warn(
      "[index] ACURAST_WORKER_KEY is set but you are NOT running on Acurast hardware. " +
      "The keeper contract will reject the tx (attestation check). " +
      "Add DRY_RUN=true to .env to simulate locally without submitting on-chain."
    );
  }

  const aprBps = CONFIG.forceTestHarvest
    ? CONFIG.forceTestAprBps != null && Number.isFinite(CONFIG.forceTestAprBps)
      ? CONFIG.forceTestAprBps
      : Math.round(aprConsensus.totalApr * 10_000)
    : Math.round(aprConsensus.totalApr * 10_000);
  const rewardCents = CONFIG.forceTestHarvest
    ? CONFIG.forceTestRewardCents != null && Number.isFinite(CONFIG.forceTestRewardCents)
      ? CONFIG.forceTestRewardCents
      : 0
    : Math.round(decision!.netRewardUsd * 100);
  const payloadHash = buildPayloadHash(CONFIG.keeperAddress, CONFIG.poolAddress, aprBps, rewardCents, nowSec);

  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? BigInt(0);
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? BigInt(0);

  let txHash: string;

  if (acurastStd) {
    const hwAddress = ethers.getAddress(acurastStd.chains.ethereum.getAddress());

    // Report the TEE's Ethereum address on every run so the operator can
    // attest it on-chain via ownerAttestProcessor(hwAddress).
    await emitTelemetry({
      event: "hw_address_report",
      timestamp: nowSec,
      hwAddress,
      note: "Attest this address on-chain via ownerAttestProcessor(hwAddress)",
    });

    const signed = signHarvestPayloadWithAcurastHardware(acurastStd, payloadHash, hwAddress);
    const submitted = await fulfillEthereumHarvest(acurastStd, {
      rpcUrl: CONFIG.rpcUrl,
      keeperAddress: CONFIG.keeperAddress,
      payloadHash: signed.payloadHash,
      r: signed.r,
      s: signed.s,
      v: signed.v,
      minAssetOut: BigInt(CONFIG.harvestMinAssetOut),
      gasLimit: CONFIG.estGasUnits.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    });
    txHash = submitted.hash;

    await emitTelemetry({
      event: "harvest_submitted",
      timestamp: nowSec,
      txHash,
      payloadHash: signed.payloadHash,
      signingMode: "acurast_hardware_secp256k1",
      ...(CONFIG.forceTestHarvest ? { forceTest: true, aprBps, rewardCents } : {}),
    });
    await executionProvider.waitForTransaction(txHash);
  } else {
    const signed = signHarvestPayload(privateKey!, payloadHash);
    const wallet = new ethers.Wallet(privateKey!, executionProvider);

    // DRY_RUN: sign + validate the payload without touching the chain.
    // Use this locally since ACURAST_WORKER_KEY is not attested in the keeper contract
    // and any real tx will revert. The payload hash + signature are logged so you can
    // verify them off-chain or manually call the contract once the key is attested.
    if (CONFIG.dryRun) {
      await emitTelemetry({
        event: "harvest_dry_run",
        timestamp: nowSec,
        payloadHash: signed.payloadHash,
        r: signed.r,
        s: signed.s,
        v: signed.v,
        signerAddress: wallet.address,
        keeperAddress: CONFIG.keeperAddress,
        note: "DRY_RUN=true — tx not submitted. Pipeline validated end-to-end.",
        ...(CONFIG.forceTestHarvest ? { forceTest: true, aprBps, rewardCents } : {}),
      });
      state.lastDecisionReason = "dry_run";
      await saveState(CONFIG.statePath, state);
      return;
    }

    // ETH balance pre-flight — fail fast with a clear message before the RPC rejects the tx
    const workerBalance = await executionProvider.getBalance(wallet.address);
    const estimatedGasCost = (feeData.maxFeePerGas ?? feeData.gasPrice ?? BigInt(0)) * BigInt(400_000);
    if (workerBalance < estimatedGasCost) {
      throw new Error(
        `Insufficient ETH for gas: worker ${wallet.address} has ${ethers.formatEther(workerBalance)} ETH, ` +
        `needs ~${ethers.formatEther(estimatedGasCost)} ETH on ${CONFIG.rpcUrl}. ` +
        `Fund the worker address with Base Sepolia ETH from https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet`
      );
    }

    let tx;
    try {
      const keeperWrite = new ethers.Contract(CONFIG.keeperAddress, KEEPER_ABI, wallet);
      tx = await keeperWrite.executeHarvest(signed.payloadHash, signed.r, signed.s, signed.v, CONFIG.harvestMinAssetOut, { gasLimit: 350000 });
    } catch (error: any) {
      // Backward compatibility for older deployed keeper signature.
      if (error?.code !== "CALL_EXCEPTION") {
        throw error;
      }
      await emitTelemetry({
        event: "keeper_abi_fallback",
        timestamp: nowSec,
        reason: "modern_executeHarvest_failed",
      });
      // Try the previous ABI (4 args, no minAssetOut) before the oldest 2-arg form
      const legacyKeeper = new ethers.Contract(CONFIG.keeperAddress, LEGACY_KEEPER_ABI, wallet);
      try {
        tx = await legacyKeeper.executeHarvest(signed.payloadHash, signed.r, signed.s, signed.v, { gasLimit: 300000 });
      } catch {
        tx = await legacyKeeper.executeHarvest(signed.r, signed.s);
      }
    }
    txHash = tx.hash;
    await emitTelemetry({
      event: "harvest_submitted",
      timestamp: nowSec,
      txHash,
      payloadHash: signed.payloadHash,
      signingMode: "local_private_key",
      ...(CONFIG.forceTestHarvest ? { forceTest: true, aprBps, rewardCents } : {}),
    });
    await tx.wait();
  }

  state.lastExecutionAt = nowSec;
  state.lastDecisionReason = "executed";
  await saveState(CONFIG.statePath, state);

  await emitTelemetry({
    event: "harvest_confirmed",
    timestamp: Math.floor(Date.now() / 1000),
    rewardUsd: rewardCents / 100,
    txHash,
  });
}

main().catch(async (error: any) => {
  const state = await loadState(CONFIG.statePath);
  state.apiFailureStreak += 1;
  state.lastRunAt = Math.floor(Date.now() / 1000);
  state.lastDecisionReason = "runtime_error";
  await saveState(CONFIG.statePath, state);
  await emitTelemetry({
    event: "runtime_error",
    timestamp: state.lastRunAt,
    message: error?.message ?? String(error),
  });
  process.exitCode = 1;
});
