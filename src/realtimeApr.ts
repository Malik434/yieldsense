// axios removed to reduce bundle size

export type AprSourceName = "geckoTerminal" | "dexScreener" | "defiLlama";

export interface AprObservation {
  source: AprSourceName;
  apr: number | null;
  timestamp: number;
  confidence: number;
  error?: string;
}

export interface AprConsensus {
  apr: number | null;
  confidence: number;
  usable: boolean;
  observations: AprObservation[];
}

const USER_AGENT = "YieldSense/3.0 (Acurast TEE)";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function buildAprConsensus(
  observations: AprObservation[],
  freshnessWindowSec: number,
  minConfidence: number
): AprConsensus {
  const timestamp = nowSec();
  const fresh = observations.filter((o) => {
    if (o.apr === null) return false;
    const age = timestamp - o.timestamp;
    return age >= 0 && age <= freshnessWindowSec;
  });

  if (fresh.length === 0) {
    return { apr: null, confidence: 0, usable: false, observations };
  }

  const aprValues = fresh.map((o) => o.apr as number);
  const center = median(aprValues);

  const filtered = fresh.filter((o) => {
    const deviation = Math.abs((o.apr as number) - center);
    const maxDeviation = Math.max(0.12, center * 0.5);
    return deviation <= maxDeviation;
  });

  if (filtered.length === 0) {
    return { apr: null, confidence: 0, usable: false, observations };
  }

  const weightedApr = filtered.reduce((sum, o) => sum + (o.apr as number) * o.confidence, 0);
  const totalWeight = filtered.reduce((sum, o) => sum + o.confidence, 0);
  const apr = totalWeight > 0 ? weightedApr / totalWeight : median(filtered.map((o) => o.apr as number));

  // Confidence should reflect quality of contributing fresh sources.
  // Dividing by total observations over-penalizes valid 2-of-3 scenarios.
  const confidence = clamp(
    filtered.reduce((sum, o) => sum + o.confidence, 0) / filtered.length,
    0,
    1
  );
  return {
    apr,
    confidence,
    usable: confidence >= minConfidence,
    observations,
  };
}

async function fetchGecko(poolAddress: string): Promise<AprObservation> {
  const timestamp = nowSec();
  try {
    const addr = poolAddress.toLowerCase();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/pools/${addr}`, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: any = await response.json();
    const attr = body?.data?.attributes ?? {};
    const directApr = attr.apr_7d ?? attr.apr;
    if (directApr !== undefined && directApr !== null) {
      return { source: "geckoTerminal", apr: Number(directApr) / 100, timestamp, confidence: 0.9 };
    }

    const vol24h = Number(attr?.volume_usd?.h24 ?? 0);
    const tvl = Number(attr?.reserve_in_usd ?? 0);
    const feePct = Number(attr?.pool_fee_percentage ?? 0.05) / 100;
    if (vol24h > 0 && tvl > 0) {
      return {
        source: "geckoTerminal",
        apr: (vol24h * feePct * 365) / tvl,
        timestamp,
        confidence: 0.65,
      };
    }
    return { source: "geckoTerminal", apr: null, timestamp, confidence: 0, error: "No APR fields found" };
  } catch (error: any) {
    return { source: "geckoTerminal", apr: null, timestamp, confidence: 0, error: error.message };
  }
}

async function fetchDexScreener(poolAddress: string): Promise<AprObservation> {
  const timestamp = nowSec();
  try {
    const addr = poolAddress.toLowerCase();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/base/${addr}`, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: any = await response.json();
    const pair = body?.pairs?.[0];
    if (!pair) {
      return { source: "dexScreener", apr: null, timestamp, confidence: 0, error: "Pair not found" };
    }
    if (pair.apr !== undefined && pair.apr !== null) {
      return { source: "dexScreener", apr: Number(pair.apr) / 100, timestamp, confidence: 0.8 };
    }
    const volume24h = Number(pair?.volume?.h24 ?? 0);
    const liquidityUsd = Number(pair?.liquidity?.usd ?? 0);
    if (volume24h > 0 && liquidityUsd > 0) {
      return {
        source: "dexScreener",
        apr: (volume24h * 0.0005 * 365) / liquidityUsd,
        timestamp,
        confidence: 0.6,
      };
    }
    return { source: "dexScreener", apr: null, timestamp, confidence: 0, error: "No APR fields found" };
  } catch (error: any) {
    return { source: "dexScreener", apr: null, timestamp, confidence: 0, error: error.message };
  }
}

async function fetchDefiLlama(poolAddress: string): Promise<AprObservation> {
  const timestamp = nowSec();
  try {
    const addr = poolAddress.toLowerCase();
    const addrNoPrefix = addr.startsWith("0x") ? addr.slice(2) : addr;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const response = await fetch("https://yields.llama.fi/pools", {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: any = await response.json();
    const pools: any[] = body?.data ?? [];

    const pool = pools.find((p: any) => {
      const poolId = String(p?.pool ?? "").toLowerCase();
      if (poolId === addr) return true;
      if (poolId.includes(addrNoPrefix)) return true;
      const underlying: string[] = (p?.underlyingTokens ?? []).map((t: string) =>
        t.toLowerCase()
      );
      return underlying.includes(addr);
    });

    if (pool?.apy !== undefined && pool?.apy !== null) {
      return { source: "defiLlama", apr: Number(pool.apy) / 100, timestamp, confidence: 0.75 };
    }
    return { source: "defiLlama", apr: null, timestamp, confidence: 0, error: "Pool not found in DefiLlama yields" };
  } catch (error: any) {
    return { source: "defiLlama", apr: null, timestamp, confidence: 0, error: error.message };
  }
}

export async function getRealtimeAprConsensus(
  poolAddress: string,
  freshnessWindowSec: number,
  minConfidence: number
): Promise<AprConsensus> {
  const observations = await Promise.all([
    fetchGecko(poolAddress),
    fetchDexScreener(poolAddress),
    fetchDefiLlama(poolAddress),
  ]);
  return buildAprConsensus(observations, freshnessWindowSec, minConfidence);
}
