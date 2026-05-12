import { FetchRequest, JsonRpcProvider, type Networkish } from "ethers";

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Sequential Failover Provider:
 * We don't use Ethers' FallbackProvider because it probes all endpoints on boot,
 * which can trigger rate-limits on free tiers or cause 10-minute "quiesce" hangs.
 * Instead, we return a provider that uses the primary URL, and we'll handle
 * rotation at the application level if needed, or rely on a simple try/catch.
 */
export function createJsonRpcProvider(rpcUrl: string, network?: Networkish): JsonRpcProvider {
  const fallbacks = (process.env.RPC_FALLBACK_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  
  const urls = [rpcUrl, ...fallbacks];
  const timeout = positiveIntEnv("RPC_REQUEST_TIMEOUT_MS", 15_000);

  // We use the first available URL. If it fails, the application's retry logic
  // (like in keeper.lastHarvest) will trigger a fresh boot or a retry.
  const request = new FetchRequest(urls[0]);
  request.timeout = timeout;

  return new JsonRpcProvider(request, network, {
    batchMaxCount: 1,
    staticNetwork: network == null ? null : true,
    cacheTimeout: positiveIntEnv("RPC_CACHE_TIMEOUT_MS", 1_000),
  });
}
