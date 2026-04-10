import { Contract, JsonRpcProvider } from "ethers";
import { fetchGeckoPoolSpotPricesUsd, geckoNetworkForChainId } from "./geckoPool.js";

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
];

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

/** Uniswap V3 / Aerodrome Slipstream */
const V3_SLOT0_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
];

export interface TokenPricesUsd {
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  price0Usd: number;
  price1Usd: number;
  /** max relative divergence vs spot-from-reserves (0-1) */
  twapSpotMaxDivergence: number;
  source: "oracle:spotReserves";
}

/** Spot prices from pool before divergence guard; `priceLookup` tags non-reserve sources. */
export type SpotPricesFromPool = Omit<TokenPricesUsd, "twapSpotMaxDivergence" | "source"> & {
  priceLookup?: "balances" | "slot0" | "gecko";
};

const STABLE_SYMBOLS = new Set(
  [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC Base
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC Base
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI Base
  ].map((a) => a.toLowerCase())
);

function isStable(addr: string): boolean {
  return STABLE_SYMBOLS.has(addr.toLowerCase());
}

/** token1 human per 1 token0 human from sqrtPriceX96 (Uniswap V3 convention). */
function human1PerToken0FromSqrt(sqrtPriceX96: bigint, d0: number, d1: number): number {
  const Q96 = 2n ** 96n;
  const s = Number(sqrtPriceX96) / Number(Q96);
  const priceRaw = s * s;
  return priceRaw * 10 ** (d0 - d1);
}

async function usdPricesFromSlot0(
  provider: JsonRpcProvider,
  poolAddress: string,
  t0: string,
  t1: string,
  d0: number,
  d1: number,
  blockTag: number | "latest"
): Promise<{ price0Usd: number; price1Usd: number }> {
  const pool = new Contract(poolAddress, V3_SLOT0_ABI, provider);
  const slot = await pool.slot0({ blockTag: blockTag === "latest" ? "latest" : blockTag });
  const sqrtPriceX96 = slot.sqrtPriceX96 as bigint;
  const h1Per0 = human1PerToken0FromSqrt(sqrtPriceX96, d0, d1);
  if (isStable(t1)) {
    return { price1Usd: 1, price0Usd: h1Per0 };
  }
  if (isStable(t0)) {
    return { price0Usd: 1, price1Usd: h1Per0 > 0 ? 1 / h1Per0 : 0 };
  }
  return { price0Usd: 1, price1Usd: h1Per0 };
}

async function readBalancesHuman(
  c0: Contract,
  c1: Contract,
  poolAddress: string,
  d0: number,
  d1: number,
  blockTag: number | "latest"
): Promise<{ r0: number; r1: number }> {
  const bal0 = await c0.balanceOf(poolAddress, { blockTag });
  const bal1 = await c1.balanceOf(poolAddress, { blockTag });
  return { r0: Number(bal0) / 10 ** d0, r1: Number(bal1) / 10 ** d1 };
}

/**
 * Spot USD prices from pool token balances (V2 + V3) or slot0 (Slipstream when balances RPC fails).
 */
export async function getSpotPricesFromPool(
  provider: JsonRpcProvider,
  poolAddress: string,
  blockTag: number | "latest"
): Promise<SpotPricesFromPool> {
  const pair = new Contract(poolAddress, PAIR_ABI, provider);
  const [token0, token1] = await Promise.all([pair.token0(), pair.token1()]);
  const t0 = token0 as string;
  const t1 = token1 as string;

  const c0 = new Contract(t0, ERC20_ABI, provider);
  const c1 = new Contract(t1, ERC20_ABI, provider);
  const [decimals0, decimals1] = await Promise.all([c0.decimals(), c1.decimals()]);
  const d0 = Number(decimals0);
  const d1 = Number(decimals1);

  let r0 = 0;
  let r1 = 0;
  const tags: Array<number | "latest"> =
    blockTag === "latest" ? ["latest"] : [blockTag, "latest"];

  for (const tag of tags) {
    try {
      const b = await readBalancesHuman(c0, c1, poolAddress, d0, d1, tag);
      r0 = b.r0;
      r1 = b.r1;
      if (r0 > 0 && r1 > 0) break;
    } catch {
      // try next tag or fall through to slot0
    }
  }

  if (r0 > 0 && r1 > 0) {
    let price0Usd: number;
    let price1Usd: number;
    if (isStable(t1)) {
      price1Usd = 1;
      price0Usd = (r1 * price1Usd) / r0;
    } else if (isStable(t0)) {
      price0Usd = 1;
      price1Usd = (r0 * price0Usd) / r1;
    } else {
      const ratio = r1 / r0;
      price0Usd = 1;
      price1Usd = ratio;
    }
    return {
      token0: t0,
      token1: t1,
      decimals0: d0,
      decimals1: d1,
      price0Usd,
      price1Usd,
      priceLookup: "balances",
    };
  }

  for (const tag of tags) {
    try {
      const { price0Usd, price1Usd } = await usdPricesFromSlot0(provider, poolAddress, t0, t1, d0, d1, tag);
      if (price0Usd > 0 || price1Usd > 0) {
        return {
          token0: t0,
          token1: t1,
          decimals0: d0,
          decimals1: d1,
          price0Usd,
          price1Usd,
          priceLookup: "slot0",
        };
      }
    } catch {
      // continue
    }
  }

  let chainId = 8453;
  try {
    chainId = Number((await provider.getNetwork()).chainId);
  } catch {
    // keep default
  }
  const gecko = await fetchGeckoPoolSpotPricesUsd(
    poolAddress,
    geckoNetworkForChainId(chainId),
    t0,
    t1
  );
  if (gecko) {
    return {
      token0: t0,
      token1: t1,
      decimals0: d0,
      decimals1: d1,
      price0Usd: gecko.price0Usd,
      price1Usd: gecko.price1Usd,
      priceLookup: "gecko",
    };
  }

  throw new Error(
    `Could not price pool ${poolAddress}: balanceOf and slot0 failed on this RPC, and GeckoTerminal had no prices. Set DATA_RPC_URL to a Base mainnet archive or public node (e.g. https://mainnet.base.org).`
  );
}

export function attachDivergenceGuard(
  prices: SpotPricesFromPool,
  twapSpotMaxDivergence: number
): TokenPricesUsd {
  const { priceLookup: _p, ...rest } = prices;
  return { ...rest, twapSpotMaxDivergence, source: "oracle:spotReserves" };
}

/** Convert swap input amounts (wei) to USD fee portion. */
export function feeUsdFromSwapInputs(
  amount0In: bigint,
  amount1In: bigint,
  feeBps: number,
  prices: Pick<TokenPricesUsd, "decimals0" | "decimals1" | "price0Usd" | "price1Usd">
): number {
  const f = feeBps / 10000;
  const v0 = Number(amount0In) / 10 ** prices.decimals0;
  const v1 = Number(amount1In) / 10 ** prices.decimals1;
  return v0 * prices.price0Usd * f + v1 * prices.price1Usd * f;
}

export function tvlUsdFromReserves(
  reserve0Human: number,
  reserve1Human: number,
  prices: Pick<TokenPricesUsd, "price0Usd" | "price1Usd">
): number {
  return reserve0Human * prices.price0Usd + reserve1Human * prices.price1Usd;
}
