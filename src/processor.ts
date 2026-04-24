import { ethers } from "ethers";
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

/** Confidential strategy parameters submitted by the user from the frontend. */
type UserStrategyParams = {
  stopLossPrice: number;   // in USDC
  gridUpper: number;       // upper bound
  gridLower: number;       // lower bound
  rebalanceInterval: number; // in hours
  signer: string;          // user wallet address
  signature: string;       // EIP-712 signature from wallet
  timestamp: number;       // Unix ms when signed
};

type GridTradePayload = {
  user: string;
  pnlDelta: bigint;
  nonce: bigint;
  digest: string;
  signature: string;
};

const UNISWAP_V3_POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
];

const KEEPER_ABI = [
  "function executeTrade(address user,int256 pnlDelta,uint256 nonce,bytes signature) external",
];
const EXECUTE_TRADE_SIGNATURE = "executeTrade(address,int256,uint256,bytes)";

const POLL_INTERVAL_MS = 60_000;
const BPS_DENOMINATOR = 10_000;

function parseJsonEnv<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  return JSON.parse(raw) as T;
}

function decodeStopLossRules(): StopLossRule[] {
  const encryptedBlob = process.env.STOP_LOSS_SECRET_JSON;
  if (encryptedBlob) {
    // In production this value is decrypted by the TEE runtime before process start.
    return JSON.parse(encryptedBlob) as StopLossRule[];
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

/**
 * Fetches the user's confidential strategy params from the Next.js API relay,
 * verifies the EIP-712 signature, and stores them in `_STD_.storage`.
 *
 * The frontend signs params with `eth_signTypedData_v4` so the processor can
 * trustlessly verify they came from the vault owner before storing.
 */
async function fetchAndStoreStrategyParams(userAddress: string, frontendUrl: string): Promise<void> {
  const std = getAcurastStd();

  try {
    const resp = await fetch(`${frontendUrl}/api/strategy?address=${userAddress}`);
    if (!resp.ok) return;

    const params = (await resp.json()) as UserStrategyParams;
    if (!params?.signer || !params?.signature) return;

    // Reconstruct the EIP-712 digest and verify the wallet signature
    const domain = {
      name: "YieldSense",
      version: "1",
      chainId: 84532, // Base Sepolia — must match frontend/src/app/api/strategy/route.ts
      verifyingContract: process.env.KEEPER_ADDRESS || "0x596560cD5Ed45ab89044304345855c6b29e7fA6e",
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
      console.error(JSON.stringify({ event: "strategy_params_invalid_signature", expected: params.signer, got: recoveredSigner }));
      return;
    }

    // Signature valid — persist to _STD_.storage
    if (std) {
      storageSet(std, `strategy:${userAddress.toLowerCase()}`, params);
      // stopLossPrice intentionally omitted from log to prevent confidentiality leak
      console.log(JSON.stringify({ event: "strategy_params_stored", user: userAddress.substring(0, 8) + "..." }));
      // Append to hardware logs in state
      let state = await loadState(process.env.STATE_PATH ?? ".yieldsense-state.json");
      if (!state.hardwareLogs) state.hardwareLogs = [];
      state.hardwareLogs.push({
        timestamp: Date.now(),
        type: 'STORAGE_SYNC',
        message: `_STD_.storage synced for ${userAddress.substring(0, 6)}...`
      });
      // Keep only last 10 logs
      if (state.hardwareLogs.length > 10) state.hardwareLogs.shift();
      await saveState(process.env.STATE_PATH ?? ".yieldsense-state.json", state);
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "strategy_params_fetch_error", message: String(err) }));
  }
}

/**
 * Loads strategy params for a user from `_STD_.storage`, falling back to env vars.
 */
function loadStrategyParams(userAddress: string): UserStrategyParams | null {
  const std = getAcurastStd();
  if (!std) return null;
  return storageGet<UserStrategyParams | null>(std, `strategy:${userAddress.toLowerCase()}`, null);
}

function calculatePriceFromSqrtX96(sqrtPriceX96: bigint): number {
  const q96 = BigInt(2) ** BigInt(96);
  const ratio = Number(sqrtPriceX96) / Number(q96);
  return ratio * ratio;
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

function signTradeDigestWithHardware(digest: string): string {
  const std = getAcurastStd();
  if (!std) {
    throw new Error("Acurast _STD_ hardware signer unavailable");
  }

  const rawSig = std.signers.secp256k1.sign(digest.replace("0x", ""));
  return rawSig.startsWith("0x") ? rawSig : `0x${rawSig}`;
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
  currentPrice: number
): GridTradePayload {
  const allocation = BigInt(Math.round((allocationBps / BPS_DENOMINATOR) * 1_000_000));
  const pnlDelta = currentPrice >= referencePrice ? allocation : -allocation;
  const nonce = BigInt(Date.now());
  const digest = buildTradeDigest(chainId, keeperAddress, user, pnlDelta, nonce);
  const signature = signTradeDigestWithHardware(digest);
  return { user, pnlDelta, nonce, digest, signature };
}

function encodeExecuteTradePayload(trade: GridTradePayload): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "int256", "uint256", "bytes"],
    [trade.user, trade.pnlDelta, trade.nonce, trade.signature]
  );
}

async function submitTradeViaAcurast(
  rpcUrl: string,
  keeperAddress: string,
  trade: GridTradePayload
): Promise<string> {
  const std = getAcurastStd();
  if (!std) {
    throw new Error("Acurast _STD_ required for on-chain execution");
  }

  const payload = encodeExecuteTradePayload(trade);
  return new Promise((resolve, reject) => {
    std.chains.ethereum.fulfill(
      rpcUrl,
      keeperAddress,
      payload,
      {
        methodSignature: EXECUTE_TRADE_SIGNATURE,
      },
      (operationHash: string) => resolve(operationHash),
      (messages: string[]) => reject(new Error(messages.join("; ")))
    );
  });
}

async function monitorAndExecute(): Promise<void> {
  const rpcUrl = process.env.RPC_URL || "https://sepolia.base.org";
  const poolAddress = process.env.UNISWAP_POOL_ADDRESS || "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
  // Keeper deployed with acurastSigner = TEE hw address 0x6F34eBba2c775FFdc5c25A35a7799d16E821F75D
  const keeperAddress = process.env.KEEPER_ADDRESS || "0x596560cD5Ed45ab89044304345855c6b29e7fA6e";
  const userAddress = process.env.USER_ADDRESS || "0x1B77DAd014Cc99d877fE8CF5152773432d39d7bA";

  if (!rpcUrl || !poolAddress || !keeperAddress || !userAddress) {
    throw new Error("Missing one of RPC_URL, UNISWAP_POOL_ADDRESS, KEEPER_ADDRESS, USER_ADDRESS");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  const chainId = network.chainId;
  const grids = parseJsonEnv<GridLevel[]>("GRID_CONFIG_JSON", []);
  const stopLossRules = decodeStopLossRules();

  // --- Load strategy params from _STD_.storage (set by fetchAndStoreStrategyParams) ---
  const storedParams = loadStrategyParams(userAddress);
  if (storedParams) {
    // Override stop-loss from user's signed frontend submission
    const existingRule = stopLossRules.find(r => r.user.toLowerCase() === userAddress.toLowerCase());
    if (!existingRule && storedParams.stopLossPrice > 0) {
      stopLossRules.push({ user: userAddress, stopLossPrice: storedParams.stopLossPrice });
    }
  }

  const activeGrids = grids.filter((grid) => {
    const stopLoss = stopLossRules.find((rule) => rule.user.toLowerCase() === userAddress.toLowerCase());
    if (!stopLoss) return true;
    return grid.referencePrice >= stopLoss.stopLossPrice;
  });

  const currentPrice = await fetchPoolPrice(provider, poolAddress);
  const pendingTrades: GridTradePayload[] = [];

  for (const grid of activeGrids) {
    if (!shouldTrigger(grid, currentPrice)) {
      continue;
    }
    pendingTrades.push(
      createTradePayload(chainId, keeperAddress, userAddress, grid.referencePrice, grid.allocationBps, currentPrice)
    );
  }

  let stateUpdated = false;
  let state = await loadState(process.env.STATE_PATH ?? ".yieldsense-state.json");

  for (const trade of pendingTrades) {
    const txHash = await submitTradeViaAcurast(rpcUrl, keeperAddress, trade);
    const nowSec = Math.floor(Date.now() / 1000);

    // Bridge to Netlify Blobs via telemetry so the frontend can display real trade history
    await emitTelemetry({
      event: "grid_trade_executed",
      timestamp: nowSec,
      user: trade.user,
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
      message: `Grid Trade executed for ${trade.user.substring(0, 6)}...`,
      txHash
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

  // On first run, pull the latest signed strategy from the frontend relay
  // and commit it to _STD_.storage so subsequent executions are fully autonomous.
  if (userAddress) {
    await fetchAndStoreStrategyParams(userAddress, frontendUrl);
  }

  for (; ;) {
    try {
      await monitorAndExecute();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "processor_error",
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

startLoop().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
