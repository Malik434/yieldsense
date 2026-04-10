import { Contract, Interface, JsonRpcProvider } from "ethers";
import { getLogsChunked, getBlockTimestamp } from "../ingestion/rpc.js";
import type { FeeIndexResult } from "../types.js";
import { feeUsdFromSwapInputs, type TokenPricesUsd } from "../ingestion/prices.js";

const V2_SWAP_IFACE = new Interface([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
]);

const V3_SWAP_IFACE = new Interface([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

const V2_SWAP_TOPIC = V2_SWAP_IFACE.getEvent("Swap")!.topicHash;
const V3_SWAP_TOPIC = V3_SWAP_IFACE.getEvent("Swap")!.topicHash;

function feeUsdFromV3Swap(
  amount0: bigint,
  amount1: bigint,
  feeBps: number,
  prices: TokenPricesUsd
): number {
  const a0 = amount0 < 0n ? -amount0 : amount0;
  const a1 = amount1 < 0n ? -amount1 : amount1;
  const v0 = Number(a0) / 10 ** prices.decimals0;
  const v1 = Number(a1) / 10 ** prices.decimals1;
  const notionalUsd = Math.max(v0 * prices.price0Usd, v1 * prices.price1Usd);
  return notionalUsd * (feeBps / 10000);
}

async function collectSwapFees(
  provider: JsonRpcProvider,
  poolAddress: string,
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
  topic: string,
  iface: Interface,
  poolFeeBps: number,
  prices: TokenPricesUsd,
  mode: "v2" | "v3"
): Promise<{ feeUsd: number; swapCount: number; failedChunks: number; totalChunks: number }> {
  const { logs, failedChunks, totalChunks } = await getLogsChunked(
    provider,
    { address: poolAddress, topics: [topic] },
    fromBlock,
    toBlock,
    chunkSize
  );

  let feeUsd = 0;
  let swapCount = 0;
  for (const log of logs) {
    try {
      const parsed = iface.parseLog(log);
      if (!parsed || parsed.name !== "Swap") continue;
      if (mode === "v2") {
        const amount0In = parsed.args.amount0In as bigint;
        const amount1In = parsed.args.amount1In as bigint;
        feeUsd += feeUsdFromSwapInputs(amount0In, amount1In, poolFeeBps, prices);
      } else {
        const amount0 = parsed.args.amount0 as bigint;
        const amount1 = parsed.args.amount1 as bigint;
        feeUsd += feeUsdFromV3Swap(amount0, amount1, poolFeeBps, prices);
      }
      swapCount += 1;
    } catch {
      // non-matching layout
    }
  }
  return { feeUsd, swapCount, failedChunks, totalChunks };
}

export async function indexSwapFeesUsd(
  provider: JsonRpcProvider,
  poolAddress: string,
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
  poolFeeBps: number,
  prices: TokenPricesUsd
): Promise<FeeIndexResult> {
  const v2 = await collectSwapFees(
    provider,
    poolAddress,
    fromBlock,
    toBlock,
    chunkSize,
    V2_SWAP_TOPIC,
    V2_SWAP_IFACE,
    poolFeeBps,
    prices,
    "v2"
  );
  const v3 = await collectSwapFees(
    provider,
    poolAddress,
    fromBlock,
    toBlock,
    chunkSize,
    V3_SWAP_TOPIC,
    V3_SWAP_IFACE,
    poolFeeBps,
    prices,
    "v3"
  );

  const feeUsd = v2.feeUsd + v3.feeUsd;
  const swapCount = v2.swapCount + v3.swapCount;
  const totalChunks = v2.totalChunks + v3.totalChunks;
  const failedChunks = v2.failedChunks + v3.failedChunks;

  const t0 = await getBlockTimestamp(provider, fromBlock);
  const t1 = await getBlockTimestamp(provider, toBlock);
  const windowSecActual = Math.max(1, t1 - t0);
  const coverageRatio = totalChunks > 0 ? (totalChunks - failedChunks) / totalChunks : 0;

  return {
    feeUsd,
    swapCount,
    fromBlock,
    toBlock,
    coverageRatio,
    windowSecActual,
    failedChunks,
    totalChunks,
  };
}

/** V2: fee in bps. V3 / Slipstream: fee in hundredths of a bip (500 = 0.05% = 5 bps). */
export async function readPoolFeeBps(provider: JsonRpcProvider, poolAddress: string): Promise<number> {
  try {
    const POOL_FEES_ABI = ["function fee() view returns (uint24)"];
    const c = new Contract(poolAddress, POOL_FEES_ABI, provider);
    const fee = await c.fee();
    const n = Number(fee);
    if (!Number.isFinite(n) || n <= 0) return 30;
    // Uniswap V3–style tiers: 100, 500, 3000, 10000 → bps = n / 100
    if (n >= 100 && n < 1000) return Math.max(1, Math.round(n / 100));
    if (n >= 1000 && n <= 1_000_000) return Math.round(n / 100);
    // V2-style bps (e.g. 30 = 0.30%)
    if (n <= 100) return Math.max(1, n);
  } catch {
    // ignore
  }
  return 30;
}
