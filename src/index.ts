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
import { apiSingleSourceApr } from "./yieldEngine/legacy/apiFallback.js";
import type { FallbackMode, YieldEstimateRequest } from "./yieldEngine/types.js";
import type { SingleAprSourceName } from "./realtimeApr.js";
import { loadState, saveState } from "./runtimeState.js";
import { buildHarvestPayloadHash, type HarvestParams, type Route } from "./signature.js";
import {
  fulfillEthereumHarvest,
  BUILDER_CODE_SUFFIX,
  getAcurastStd,
} from "./acurastHardware.js";
import { emitTelemetry, flushTelemetry } from "./telemetry.js";
import { monitorAndExecuteGrid } from "./processor.js";
import {
  getAcurastPaymasterSmartAccountAddress,
  getPaymasterOwnerMode,
  getPaymasterRpcUrl,
  submitHarvestWithBasePaymaster,
} from "./paymaster.js";
import { createJsonRpcProvider } from "./rpcProvider.js";
import {
  calculateRecentRunSkip,
  calculateSupervisorDelayMs,
  isProcessorNotAttestedError,
  serialiseError,
} from "./processorSupervisor.js";

type FastYieldMode = "api" | "skip";

function normaliseFastYieldMode(value: string | undefined): FastYieldMode {
  return value?.toLowerCase() === "skip" ? "skip" : "api";
}

function normaliseFastYieldSource(value: string | undefined): SingleAprSourceName {
  const normalized = value?.toLowerCase();
  if (normalized === "dexscreener" || normalized === "dex_screener") {
    return "dexScreener";
  }
  return "geckoTerminal";
}

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
  estGasUnits: BigInt(process.env.EST_GAS_UNITS ?? "1200000"),
  minRewardUsd: Number(process.env.MIN_NET_REWARD_USD ?? 1),
  maxGasUsd: Number(process.env.MAX_GAS_USD ?? 30),
  enforceProfitability: process.env.ENFORCE_PROFITABILITY !== "false",
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
  minRunIntervalMs: Number(process.env.MIN_RUN_INTERVAL_MS ?? 5 * 60_000),
  frontendUrl: process.env.FRONTEND_URL?.trim() || "",
  remoteCooldownGuard: process.env.REMOTE_COOLDOWN_GUARD === "true",
  cooldownRemoteTimeoutMs: Number(process.env.COOLDOWN_REMOTE_TIMEOUT_MS ?? 3_500),
  enableGridKeeper: process.env.ENABLE_GRID_KEEPER === "true",
  gasSponsorMode: (process.env.GAS_SPONSOR_MODE ?? "native").toLowerCase(),
  paymasterGasCostUsd: Number(process.env.PAYMASTER_GAS_COST_USD ?? 0.015),
  paymasterDiscoveryOnly: process.env.PAYMASTER_DISCOVERY_ONLY === "true",
  startupRpcProbe: process.env.STARTUP_RPC_PROBE === "true",
  yieldEstimateTimeoutMs: Number(process.env.YIELD_ESTIMATE_TIMEOUT_MS ?? 45_000),
  keeperReadTimeoutMs: Number(process.env.KEEPER_READ_TIMEOUT_MS ?? 8_000),
  feeDataTimeoutMs: Number(process.env.FEE_DATA_TIMEOUT_MS ?? 8_000),
  executionBudgetMs: Number(process.env.PROCESSOR_EXECUTION_BUDGET_MS ?? 50_000),
  executionShutdownGraceMs: Number(process.env.PROCESSOR_SHUTDOWN_GRACE_MS ?? 8_000),
  acurastFastSubmit: process.env.ACURAST_FAST_SUBMIT !== "false",
  acurastChainDiagnostics: process.env.ACURAST_CHAIN_DIAGNOSTICS === "true",
  acurastFastYieldMode: normaliseFastYieldMode(process.env.ACURAST_FAST_YIELD_MODE),
  acurastFastYieldSource: normaliseFastYieldSource(process.env.ACURAST_FAST_YIELD_SOURCE),
  acurastFastYieldTimeoutMs: Number(process.env.ACURAST_FAST_YIELD_TIMEOUT_MS ?? process.env.APR_API_TIMEOUT_MS ?? 3_500),
  acurastUseFallbackFees: process.env.ACURAST_USE_FALLBACK_FEES !== "false",
  waitForHarvestReceipt: process.env.WAIT_FOR_HARVEST_RECEIPT === "true",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HARDWARE_REPORT_INTERVAL_MS = Number(process.env.HW_ADDRESS_REPORT_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
const HARVEST_RECEIPT_TIMEOUT_MS = Number(process.env.HARVEST_RECEIPT_TIMEOUT_MS ?? 15_000);
const PROCESSOR_CHAIN_DIAGNOSTIC_TIMEOUT_MS = Number(process.env.PROCESSOR_CHAIN_DIAGNOSTIC_TIMEOUT_MS ?? 2_500);
const FINAL_LOG_DRAIN_MS = Number(process.env.FINAL_LOG_DRAIN_MS ?? 1_500);
const FALLBACK_MAX_FEE_PER_GAS = BigInt(process.env.FALLBACK_MAX_FEE_PER_GAS_WEI ?? "100000000");
const FALLBACK_MAX_PRIORITY_FEE_PER_GAS = BigInt(process.env.FALLBACK_MAX_PRIORITY_FEE_PER_GAS_WEI ?? "1000000");
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AERODROME_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const ROUTER_ADDRESS = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const DIRECT_AERO_USDC_ROUTE: Route[] = [{ from: AERO, to: USDC, stable: false, factory: AERODROME_FACTORY }];

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

type CooldownState = Pick<
  Awaited<ReturnType<typeof loadState>>,
  "lastRunAt" | "suggestedNextCheckMs"
>;

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestampSec(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed == null || parsed <= 0) return null;
  return parsed > 10_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed);
}

function latestLogTimestampSec(logs: unknown): number | null {
  if (!Array.isArray(logs)) return null;
  let latest: number | null = null;
  for (const log of logs) {
    const timestamp = normalizeTimestampSec((log as { timestamp?: unknown } | null)?.timestamp);
    if (timestamp != null && (latest == null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}

async function fetchRemoteCooldownState(
  userAddress: string | undefined,
  chainId: number
): Promise<CooldownState | null> {
  if (!CONFIG.remoteCooldownGuard || !CONFIG.frontendUrl || !userAddress) return null;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const url = new URL("/api/state", CONFIG.frontendUrl);
    url.searchParams.set("userAddress", userAddress);
    url.searchParams.set("chainId", String(chainId));

    timeout = setTimeout(() => controller.abort(), CONFIG.cooldownRemoteTimeoutMs);
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`state API returned HTTP ${response.status}`);
    }

    const body = await response.json() as Record<string, unknown>;
    const lastRunAt = normalizeTimestampSec(body.lastRunAt) ?? latestLogTimestampSec(body.logs);
    const suggestedNextCheckMs = finiteNumber(body.suggestedNextCheckMs);
    if (lastRunAt == null && suggestedNextCheckMs == null) return null;

    return {
      lastRunAt,
      suggestedNextCheckMs,
    };
  } catch (error) {
    emitOperationalLog("remote_cooldown_state_failed", {
      message: error instanceof Error ? error.message : String(error),
      frontendHost: (() => {
        try {
          return new URL(CONFIG.frontendUrl).host;
        } catch {
          return "invalid_frontend_url";
        }
      })(),
    });
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function mergeCooldownState(
  localState: Awaited<ReturnType<typeof loadState>>,
  remoteState: CooldownState | null
): { state: Awaited<ReturnType<typeof loadState>>; source: "local_storage" | "remote_state" } {
  if (!remoteState?.lastRunAt || (localState.lastRunAt && localState.lastRunAt >= remoteState.lastRunAt)) {
    return { state: localState, source: "local_storage" };
  }

  return {
    state: {
      ...localState,
      lastRunAt: remoteState.lastRunAt,
      suggestedNextCheckMs: remoteState.suggestedNextCheckMs ?? localState.suggestedNextCheckMs,
    },
    source: "remote_state",
  };
}

function emitOperationalLog(
  event: string,
  details: Record<string, unknown> = {},
  level: "info" | "error" = "info"
): void {
  const payload = {
    event,
    timestamp: Math.floor(Date.now() / 1000),
    chainId: process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined,
    userAddress: process.env.USER_ADDRESS || (globalThis as any).__ENV__?.USER_ADDRESS,
    ...details,
  };
  const line = `[OP_LOG] ${JSON.stringify(payload)}`;
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function sanitizeBroadcastError(error: unknown): Record<string, unknown> {
  const anyError = error as any;
  const nestedError = anyError?.error;
  const transactionHash =
    anyError?.transactionHash ??
    anyError?.receipt?.hash ??
    anyError?.receipt?.transactionHash ??
    nestedError?.transactionHash;

  return {
    name: anyError?.name,
    code: anyError?.code ?? nestedError?.code,
    reason: anyError?.reason ?? nestedError?.reason,
    shortMessage: anyError?.shortMessage,
    message: String(anyError?.message ?? nestedError?.message ?? error).slice(0, 500),
    acurastFulfillMessages: Array.isArray(anyError?.acurastFulfillMessages)
      ? anyError.acurastFulfillMessages.map((message: unknown) => String(message).slice(0, 300)).slice(0, 5)
      : undefined,
    transactionHash,
  };
}

function rpcUrlHost(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return "invalid_rpc_url";
  }
}

async function emitProcessorBoot(processStartedAtSec: number): Promise<void> {
  emitOperationalLog("processor_boot", {
    phase: "process_started",
    hasAcurastStd: Boolean(getAcurastStd()),
    hasUserAddress: Boolean(process.env.USER_ADDRESS || (globalThis as any).__ENV__?.USER_ADDRESS),
    hasProcessorSharedSecret: Boolean(process.env.PROCESSOR_SHARED_SECRET || (globalThis as any).__ENV__?.PROCESSOR_SHARED_SECRET),
    dryRun: CONFIG.dryRun,
    acurastFastSubmit: CONFIG.acurastFastSubmit,
    acurastUseFallbackFees: CONFIG.acurastUseFallbackFees,
    waitForHarvestReceipt: CONFIG.waitForHarvestReceipt,
  });
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
  emitOperationalLog("hw_address_report", {
    hwAddress,
    note: "Attest and fund this exact address for production Acurast executions.",
  });
  await emitTelemetry({
    event: "hw_address_report",
    timestamp: nowSec,
    hwAddress,
    note: "Attest this address on-chain via ownerAttestProcessor(hwAddress)",
  });
}

async function emitProcessorChainDiagnostics(
  provider: ethers.JsonRpcApiProvider,
  processorAddress: string,
  keeperAddress: string,
  executionChainId: number,
  envUser: string | undefined
): Promise<void> {
  const attestationContract = new ethers.Contract(
    keeperAddress,
    ["function attestedProcessors(address) view returns (bool)"],
    provider
  );

  const [balanceResult, pendingNonceResult, latestNonceResult, attestationResult] = await Promise.allSettled([
    withTimeout(provider.getBalance(processorAddress), PROCESSOR_CHAIN_DIAGNOSTIC_TIMEOUT_MS, "processor.getBalance"),
    withTimeout(provider.getTransactionCount(processorAddress, "pending"), PROCESSOR_CHAIN_DIAGNOSTIC_TIMEOUT_MS, "processor.getTransactionCount pending"),
    withTimeout(provider.getTransactionCount(processorAddress, "latest"), PROCESSOR_CHAIN_DIAGNOSTIC_TIMEOUT_MS, "processor.getTransactionCount latest"),
    withTimeout(attestationContract.attestedProcessors(processorAddress), PROCESSOR_CHAIN_DIAGNOSTIC_TIMEOUT_MS, "keeper.attestedProcessors"),
  ]);

  const diagnostics: Record<string, unknown> = {
    processorAddress,
    keeperAddress,
    diagnosticTimeoutMs: PROCESSOR_CHAIN_DIAGNOSTIC_TIMEOUT_MS,
  };

  if (balanceResult.status === "fulfilled") {
    diagnostics.balanceWei = balanceResult.value.toString();
    diagnostics.balanceEth = ethers.formatEther(balanceResult.value);
  } else {
    diagnostics.balanceError = sanitizeBroadcastError(balanceResult.reason);
  }

  if (pendingNonceResult.status === "fulfilled") {
    diagnostics.pendingNonce = pendingNonceResult.value;
  } else {
    diagnostics.pendingNonceError = sanitizeBroadcastError(pendingNonceResult.reason);
  }

  if (latestNonceResult.status === "fulfilled") {
    diagnostics.latestNonce = latestNonceResult.value;
  } else {
    diagnostics.latestNonceError = sanitizeBroadcastError(latestNonceResult.reason);
  }

  if (attestationResult.status === "fulfilled") {
    diagnostics.processorAttested = Boolean(attestationResult.value);
  } else {
    diagnostics.attestationError = sanitizeBroadcastError(attestationResult.reason);
  }

  emitOperationalLog("processor_chain_diagnostics", diagnostics);
  await emitTelemetry({
    event: "processor_chain_diagnostics",
    timestamp: Math.floor(Date.now() / 1000),
    chainId: executionChainId,
    userAddress: envUser,
    ...diagnostics,
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

type HarvestReceiptLike = {
  logs: readonly {
    topics: readonly string[];
    data: string;
  }[];
  blockNumber: number | bigint;
};

function parseHarvestReceiptProof(receipt: HarvestReceiptLike): HarvestReceiptProof {
  let profitCredited = 0n;
  let rewardClaimed: bigint | undefined;
  let profitUsdc: bigint | undefined;
  let lpAdded: bigint | undefined;
  let profitPulled: bigint | undefined;

  for (const log of receipt.logs) {
    for (const iface of HARVEST_AUDIT_IFACES) {
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
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
    blockNumber: Number(receipt.blockNumber),
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

function fallbackFeeData(): ethers.FeeData {
  return new ethers.FeeData(null, FALLBACK_MAX_FEE_PER_GAS, FALLBACK_MAX_PRIORITY_FEE_PER_GAS);
}

function fallbackYieldResult(reason: string) {
  return {
    estimate: {
      usable: true,
      totalApr: 0,
      feeApr: 0,
      rewardApr: 0,
      confidence: 0,
      dataSourcesUsed: [],
      diagnostics: { fallbackReason: reason },
      estimatedApy: 0,
      forwardAprEstimate: null,
    },
    indexerCheckpointBlock: null,
    rewardAprEwmNext: null,
  };
}

function buildBestEffortHarvestAttempt(nowSec: number, amountToSwap: bigint, routes: Route[]): HarvestParams {
  return {
    nonce: Date.now().toString(),
    targetPool: CONFIG.poolAddress,
    minLpOut: "1",
    amountToSwap: amountToSwap.toString(),
    deadline: nowSec + 300,
    routes,
  };
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

  const isGracefulSkip = processorNotAttested ||
    errorDetails.message.includes("too frequent") ||
    errorDetails.message.includes("unknown reason");

  state.apiFailureStreak = isGracefulSkip ? state.apiFailureStreak : state.apiFailureStreak + 1;
  state.lastRunAt = nowSec;
  state.lastDecisionReason = processorNotAttested ? "processor_not_attested" :
    isGracefulSkip ? "harvest_cooldown_revert" : "harvest_submission_failed";

  // 10-minute backoff on any submission failure or revert
  state.suggestedNextCheckMs = 10 * 60 * 1000;
  await saveState(CONFIG.statePath, state);

  emitOperationalLog(isGracefulSkip ? "harvest_gracefully_skipped" : "harvest_submission_failed", {
    reason: state.lastDecisionReason,
    processorNotAttested,
    apiFailureStreak: state.apiFailureStreak,
    recommendedNextCheckMs: state.suggestedNextCheckMs,
    message: errorDetails.message,
    name: errorDetails.name,
  }, isGracefulSkip ? "info" : "error");

  await emitTelemetry({
    event: isGracefulSkip ? "harvest_gracefully_skipped" : "harvest_submission_failed",
    timestamp: Math.floor(Date.now() / 1000),
    reason: state.lastDecisionReason,
    processorNotAttested,
    apiFailureStreak: state.apiFailureStreak,
    recommendedNextCheckMs: state.suggestedNextCheckMs,
    chainId: executionChainId,
    userAddress: envUser,
    ...(isGracefulSkip ? { message: "Harvest skipped gracefully (contract cooldown or attestation pending)." } : errorDetails),
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
  const envUser = process.env.USER_ADDRESS || (globalThis as any).__ENV__?.USER_ADDRESS;
  const configuredExecutionChainId = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : 8453;
  const previousLastRunAt = state.lastRunAt;
  const previousLastExecutionAt = state.lastExecutionAt;

  // Crash-safe cooldown guard.
  // Stamp the run immediately. If we crash 1 second from now, the next 
  // restart will see this timestamp and skip.
  const std = getAcurastStd();
  const guardStorageKey = `worker-state:${(envUser ?? "default").toLowerCase()}:.yieldsense-state.json`;

  // 1. Check Cooldown
  const remoteCooldownState = await fetchRemoteCooldownState(envUser, configuredExecutionChainId);
  const cooldown = mergeCooldownState(state, remoteCooldownState);
  const recentRun = shouldSkipRecentRun(cooldown.state, startNow);
  if (recentRun.skip) {
    const lastSkippedAt = state.lastSkippedAt ?? 0;
    if (startNow - lastSkippedAt >= 60) {
      state.lastSkippedAt = startNow;
      state.lastDecisionReason = "cooldown_guard";
      await saveState(CONFIG.statePath, state);
      emitOperationalLog("run_skipped_recent", {
        elapsedMs: recentRun.elapsedMs,
        waitMs: recentRun.waitMs,
        intervalMs: recentRun.intervalMs,
        cooldownSource: cooldown.source,
        remoteLastRunAt: remoteCooldownState?.lastRunAt,
        remoteSuggestedNextCheckMs: remoteCooldownState?.suggestedNextCheckMs,
      });
      await emitTelemetry({
        event: "run_skipped_recent",
        timestamp: startNow,
        elapsedMs: recentRun.elapsedMs,
        waitMs: recentRun.waitMs,
        intervalMs: recentRun.intervalMs,
        reason: "cooldown_guard",
        cooldownSource: cooldown.source,
        remoteLastRunAt: remoteCooldownState?.lastRunAt,
        remoteSuggestedNextCheckMs: remoteCooldownState?.suggestedNextCheckMs,
        bestEffortSubmissionContinues: false,
        hasAcurastStd: Boolean(getAcurastStd()),
      });
    }
    return recentRun.waitMs;
  }

  await emitHardwareAddressReport(startNow);

  // 2. Stamp and Save Immediately
  state.lastRunAt = startNow;
  state.lastDecisionReason = "run_started";

  try {
    await saveState(CONFIG.statePath, state);
  } catch (saveError) {
    console.error(`[STORAGE_ERROR] Failed to save state: ${String(saveError)}`);
  }

  if (std?.storage) {
    try {
      const existing = std.storage.get(guardStorageKey);
      const parsed = existing ? JSON.parse(existing) : {};
      std.storage.set(guardStorageKey, JSON.stringify({ ...parsed, lastRunAt: startNow }));
    } catch (e) {
      console.error(`[STORAGE_ERROR] Guard storage failure: ${String(e)}`);
    }
  }

  // 3. Log Config for TEE Diagnostics
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
    paymasterGasCostUsd: CONFIG.paymasterGasCostUsd,
    paymasterDiscoveryOnly: CONFIG.paymasterDiscoveryOnly,
    startupRpcProbe: CONFIG.startupRpcProbe,
    acurastFastSubmit: CONFIG.acurastFastSubmit,
    acurastFastYieldMode: CONFIG.acurastFastYieldMode,
    acurastFastYieldSource: CONFIG.acurastFastYieldSource,
    acurastFastYieldTimeoutMs: CONFIG.acurastFastYieldTimeoutMs,
    acurastUseFallbackFees: CONFIG.acurastUseFallbackFees,
    acurastChainDiagnostics: CONFIG.acurastChainDiagnostics,
    waitForHarvestReceipt: CONFIG.waitForHarvestReceipt,
    enforceProfitability: CONFIG.enforceProfitability,
    userAddress: envUser,
  }).catch(() => { });

  const executionProvider = createJsonRpcProvider(
    CONFIG.rpcUrl,
    configuredExecutionChainId
  );

  const dataProvider =
    CONFIG.dataRpcUrl && CONFIG.dataRpcUrl !== CONFIG.rpcUrl
      ? createJsonRpcProvider(CONFIG.dataRpcUrl, CONFIG.yieldChainId ?? 8453)
      : executionProvider;
  emitTelemetry({
    event: "worker_stage",
    timestamp: Math.floor(Date.now() / 1000),
    stage: "providers_created",
    configuredExecutionChainId,
    configuredYieldChainId: CONFIG.yieldChainId,
    userAddress: envUser,
  }).catch(() => { });
  const executionChainId = configuredExecutionChainId;
  const dataChainId = CONFIG.yieldChainId ?? 8453;
  let yieldChainId = dataChainId;

  if (yieldChainId !== dataChainId) {
    throw new Error(
      `YIELD_CHAIN_ID ${yieldChainId} does not match DATA_RPC_URL chainId ${dataChainId}. ` +
      `Set YIELD_CHAIN_ID=${dataChainId} or point DATA_RPC_URL at the intended network.`
    );
  }

  console.log(`[BOOT] Execution RPC: ${CONFIG.rpcUrl}`);

  emitTelemetry({
    event: "worker_stage",
    timestamp: Math.floor(Date.now() / 1000),
    stage: "network_ready",
    executionChainId,
    dataChainId,
    yieldChainId,
    userAddress: envUser,
  }).catch(() => { });

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
  const acurastStd = std;
  const fastSubmitMode = Boolean(acurastStd && !CONFIG.dryRun && CONFIG.acurastFastSubmit);

  const hybridMainnetRead = CONFIG.dataRpcUrl.length > 0;

  const elapsedEwma =
    state.lastRunAt != null ? Math.max(60, nowSec - state.lastRunAt) : 300;

  let yieldResult;
  let yieldEstimateFailed = false;
  if (fastSubmitMode) {
    if (CONFIG.acurastFastYieldMode === "api") {
      try {
        const fastYieldTimeoutMs = remainingExecutionTimeoutMs(
          startedAtMs,
          CONFIG.acurastFastYieldTimeoutMs
        );
        const request = buildYieldRequest(yieldChainId, CONFIG.poolAddress);
        const fastApr = await withTimeout(
          apiSingleSourceApr(
            request.apiPoolAddress ?? request.poolAddress,
            request.aprFreshnessWindowSec,
            request.minApiConfidence,
            request.apyCompoundPeriodsPerYear ?? 365,
            CONFIG.acurastFastYieldSource
          ),
          fastYieldTimeoutMs,
          "fast API yield estimate"
        );

        if (!fastApr) {
          throw new Error(`Fast API APR unavailable from ${CONFIG.acurastFastYieldSource}`);
        }

        yieldResult = {
          estimate: fastApr.estimate,
          indexerCheckpointBlock: state.yieldIndexerCheckpointBlock ?? 0,
          rewardAprEwmNext: state.rewardAprEwm ?? null,
        };
      } catch (error: any) {
        yieldEstimateFailed = true;
        yieldResult = fallbackYieldResult("acurast_fast_api_unavailable");
        await emitTelemetry({
          event: "yield_estimate_failed",
          timestamp: Math.floor(Date.now() / 1000),
          reason: "acurast_fast_api_unavailable",
          source: CONFIG.acurastFastYieldSource,
          message: error?.message ?? String(error),
          name: error?.name,
          chainId: executionChainId,
          userAddress: envUser,
        });
      }

      await emitTelemetry({
        event: "yield_estimate_complete",
        timestamp: Math.floor(Date.now() / 1000),
        mode: "fast_api",
        source: CONFIG.acurastFastYieldSource,
        fallback: yieldEstimateFailed,
        usable: yieldResult.estimate.usable,
        confidence: yieldResult.estimate.confidence,
        apr: yieldResult.estimate.totalApr,
        estimatedApy: yieldResult.estimate.estimatedApy,
        sources: yieldResult.estimate.dataSourcesUsed,
        chainId: executionChainId,
        userAddress: envUser,
      });
    } else {
      yieldEstimateFailed = true;
      yieldResult = fallbackYieldResult("acurast_fast_submit");
      await emitTelemetry({
        event: "yield_estimate_skipped",
        timestamp: nowSec,
        reason: "acurast_fast_submit",
        note: "Skipping RPC-heavy yield indexing; best-effort harvest submission continues.",
        chainId: executionChainId,
        userAddress: envUser,
      });
    }
  } else if (CONFIG.forceTestHarvest) {
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
    }).catch(() => { });

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
      yieldEstimateFailed = true;
      await persistYieldEstimateFailure(state, nowSec, executionChainId, envUser, error);
      yieldResult = fallbackYieldResult("yield_estimate_failed");
    }

    emitTelemetry({
      event: "worker_stage",
      timestamp: Math.floor(Date.now() / 1000),
      stage: "yield_estimate_complete",
      fallback: yieldEstimateFailed,
      usable: yieldResult.estimate.usable,
      confidence: yieldResult.estimate.confidence,
      sources: yieldResult.estimate.dataSourcesUsed,
      chainId: executionChainId,
      userAddress: envUser,
    }).catch(() => { });
  }

  let ethPrice = 3500;
  let lastHarvest = 0n;
  let feeData = fallbackFeeData();
  let keeperOrFeeReadFailed = false;
  try {
    if (!fastSubmitMode) {
      ethPrice = await getEthPrice();
    }
    if (fastSubmitMode && CONFIG.acurastUseFallbackFees) {
      feeData = fallbackFeeData();
      await emitTelemetry({
        event: "fee_data_skipped",
        timestamp: Math.floor(Date.now() / 1000),
        reason: "acurast_fast_submit",
        maxFeePerGas: feeData.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
        chainId: executionChainId,
        userAddress: envUser,
      });
    } else {
      feeData = await withTimeout(
        executionProvider.getFeeData(),
        CONFIG.feeDataTimeoutMs,
        "executionProvider.getFeeData"
      );
    }

    if (CONFIG.forceTestHarvest) {
      lastHarvest = 0n;
    } else if (fastSubmitMode) {
      const fastModeReferenceTime =
        previousLastExecutionAt ??
        previousLastRunAt ??
        nowSec - Math.max(CONFIG.cooldownSec, 300);
      lastHarvest = BigInt(Math.max(0, fastModeReferenceTime));
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

      // CONTRACT COOLDOWN SAFETY GUARD
      const MIN_HARVEST_INTERVAL = 45 * 60; // 45 minutes
      const timeSinceLastHarvest = nowSec - Number(lastHarvest);
      if (timeSinceLastHarvest < MIN_HARVEST_INTERVAL && !CONFIG.forceTestHarvest) {
        const remaining = MIN_HARVEST_INTERVAL - timeSinceLastHarvest;
        state.lastDecisionReason = "contract_cooldown_active";
        state.lastRunAt = nowSec;
        state.suggestedNextCheckMs = remaining * 1000;
        await saveState(CONFIG.statePath, state);

        emitOperationalLog("harvest_skipped_cooldown", {
          lastHarvest: Number(lastHarvest),
          timeSinceLastHarvest,
          remainingCooldown: remaining,
        });
        await emitTelemetry({
          event: "harvest_skipped_cooldown",
          timestamp: nowSec,
          lastHarvest: Number(lastHarvest),
          timeSinceLastHarvest,
          remainingCooldown: remaining,
          chainId: executionChainId,
        });
        return remaining * 1000;
      }
    }
  } catch (error: any) {
    keeperOrFeeReadFailed = true;
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
      bestEffortSubmissionContinues: true,
    });
  }

  const aprConsensus = yieldResult.estimate;
  if (fastSubmitMode) {
    state.apiFailureStreak = 0;
  }
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
      bestEffortSubmissionContinues: true,
    });
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
        bestEffortSubmissionContinues: true,
        hint: "Best-effort mode will still submit. Set RPC_URL to https://sepolia.base.org for test-only execution.",
      });
    }
  }

  let decision: ReturnType<typeof evaluateDecision> | null = null;
  let earnedAero = 0n;

  if (!CONFIG.forceTestHarvest) {
    if (!yieldEstimateFailed && !keeperOrFeeReadFailed) {
      state.apiFailureStreak = 0;
    }
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? BigInt(0);
    const nativeGasCostUsd = Number(ethers.formatEther(gasPrice * CONFIG.estGasUnits)) * ethPrice;
    const usesPaymaster = CONFIG.gasSponsorMode === "paymaster";
    const paymasterGasCostUsd = Number.isFinite(CONFIG.paymasterGasCostUsd)
      ? Math.max(0, CONFIG.paymasterGasCostUsd)
      : 0.015;
    const gasCostUsd = usesPaymaster ? paymasterGasCostUsd : nativeGasCostUsd;
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
      nativeGasCostUsd,
      paymasterGasCostUsd: usesPaymaster ? paymasterGasCostUsd : undefined,
      gasCostSource: usesPaymaster ? "paymaster_estimate" : "native_fee_estimate",
      thresholdUsd: decision.thresholdUsd,
      reason: decision.reason,
      recommendedNextCheckMs: decision.recommendedNextCheckMs,
      bestEffortSubmissionContinues: !decision.shouldExecute,
      chainId: executionChainId,
    });
    emitOperationalLog("profitability_check", {
      shouldExecute: decision.shouldExecute,
      reason: decision.reason,
      netRewardUsd: decision.netRewardUsd,
      grossRewardUsd: decision.grossRewardUsd,
      gasCostUsd,
      nativeGasCostUsd,
      paymasterGasCostUsd: usesPaymaster ? paymasterGasCostUsd : undefined,
      gasCostSource: usesPaymaster ? "paymaster_estimate" : "native_fee_estimate",
      thresholdUsd: decision.thresholdUsd,
      apr: aprConsensus.totalApr,
      confidence: aprConsensus.confidence,
      enforceProfitability: CONFIG.enforceProfitability,
      usedYieldFallback: yieldEstimateFailed,
      usedFeeFallback: keeperOrFeeReadFailed,
    });

    state.previousApr = aprConsensus.totalApr;
    state.lastDecisionReason = decision.reason;
    state.lastRunAt = nowSec;
    state.suggestedNextCheckMs = decision.recommendedNextCheckMs;

    if (!decision.shouldExecute) {
      await saveState(CONFIG.statePath, state);
      if (CONFIG.enforceProfitability) {
        emitOperationalLog("harvest_skipped_profitability", {
          reason: decision.reason,
          netRewardUsd: decision.netRewardUsd,
          thresholdUsd: decision.thresholdUsd,
          recommendedNextCheckMs: decision.recommendedNextCheckMs,
        });
        await emitTelemetry({
          event: "harvest_skipped_profitability",
          timestamp: nowSec,
          reason: decision.reason,
          netRewardUsd: decision.netRewardUsd,
          thresholdUsd: decision.thresholdUsd,
          recommendedNextCheckMs: decision.recommendedNextCheckMs,
          chainId: executionChainId,
          userAddress: envUser,
        });
        return decision.recommendedNextCheckMs;
      }
      await emitTelemetry({
        event: "harvest_gate_overridden",
        timestamp: nowSec,
        reason: decision.reason,
        note: "Best-effort mode submits once per Acurast execution even when profitability gates fail.",
        chainId: executionChainId,
        userAddress: envUser,
      });
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
  const directRoute = DIRECT_AERO_USDC_ROUTE;
  let routes = directRoute;
  let estimatedUsdcIn = ethers.parseUnits("10", 6); // fallback

  // Zap Math: Calculate optimal swap amount
  let amountToSwap = estimatedUsdcIn / 2n;

  if (!CONFIG.dryRun && !fastSubmitMode) {
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

  const harvestParams = buildBestEffortHarvestAttempt(nowSec, amountToSwap, routes);
  const harvestPayloadHash = buildHarvestPayloadHash(harvestParams);

  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? FALLBACK_MAX_FEE_PER_GAS;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? FALLBACK_MAX_PRIORITY_FEE_PER_GAS;

  let txHash = "";
  let receipt: HarvestReceiptLike | null = null;

  try {
    emitOperationalLog("harvest_submit_attempt", {
      keeperAddress: CONFIG.keeperAddress,
      targetPool: harvestParams.targetPool,
      minLpOut: harvestParams.minLpOut,
      amountToSwap: harvestParams.amountToSwap,
      deadline: harvestParams.deadline,
      routeCount: harvestParams.routes.length,
      usedYieldFallback: yieldEstimateFailed,
      usedFeeFallback: keeperOrFeeReadFailed,
      dryRun: CONFIG.dryRun,
      gasLimit: CONFIG.estGasUnits.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      signingMode: acurastStd ? "acurast_fulfill_attested_sender" : "local_private_key",
    });
    await emitTelemetry({
      event: "harvest_submit_attempt",
      timestamp: Math.floor(Date.now() / 1000),
      payloadHash: harvestPayloadHash,
      keeperAddress: CONFIG.keeperAddress,
      targetPool: harvestParams.targetPool,
      minLpOut: harvestParams.minLpOut,
      amountToSwap: harvestParams.amountToSwap,
      deadline: harvestParams.deadline,
      routeCount: harvestParams.routes.length,
      usedYieldFallback: yieldEstimateFailed,
      usedFeeFallback: keeperOrFeeReadFailed,
      forceTestHarvest: CONFIG.forceTestHarvest,
      dryRun: CONFIG.dryRun,
      chainId: executionChainId,
      userAddress: envUser,
    });

    if (acurastStd) {
      const hwAddress = ethers.getAddress(acurastStd.chains.ethereum.getAddress());
      if (CONFIG.acurastChainDiagnostics) {
        await emitProcessorChainDiagnostics(executionProvider, hwAddress, CONFIG.keeperAddress, executionChainId, envUser);
      }

      if (CONFIG.gasSponsorMode === "paymaster") {
        const paymasterRpcUrl = getPaymasterRpcUrl();
        if (!paymasterRpcUrl) {
          throw new Error("BASE_PAYMASTER_RPC_URL or PAYMASTER_RPC_URL is required when GAS_SPONSOR_MODE=paymaster.");
        }

        const paymasterContext = {
          payloadHash: harvestPayloadHash,
          keeperAddress: CONFIG.keeperAddress,
          hardwareProcessorAddress: hwAddress,
          paymasterOwnerMode: getPaymasterOwnerMode(),
          rpcUrlHost: rpcUrlHost(CONFIG.rpcUrl),
          paymasterRpcHost: rpcUrlHost(paymasterRpcUrl),
          signingMode: "coinbase_smart_account_paymaster",
        };

        if (CONFIG.paymasterDiscoveryOnly) {
          const smartAccountAddress = await getAcurastPaymasterSmartAccountAddress({
            rpcUrl: CONFIG.rpcUrl,
            std: acurastStd,
          });
          emitOperationalLog("paymaster_smart_account_report", {
            ...paymasterContext,
            smartAccountAddress,
            note: "Attest this smartAccountAddress via ownerAttestProcessor before disabling PAYMASTER_DISCOVERY_ONLY.",
          });
          await emitTelemetry({
            event: "paymaster_smart_account_report",
            timestamp: Math.floor(Date.now() / 1000),
            chainId: executionChainId,
            userAddress: envUser,
            ...paymasterContext,
            smartAccountAddress,
          });
          state.lastDecisionReason = "paymaster_discovery_only";
          state.lastRunAt = nowSec;
          state.suggestedNextCheckMs = 10 * 60 * 1000;
          await saveState(CONFIG.statePath, state);
          return;
        }

        emitOperationalLog("paymaster_userop_submit_start", paymasterContext);
        await emitTelemetry({
          event: "paymaster_userop_submit_start",
          timestamp: Math.floor(Date.now() / 1000),
          chainId: executionChainId,
          userAddress: envUser,
          ...paymasterContext,
        });

        try {
          const sponsored = await submitHarvestWithBasePaymaster({
            std: acurastStd,
            rpcUrl: CONFIG.rpcUrl,
            paymasterRpcUrl,
            keeperAddress: CONFIG.keeperAddress,
            nonce: harvestParams.nonce,
            targetPool: harvestParams.targetPool,
            minLpOut: harvestParams.minLpOut,
            amountToSwap: harvestParams.amountToSwap,
            deadline: harvestParams.deadline,
            routes,
          });

          txHash = sponsored.hash;
          receipt = sponsored.receipt;
          const submittedAtSec = Math.floor(Date.now() / 1000);

          emitOperationalLog("paymaster_userop_confirmed", {
            ...paymasterContext,
            smartAccountAddress: sponsored.smartAccountAddress,
            userOpHash: sponsored.userOpHash,
            txHash,
            blockNumber: Number(sponsored.receipt.blockNumber),
          });
          await emitTelemetry({
            event: "paymaster_userop_confirmed",
            timestamp: Math.floor(Date.now() / 1000),
            chainId: executionChainId,
            userAddress: envUser,
            ...paymasterContext,
            smartAccountAddress: sponsored.smartAccountAddress,
            userOpHash: sponsored.userOpHash,
            txHash,
            blockNumber: Number(sponsored.receipt.blockNumber),
          });

          emitOperationalLog("paymaster_smart_account_report", {
            ...paymasterContext,
            smartAccountAddress: sponsored.smartAccountAddress,
          });

          emitOperationalLog("harvest_submitted", {
            txHash,
            payloadHash: harvestPayloadHash,
            signingMode: "coinbase_smart_account_paymaster",
            processorAddress: sponsored.smartAccountAddress,
            hardwareProcessorAddress: hwAddress,
            userOpHash: sponsored.userOpHash,
          });

          // Update state immediately to prevent rapid-fire retries
          state.lastExecutionAt = submittedAtSec;
          state.lastRunAt = submittedAtSec;
          state.lastDecisionReason = "submitted_paymaster";
          state.suggestedNextCheckMs = 45 * 60 * 1000; // 45 minute cooldown
          await saveState(CONFIG.statePath, state);

          await emitTelemetry({
            event: "harvest_submitted",
            timestamp: submittedAtSec,
            txHash,
            payloadHash: harvestPayloadHash,
            signingMode: "coinbase_smart_account_paymaster",
            processorAddress: sponsored.smartAccountAddress,
            hardwareProcessorAddress: hwAddress,
            userOpHash: sponsored.userOpHash,
            ...(CONFIG.forceTestHarvest ? { forceTest: true, aprBps, rewardCents } : {}),
          });
        } catch (paymasterError) {
          const sanitizedError = sanitizeBroadcastError(paymasterError);
          emitOperationalLog("paymaster_userop_failed", {
            ...paymasterContext,
            ...sanitizedError,
          }, "error");
          await emitTelemetry({
            event: "paymaster_userop_failed",
            timestamp: Math.floor(Date.now() / 1000),
            chainId: executionChainId,
            userAddress: envUser,
            ...paymasterContext,
            ...sanitizedError,
          });
          throw paymasterError;
        }
      } else {
        const broadcastContext = {
          payloadHash: harvestPayloadHash,
          keeperAddress: CONFIG.keeperAddress,
          processorAddress: hwAddress,
          rpcUrlHost: rpcUrlHost(CONFIG.rpcUrl),
          gasLimit: CONFIG.estGasUnits.toString(),
          maxFeePerGas: maxFeePerGas.toString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          signingMode: "acurast_fulfill_attested_sender",
        };
        emitOperationalLog("broadcast_start", broadcastContext);
        await emitTelemetry({
          event: "broadcast_start",
          timestamp: Math.floor(Date.now() / 1000),
          chainId: executionChainId,
          userAddress: envUser,
          ...broadcastContext,
        });

        let submitted: Awaited<ReturnType<typeof fulfillEthereumHarvest>>;
        try {
          submitted = await fulfillEthereumHarvest(acurastStd, {
            rpcUrl: CONFIG.rpcUrl,
            keeperAddress: CONFIG.keeperAddress,
            nonce: harvestParams.nonce,
            targetPool: CONFIG.poolAddress,
            minLpOut: harvestParams.minLpOut,
            amountToSwap: harvestParams.amountToSwap,
            deadline: harvestParams.deadline,
            routes,
            gasLimit: CONFIG.estGasUnits.toString(),
            maxFeePerGas: maxFeePerGas.toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          });
        } catch (broadcastError) {
          const sanitizedError = sanitizeBroadcastError(broadcastError);
          emitOperationalLog("broadcast_error", {
            ...broadcastContext,
            ...sanitizedError,
          }, "error");
          await emitTelemetry({
            event: "broadcast_error",
            timestamp: Math.floor(Date.now() / 1000),
            chainId: executionChainId,
            userAddress: envUser,
            ...broadcastContext,
            ...sanitizedError,
          });
          throw broadcastError;
        }
        txHash = submitted.hash;
        const submittedAtSec = Math.floor(Date.now() / 1000);

        emitOperationalLog("broadcast_result", {
          ...broadcastContext,
          txHash,
        });
        await emitTelemetry({
          event: "broadcast_result",
          timestamp: Math.floor(Date.now() / 1000),
          txHash,
          chainId: executionChainId,
          userAddress: envUser,
          ...broadcastContext,
        });

        emitOperationalLog("harvest_submitted", {
          txHash,
          payloadHash: harvestPayloadHash,
          signingMode: "acurast_fulfill_attested_sender",
          processorAddress: hwAddress,
        });
        await emitTelemetry({
          event: "harvest_submitted",
          timestamp: submittedAtSec,
          txHash,
          payloadHash: harvestPayloadHash,
          signingMode: "acurast_fulfill_attested_sender",
          processorAddress: hwAddress,
          ...(CONFIG.forceTestHarvest ? { forceTest: true, aprBps, rewardCents } : {}),
        });
        if (!CONFIG.waitForHarvestReceipt) {
          state.lastDecisionReason = "submitted";
          state.lastRunAt = submittedAtSec;
          state.lastExecutionAt = submittedAtSec;
          state.suggestedNextCheckMs = 10 * 60 * 1000;
          await saveState(CONFIG.statePath, state);
          emitOperationalLog("harvest_receipt_wait_skipped", {
            txHash,
            reason: "WAIT_FOR_HARVEST_RECEIPT_not_true",
          });
          await emitTelemetry({
            event: "harvest_receipt_wait_skipped",
            timestamp: Math.floor(Date.now() / 1000),
            txHash,
            reason: "WAIT_FOR_HARVEST_RECEIPT_not_true",
            chainId: executionChainId,
            userAddress: envUser,
          });
          return;
        }
        try {
          receipt = await withTimeout(
            executionProvider.waitForTransaction(txHash),
            HARVEST_RECEIPT_TIMEOUT_MS,
            "executionProvider.waitForTransaction"
          );
        } catch (receiptError) {
          state.lastDecisionReason = "submitted_receipt_pending";
          await saveState(CONFIG.statePath, state);
          await emitTelemetry({
            event: "harvest_receipt_wait_failed",
            timestamp: Math.floor(Date.now() / 1000),
            txHash,
            chainId: executionChainId,
            userAddress: envUser,
            ...serialiseError(receiptError),
          });
          return;
        }
      }
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

      let tx;
      const broadcastContext = {
        payloadHash: harvestPayloadHash,
        keeperAddress: CONFIG.keeperAddress,
        processorAddress: wallet.address,
        rpcUrlHost: rpcUrlHost(CONFIG.rpcUrl),
        gasLimit: CONFIG.estGasUnits.toString(),
        signingMode: "local_private_key",
      };
      emitOperationalLog("broadcast_start", broadcastContext);
      await emitTelemetry({
        event: "broadcast_start",
        timestamp: Math.floor(Date.now() / 1000),
        chainId: executionChainId,
        userAddress: envUser,
        ...broadcastContext,
      });
      try {
        const keeperWrite = new ethers.Contract(CONFIG.keeperAddress, KEEPER_ABI, wallet);
        const data = keeperWrite.interface.encodeFunctionData("executeHarvest", [
          harvestParams.nonce,
          harvestParams.targetPool,
          harvestParams.minLpOut,
          harvestParams.amountToSwap,
          harvestParams.deadline,
          harvestParams.routes,
        ]);
        tx = await wallet.sendTransaction({
          to: CONFIG.keeperAddress,
          data: data + BUILDER_CODE_SUFFIX.replace(/^0x/, ""),
          gasLimit: CONFIG.estGasUnits,
        });
        if (false) tx = await keeperWrite.executeHarvest(
          harvestParams.nonce,
          harvestParams.targetPool,
          harvestParams.minLpOut,
          harvestParams.amountToSwap,
          harvestParams.deadline,
          harvestParams.routes,
          { gasLimit: CONFIG.estGasUnits }
        );
      } catch (error: any) {
        const sanitizedError = sanitizeBroadcastError(error);
        emitOperationalLog("broadcast_error", {
          ...broadcastContext,
          ...sanitizedError,
        }, "error");
        await emitTelemetry({
          event: "broadcast_error",
          timestamp: Math.floor(Date.now() / 1000),
          chainId: executionChainId,
          userAddress: envUser,
          ...broadcastContext,
          ...sanitizedError,
        });
        throw error;
      }
      txHash = tx.hash;
      const submittedAtSec = Math.floor(Date.now() / 1000);
      emitOperationalLog("broadcast_result", {
        ...broadcastContext,
        txHash,
      });
      await emitTelemetry({
        event: "broadcast_result",
        timestamp: Math.floor(Date.now() / 1000),
        txHash,
        chainId: executionChainId,
        userAddress: envUser,
        ...broadcastContext,
      });
      emitOperationalLog("harvest_submitted", {
        txHash,
        payloadHash: harvestPayloadHash,
        signingMode: "local_private_key",
      });
      await emitTelemetry({
        event: "harvest_submitted",
        timestamp: submittedAtSec,
        txHash,
        payloadHash: harvestPayloadHash,
        signingMode: "local_private_key",
        ...(CONFIG.forceTestHarvest ? { forceTest: true, aprBps, rewardCents } : {}),
      });
      if (!CONFIG.waitForHarvestReceipt) {
        state.lastDecisionReason = "submitted";
        state.lastRunAt = submittedAtSec;
        state.lastExecutionAt = submittedAtSec;
        state.suggestedNextCheckMs = 10 * 60 * 1000;
        await saveState(CONFIG.statePath, state);
        emitOperationalLog("harvest_receipt_wait_skipped", {
          txHash,
          reason: "WAIT_FOR_HARVEST_RECEIPT_not_true",
        });
        await emitTelemetry({
          event: "harvest_receipt_wait_skipped",
          timestamp: Math.floor(Date.now() / 1000),
          txHash,
          reason: "WAIT_FOR_HARVEST_RECEIPT_not_true",
          chainId: executionChainId,
          userAddress: envUser,
        });
        return;
      }
      try {
        receipt = await withTimeout(tx.wait(), HARVEST_RECEIPT_TIMEOUT_MS, "tx.wait");
      } catch (receiptError) {
        state.lastDecisionReason = "submitted_receipt_pending";
        await saveState(CONFIG.statePath, state);
        await emitTelemetry({
          event: "harvest_receipt_wait_failed",
          timestamp: Math.floor(Date.now() / 1000),
          txHash,
          chainId: executionChainId,
          userAddress: envUser,
          ...serialiseError(receiptError),
        });
        return;
      }
    }
  } catch (error) {
    await persistHarvestExecutionFailure(state, nowSec, executionChainId, envUser, error);
    return;
  }

  if (!receipt) {
    state.lastDecisionReason = "submitted_receipt_missing";
    await saveState(CONFIG.statePath, state);
    await emitTelemetry({
      event: "harvest_receipt_missing",
      timestamp: Math.floor(Date.now() / 1000),
      txHash,
      chainId: executionChainId,
      userAddress: envUser,
    });
    return;
  }

  const receiptProof = parseHarvestReceiptProof(receipt);

  state.lastExecutionAt = nowSec;
  state.lastDecisionReason = "executed";
  await saveState(CONFIG.statePath, state);

  emitOperationalLog("harvest_confirmed", {
    txHash,
    profitCreditedUsd: receiptProof.profitCreditedUsd,
    profitCreditedRaw: receiptProof.profitCreditedRaw,
    blockNumber: receiptProof.blockNumber,
  });

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
  emitOperationalLog("runtime_error", serialiseError(error), "error");
  await emitTelemetry({
    event: "runtime_error",
    timestamp: state.lastRunAt,
    chainId: process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined,
    userAddress: process.env.USER_ADDRESS || (globalThis as any).__ENV__?.USER_ADDRESS,
    ...serialiseError(error),
  });
}

async function emitProcessorCycleComplete(
  cycle: number,
  processStartedAtMs: number,
  nextDelayMs: number,
  status: "ok" | "error"
): Promise<void> {
  const state = await loadState(CONFIG.statePath);
  emitOperationalLog("processor_cycle_complete", {
    phase: "cycle_complete",
    status,
    cycle,
    uptimeMs: Date.now() - processStartedAtMs,
    nextDelayMs,
    lastDecisionReason: state.lastDecisionReason,
    apiFailureStreak: state.apiFailureStreak,
  }, status === "error" ? "error" : "info");
  await emitTelemetry({
    event: "processor_cycle_complete",
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

async function start(): Promise<void> {
  const processStartedAtMs = Date.now();
  await emitProcessorBoot(Math.floor(processStartedAtMs / 1000));

  let status: "ok" | "error" = "ok";
  let requestedDelayMs: number | undefined;

  try {
    requestedDelayMs = await runOnce();
  } catch (error) {
    status = "error";
    await persistRuntimeError(error);
    console.error(JSON.stringify({ event: "runtime_error", message: serialiseError(error).message }));
  } finally {
    const state = await loadState(CONFIG.statePath);
    const nextDelayMs = Number.isFinite(requestedDelayMs ?? NaN)
      ? Math.max(15_000, Number(requestedDelayMs))
      : nextSupervisorDelayMs(state);

    await emitProcessorCycleComplete(1, processStartedAtMs, nextDelayMs, status);
    try {
      const flushResult = await flushTelemetry();
      const flushSucceeded = flushResult.status === "sent" || flushResult.status === "skipped_empty";
      emitOperationalLog(
        "telemetry_flush_complete",
        { ...flushResult },
        flushSucceeded ? "info" : "error"
      );
    } catch (flushError) {
      emitOperationalLog("telemetry_flush_complete", {
        status: "exception",
        ...serialiseError(flushError),
      }, "error");
    }

    // Let one-shot Acurast runs terminate naturally after all async work drains.
    // This avoids any platform ambiguity around an explicit process.exit during job finalization.
    console.log(`[TERMINAL] Cycle complete (${status}). Exiting.`);
    if (FINAL_LOG_DRAIN_MS > 0) {
      await sleep(FINAL_LOG_DRAIN_MS);
    }
    process.exitCode = status === "ok" ? 0 : 1;
  }
}

start().catch((error) => {
  console.error(JSON.stringify({ event: "supervisor_fatal_error", message: serialiseError(error).message }));
  process.exit(1);
});
