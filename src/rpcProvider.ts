import { FetchRequest, JsonRpcProvider, type Networkish } from "ethers";

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Production RPC provider defaults tuned for Acurast/public RPC reliability:
 * - no JSON-RPC batching; several public Base endpoints throttle batched eth_call
 * - static chain when known; avoids ethers background chain-detection retries
 * - bounded HTTP timeout; prevents a single hung request from holding the job open
 */
export function createJsonRpcProvider(rpcUrl: string, network?: Networkish): JsonRpcProvider {
  const request = new FetchRequest(rpcUrl);
  request.timeout = positiveIntEnv("RPC_REQUEST_TIMEOUT_MS", 15_000);

  return new JsonRpcProvider(request, network, {
    batchMaxCount: 1,
    staticNetwork: network == null ? null : true,
    cacheTimeout: positiveIntEnv("RPC_CACHE_TIMEOUT_MS", 1_000),
  });
}
