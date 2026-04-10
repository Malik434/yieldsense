import { Contract, JsonRpcProvider } from "ethers";
import { fetchGeckoPoolReserveUsd } from "../ingestion/geckoPool.js";
import { tvlUsdFromReserves, type TokenPricesUsd } from "../ingestion/prices.js";

const PAIR_ABI = ["function token0() view returns (address)", "function token1() view returns (address)"];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
];

async function balancesAtBlock(
  provider: JsonRpcProvider,
  poolAddress: string,
  prices: Pick<TokenPricesUsd, "decimals0" | "decimals1">,
  blockTag: number | "latest"
): Promise<{ h0: number; h1: number }> {
  const pair = new Contract(poolAddress, PAIR_ABI, provider);
  const t0 = (await pair.token0()) as string;
  const t1 = (await pair.token1()) as string;
  const c0 = new Contract(t0, ERC20_ABI, provider);
  const c1 = new Contract(t1, ERC20_ABI, provider);
  const d0 = prices.decimals0;
  const d1 = prices.decimals1;
  try {
    const [b0, b1] = await Promise.all([
      c0.balanceOf(poolAddress, { blockTag }),
      c1.balanceOf(poolAddress, { blockTag }),
    ]);
    return { h0: Number(b0) / 10 ** d0, h1: Number(b1) / 10 ** d1 };
  } catch {
    if (blockTag !== "latest") {
      const [b0, b1] = await Promise.all([
        c0.balanceOf(poolAddress, { blockTag: "latest" }),
        c1.balanceOf(poolAddress, { blockTag: "latest" }),
      ]);
      return { h0: Number(b0) / 10 ** d0, h1: Number(b1) / 10 ** d1 };
    }
    throw new Error(
      `balanceOf(pool) at block failed for ${poolAddress}; Slipstream/V3 pools have no getReserves — use an RPC with historical eth_call or only latest.`
    );
  }
}

export type TwabTvlResult = { tvlUsd: number; source: "onchain" | "gecko" };

export async function twabTvlUsd(
  provider: JsonRpcProvider,
  poolAddress: string,
  fromBlock: number,
  toBlock: number,
  prices: Pick<TokenPricesUsd, "decimals0" | "decimals1" | "price0Usd" | "price1Usd">,
  geckoNetworkSlug: string = "base"
): Promise<TwabTvlResult> {
  try {
    const [start, end] = await Promise.all([
      balancesAtBlock(provider, poolAddress, prices, fromBlock),
      balancesAtBlock(provider, poolAddress, prices, toBlock),
    ]);
    const tvlA = tvlUsdFromReserves(start.h0, start.h1, prices);
    const tvlB = tvlUsdFromReserves(end.h0, end.h1, prices);
    const avg = (tvlA + tvlB) / 2;
    if (avg > 0) return { tvlUsd: avg, source: "onchain" };
  } catch {
    // fall through to Gecko
  }
  const gecko = await fetchGeckoPoolReserveUsd(poolAddress, geckoNetworkSlug);
  if (gecko > 0) return { tvlUsd: gecko, source: "gecko" };
  throw new Error(
    `twabTvlUsd: on-chain balances unavailable and GeckoTerminal had no reserve_in_usd for ${poolAddress} on network ${geckoNetworkSlug}`
  );
}

export { geckoNetworkForChainId } from "../ingestion/geckoPool.js";
