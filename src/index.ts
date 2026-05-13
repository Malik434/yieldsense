import "./env.js";
import {
  ethers,
  getAddress
} from "ethers";
// Removed axios import in favor of native fetch for TEE compatibility
// dotenv is intentionally not imported: on Acurast TEE, env vars are injected
// by the platform before script start. dotenv.config() is a no-op there and
// adds ~150KB of dotenvx to the bundle.
import { evaluateDecision } from "./decisionEngine.js";
import { getRobustYieldEstimate } from "./yieldEngine/getRobustYieldEstimate.js";
import type { FallbackMode, YieldEstimateRequest } from "./yieldEngine/types.js";
import { loadState, saveState } from "./runtimeState.js";
import { buildHarvestPayloadHash, type HarvestParams } from "./signature.js";
import {
  fulfillEthereumHarvest,
  getAcurastStd,
} from "./acurastHardware.js";
import { emitTelemetry } from "./telemetry.js";
import { monitorAndExecuteGrid } from "./processor.js";
import { createJsonRpcProvider } from "./rpcProvider.js";
import {
  calculateRecentRunSkip,
  calculateSupervisorDelayMs,
  isProcessorNotAttestedError,
  serialiseError,
} from "./processorSupervisor.js";

const CONFIG = {
  /**
   * RPC for keeper reads, gas, and harvest transactions.
   * Mainnet is the production default. For testnet execution set RPC_URL,
   * KEEPER_ADDRESS, POOL_ADDRESS, and GAUGE_ADDRESS together.
   */
  rpcUrl: process.env.RPC_URL ?? "https://mainnet.base.org",
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
    return addr ? getAddress(addr) : getAddress("0x757d30F22692Bf81aE3E3feb0F8FB7cAD48F7CEF");
  })(),
  /** Pool (and gauge) addresses for yield indexing — use real mainnet pool when `dataRpcUrl` is mainnet. */
  poolAddress: (() => {
    const addr = process.env.POOL_ADDRESS?.trim();
    // Aerodrome SlipStream WETH/USDC on Base mainnet (used with dataRpcUrl=mainnet).
    return addr ? getAddress(addr) : getAddress("0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d");
  })(),
  strategyTvl: Number(process.env.STRATEGY_TVL_USD ?? 10000),
  efficiencyMultiplier: Number(process.env.EFFICIENCY_MULTIPLIER ?? 1.5),
  poolFee: Number(process.env.POOL_FEE_RATE ?? 0.003),
  estGasUnits: BigInt(process.env.EST_GAS_UNITS ?? "400000"),
  minRewardUsd: Number(process.env.MIN_NET_REWARD_USD ?? 1),
  maxGasUsd: Number(process.env.MAX_GAS_USD ?? 30),
  cooldownSec: Number(process.env.COOLDOWN_SEC ?? 300),
  maxApiFailureStreak: Number(process.env.MAX_API_FAILURE_STREAK ?? 3),
  minAprConfidence: Number(process.env.MIN_APR_CONFIDENCE ?? 0.55),
  aprFreshnessWindowSec: Number(process.env.APR_FRESHNESS_WINDOW_SEC ?? 1200),
  statePath: process.env.STATE_PATH ?? ".yieldsense-state.json",
  feeWindowSec: Number(process.env.FEE_WINDOW_SEC ?? 3600),
  feeMaxBlocks: Number(process.env.FEE_MAX_BLOCKS ?? 900),
  logChunkSize: Number(process.env.LOG_CHUNK_SIZE ?? 450),
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
  /** Static token metadata to save RPC calls */
  token0: process.env.TOKEN0_ADDRESS?.trim(),
  token1: process.env.TOKEN1_ADDRESS?.trim(),
  decimals0: process.env.TOKEN0_DECIMALS ? Number(process.env.TOKEN0_DECIMALS) : undefined,
  decimals1: process.env.TOKEN1_DECIMALS ? Number(process.env.TOKEN1_DECIMALS) : undefined,
  /**
   * When true: build and sign the payload but do NOT submit the on-chain transaction.
   * Useful for local testing to verify the full pipeline without spending gas or hitting
   * keeper attestation checks. Set DRY_RUN=true in .env to enable.
   */
  dryRun: process.env.DRY_RUN === "true",
  runCooldownGuard: process.env.RUN_COOLDOWN_GUARD !== "false",
  minRunIntervalMs: Number(process.env.MIN_RUN_INTERVAL_MS ?? 60_000),
  enableGridKeeper: process.env.ENABLE_GRID_KEEPER === "true",
  gasSponsorMode: (process.env.GAS_SPONSOR_MODE ?? "native").toLowerCase(),
  paymasterDiscoveryOnly: process.env.PAYMASTER_DISCOVERY_ONLY === "true",
  startupRpcProbe: process.env.STARTUP_RPC_PROBE === "true",
  yieldEstimateTimeoutMs: Number(process.env.YIELD_ESTIMATE_TIMEOUT_MS ?? 45_000),
  keeperReadTimeoutMs: Number(process.env.KEEPER_READ_TIMEOUT_MS ?? 8_000),
  feeDataTimeoutMs: Number(process.env.FEE_DATA_TIMEOUT_MS ?? 8_000),
  executionBudgetMs: Number(process.env.PROCESSOR_EXECUTION_BUDGET_MS ?? 50_000),
  executionShutdownGraceMs: Number(process.env.PROCESSOR_SHUTDOWN_GRACE_MS ?? 8_000),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HARDWARE_REPORT_INTERVAL_MS = Number(process.env.HW_ADDRESS_REPORT_INTERVAL_MS ?? 6 * 60 * 60 * 1000);

let lastHardwareReportAtMs = 0;

function shouldSkipRecentRun(
  state: Awaited<ReturnType<typeof loadState>>,
  nowSec: number
): { skip: boolean; waitMs: number; elapsedMs: number; intervalMs: number } {
  return calculateRecentRunSkip({
    runCooldownGuard: CONFIG.runCooldownGuard,
    lastRunAt: state.lastRunAt,
    suggestedNextCheckMs: state.suggestedNextCheckMs,
    nowSec,
    minRunIntervalMs: CONFIG.minRunIntervalMs,
  });
}

function nextSupervisorDelayMs(state: Awaited<ReturnType<typeof loadState>>): number {
  return calculateSupervisorDelayMs({
    minRunIntervalMs: CONFIG.minRunIntervalMs,
    suggestedNextCheckMs: state.suggestedNextCheckMs,
  });
}

async function emitProcessorBoot(processStartedAtSec: number): Promise<void> {
  await emitTelemetry({
    event: "processor_boot",
    timestamp: processStartedAtSec,
    phase: "process_started",
    hasAcurastStd: Boolean(getAcurastStd()),
    hasUserAddress: Boolean(process.env.USER_ADDRESS || (globalThis as any).__ENV__?.USER_ADDRESS),
    hasProcessorSharedSecret: Boolean(process.env.PROCESSOR_SHARED_SECRET || (globalThis as any).__ENV__?.PROCESSOR_SHARED_SECRET),
    dryRun: CONFIG.dryRun,
    forceTestHarvest: CONFIG.forceTestHarvest,
  });
}

async function emitHardwareAddressReport(nowSec: number): Promise<void> {
  const std = getAcurastStd();
  if (!std) return;

  const nowMs = Date.now();
  if (lastHardwareReportAtMs > 0 && nowMs - lastHardwareReportAtMs < HARDWARE_REPORT_INTERVAL_MS) {
    return;
  }

  lastHardwareReportAtMs = nowMs;
  const hwAddress = ethers.getAddress(std.chains.ethereum.getAddress());
  await emitTelemetry({
    event: "hw_address_report",
    timestamp: nowSec,
    hwAddress,
    note: "Attest this address on-chain via ownerAttestProcessor(hwAddress)",
  });
}

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
    token0: CONFIG.token0,
    token1: CONFIG.token1,
    decimals0: CONFIG.decimals0,
    decimals1: CONFIG.decimals1,
  };
}

const KEEPER_ABI = [
  "function lastHarvest() view returns (uint256)",
  "function executeHarvest(uint256 nonce, address targetPool, uint256 minLpOut, uint256 amountToSwap, uint256 deadline, tuple(address from, address to, bool stable, address factory)[] calldata routes) external",
];

const HARVEST_AUDIT_IFACES = [
  new ethers.Interface([
    "event HarvestExecuted(address indexed processor, uint256 indexed nonce, uint256 profitCredited)",
    "event ProfitCredited(uint256 amount)",
  ]),
  new ethers.Interface([
    "event HarvestAndCompounded(uint256 rewardClaimed, uint256 rewardSwappedToAsset, uint256 lpAdded, uint256 profitUsdc, uint256 timestamp)",
    "event ProfitPulled(address indexed to, uint256 amount)",
  ]),
];

interface HarvestReceiptProof {
  profitCreditedUsd: number;
  profitCreditedRaw: string;
  rewardClaimedRaw?: string;
  profitUsdcRaw?: string;
  lpAddedRaw?: string;
  profitPulledRaw?: string;
  blockNumber: number;
}

function parseHarvestReceiptProof(receipt: ethers.TransactionReceipt): HarvestReceiptProof {
  let profitCredited = 0n;
  let rewardClaimed: bigint | undefined;
  let profitUsdc: bigint | undefined;
  let lpAdded: bigint | undefined;
  let profitPulled: bigint | undefined;

  for (const log of receipt.logs) {
    for (const iface of HARVEST_AUDIT_IFACES) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!parsed) continue;

        if (parsed.name === "HarvestExecuted") {
          profitCredited = BigInt(parsed.args.profitCredited);
        } else if (parsed.name === "ProfitCredited") {
          profitCredited = BigInt(parsed.args.amount);
        } else if (parsed.name === "HarvestAndCompounded") {
          rewardClaimed = BigInt(parsed.args.rewardClaimed);
          profitUsdc = BigInt(parsed.args.profitUsdc);
          lpAdded = BigInt(parsed.args.lpAdded);
        } else if (parsed.name === "ProfitPulled") {
          profitPulled = BigInt(parsed.args.amount);
        }
      } catch {
        // Ignore unrelated logs from tokens, router, pool, and gauge.
      }
    }
  }

  return {
    profitCreditedUsd: Number(ethers.formatUnits(profitCredited, 6)),
    profitCreditedRaw: profitCredited.toString(),
    rewardClaimedRaw: rewardClaimed?.toString(),
    profitUsdcRaw: profitUsdc?.toString(),
    lpAddedRaw: lpAdded?.toString(),
    profitPulledRaw: profitPulled?.toString(),
    blockNumber: receipt.blockNumber,
  };
}

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function remainingExecutionTimeoutMs(startedAtMs: number, desiredTimeoutMs: number): number {
  const configuredBudgetMs = Number.isFinite(CONFIG.executionBudgetMs)
    ? CONFIG.executionBudgetMs
    : 50_000;
  const shutdownGraceMs = Number.isFinite(CONFIG.executionShutdownGraceMs)
    ? CONFIG.executionShutdownGraceMs
    : 8_000;
  const deadlineMs = startedAtMs + Math.max(10_000, configuredBudgetMs) - Math.max(1_000, shutdownGraceMs);
  const remainingMs = deadlineMs - Date.now();
  const desiredMs = Number.isFinite(desiredTimeoutMs) ? desiredTimeoutMs : 45_000;

  return Math.max(1_000, Math.min(desiredMs, remainingMs));
}

async function persistYieldEstimateFailure(
  state: Awaited<ReturnType<typeof loadState>>,
  nowSec: number,
  executionChainId: number,
  envUser: string | undefined,
  error: unknown
): Promise<void> {
  const err = error as { message?: string; name?: string };
  state.apiFailureStreak += 1;
  state.lastRunAt = nowSec;
  state.lastDecisionReason = "yield_estimate_failed";
  state.suggestedNextCheckMs = 10 * 60 * 1000;
  await saveState(CONFIG.statePath, state);
  await emitTelemetry({
    event: "yield_estimate_failed",
    timestamp: Math.floor(Date.now() / 1000),
    message: err?.message ?? String(error),
    name: err?.name,
    apiFailureStreak: state.apiFailureStreak,
    recommendedNextCheckMs: state.suggestedNextCheckMs,
    chainId: executionChainId,
    userAddress: envUser,
  });
}

async function persistHarvestExecutionFailure(
  state: Awaited<ReturnType<typeof loadState>>,
  nowSec: number,
  executionChainId: number,
  envUser: string | undefined,
  error: unknown
): Promise<void> {
  const errorDetails = serialiseError(error);
  const processorNotAttested = isProcessorNotAttestedError(error);

  state.apiFailureStreak += 1;
  state.lastRunAt = nowSec;
  state.lastDecisionReason = processorNotAttested ? "processor_not_attested" : "harvest_execution_failed";
  state.suggestedNextCheckMs = processorNotAttested ? 10 * 60 * 1000 : 60_000;
  await saveState(CONFIG.statePath, state);

  await emitTelemetry({
    event: "harvest_execution_failed",
    timestamp: Math.floor(Date.now() / 1000),
    reason: state.lastDecisionReason,
    processorNotAttested,
    apiFailureStreak: state.apiFailureStreak,
    recommendedNextCheckMs: state.suggestedNextCheckMs,
    chainId: executionChainId,
    userAddress: envUser,
    ...errorDetails,
  });
}

/**
 * Empty eth_call + lastHarvest decode failure almost always means KEEPER_ADDRESS is not
 * YieldSenseKeeper on the execution chain (e.g. Sepolia keeper while RPC_URL is mainnet).
 */
async function ensureKeeperOnExecutionChain(
  provider: ethers.JsonRpcApiProvider,
  keeperAddress: string,
  rpcUrl: string,
  timeoutMs = Number(process.env.RPC_STARTUP_TIMEOUT_MS ?? 4_000)
): Promise<void> {
  const code = await withTimeout(provider.getCode(keeperAddress), timeoutMs, "keeper.getCode startup probe");
  if (code === "0x") {
    throw new Error(
      `KEEPER_ADDRESS ${keeperAddress} has no contract on execution RPC (${rpcUrl}). ` +
      `Deploy the keeper there or set RPC_URL to that network. ` +
      `Hybrid (mainnet data, Sepolia harvest): RPC_URL=https://sepolia.base.org DATA_RPC_URL=https://mainnet.base.org ` +
      `with mainnet POOL_ADDRESS/GAUGE_ADDRESS and KEEPER_ADDRESS = Sepolia keeper.`
    );
  }
}

async function runOnce(): Promise<number | undefined> {
  const startedAtMs = Date.now();
  const startNow = Math.floor(Date.now() / 1000);
  const state = await loadState(CONFIG.statePath);

  // Crash-safe cooldown guard.
  // Stamp the run immediately. If we crash 1 second from now, the next 
  // restart will see this timestamp and skip.
  const std = getAcurastStd();
  const guardStorageKey = `worker-state:${(process.env.USER_ADDRESS ?? "default").toLowerCase()}:.yieldsense-state.json`;
  
  // 1. Check Cooldown
  const recentRun = shouldSkipRecentRun(state, startNow);
  if (recentRun.skip) {
    const lastSkippedAt = state.lastSkippedAt ?? 0;
    if (startNow - lastSkippedAt >= 60) {
      state.lastSkippedAt = startNow;
      state.lastDecisionReason = "cooldown_guard";
      await saveState(CONFIG.statePath, state);
      await emitTelemetry({
        event: "run_skipped_recent",
        timestamp: startNow,
        elapsedMs: recentRun.elapsedMs,
        waitMs: recentRun.waitMs,
        intervalMs: recentRun.intervalMs,
        reason: "cooldown_guard",
        hasAcurastStd: Boolean(getAcurastStd()),
      });
    }
    return recentRun.waitMs;
  }

  await emitHardwareAddressReport(startNow);

  // 2. Stamp and Save Immediately
  state.lastRunAt = startNow;
  state.lastDecisionReason = "run_started";
  await saveState(CONFIG.statePath, state);
  
  if (std?.storage) {
    try {
      const existing = std.storage.get(guardStorageKey);
      const parsed = existing ? JSON.parse(existing) : {};
      std.storage.set(guardStorageKey, JSON.stringify({ ...parsed, lastRunAt: startNow }));
    } catch (e) {}
  }

  // 3. Log Config for TEE Diagnostics
  const envUser = process.env.USER_ADDRESS || (globalThis as any).__ENV__?.USER_ADDRESS;
  console.log(`[CONFIG] User: ${envUser || "MISSING"}`);
  console.log(`[CONFIG] Keeper: ${CONFIG.keeperAddress}`);
  console.log(`[CONFIG] RPC: ${CONFIG.rpcUrl}`);
  emitTelemetry({
    event: "worker_stage",
    timestamp: Math.floor(Date.now() / 1000),
    stage: "config_loaded",
    keeperAddress: CONFIG.keeperAddress,
    rpcUrlConfigured: Boolean(CONFIG.rpcUrl),
    dataRpcUrlConfigured: Boolean(CONFIG.dataRpcUrl),
    dryRun: CONFIG.dryRun,
    forceTestHarvest: CONFIG.forceTestHarvest,
    enableGridKeeper: CONFIG.enableGridKeeper,
    gasSponsorMode: CONFIG.gasSponsorMode,
    paymasterDiscoveryOnly: CONFIG.paymasterDiscoveryOnly,
    startupRpcProbe: CONFIG.startupRpcProbe,
    userAddress: envUser,
  }).catch(() => {});

  const configuredExecutionChainId = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined;
  const executionProvider = createJsonRpcProvider(
    CONFIG.rpcUrl,
    Number.isFinite(configuredExecutionChainId) ? configuredExecutionChainId : undefined
  );
  const dataProvider =
    CONFIG.dataRpcUrl.length > 0
      ? createJsonRpcProvider(CONFIG.dataRpcUrl, CONFIG.yieldChainId ?? 8453)
      : executionProvider;
  emitTelemetry({
    event: "worker_stage",
    timestamp: Math.floor(Date.now() / 1000),
    stage: "providers_created",
    configuredExecutionChainId,
    configuredYieldChainId: CONFIG.yieldChainId,
    userAddress: envUser,
  }).catch(() => {});
  const rpcStartupTimeoutMs = Number(process.env.RPC_STARTUP_TIMEOUT_MS ?? 4_000);
  const executionChainId = Number.isFinite(configuredExecutionChainId)
    ? Number(configuredExecutionChainId)
    : Number((await withTimeout(executionProvider.getNetwork(), rpcStartupTimeoutMs, "executionProvider.getNetwork")).chainId);
  const dataChainId = Number.isFinite(CONFIG.yieldChainId)
    ? Number(CONFIG.yieldChainId)
    : Number((await withTimeout(dataProvider.getNetwork(), rpcStartupTimeoutMs, "dataProvider.getNetwork")).chainId);
  let yieldChainId = CONFIG.yieldChainId;
  if (yieldChainId == null || !Number.isFinite(yieldChainId)) {
    yieldChainId = dataChainId;
  }

  if (yieldChainId !== dataChainId) {
    throw new Error(
      `YIELD_CHAIN_ID ${yieldChainId} does not match DATA_RPC_URL chainId ${dataChainId}. ` +
      `Set YIELD_CHAIN_ID=${dataChainId} or point DATA_RPC_URL at the intended network.`
    );
  }

  if (CONFIG.startupRpcProbe) {
    await emitTelemetry({
      event: "worker_stage",
      timestamp: Math.floor(Date.now() / 1000),
      stage: "rpc_probe_start",
      rpcStartupTimeoutMs,
      userAddress: envUser,
    });
    await ensureKeeperOnExecutionChain(executionProvider, CONFIG.keeperAddress, CONFIG.rpcUrl, rpcStartupTimeoutMs);
  }

  console.log(`[BOOT] Connecting to Execution RPC: ${CONFIG.rpcUrl}...`);
  // Pre-flight raw fetch probe to bypass any Ethers initialization hangs
  try {
    const controller = new AbortController();
    const tId = setTimeout(() => controller.abort(), 8000);
    const probe = await fetch(CONFIG.rpcUrl.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: controller.signal
    });
    clearTimeout(tId);
    if (probe.ok) {
      console.log(`[BOOT] Raw RPC Probe Success: HTTP ${probe.status}`);
    } else {
      console.warn(`[BOOT] Raw RPC Probe Warning: HTTP ${probe.status}`);
    }
  } catch (e: any) {
    console.error(`[BOOT] Raw RPC Probe Failed: ${e?.message || String(e)}`);
  }

  emitTelemetry({
    event: "worker_stage",
    timestamp: Math.floor(Date.now() / 1000),
    stage: "network_ready",
    executionChainId,
    dataChainId,
    yieldChainId,
    userAddress: envUser,
  }).catch(() => {});

  // 2. Optional Grid/Stop-Loss Check
  if (CONFIG.enableGridKeeper) {
    try {
      await monitorAndExecuteGrid();
    } catch (gridError) {
      await emitTelemetry({
        event: "grid_check_error",
        timestamp: Math.floor(Date.now() / 1000),
        stage: "monitorAndExecuteGrid",
        message: gridError instanceof Error ? gridError.message : String(gridError),
        name: gridError instanceof Error ? gridError.name : undefined,
        stack: gridError instanceof Error ? gridError.stack?.split("\n").slice(0, 6).join("\n") : undefined,
        chainId: executionChainId,
        userAddress: envUser,
      });
      console.error(JSON.stringify({ event: "grid_check_error", message: String(gridError) }));
    }
  } else {
    await emitTelemetry({
      event: "grid_check_skipped",
      timestamp: Math.floor(Date.now() / 1000),
      reason: "ENABLE_GRID_KEEPER_not_true",
      chainId: executionChainId,
      userAddress: envUser,
    });
  }

  // 2. Continue with Harvest Profitability Check
  const keeperRead = new ethers.Contract(CONFIG.keeperAddress, KEEPER_ABI, executionProvider);
  const nowSec = Math.floor(Date.now() / 1000);

  const hybridMainnetRead = CONFIG.dataRpcUrl.length > 0;

  const elapsedEwma =
    state.lastRunAt != null ? Math.max(60, nowSec - state.lastRunAt) : 300;

  let yieldResult;
  if (CONFIG.forceTestHarvest) {
    yieldResult = {
      estimate: { usable: true, totalApr: 0.1, feeApr: 0.05, rewardApr: 0.05, confidence: 1, dataSourcesUsed: [], diagnostics: {}, estimatedApy: 0.1, forwardAprEstimate: null },
      indexerCheckpointBlock: null,
      rewardAprEwmNext: null
    };
  } else {
    emitTelemetry({
      event: "worker_stage",
      timestamp: Math.floor(Date.now() / 1000),
      stage: "yield_estimate_start",
      yieldEstimateTimeoutMs: CONFIG.yieldEstimateTimeoutMs,
      effectiveYieldEstimateTimeoutMs: remainingExecutionTimeoutMs(startedAtMs, CONFIG.yieldEstimateTimeoutMs),
      executionBudgetMs: CONFIG.executionBudgetMs,
      executionShutdownGraceMs: CONFIG.executionShutdownGraceMs,
      keeperReadTimeoutMs: CONFIG.keeperReadTimeoutMs,
      feeDataTimeoutMs: CONFIG.feeDataTimeoutMs,
      chainId: executionChainId,
      userAddress: envUser,
    }).catch(() => {});

    try {
      const effectiveYieldEstimateTimeoutMs = remainingExecutionTimeoutMs(
        startedAtMs,
        CONFIG.yieldEstimateTimeoutMs
      );

      yieldResult = await withTimeout(
        getRobustYieldEstimate(
          {
            provider: dataProvider,
            indexerCheckpointBlock: state.yieldIndexerCheckpointBlock ?? undefined,
            rewardAprEwmPrev: state.rewardAprEwm ?? undefined,
          },
          buildYieldRequest(yieldChainId, CONFIG.poolAddress),
          { elapsedSecSinceLastEwma: elapsedEwma }
        ),
        effectiveYieldEstimateTimeoutMs,
        "getRobustYieldEstimate"
      );
    } catch (error: any) {
      await persistYieldEstimateFailure(state, nowSec, executionChainId, envUser, error);
      return;
    }

    emitTelemetry({
      event: "worker_stage",
      timestamp: Math.floor(Date.now() / 1000),
      stage: "yield_estimate_complete",
      usable: yieldResult.estimate.usable,
      confidence: yieldResult.estimate.confidence,
      sources: yieldResult.estimate.dataSourcesUsed,
      chainId: executionChainId,
      userAddress: envUser,
    }).catch(() => {});
  }

  let ethPrice: number;
  let lastHarvest: bigint;
  let feeData: ethers.FeeData;
  try {
    ethPrice = await getEthPrice();
    feeData = await withTimeout(
      executionProvider.getFeeData(),
      CONFIG.feeDataTimeoutMs,
      "executionProvider.getFeeData"
    );

    if (CONFIG.forceTestHarvest) {
      lastHarvest = 0n;
    } else {
      lastHarvest = await (async () => {
        for (let i = 0; i < 3; i++) {
          try {
            return await withTimeout(
              keeperRead.lastHarvest(),
              CONFIG.keeperReadTimeoutMs,
              "keeper.lastHarvest"
            );
          } catch (err: any) {
            if (i === 2) throw err;
            await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
          }
        }
        return 0n;
      })();
    }
  } catch (error: any) {
    state.apiFailureStreak += 1;
    state.lastRunAt = nowSec;
    state.lastDecisionReason = "keeper_or_fee_read_failed";
    state.suggestedNextCheckMs = 10 * 60 * 1000;
    await saveState(CONFIG.statePath, state);
    await emitTelemetry({
      event: "keeper_or_fee_read_failed",
      timestamp: Math.floor(Date.now() / 1000),
      message: error?.message ?? String(error),
      name: error?.name,
      apiFailureStreak: state.apiFailureStreak,
      recommendedNextCheckMs: state.suggestedNextCheckMs,
      chainId: executionChainId,
      userAddress: envUser,
    });
    return;
  }

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
  if (CONFIG.forceTestHarvest && !CONFIG.dryRun) {
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
  let earnedAero = 0n;

  if (!CONFIG.forceTestHarvest) {
    state.apiFailureStreak = 0;
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? BigInt(0);
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
      chainId: executionChainId,
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
      note: CONFIG.dryRun
        ? "Profitability and yield-usable gates skipped for dry-run payload validation."
        : "Profitability and yield-usable gates skipped; submitting executeHarvest.",
    });
  }

  const acurastStd = getAcurastStd();
  const privateKey = process.env.ACURAST_WORKER_KEY;
  if (!acurastStd && !privateKey && !CONFIG.dryRun) {
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
      : Math.floor(Math.random() * 10) + 5
    : Math.round(decision!.netRewardUsd * 100);

  // Dynamic Routing & Zap Math
  const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
  const ROUTER_ADDRESS = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
  
  const directRoute = [{ from: AERO, to: USDC, stable: false, factory: FACTORY }];
  let routes = directRoute;
  let estimatedUsdcIn = ethers.parseUnits("10", 6); // fallback

  // Zap Math: Calculate optimal swap amount
  let amountToSwap = estimatedUsdcIn / 2n;

  if (!CONFIG.dryRun) {
    try {
      const router = new ethers.Contract(ROUTER_ADDRESS, ["function getAmountsOut(uint amountIn, tuple(address from, address to, bool stable, address factory)[] memory routes) view returns (uint[] memory amounts)"], dataProvider);
      // Rough estimate of AERO rewards to find best route (assume 100 AERO)
      const amountIn = ethers.parseEther("100");
      const amtDirect = await withTimeout(
        router.getAmountsOut(amountIn, directRoute),
        8_000,
        "router.getAmountsOut"
      );
      estimatedUsdcIn = amtDirect[amtDirect.length - 1];
      amountToSwap = estimatedUsdcIn / 2n;
    } catch (e) {
      // fallback to direct route and estimate
    }

    try {
      const POOL_ABI = [
        "function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 timestamp)",
        "function token0() view returns (address)",
        "function stable() view returns (bool)"
      ];
      const pool = new ethers.Contract(CONFIG.poolAddress, POOL_ABI, dataProvider);
      const stable = await withTimeout(pool.stable(), 8_000, "pool.stable");
      if (stable) {
        amountToSwap = estimatedUsdcIn / 2n;
      } else {
        const [res0, res1, token0] = await withTimeout(
          Promise.all([pool.getReserves(), pool.token0()]),
          8_000,
          "pool reserves/token0"
        ).then(([reserves, token0]) => [reserves[0], reserves[1], token0] as const);
        const isUSDC0 = token0.toLowerCase() === USDC.toLowerCase();
        const R = isUSDC0 ? (res0 as bigint) : (res1 as bigint);
        
        if (R > 0n && estimatedUsdcIn > 0n) {
          const f = 30n; // 0.3% fee
          const F2 = (2000n - f) * (2000n - f);
          const F1 = (1000n - f) * 1000n;
          const inner = R * (R * F2 + 4n * F1 * estimatedUsdcIn);
          let z = inner;
          let x = (z + 1n) / 2n;
          let sqrt = z;
          while (x < sqrt) {
              sqrt = x;
              x = (z / x + x) / 2n;
          }
          amountToSwap = (sqrt - R * (2000n - f)) / (2n * 1000n);
        }
      }
    } catch (e) {
      amountToSwap = estimatedUsdcIn / 2n;
    }
  }

  const nonce = Date.now().toString();
  const deadline = nowSec + 300; // 5 minutes max deadline
  
  const harvestParams: HarvestParams = {
    nonce,
    targetPool: CONFIG.poolAddress,
    minLpOut: "1", // Pass minimum 1 to avoid ZeroAmount() revert; ideally compute real slippage bound
    amountToSwap: amountToSwap.toString(),
    deadline,
    routes
  };
  const harvestPayloadHash = buildHarvestPayloadHash(harvestParams);

  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? BigInt(0);
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? BigInt(0);

  let txHash = "";
  let receipt: ethers.TransactionReceipt | null = null;

  try {
    if (acurastStd) {
      const hwAddress = ethers.getAddress(acurastStd.chains.ethereum.getAddress());
      const submitted = await fulfillEthereumHarvest(acurastStd, {
        rpcUrl: CONFIG.rpcUrl,
        keeperAddress: CONFIG.keeperAddress,
        nonce,
        targetPool: CONFIG.poolAddress,
        minLpOut: harvestParams.minLpOut,
        amountToSwap: harvestParams.amountToSwap,
        deadline,
        routes,
        gasLimit: CONFIG.estGasUnits.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      });
      txHash = submitted.hash;

      await emitTelemetry({
        event: "harvest_submitted",
        timestamp: nowSec,
        txHash,
        payloadHash: harvestPayloadHash,
        signingMode: "acurast_fulfill_attested_sender",
        processorAddress: hwAddress,
        ...(CONFIG.forceTestHarvest ? { forceTest: true, aprBps, rewardCents } : {}),
      });
      receipt = await executionProvider.waitForTransaction(txHash);
    } else {
      const wallet = privateKey ? new ethers.Wallet(privateKey, executionProvider) : null;

      // DRY_RUN: sign + validate the payload without touching the chain.
      // Use this locally since ACURAST_WORKER_KEY is not attested in the keeper contract
      // and any real tx will revert. The payload hash + signature are logged so you can
      // verify them off-chain or manually call the contract once the key is attested.
      if (CONFIG.dryRun) {
        await emitTelemetry({
          event: "harvest_dry_run",
          timestamp: nowSec,
          payloadHash: harvestPayloadHash,
          signerAddress: wallet?.address ?? null,
          keeperAddress: CONFIG.keeperAddress,
        note: "DRY_RUN=true — tx not submitted. Deployed executeHarvest payload validated end-to-end.",
        ...(CONFIG.forceTestHarvest ? { forceTest: true, aprBps, rewardCents } : {}),
      });
      state.lastDecisionReason = "dry_run";
      await saveState(CONFIG.statePath, state);
      return;
    }

    // ETH balance pre-flight — fail fast with a clear message before the RPC rejects the tx
    if (!wallet) {
      throw new Error("ACURAST_WORKER_KEY is required for local non-dry-run execution.");
    }

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
      tx = await keeperWrite.executeHarvest(
        harvestParams.nonce,
        harvestParams.targetPool,
        harvestParams.minLpOut,
        harvestParams.amountToSwap,
        harvestParams.deadline,
        harvestParams.routes,
        { gasLimit: 350000 }
      );
    } catch (error: any) {
      throw error;
    }
    txHash = tx.hash;
    await emitTelemetry({
      event: "harvest_submitted",
      timestamp: nowSec,
      txHash,
      payloadHash: harvestPayloadHash,
      signingMode: "local_private_key",
      ...(CONFIG.forceTestHarvest ? { forceTest: true, aprBps, rewardCents } : {}),
    });
    receipt = await tx.wait();
  }
  } catch (error) {
    await persistHarvestExecutionFailure(state, nowSec, executionChainId, envUser, error);
    return;
  }

  if (!receipt) {
    throw new Error(`Harvest transaction ${txHash} was submitted but no receipt was returned.`);
  }

  const receiptProof = parseHarvestReceiptProof(receipt);

  state.lastExecutionAt = nowSec;
  state.lastDecisionReason = "executed";
  await saveState(CONFIG.statePath, state);

  await emitTelemetry({
    event: "harvest_confirmed",
    timestamp: Math.floor(Date.now() / 1000),
    profitCreditedUsd: receiptProof.profitCreditedUsd,
    profitCreditedRaw: receiptProof.profitCreditedRaw,
    estimatedRewardUsd: rewardCents / 100,
    rewardClaimedRaw: receiptProof.rewardClaimedRaw,
    profitUsdcRaw: receiptProof.profitUsdcRaw,
    lpAddedRaw: receiptProof.lpAddedRaw,
    profitPulledRaw: receiptProof.profitPulledRaw,
    blockNumber: receiptProof.blockNumber,
    txHash,
    chainId: executionChainId,
  });
}

async function persistRuntimeError(error: unknown): Promise<void> {
  const state = await loadState(CONFIG.statePath);
  state.apiFailureStreak += 1;
  state.lastRunAt = Math.floor(Date.now() / 1000);
  state.lastDecisionReason = "runtime_error";
  state.suggestedNextCheckMs = 60_000;
  await saveState(CONFIG.statePath, state);
  await emitTelemetry({
    event: "runtime_error",
    timestamp: state.lastRunAt,
    chainId: process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined,
    userAddress: process.env.USER_ADDRESS || (globalThis as any).__ENV__?.USER_ADDRESS,
    ...serialiseError(error),
  });
}

async function emitSupervisorHeartbeat(
  cycle: number,
  processStartedAtMs: number,
  nextDelayMs: number,
  status: "ok" | "error"
): Promise<void> {
  const state = await loadState(CONFIG.statePath);
  await emitTelemetry({
    event: "processor_heartbeat",
    timestamp: Math.floor(Date.now() / 1000),
    phase: "cycle_complete",
    status,
    cycle,
    uptimeMs: Date.now() - processStartedAtMs,
    nextDelayMs,
    lastDecisionReason: state.lastDecisionReason,
    apiFailureStreak: state.apiFailureStreak,
    chainId: process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined,
    userAddress: process.env.USER_ADDRESS || (globalThis as any).__ENV__?.USER_ADDRESS,
  });
}

async function runForever(): Promise<void> {
  const processStartedAtMs = Date.now();
  await emitProcessorBoot(Math.floor(processStartedAtMs / 1000));

  let cycle = 0;
  for (;;) {
    cycle += 1;
    let status: "ok" | "error" = "ok";
    let requestedDelayMs: number | undefined;

    try {
      requestedDelayMs = await runOnce();
    } catch (error) {
      status = "error";
      await persistRuntimeError(error);
      console.error(JSON.stringify({ event: "runtime_error", message: serialiseError(error).message }));
    }

    const state = await loadState(CONFIG.statePath);
    const nextDelayMs = Number.isFinite(requestedDelayMs ?? NaN)
      ? Math.max(15_000, Number(requestedDelayMs))
      : nextSupervisorDelayMs(state);
    await emitSupervisorHeartbeat(cycle, processStartedAtMs, nextDelayMs, status);
    await sleep(nextDelayMs);
  }
}

runForever().catch((error) => {
  console.error(JSON.stringify({ event: "supervisor_fatal_error", message: serialiseError(error).message }));
  process.exitCode = 1;
});
