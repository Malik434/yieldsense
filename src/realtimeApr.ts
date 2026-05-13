// axios removed to reduce bundle size
import { emitTelemetry } from "./telemetry.js";

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
const DEFAULT_POOL_FEE_RATE = Number(process.env.POOL_FEE_RATE ?? 0.003);
const DEFAULT_API_TIMEOUT_MS = Number(process.env.APR_API_TIMEOUT_MS ?? 3500);
const ENABLE_DEFILLAMA_APR = process.env.ENABLE_DEFILLAMA_APR === "true";
const apiTelemetryReported = new Set<string>();

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

async function emitApiTelemetry(
  source: AprSourceName,
  stage: "attempt" | "result" | "error" | "skipped",
  details: Record<string, unknown> = {}
): Promise<void> {
  const key = `${source}:${stage}`;
  if (apiTelemetryReported.has(key)) return;
  apiTelemetryReported.add(key);

  await emitTelemetry({
    event: "apr_api_source",
    timestamp: nowSec(),
    source,
    stage,
    ...details,
  }).catch(() => {});
}

async function fetchJsonWithHardTimeout<T>(
  source: AprSourceName,
  url: string,
  timeoutMs: number = DEFAULT_API_TIMEOUT_MS
): Promise<T> {
  await emitApiTelemetry(source, "attempt", { timeoutMs });

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([
      (async () => {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as T;
      })(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          try {
            controller.abort();
          } catch {
            // Acurast may expose fetch without a functional abort implementation.
          }
          reject(new Error(`${source} API timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    await emitApiTelemetry(source, "result");
    return body;
  } catch (error: any) {
    await emitApiTelemetry(source, "error", {
      message: error?.message ?? String(error),
      name: error?.name,
    });
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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
    const body = await fetchJsonWithHardTimeout<any>(
      "geckoTerminal",
      `https://api.geckoterminal.com/api/v2/networks/base/pools/${addr}`
    );
    const attr = body?.data?.attributes ?? {};
    const directApr = attr.apr_7d ?? attr.apr;
    if (directApr !== undefined && directApr !== null) {
      return { source: "geckoTerminal", apr: Number(directApr) / 100, timestamp, confidence: 0.9 };
    }

    const vol24h = Number(attr?.volume_usd?.h24 ?? 0);
    const tvl = Number(attr?.reserve_in_usd ?? 0);
    const feePct =
      attr?.pool_fee_percentage != null
        ? Number(attr.pool_fee_percentage) / 100
        : DEFAULT_POOL_FEE_RATE;
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
    const body = await fetchJsonWithHardTimeout<any>(
      "dexScreener",
      `https://api.dexscreener.com/latest/dex/pairs/base/${addr}`
    );
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
        apr: (volume24h * DEFAULT_POOL_FEE_RATE * 365) / liquidityUsd,
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
  if (!ENABLE_DEFILLAMA_APR) {
    await emitApiTelemetry("defiLlama", "skipped", { reason: "ENABLE_DEFILLAMA_APR_not_true" });
    return { source: "defiLlama", apr: null, timestamp, confidence: 0, error: "disabled" };
  }

  try {
    const addr = poolAddress.toLowerCase();
    const addrNoPrefix = addr.startsWith("0x") ? addr.slice(2) : addr;
    const body = await fetchJsonWithHardTimeout<any>(
      "defiLlama",
      "https://yields.llama.fi/pools",
      Math.max(DEFAULT_API_TIMEOUT_MS, 5000)
    );
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
