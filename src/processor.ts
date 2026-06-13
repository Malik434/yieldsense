import "./env.js";
import {
  ethers,
  JsonRpcProvider,
  Contract,
} from "ethers";
import { getAcurastStd, storageGet, storageSet, BUILDER_CODE_SUFFIX } from "./acurastHardware.js";
import { loadState, saveState } from "./runtimeState.js";
import { emitTelemetry } from "./telemetry.js";
import { createJsonRpcProvider } from "./rpcProvider.js";
import {
  assertFreshChainState,
  buildExecutionIdempotencyKey,
  classifyReceiptStatus,
  deriveIntervalWindow,
  type ChainStateSnapshot,
  type GridSide,
} from "./gridExecutionSafety.js";

interface HardwareLog {
  timestamp: number;
  type: 'ATTESTATION' | 'EXECUTION' | 'STORAGE_SYNC';
  message: string;
  txHash?: string;
}

type GridLevel = {
  id: string;
  referencePrice: number;
  triggerPercent: number;
  allocationBps: number;
  stopLossPercent?: number;
};

type StopLossRule = {
  user: string;
  stopLossPrice: number;
};

type UserStrategyParams = {
  stopLossPrice: number;
  gridUpper: number;
  gridLower: number;
  rebalanceInterval: number;
  maxSlippage: number;
  autoReinvest: boolean;
  signer: string;
  signature: string;
  timestamp: number;
  chainId?: number;
};

type GridTradePayload = {
  user: string;
  pnlDelta: bigint;
  nonce: bigint;
  digest: string;
  signature: string;
};

type LiveGridStrategyConfig = {
  strategyId: string;
  pairId: string;
  poolAddress?: string;
  dexRouter: string;
  factory: string;
  stable?: boolean;
  lowerPrice: number;
  upperPrice: number;
  gridMode?: "arithmetic" | "geometric";
  gridCount: number;
  tradeSizeQuote: string;
  triggerPrice?: number | null;
  stopLossPrice?: number | null;
  takeProfitPrice?: number | null;
  maxSlippageBps: number;
  executionIntervalSec: number;
  quoteDecimals?: number;
  baseDecimals?: number;
};

type ProcessorStage =
  | "start"
  | "network_ready"
  | "strategy_loaded"
  | "no_active_grid_levels"
  | "pool_price_observed"
  | "trade_evaluation_complete"
  | "trade_submit_start"
  | "complete";

const UNISWAP_V3_POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)",
];

const KEEPER_ABI = [
  "function executeTrade(address user,int256 pnlDelta,uint256 nonce,bytes signature) external",
];
const EXECUTE_TRADE_SIGNATURE = "executeTrade(address,int256,uint256,bytes)";

const GRID_STRATEGY_MANAGER_ABI = [
  "function getStrategy(bytes32 strategyId) view returns (tuple(bytes32 id,address owner,bytes32 pairId,address baseToken,address quoteToken,uint256 allocatedQuote,uint256 quoteBalance,uint256 baseBalance,uint256 avgEntryPrice,int256 realizedPnlQuote,uint256 feesPaidQuote,uint256 gasReserveQuote,uint256 gasSpentQuote,uint256 maxGasCostQuotePerTrade,uint64 lastExecutionAt,int32 currentGridLevel,uint32 strategyVersion,bytes32 encryptedPayloadHash,uint8 status,uint64 createdAt,uint64 updatedAt))",
  "function getChainStateSnapshot(bytes32 strategyId) view returns (tuple(uint32 strategyVersion,int32 currentGridLevel,uint64 lastExecutionAt,uint256 quoteBalance,uint256 baseBalance))",
];

const GRID_EXECUTION_ROUTER_ABI = [
  "function executeAerodromeBuy(bytes32 strategyId,bytes32 pairId,bytes32 executionId,address dexRouter,tuple(uint32 strategyVersion,int32 currentGridLevel,uint64 lastExecutionAt,uint256 quoteBalance,uint256 baseBalance) snapshot,uint256 quoteAmount,uint256 minBaseOut,uint256 avgEntryPrice,uint256 dexFeeQuote,uint256 gasCostQuote,int32 nextGridLevel,uint256 deadline,tuple(address from,address to,bool stable,address factory)[] routes) external",
  "function executeAerodromeSell(bytes32 strategyId,bytes32 pairId,bytes32 executionId,address dexRouter,tuple(uint32 strategyVersion,int32 currentGridLevel,uint64 lastExecutionAt,uint256 quoteBalance,uint256 baseBalance) snapshot,uint256 baseAmount,uint256 minQuoteOut,int256 realizedPnlQuote,uint256 dexFeeQuote,uint256 gasCostQuote,int32 nextGridLevel,uint256 deadline,tuple(address from,address to,bool stable,address factory)[] routes) external",
  "function markExecutionReverted(bytes32 strategyId,bytes32 executionId,string reason) external",
  "function markStrategyGasPaused(bytes32 strategyId) external",
];

const EXECUTOR_REGISTRY_ABI = [
  "function GRID_EXECUTOR() view returns (bytes32)",
  "function isAuthorized(address processor, bytes32 role) view returns (bool)",
];

const POLL_INTERVAL_MS = 60_000;
const BPS_DENOMINATOR = 10_000;

/**
 * Decimal correction factor for WETH (18 dec) / USDC (6 dec) Uniswap V3 pools.
 * sqrtPriceX96 encodes the ratio of raw token amounts. To get the human-readable
 * USD price of WETH we must multiply the raw ratio^2 by 10^(18-6) = 10^12.
 *
 * For other pool pairs, set POOL_DECIMAL_FACTOR in the environment:
 *   WETH/USDC  → 1e12  (default)
 *   WBTC/USDC  → 1e2   (WBTC=8 dec, USDC=6 dec → 10^(8-6))
 */
const POOL_DECIMAL_FACTOR = parseFloat(process.env.POOL_DECIMAL_FACTOR ?? "1e12");

function parseJsonEnv<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  // Try direct JSON parse first (raw JSON value)
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Fall through: try base64-decode (used when SCALE-encoding raw JSON special chars)
  }
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(decoded) as T;
  } catch {
    console.warn(`[processor] Failed to parse env var ${name} as JSON or base64 JSON — using fallback`);
    return fallback;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getGridProcessorDeploymentId(): string | undefined {
  return process.env.ACURAST_DEPLOYMENT_ID || (globalThis as any).__ENV__?.ACURAST_DEPLOYMENT_ID;
}

function getGridProcessorLeaseEpoch(): number | undefined {
  const raw = process.env.GRID_PROCESSOR_LEASE_EPOCH || (globalThis as any).__ENV__?.GRID_PROCESSOR_LEASE_EPOCH;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function reportGridProcessorIdentity(processorAddress: string): Promise<void> {
  await emitTelemetry(
    {
      event: "grid_processor_identity",
      timestamp: nowSeconds(),
      processorAddress,
      deploymentId: getGridProcessorDeploymentId(),
      leaseEpoch: getGridProcessorLeaseEpoch(),
      healthy: true,
    },
    true
  );
}

async function isCurrentGridProcessorAuthorized(
  provider: ethers.JsonRpcApiProvider,
  processorAddress: string
): Promise<boolean> {
  const registryAddress = process.env.EXECUTOR_REGISTRY_ADDRESS || process.env.NEXT_PUBLIC_EXECUTOR_REGISTRY_ADDRESS;
  if (!registryAddress) return true;

  const registry = new ethers.Contract(registryAddress, EXECUTOR_REGISTRY_ABI, provider);
  const role = await registry.GRID_EXECUTOR();
  return Boolean(await registry.isAuthorized(processorAddress, role));
}

function serialiseError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack?.split("\n").slice(0, 6).join("\n"),
    };
  }
  return { message: String(error) };
}

async function emitProcessorStage(
  stage: ProcessorStage,
  userAddress: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  await emitTelemetry({
    event: "processor_stage",
    timestamp: nowSeconds(),
    stage,
    userAddress,
    ...details,
  });
}

function decodeStopLossRules(): StopLossRule[] {
  const encryptedBlob = process.env.STOP_LOSS_SECRET_JSON;
  if (encryptedBlob) {
    // In production the TEE runtime decrypts this before process start.
    try {
      return JSON.parse(encryptedBlob) as StopLossRule[];
    } catch {
      return [];
    }
  }

  const signedPayload = process.env.STOP_LOSS_SIGNED_PAYLOAD;
  if (!signedPayload) return [];

  const parsed = JSON.parse(signedPayload) as { rules: StopLossRule[]; signature: string; signer: string };
  const digest = ethers.hashMessage(JSON.stringify(parsed.rules));
  const recovered = ethers.recoverAddress(digest, parsed.signature);
  if (recovered.toLowerCase() !== parsed.signer.toLowerCase()) {
    throw new Error("STOP_LOSS_SIGNED_PAYLOAD verification failed");
  }
  return parsed.rules;
}

// ─── Monotonic nonce counter ──────────────────────────────────────────────────
//
// Nonces must be unique per (user, contract) pair and never reused. The contract
// uses a bitmap so any uint256 value works as long as it isn't repeated.
//
// TEE path:  counter is persisted in _STD_.storage across job restarts.
// Local path: module-scoped counter (valid for the lifetime of the process).

let _localNonceCounter = 0;

function getAndIncrementNonce(userAddress: string): bigint {
  const std = getAcurastStd();
  if (std) {
    const key = `nonce:${userAddress.toLowerCase()}`;
    const current = storageGet<number>(std, key, 0);
    storageSet(std, key, current + 1);
    return BigInt(current);
  }
  // Local fallback: simple monotonic counter, safe for single-process dev
  return BigInt(_localNonceCounter++);
}

// ─── Strategy params ──────────────────────────────────────────────────────────

async function fetchAndStoreStrategyParams(userAddress: string, frontendUrl: string): Promise<void> {
  const std = getAcurastStd();
  const chainId = parseInt(process.env.CHAIN_ID ?? "8453");
  const keeperAddress = process.env.KEEPER_ADDRESS ?? "";

  if (!keeperAddress) {
    console.warn("[processor] KEEPER_ADDRESS not set — skipping strategy param fetch");
    return;
  }

  try {
    const resp = await fetch(`${frontendUrl}/api/strategy?address=${userAddress}&chainId=${chainId}`);
    if (!resp.ok) return;

    const params = (await resp.json()) as UserStrategyParams;
    if (!params?.signer || !params?.signature) return;

    const domain = {
      name: "YieldSense",
      version: "1",
      chainId,
      verifyingContract: keeperAddress as `0x${string}`,
    };
    const types = {
      StrategyParams: [
        { name: "stopLossPrice", type: "string" },
        { name: "gridUpper", type: "string" },
        { name: "gridLower", type: "string" },
        { name: "rebalanceInterval", type: "string" },
        { name: "maxSlippage", type: "string" },
        { name: "autoReinvest", type: "bool" },
        { name: "timestamp", type: "uint256" },
      ],
    };
    const value = {
      stopLossPrice: String(params.stopLossPrice),
      gridUpper: String(params.gridUpper),
      gridLower: String(params.gridLower),
      rebalanceInterval: String(params.rebalanceInterval),
      maxSlippage: String(params.maxSlippage),
      autoReinvest: Boolean(params.autoReinvest),
      timestamp: params.timestamp,
    };

    const recoveredSigner = ethers.verifyTypedData(domain, types, value, params.signature);
    if (recoveredSigner.toLowerCase() !== params.signer.toLowerCase()) {
      console.error(JSON.stringify({
        event: "strategy_params_invalid_signature",
        expected: params.signer,
        got: recoveredSigner,
      }));
      return;
    }

    if (std) {
      storageSet(std, `strategy:${userAddress.toLowerCase()}`, params);
      console.log(JSON.stringify({
        event: "strategy_params_stored",
        user: userAddress.substring(0, 8) + "...",
      }));

      let state = await loadState(process.env.STATE_PATH ?? ".yieldsense-state.json");
      if (!state.hardwareLogs) state.hardwareLogs = [];
      state.hardwareLogs.push({
        timestamp: Date.now(),
        type: 'STORAGE_SYNC',
        message: `_STD_.storage synced for ${userAddress.substring(0, 6)}...`,
      });
      if (state.hardwareLogs.length > 10) state.hardwareLogs.shift();
      await saveState(process.env.STATE_PATH ?? ".yieldsense-state.json", state);
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "strategy_params_fetch_error", message: String(err) }));
  }
}

function loadStrategyParams(userAddress: string): UserStrategyParams | null {
  const std = getAcurastStd();
  if (!std) return null;
  return storageGet<UserStrategyParams | null>(std, `strategy:${userAddress.toLowerCase()}`, null);
}

// ─── Price calculation ────────────────────────────────────────────────────────

/**
 * Converts Uniswap V3 sqrtPriceX96 to a human-readable token price.
 *
 * Formula: price = (sqrtPriceX96 / 2^96)^2 × POOL_DECIMAL_FACTOR
 *
 * The POOL_DECIMAL_FACTOR corrects for token decimal differences.
 * For WETH (18 dec) / USDC (6 dec): factor = 10^(18-6) = 10^12.
 *
 * Precision note: sqrtPriceX96^2 is a ~320-bit integer. Converting it
 * directly to Number before dividing silently truncates to 53-bit float
 * precision, introducing significant rounding error at high price values.
 * We maintain BigInt arithmetic through the division by scaling the result
 * by a large integer factor first, then convert only at the final step.
 */
function calculatePriceFromSqrtX96(sqrtPriceX96: bigint): number {
  const Q96 = 2n ** 96n;
  // Scale factor keeps 18 decimal places of precision in the integer domain
  // before we convert to float for the final POOL_DECIMAL_FACTOR multiply.
  const PRECISION = 10n ** 18n;
  const scaled = (sqrtPriceX96 * sqrtPriceX96 * PRECISION) / (Q96 * Q96);
  return (Number(scaled) / Number(PRECISION)) * POOL_DECIMAL_FACTOR;
}

function variationPercent(referencePrice: number, currentPrice: number): number {
  if (referencePrice <= 0) return 0;
  return Math.abs((currentPrice - referencePrice) / referencePrice) * 100;
}

function shouldTrigger(grid: GridLevel, currentPrice: number): boolean {
  const deltaPercent = variationPercent(grid.referencePrice, currentPrice);
  if (deltaPercent >= grid.triggerPercent) return true;

  if (grid.stopLossPercent != null) {
    const stopLossPrice = grid.referencePrice * (1 - grid.stopLossPercent / 100);
    if (currentPrice <= stopLossPrice) return true;
  }
  return false;
}

// ─── Trade payload construction ───────────────────────────────────────────────

function buildTradeDigest(
  chainId: bigint,
  keeperAddress: string,
  user: string,
  pnlDelta: bigint,
  nonce: bigint
): string {
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "address", "int256", "uint256"],
    [chainId, keeperAddress, user, pnlDelta, nonce]
  );
}

/**
 * Signs a trade digest using the TEE hardware key or a local private key fallback.
 *
 * Signing flow:
 *  1. `digest` = solidityPackedKeccak256(chainId, keeper, user, pnlDelta, nonce)
 *  2. `ethDigest` = keccak256("\x19Ethereum Signed Message:\n32" || digest)
 *     This matches MessageHashUtils.toEthSignedMessageHash(digest) in Solidity.
 *  3. The TEE/wallet signs `ethDigest` as a raw 32-byte hash (no further prefix).
 *
 * The contract recovers: ECDSA.recover(toEthSignedMessageHash(digest), sig)
 * which is equivalent to: recover(ethDigest, sig). Both sides agree. ✓
 */
function signTradeDigest(digest: string, privateKey?: string): string {
  const std = getAcurastStd();

  if (!std && !privateKey) {
    throw new Error(
      "No signer available: Acurast _STD_ unavailable and ACURAST_WORKER_KEY not set."
    );
  }

  // ethDigest = keccak256("\x19Ethereum Signed Message:\n32" || digest)
  const ethDigest = ethers.hashMessage(ethers.getBytes(digest));

  if (std) {
    // std.signers.secp256k1.sign expects the raw 32-byte hash WITHOUT prefix.
    // We pass ethDigest (already includes the "\x19..." prefix) as the raw hash.
    const rawSig = std.signers.secp256k1.sign(ethDigest.replace(/^0x/, ""));
    return rawSig.startsWith("0x") ? rawSig : `0x${rawSig}`;
  }

  // Local fallback: wallet.signingKey.sign signs the raw hash without adding prefix
  const wallet = new ethers.Wallet(privateKey!);
  return wallet.signingKey.sign(ethDigest).serialized;
}

async function fetchPoolPrice(provider: ethers.JsonRpcApiProvider, poolAddress: string): Promise<number> {
  try {
    const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
    const slot0 = await pool.slot0();
    return calculatePriceFromSqrtX96(slot0.sqrtPriceX96 as bigint);
  } catch (err: any) {
    if (err.code === "CALL_EXCEPTION") {
      try {
        const v2Abi = [
          "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
        ];
        const v2Pool = new ethers.Contract(poolAddress, v2Abi, provider);
        const [r0, r1] = await v2Pool.getReserves();
        if (r0 === 0n || r1 === 0n) return 0;
        const precision = 10n ** 18n;
        const scaled = (r0 * precision) / r1;
        return (Number(scaled) / Number(precision)) * POOL_DECIMAL_FACTOR;
      } catch (innerErr) {}
    }
    throw err;
  }
}

function createTradePayload(
  chainId: bigint,
  keeperAddress: string,
  user: string,
  referencePrice: number,
  allocationBps: number,
  currentPrice: number,
  userAddress: string,
  privateKey?: string
): GridTradePayload {
  const allocation = BigInt(Math.round((allocationBps / BPS_DENOMINATOR) * 1_000_000));
  const pnlDelta = currentPrice >= referencePrice ? allocation : -allocation;
  const nonce = getAndIncrementNonce(userAddress);
  const digest = buildTradeDigest(chainId, keeperAddress, user, pnlDelta, nonce);
  const signature = signTradeDigest(digest, privateKey);
  return { user, pnlDelta, nonce, digest, signature };
}

function encodeExecuteTradePayload(trade: GridTradePayload): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "int256", "uint256", "bytes"],
    [trade.user, trade.pnlDelta, trade.nonce, trade.signature]
  );
}

async function submitTrade(
  rpcUrl: string,
  keeperAddress: string,
  trade: GridTradePayload,
  privateKey?: string
): Promise<string> {
  const std = getAcurastStd();

  if (std) {
    const payload = encodeExecuteTradePayload(trade);
    const payloadWithSuffix = payload + BUILDER_CODE_SUFFIX.replace(/^0x/, "");
    return new Promise((resolve, reject) => {
      std.chains.ethereum.fulfill(
        rpcUrl,
        keeperAddress,
        payloadWithSuffix,
        { methodSignature: EXECUTE_TRADE_SIGNATURE },
        (operationHash: string) => resolve(operationHash),
        (messages: string[]) => reject(new Error(messages.join("; ")))
      );
    });
  }

  // Local Ethers fallback
  const provider = createJsonRpcProvider(rpcUrl, Number(process.env.CHAIN_ID ?? 8453));
  const wallet = new ethers.Wallet(privateKey!, provider);
  const keeper = new ethers.Contract(keeperAddress, KEEPER_ABI, wallet);
  const data = keeper.interface.encodeFunctionData("executeTrade", [
    trade.user,
    trade.pnlDelta,
    trade.nonce,
    trade.signature
  ]);
  const dataWithSuffix = data + BUILDER_CODE_SUFFIX.replace(/^0x/, "");
  const tx = await wallet.sendTransaction({
    to: keeperAddress,
    data: dataWithSuffix,
  });
  return tx.hash;
}

function toSnapshotTuple(snapshot: any): [number, number, number, bigint, bigint] {
  return [
    Number(snapshot.strategyVersion),
    Number(snapshot.currentGridLevel),
    Number(snapshot.lastExecutionAt),
    BigInt(snapshot.quoteBalance),
    BigInt(snapshot.baseBalance),
  ];
}

function toChainStateSnapshot(snapshot: any): ChainStateSnapshot {
  return {
    strategyVersion: Number(snapshot.strategyVersion),
    currentGridLevel: Number(snapshot.currentGridLevel),
    lastExecutionAt: String(snapshot.lastExecutionAt),
    quoteBalance: String(snapshot.quoteBalance),
    baseBalance: String(snapshot.baseBalance),
  };
}

function calculateGridLevel(config: LiveGridStrategyConfig, price: number): number {
  if (config.gridCount <= 0 || config.upperPrice <= config.lowerPrice) return 0;
  if (price <= config.lowerPrice) return 0;
  if (price >= config.upperPrice) return config.gridCount;

  if (config.gridMode === "geometric") {
    const ratio = config.upperPrice / config.lowerPrice;
    if (ratio <= 1) return 0;
    const level = Math.floor((Math.log(price / config.lowerPrice) / Math.log(ratio)) * config.gridCount);
    return Math.max(0, Math.min(config.gridCount, level));
  }

  const spacing = (config.upperPrice - config.lowerPrice) / config.gridCount;
  return Math.max(0, Math.min(config.gridCount, Math.floor((price - config.lowerPrice) / spacing)));
}

function shouldEvaluateLiveGrid(config: LiveGridStrategyConfig, price: number): boolean {
  if (config.triggerPrice && config.triggerPrice > 0 && price < config.triggerPrice) return false;
  if (config.stopLossPrice && config.stopLossPrice > 0 && price <= config.stopLossPrice) return false;
  if (config.takeProfitPrice && config.takeProfitPrice > 0 && price >= config.takeProfitPrice) return false;
  return true;
}

function buildSingleAerodromeRoute(from: string, to: string, config: LiveGridStrategyConfig) {
  return [{ from, to, stable: Boolean(config.stable), factory: config.factory }];
}

function minOutForSlippage(amount: bigint, maxSlippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(maxSlippageBps))));
  return (amount * (10_000n - bps)) / 10_000n;
}

async function postQueueJob(frontendUrl: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${frontendUrl}/api/grid/execution-queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`queue POST failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function patchQueueJob(frontendUrl: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${frontendUrl}/api/grid/execution-queue`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`queue PATCH failed: ${res.status} ${await res.text()}`);
}

async function loadLiveGridStrategies(frontendUrl: string): Promise<LiveGridStrategyConfig[]> {
  const configured = parseJsonEnv<LiveGridStrategyConfig[]>("GRID_LIVE_STRATEGIES_JSON", []);
  if (configured.length > 0) return configured;

  const chainId = Number(process.env.CHAIN_ID ?? 8453);
  const res = await fetch(`${frontendUrl}/api/grid/strategies?status=active&chainId=${chainId}&mode=processor`);
  if (!res.ok) throw new Error(`strategy discovery failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return Array.isArray(body.strategies) ? body.strategies : [];
}

async function submitLiveGridExecution(args: {
  rpcUrl: string;
  routerAddress: string;
  manager: Contract;
  config: LiveGridStrategyConfig;
  side: GridSide;
  executionId: string;
  snapshot: any;
  currentPrice: number;
  nextGridLevel: number;
  privateKey?: string;
}): Promise<{ txHash: string; status: "confirmed" | "reverted" | "submitted"; gasUsed?: string }> {
  const strategy = await args.manager.getStrategy(args.config.strategyId);
  const quoteDecimals = args.config.quoteDecimals ?? 6;
  const baseDecimals = args.config.baseDecimals ?? 18;
  const deadline = Math.floor(Date.now() / 1000) + 90;
  const gasCostQuote = BigInt(process.env.GRID_GAS_COST_QUOTE ?? "0");
  const dexFeeQuote = BigInt(process.env.GRID_DEX_FEE_QUOTE ?? "0");
  const iface = new ethers.Interface(GRID_EXECUTION_ROUTER_ABI);
  const std = getAcurastStd();

  let data: string;
  let methodSignature: string;
  if (args.side === "buy") {
    const quoteAmount = ethers.parseUnits(args.config.tradeSizeQuote, quoteDecimals);
    const expectedBase = args.currentPrice > 0
      ? ethers.parseUnits((Number(args.config.tradeSizeQuote) / args.currentPrice).toFixed(Math.min(baseDecimals, 12)), baseDecimals)
      : 0n;
    const minBaseOut = minOutForSlippage(expectedBase, args.config.maxSlippageBps);
    const avgEntryPrice = ethers.parseUnits(args.currentPrice.toFixed(Math.min(quoteDecimals, 6)), quoteDecimals);
    methodSignature = "executeAerodromeBuy(bytes32,bytes32,bytes32,address,(uint32,int32,uint64,uint256,uint256),uint256,uint256,uint256,uint256,uint256,int32,uint256,(address,address,bool,address)[])";
    data = iface.encodeFunctionData("executeAerodromeBuy", [
      args.config.strategyId,
      args.config.pairId,
      args.executionId,
      args.config.dexRouter,
      toSnapshotTuple(args.snapshot),
      quoteAmount,
      minBaseOut,
      avgEntryPrice,
      dexFeeQuote,
      gasCostQuote,
      args.nextGridLevel,
      deadline,
      buildSingleAerodromeRoute(strategy.quoteToken, strategy.baseToken, args.config),
    ]);
  } else {
    const baseAmount = ethers.parseUnits(
      (Number(args.config.tradeSizeQuote) / Math.max(args.currentPrice, 0.0000001)).toFixed(Math.min(baseDecimals, 12)),
      baseDecimals
    );
    const expectedQuote = ethers.parseUnits(args.config.tradeSizeQuote, quoteDecimals);
    const minQuoteOut = minOutForSlippage(expectedQuote, args.config.maxSlippageBps);
    const realizedPnlQuote = BigInt(process.env.GRID_REALIZED_PNL_QUOTE ?? "0");
    methodSignature = "executeAerodromeSell(bytes32,bytes32,bytes32,address,(uint32,int32,uint64,uint256,uint256),uint256,uint256,int256,uint256,uint256,int32,uint256,(address,address,bool,address)[])";
    data = iface.encodeFunctionData("executeAerodromeSell", [
      args.config.strategyId,
      args.config.pairId,
      args.executionId,
      args.config.dexRouter,
      toSnapshotTuple(args.snapshot),
      baseAmount,
      minQuoteOut,
      realizedPnlQuote,
      dexFeeQuote,
      gasCostQuote,
      args.nextGridLevel,
      deadline,
      buildSingleAerodromeRoute(strategy.baseToken, strategy.quoteToken, args.config),
    ]);
  }

  const dataWithSuffix = data + BUILDER_CODE_SUFFIX.replace(/^0x/, "");
  if (std) {
    const operationHash = await new Promise<string>((resolve, reject) => {
      std.chains.ethereum.fulfill(
        args.rpcUrl,
        args.routerAddress,
        dataWithSuffix,
        { methodSignature },
        (hash: string) => resolve(hash),
        (messages: string[]) => reject(new Error(messages.join("; ")))
      );
    });
    return { txHash: operationHash, status: "submitted" };
  }

  if (!args.privateKey) throw new Error("ACURAST_WORKER_KEY is required for local live grid execution");
  const provider = createJsonRpcProvider(args.rpcUrl, Number(process.env.CHAIN_ID ?? 8453));
  const wallet = new ethers.Wallet(args.privateKey, provider);
  const tx = await wallet.sendTransaction({ to: args.routerAddress, data: dataWithSuffix });
  const receipt = await tx.wait();
  return {
    txHash: tx.hash,
    status: classifyReceiptStatus({ status: receipt?.status }),
    gasUsed: receipt?.gasUsed?.toString(),
  };
}

async function monitorAndExecuteLiveGrid(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? "https://mainnet.base.org";
  const dataRpcUrl = process.env.DATA_RPC_URL ?? rpcUrl;
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
  const managerAddress = process.env.GRID_STRATEGY_MANAGER_ADDRESS ?? "";
  const routerAddress = process.env.GRID_EXECUTION_ROUTER_ADDRESS ?? "";
  const strategies = await loadLiveGridStrategies(frontendUrl);
  const privateKey = process.env.ACURAST_WORKER_KEY;
  const acurastStd = getAcurastStd();
  const processorAddress = acurastStd
    ? ethers.getAddress(acurastStd.chains.ethereum.getAddress())
    : privateKey
      ? new ethers.Wallet(privateKey).address
      : "";

  if (processorAddress) {
    await reportGridProcessorIdentity(processorAddress);
  }

  if (!managerAddress || !routerAddress || strategies.length === 0) {
    await emitTelemetry({
      event: "grid_live_check_skipped",
      timestamp: nowSeconds(),
      reason: !managerAddress || !routerAddress ? "missing_grid_contract_addresses" : "no_active_grid_strategies",
    });
    return;
  }

  const provider = createJsonRpcProvider(rpcUrl, Number(process.env.CHAIN_ID ?? 8453));
  const dataProvider = createJsonRpcProvider(dataRpcUrl, Number(process.env.CHAIN_ID ?? 8453));
  const manager = new ethers.Contract(managerAddress, GRID_STRATEGY_MANAGER_ABI, provider);

  if (processorAddress) {
    const authorized = await isCurrentGridProcessorAuthorized(provider, processorAddress);
    if (!authorized) {
      await emitTelemetry({
        event: "grid_live_check_skipped",
        timestamp: nowSeconds(),
        reason: "processor_not_authorized",
        processorAddress,
      });
      return;
    }
  }

  for (const config of strategies) {
    const strategy = await manager.getStrategy(config.strategyId);
    if (Number(strategy.status) !== 2) continue;

    const poolAddress = config.poolAddress ?? process.env.GRID_POOL_ADDRESS ?? process.env.POOL_ADDRESS ?? "";
    if (!poolAddress) continue;

    const snapshot = await manager.getChainStateSnapshot(config.strategyId);
    const currentPrice = await fetchPoolPrice(dataProvider, poolAddress);
    if (!shouldEvaluateLiveGrid(config, currentPrice)) continue;
    const nextGridLevel = calculateGridLevel(config, currentPrice);
    const currentGridLevel = Number(snapshot.currentGridLevel);
    if (nextGridLevel === currentGridLevel) continue;

    const side: GridSide = nextGridLevel < currentGridLevel ? "buy" : "sell";
    const intervalWindow = deriveIntervalWindow(Date.now(), config.executionIntervalSec);
    const idempotencyKey = buildExecutionIdempotencyKey({
      strategyId: config.strategyId,
      strategyVersion: Number(snapshot.strategyVersion),
      pairId: config.pairId,
      gridLevel: nextGridLevel,
      side,
      intervalWindow,
    });
    const executionId = ethers.keccak256(ethers.toUtf8Bytes(idempotencyKey));

    const queue = await postQueueJob(frontendUrl, {
      strategyId: config.strategyId,
      pairId: config.pairId,
      side,
      gridLevel: nextGridLevel,
      idempotencyKey,
      chainStateSnapshot: toChainStateSnapshot(snapshot),
    });
    const job = queue.job;
    if (!job || queue.duplicate) continue;
    await patchQueueJob(frontendUrl, { id: job.id, status: "claimed" });

    try {
      const freshSnapshot = await manager.getChainStateSnapshot(config.strategyId);
      assertFreshChainState(toChainStateSnapshot(snapshot), toChainStateSnapshot(freshSnapshot));
      await patchQueueJob(frontendUrl, { id: job.id, status: "submitted" });
      const result = await submitLiveGridExecution({
        rpcUrl,
        routerAddress,
        manager,
        config,
        side,
        executionId,
        snapshot: freshSnapshot,
        currentPrice,
        nextGridLevel,
        privateKey,
      });
      await patchQueueJob(frontendUrl, { id: job.id, status: result.status, txHash: result.txHash, gasUsed: result.gasUsed });
      await emitTelemetry({
        event: "grid_live_trade_executed",
        timestamp: nowSeconds(),
        strategyId: config.strategyId,
        side,
        gridLevel: nextGridLevel,
        currentPrice,
        txHash: result.txHash,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stale = message.includes("Stale grid execution job");
      await patchQueueJob(frontendUrl, {
        id: job.id,
        status: stale ? "stale" : "failed",
        staleReason: stale ? message : undefined,
        error: stale ? undefined : message,
      });
      await emitTelemetry({
        event: stale ? "grid_live_trade_stale" : "grid_live_trade_failed",
        timestamp: nowSeconds(),
        strategyId: config.strategyId,
        message,
      });
    }
  }
}

// ─── Main grid loop ───────────────────────────────────────────────────────────

export async function monitorAndExecuteGrid(): Promise<void> {
  if (process.env.ENABLE_LIVE_GRID_EXECUTOR === "true") {
    await monitorAndExecuteLiveGrid();
    return;
  }

  const getEnv = (name: string, fallback: string): string => {
    const baked = (globalThis as any).__ENV__?.[name];
    const env = process.env[name];
    return (baked ?? env ?? fallback).trim();
  };

  const rpcUrl = getEnv("RPC_URL", "https://mainnet.base.org");
  const dataRpcUrl = getEnv("DATA_RPC_URL", rpcUrl);
  const poolAddress = getEnv(
    "GRID_POOL_ADDRESS",
    getEnv("POOL_ADDRESS", "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d")
  );
  const keeperAddress = getEnv("KEEPER_ADDRESS", "0xEb7cac0570236D6A36DF7BcCF275Cb6681f84792");
  const userAddress = getEnv("USER_ADDRESS", "");

  try {
    await emitProcessorStage("start", userAddress, {
      keeperAddress,
      poolAddress,
      hasRpcUrl: Boolean(rpcUrl),
      hasDataRpcUrl: Boolean(dataRpcUrl),
      hasAcurastStd: Boolean(getAcurastStd()),
      dryRun: process.env.DRY_RUN === "true",
    });

  if (!keeperAddress || !userAddress) {
    await emitProcessorStage("complete", userAddress, {
      status: "skipped",
      reason: "missing_keeper_or_user_address",
    });
    console.warn("[processor] Missing KEEPER_ADDRESS or USER_ADDRESS — skipping grid check");
    return;
  }

  const executionProvider = createJsonRpcProvider(rpcUrl, Number(process.env.CHAIN_ID ?? 8453));
  const dataProvider = createJsonRpcProvider(dataRpcUrl, Number(process.env.YIELD_CHAIN_ID ?? process.env.CHAIN_ID ?? 8453));
  const network = await executionProvider.getNetwork();
  const chainId = network.chainId;

  await emitProcessorStage("network_ready", userAddress, {
    chainId: Number(chainId),
    executionNetwork: network.name,
  });

  const grids = parseJsonEnv<GridLevel[]>("GRID_CONFIG_JSON", []);
  const stopLossRules = decodeStopLossRules();

  const storedParams = loadStrategyParams(userAddress);
  if (storedParams) {
    const existingRule = stopLossRules.find(
      r => r.user.toLowerCase() === userAddress.toLowerCase()
    );
    if (!existingRule && storedParams.stopLossPrice > 0) {
      stopLossRules.push({ user: userAddress, stopLossPrice: storedParams.stopLossPrice });
    }
  }

  const activeGrids = grids.filter((grid) => {
    const stopLoss = stopLossRules.find(
      r => r.user.toLowerCase() === userAddress.toLowerCase()
    );
    if (!stopLoss) return true;
    return grid.referencePrice >= stopLoss.stopLossPrice;
  });

  await emitProcessorStage("strategy_loaded", userAddress, {
    chainId: Number(chainId),
    configuredGridLevels: grids.length,
    activeGridLevels: activeGrids.length,
    stopLossRules: stopLossRules.length,
    hasStoredStrategyParams: Boolean(storedParams),
  });

  // Price from on-chain pool — sqrtPriceX96 is instantaneous and flash-loan
  // manipulable. For production, use a TWAP or multi-source oracle.
  if (activeGrids.length === 0 || !poolAddress) {
    await emitProcessorStage("no_active_grid_levels", userAddress, {
      chainId: Number(chainId),
      reason: !poolAddress ? "missing_pool_address" : "all_levels_filtered_by_stop_loss",
    });
    return;
  }

  const currentPrice = await fetchPoolPrice(dataProvider, poolAddress);
  await emitProcessorStage("pool_price_observed", userAddress, {
    chainId: Number(chainId),
    poolAddress,
    currentPrice,
  });
  const pendingTrades: GridTradePayload[] = [];
  const privateKey = process.env.ACURAST_WORKER_KEY;

  for (const grid of activeGrids) {
    if (!shouldTrigger(grid, currentPrice)) continue;
    pendingTrades.push(
      createTradePayload(
        chainId,
        keeperAddress,
        userAddress,
        grid.referencePrice,
        grid.allocationBps,
        currentPrice,
        userAddress,
        privateKey
      )
    );
  }

  await emitProcessorStage("trade_evaluation_complete", userAddress, {
    chainId: Number(chainId),
    activeGridLevels: activeGrids.length,
    pendingTrades: pendingTrades.length,
  });

  let stateUpdated = false;
  const state = await loadState(process.env.STATE_PATH ?? ".yieldsense-state.json");
  const isDryRun = process.env.DRY_RUN === "true";

  for (const trade of pendingTrades) {
    const nowSec = Math.floor(Date.now() / 1000);

    if (isDryRun) {
      // DRY_RUN: log the would-be trade without submitting. The local ACURAST_WORKER_KEY
      // is not attested in the keeper contract so any real submit would revert.
      await emitTelemetry({
        event: "grid_trade_dry_run",
        timestamp: nowSec,
        userAddress: trade.user,
        nonce: trade.nonce.toString(),
        pnlDelta: trade.pnlDelta.toString(),
        digest: trade.digest,
        chainId: Number(chainId),
        note: "DRY_RUN=true — grid trade not submitted on-chain.",
      });
      continue;
    }

    await emitProcessorStage("trade_submit_start", userAddress, {
      chainId: Number(chainId),
      nonce: trade.nonce.toString(),
      pnlDelta: trade.pnlDelta.toString(),
      signingMode: getAcurastStd() ? "acurast_fulfill" : "local_private_key",
    });

    const txHash = await submitTrade(rpcUrl, keeperAddress, trade, privateKey);

    await emitTelemetry({
      event: "grid_trade_executed",
      timestamp: nowSec,
      userAddress: trade.user,
      nonce: trade.nonce.toString(),
      pnlDelta: trade.pnlDelta.toString(),
      txHash,
      chainId: Number(chainId),
    });

    state.gridTradesExecuted = (state.gridTradesExecuted || 0) + 1;
    state.lastGridTradeAt = nowSec;

    if (!state.hardwareLogs) state.hardwareLogs = [];
    state.hardwareLogs.push({
      timestamp: Date.now(),
      type: 'EXECUTION',
      message: `Grid trade executed for ${trade.user.substring(0, 6)}...`,
      txHash,
    });
    if (state.hardwareLogs.length > 10) state.hardwareLogs.shift();

    stateUpdated = true;
  }

  if (stateUpdated) {
    await saveState(process.env.STATE_PATH ?? ".yieldsense-state.json", state);
  }

  await emitProcessorStage("complete", userAddress, {
    chainId: Number(chainId),
    status: "ok",
    submittedTrades: pendingTrades.length,
  });
  } catch (error) {
    await emitTelemetry({
      event: "processor_error",
      timestamp: nowSeconds(),
      userAddress,
      stage: "monitorAndExecuteGrid",
      ...serialiseError(error),
    });
    throw error;
  }
}

async function startLoop(): Promise<void> {
  const userAddress = process.env.USER_ADDRESS ?? "";
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";

  if (!process.env.KEEPER_ADDRESS && process.env.ENABLE_LIVE_GRID_EXECUTOR !== "true") {
    console.error("[processor] KEEPER_ADDRESS is required — exiting");
    process.exitCode = 1;
    return;
  }

  if (!process.env.CHAIN_ID) {
    console.warn("[processor] CHAIN_ID not set — defaulting to 8453 (Base Mainnet)");
  }

  if (!process.env.PROCESSOR_SHARED_SECRET) {
    console.warn(
      "[processor] PROCESSOR_SHARED_SECRET not set — telemetry writes will be rejected by the production API"
    );
  }

  // On first run, pull the latest signed strategy from the frontend relay
  if (userAddress) {
    await fetchAndStoreStrategyParams(userAddress, frontendUrl);
  }

  for (; ;) {
    try {
      await monitorAndExecuteGrid();
    } catch (error) {
      await emitTelemetry({
        event: "processor_error",
        timestamp: nowSeconds(),
        userAddress,
        stage: "startLoop",
        ...serialiseError(error),
      });
      console.error(
        JSON.stringify({
          event: "processor_error",
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }
    await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// Removed top-level startLoop() execution to prevent duplicate concurrent runs
// when imported by index.ts. The processor is now orchestrated purely by index.ts.
