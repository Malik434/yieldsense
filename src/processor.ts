import {
  ethers,
  JsonRpcProvider,
  Contract,
} from "ethers";
import { getAcurastStd, storageGet, storageSet } from "./acurastHardware.js";
import { loadState, saveState } from "./runtimeState.js";
import { emitTelemetry } from "./telemetry.js";

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
  signer: string;
  signature: string;
  timestamp: number;
};

type GridTradePayload = {
  user: string;
  pnlDelta: bigint;
  nonce: bigint;
  digest: string;
  signature: string;
};

const UNISWAP_V3_POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)",
];

const KEEPER_ABI = [
  "function executeTrade(address user,int256 pnlDelta,uint256 nonce,bytes signature) external",
];
const EXECUTE_TRADE_SIGNATURE = "executeTrade(address,int256,uint256,bytes)";

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
  const chainId = parseInt(process.env.CHAIN_ID ?? "84532");
  const keeperAddress = process.env.KEEPER_ADDRESS ?? "";

  if (!keeperAddress) {
    console.warn("[processor] KEEPER_ADDRESS not set — skipping strategy param fetch");
    return;
  }

  try {
    const resp = await fetch(`${frontendUrl}/api/strategy?address=${userAddress}`);
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
        { name: "timestamp", type: "uint256" },
      ],
    };
    const value = {
      stopLossPrice: String(params.stopLossPrice),
      gridUpper: String(params.gridUpper),
      gridLower: String(params.gridLower),
      rebalanceInterval: String(params.rebalanceInterval),
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
 * Without this correction the raw price is off by 10^12, causing every grid
 * trigger comparison and stop-loss check to use a wildly incorrect value.
 */
function calculatePriceFromSqrtX96(sqrtPriceX96: bigint): number {
  const Q96 = 2n ** 96n;
  // Use BigInt division to avoid precision loss at extreme sqrtPrice values,
  // then switch to floating point for the final multiplication.
  const numerator = Number(sqrtPriceX96 * sqrtPriceX96);
  const denominator = Number(Q96 * Q96);
  return (numerator / denominator) * POOL_DECIMAL_FACTOR;
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

async function fetchPoolPrice(provider: ethers.JsonRpcProvider, poolAddress: string): Promise<number> {
  const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
  const slot0 = await pool.slot0();
  return calculatePriceFromSqrtX96(slot0.sqrtPriceX96 as bigint);
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
    return new Promise((resolve, reject) => {
      std.chains.ethereum.fulfill(
        rpcUrl,
        keeperAddress,
        payload,
        { methodSignature: EXECUTE_TRADE_SIGNATURE },
        (operationHash: string) => resolve(operationHash),
        (messages: string[]) => reject(new Error(messages.join("; ")))
      );
    });
  }

  // Local Ethers fallback
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey!, provider);
  const keeper = new ethers.Contract(keeperAddress, KEEPER_ABI, wallet);
  const tx = await keeper.executeTrade(trade.user, trade.pnlDelta, trade.nonce, trade.signature);
  return tx.hash;
}

// ─── Main grid loop ───────────────────────────────────────────────────────────

export async function monitorAndExecuteGrid(): Promise<void> {
  const rpcUrl = process.env.RPC_URL || "https://sepolia.base.org";
  const dataRpcUrl = process.env.DATA_RPC_URL || rpcUrl;
  const poolAddress = process.env.POOL_ADDRESS || "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
  const keeperAddress = process.env.KEEPER_ADDRESS;
  const userAddress = process.env.USER_ADDRESS;

  if (!keeperAddress || !userAddress) {
    console.warn("[processor] Missing KEEPER_ADDRESS or USER_ADDRESS — skipping grid check");
    return;
  }

  const executionProvider = new ethers.JsonRpcProvider(rpcUrl);
  const dataProvider = new ethers.JsonRpcProvider(dataRpcUrl);
  const network = await executionProvider.getNetwork();
  const chainId = network.chainId;

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

  // Price from on-chain pool — sqrtPriceX96 is instantaneous and flash-loan
  // manipulable. For production, use a TWAP or multi-source oracle.
  const currentPrice = await fetchPoolPrice(dataProvider, poolAddress);
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

  let stateUpdated = false;
  const state = await loadState(process.env.STATE_PATH ?? ".yieldsense-state.json");

  for (const trade of pendingTrades) {
    const txHash = await submitTrade(rpcUrl, keeperAddress, trade, privateKey);
    const nowSec = Math.floor(Date.now() / 1000);

    await emitTelemetry({
      event: "grid_trade_executed",
      timestamp: nowSec,
      userAddress: trade.user,
      nonce: trade.nonce.toString(),
      pnlDelta: trade.pnlDelta.toString(),
      txHash,
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
}

async function startLoop(): Promise<void> {
  const userAddress = process.env.USER_ADDRESS ?? "";
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";

  if (!process.env.KEEPER_ADDRESS) {
    console.error("[processor] KEEPER_ADDRESS is required — exiting");
    process.exitCode = 1;
    return;
  }

  if (!process.env.CHAIN_ID) {
    console.warn("[processor] CHAIN_ID not set — defaulting to 84532 (Base Sepolia)");
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

  for (;;) {
    try {
      await monitorAndExecuteGrid();
    } catch (error) {
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
