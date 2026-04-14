import { ethers } from "ethers";
import { getAcurastStd } from "./acurastHardware.js";

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
  "function executeTrade(address user,int256 pnlDelta,uint256 nonce,bytes32 digest,bytes signature) external",
];
const EXECUTE_TRADE_SIGNATURE = "executeTrade(address,int256,uint256,bytes32,bytes)";

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
    ["address", "int256", "uint256", "bytes32", "bytes"],
    [trade.user, trade.pnlDelta, trade.nonce, trade.digest, trade.signature]
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
  const rpcUrl = process.env.RPC_URL ?? "";
  const poolAddress = process.env.UNISWAP_POOL_ADDRESS ?? "";
  const keeperAddress = process.env.KEEPER_ADDRESS ?? "";
  const userAddress = process.env.USER_ADDRESS ?? "";

  if (!rpcUrl || !poolAddress || !keeperAddress || !userAddress) {
    throw new Error("Missing one of RPC_URL, UNISWAP_POOL_ADDRESS, KEEPER_ADDRESS, USER_ADDRESS");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  const chainId = network.chainId;
  const grids = parseJsonEnv<GridLevel[]>("GRID_CONFIG_JSON", []);
  const stopLossRules = decodeStopLossRules();

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

  for (const trade of pendingTrades) {
    const txHash = await submitTradeViaAcurast(rpcUrl, keeperAddress, trade);
    console.log(
      JSON.stringify({
        event: "grid_trade_executed",
        user: trade.user,
        nonce: trade.nonce.toString(),
        txHash,
      })
    );
  }
}

async function startLoop(): Promise<void> {
  for (;;) {
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
