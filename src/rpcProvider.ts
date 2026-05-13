import {
  JsonRpcApiProvider,
  type JsonRpcApiProviderOptions,
  type JsonRpcError,
  type JsonRpcPayload,
  type JsonRpcResult,
  type Networkish,
} from "ethers";
import { emitTelemetry } from "./telemetry.js";

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const telemetryMethodsReported = new Set<string>();
let rpcQueue: Promise<void> = Promise.resolve();

function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

function firstPayloadMethod(payload: JsonRpcPayload | Array<JsonRpcPayload>): string {
  const first = Array.isArray(payload) ? payload[0] : payload;
  return first?.method ?? "unknown";
}

async function emitRpcTransportTelemetry(
  stage: "attempt" | "result" | "error",
  rpcUrl: string,
  method: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  const key = `${stage}:${rpcHost(rpcUrl)}:${method}`;
  if (telemetryMethodsReported.has(key)) return;
  telemetryMethodsReported.add(key);

  await emitTelemetry({
    event: "rpc_transport",
    timestamp: Math.floor(Date.now() / 1000),
    stage,
    method,
    rpcHost: rpcHost(rpcUrl),
    transport: "native_fetch",
    ...details,
  }).catch(() => {});
}

async function runQueuedRpc<T>(task: () => Promise<T>): Promise<T> {
  const run = rpcQueue.catch(() => undefined).then(task);
  rpcQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

class NativeFetchJsonRpcProvider extends JsonRpcApiProvider {
  readonly #rpcUrl: string;
  readonly #timeoutMs: number;

  constructor(rpcUrl: string, network?: Networkish, options?: JsonRpcApiProviderOptions) {
    super(network, options);
    this.#rpcUrl = rpcUrl;
    this.#timeoutMs = positiveIntEnv("RPC_REQUEST_TIMEOUT_MS", 6_000);
    this._start();
  }

  async _send(payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult | JsonRpcError>> {
    return runQueuedRpc(() => this.#sendNow(payload));
  }

  async #sendNow(payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult | JsonRpcError>> {
    const method = firstPayloadMethod(payload);
    await emitRpcTransportTelemetry("attempt", this.#rpcUrl, method);

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const json = await Promise.race([
        (async () => {
          const response = await fetch(this.#rpcUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(`JSON-RPC HTTP ${response.status}`);
          }

          return (await response.json()) as JsonRpcResult | JsonRpcError | Array<JsonRpcResult | JsonRpcError>;
        })(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            try {
              controller.abort();
            } catch {
              // Some Acurast runtimes expose fetch without a fully functional abort.
            }
            reject(new Error(`JSON-RPC ${method} timed out after ${this.#timeoutMs}ms`));
          }, this.#timeoutMs);
        }),
      ]);
      const result = Array.isArray(json) ? json : [json];
      await emitRpcTransportTelemetry("result", this.#rpcUrl, method, { count: result.length });
      return result;
    } catch (error) {
      const err = error as { name?: string; message?: string };
      await emitRpcTransportTelemetry("error", this.#rpcUrl, method, {
        name: err?.name,
        message: err?.message ?? String(error),
      });
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}

/**
 * Sequential Failover Provider:
 * We don't use Ethers' FallbackProvider because it probes all endpoints on boot,
 * which can trigger rate-limits on free tiers or cause 10-minute "quiesce" hangs.
 * Instead, we return a provider that uses the primary URL, and we'll handle
 * rotation at the application level if needed, or rely on a simple try/catch.
 */
export function createJsonRpcProvider(rpcUrl: string, network?: Networkish): JsonRpcApiProvider {
  const fallbacks = (process.env.RPC_FALLBACK_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  
  const urls = [rpcUrl.trim(), ...fallbacks.map(u => u.trim())];

  return new NativeFetchJsonRpcProvider(urls[0], network, {
    batchMaxCount: 1,
    staticNetwork: network == null ? null : true,
    cacheTimeout: positiveIntEnv("RPC_CACHE_TIMEOUT_MS", 1_000),
  });
}
