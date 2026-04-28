// axios removed to reduce bundle size

/**
 * Standardized pool yield data from DefiLlama Yields API.
 */
export interface DefiLlamaPoolYield {
  pool: string;            // DefiLlama pool UUID (not always the on-chain address)
  chain: string;           // "Base"
  project: string;         // "aerodrome-v2", "moonwell", etc.
  symbol: string;          // e.g. "WETH-USDC", "USDC"
  tvlUsd: number;
  apy: number;             // total APY % (base + reward combined)
  apyBase: number | null;
  apyReward: number | null;
  rewardTokens: string[] | null;
  underlyingTokens: string[] | null;
  poolMeta: string | null;
}

const DEFILLAMA_YIELDS_URL = "https://yields.llama.fi/pools";
const USER_AGENT = "YieldSense/3.0 (yield-engine)";

// In-memory cache — 5-minute TTL to avoid hammering the API
let cachedPools: DefiLlamaPoolYield[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch and cache all Base-chain pools from DefiLlama Yields API.
 * The API ignores query parameters — we filter client-side.
 */
async function fetchAllBasePools(): Promise<DefiLlamaPoolYield[]> {
  const now = Date.now();
  if (cachedPools && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedPools;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  const res = await fetch(DEFILLAMA_YIELDS_URL, {
    signal: controller.signal,
    headers: { "User-Agent": USER_AGENT },
  });
  clearTimeout(timeoutId);
  if (!res.ok) return [];

  const body: any = await res.json();
  const allPools: any[] = body?.data ?? [];

  cachedPools = allPools
    .filter((p: any) => p.chain === "Base")
    .map((p: any) => ({
      pool: p.pool,
      chain: p.chain,
      project: p.project,
      symbol: p.symbol,
      tvlUsd: p.tvlUsd ?? 0,
      apy: p.apy ?? 0,
      apyBase: p.apyBase ?? null,
      apyReward: p.apyReward ?? null,
      rewardTokens: p.rewardTokens ?? null,
      underlyingTokens: p.underlyingTokens ?? null,
      poolMeta: p.poolMeta ?? null,
    }));

  cacheTimestamp = now;
  return cachedPools!;
}

/**
 * Get Aerodrome pool yields on Base, sorted by TVL descending.
 *
 * DefiLlama slugs for Aerodrome: "aerodrome-v2", "aerodrome-v3", "aerodrome-cl"
 * All are matched with a startsWith("aerodrome") prefix.
 *
 * @param minTvl Minimum TVL filter in USD (default $10k)
 * @param limit  Max pools to return (default 20)
 */
export async function getAerodromeYields(
  minTvl = 10_000,
  limit = 20
): Promise<DefiLlamaPoolYield[]> {
  const pools = await fetchAllBasePools();
  const results = pools
    .filter((p) => p.project.startsWith("aerodrome") && p.tvlUsd >= minTvl)
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, limit);

  if (results.length === 0) {
    const found = [...new Set(pools.map((p) => p.project))].slice(0, 10);
    console.warn(
      `[defiLlamaYields] No Aerodrome pools found with TVL ≥ $${minTvl.toLocaleString()}. ` +
        `Base projects visible: ${found.join(", ")}`
    );
  }
  return results;
}

/**
 * Known DefiLlama project slugs for Moonwell on Base.
 * DefiLlama has migrated between "moonwell", "moonwell-lending", and "moonwell-finance" at
 * different times. We check all variants so the filter is robust against slug changes.
 */
const MOONWELL_SLUGS = new Set(["moonwell", "moonwell-lending", "moonwell-finance", "moonwell-base"]);

/**
 * Get Moonwell lending market yields on Base, sorted by TVL descending.
 *
 * @param minTvl Minimum TVL filter in USD (default $10k)
 * @param limit  Max markets to return (default 20)
 */
export async function getMoonwellYields(
  minTvl = 10_000,
  limit = 20
): Promise<DefiLlamaPoolYield[]> {
  const pools = await fetchAllBasePools();
  const results = pools
    .filter((p) => MOONWELL_SLUGS.has(p.project) && p.tvlUsd >= minTvl)
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, limit);

  if (results.length === 0) {
    // Log which slugs were actually present so the caller can debug slug drift
    const moonLike = pools.filter((p) => p.project.toLowerCase().includes("moon"));
    const slugs = [...new Set(moonLike.map((p) => p.project))];
    console.warn(
      `[defiLlamaYields] No Moonwell markets found with TVL ≥ $${minTvl.toLocaleString()}. ` +
        (slugs.length > 0
          ? `Moon-like slugs on Base: ${slugs.join(", ")}`
          : "No moon-like slugs found on Base — check DefiLlama for slug changes.")
    );
  }
  return results;
}

/**
 * Look up a specific pool by its underlying token addresses.
 * Useful for matching an on-chain pool to its DefiLlama entry.
 *
 * @param project  Project slug prefix (e.g. "aerodrome", "moonwell")
 * @param token0   Required underlying token address
 * @param token1   Optional second token address (for LP pairs)
 */
export async function findPoolByTokens(
  project: string,
  token0: string,
  token1?: string
): Promise<DefiLlamaPoolYield | null> {
  const pools = await fetchAllBasePools();
  const t0 = token0.toLowerCase();
  const t1 = token1?.toLowerCase();

  return (
    pools.find((p) => {
      if (!p.project.startsWith(project)) return false;
      const underlying = (p.underlyingTokens ?? []).map((t: string) => t.toLowerCase());
      if (!underlying.includes(t0)) return false;
      if (t1 && !underlying.includes(t1)) return false;
      return true;
    }) ?? null
  );
}

/**
 * Look up a pool by its on-chain address.
 *
 * DefiLlama pool IDs are usually UUIDs, but some protocols embed the
 * contract address in the ID. This function checks:
 *   1. Exact match (ID === address)
 *   2. ID contains the address (without 0x prefix)
 *   3. underlyingTokens contains the address (single-asset lending markets)
 *
 * Returns the highest-TVL match when multiple records match.
 */
export async function findPoolByAddress(
  poolAddress: string
): Promise<DefiLlamaPoolYield | null> {
  const pools = await fetchAllBasePools();
  const addr = poolAddress.toLowerCase();
  const addrNoPrefix = addr.startsWith("0x") ? addr.slice(2) : addr;

  const matches = pools.filter((p) => {
    const poolId = p.pool.toLowerCase();
    if (poolId === addr) return true;
    if (poolId.includes(addrNoPrefix)) return true;
    const underlying = (p.underlyingTokens ?? []).map((t: string) => t.toLowerCase());
    return underlying.includes(addr);
  });

  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
}

/**
 * Convenience: get DefiLlama APY (as a decimal fraction, e.g. 0.053 = 5.3%)
 * for a known pool address. Returns null when the pool is not indexed.
 */
export async function getDefiLlamaApyForPool(
  poolAddress: string
): Promise<{ apyDecimal: number; apyBaseDecimal: number; apyRewardDecimal: number; pool: DefiLlamaPoolYield } | null> {
  const pool = await findPoolByAddress(poolAddress);
  if (!pool || pool.apy === 0) return null;
  return {
    apyDecimal: pool.apy / 100,
    apyBaseDecimal: (pool.apyBase ?? 0) / 100,
    apyRewardDecimal: (pool.apyReward ?? 0) / 100,
    pool,
  };
}

/**
 * Get a summary of all yields from both protocols for telemetry / health-check.
 */
export async function getProtocolYieldSummary(): Promise<{
  aerodrome: { poolCount: number; topPools: DefiLlamaPoolYield[] };
  moonwell: { marketCount: number; topMarkets: DefiLlamaPoolYield[] };
  fetchedAt: number;
}> {
  const [aero, moon] = await Promise.all([
    getAerodromeYields(10_000, 5),
    getMoonwellYields(10_000, 5),
  ]);

  return {
    aerodrome: { poolCount: aero.length, topPools: aero },
    moonwell: { marketCount: moon.length, topMarkets: moon },
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}
