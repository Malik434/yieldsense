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
  readonly #urls: string[];
  #currentUrlIndex: number = 0;
  readonly #timeoutMs: number;

  constructor(urls: string | string[], network?: Networkish, options?: JsonRpcApiProviderOptions) {
    super(network, options);
    this.#urls = Array.isArray(urls) ? urls : [urls];
    this.#timeoutMs = positiveIntEnv("RPC_REQUEST_TIMEOUT_MS", 6_000);
    this._start();
  }

  async _send(payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult | JsonRpcError>> {
    return runQueuedRpc(() => this.#sendWithFailover(payload));
  }

  async #sendWithFailover(payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult | JsonRpcError>> {
    const method = firstPayloadMethod(payload);
    let lastError: any;

    // Try up to 3 URLs in our list
    const maxTries = Math.min(this.#urls.length, 3);
    for (let i = 0; i < maxTries; i++) {
      const url = this.#urls[this.#currentUrlIndex];
      try {
        return await this.#sendNow(url, payload);
      } catch (error) {
        lastError = error;
        const msg = String(error);
        
        // If it's a 429 or timeout, rotate to the next URL immediately
        if (msg.includes("429") || msg.includes("timed out") || msg.includes("500") || msg.includes("503")) {
          const oldHost = rpcHost(url);
          this.#currentUrlIndex = (this.#currentUrlIndex + 1) % this.#urls.length;
          const newHost = rpcHost(this.#urls[this.#currentUrlIndex]);
          console.warn(`[RPC_FAILOVER] ${method} failed on ${oldHost} (${msg}). Rotating to ${newHost}.`);
        } else {
          // If it's a logic error (revert), don't bother rotating, just throw
          throw error;
        }
      }
    }
    throw lastError;
  }

  async #sendNow(rpcUrl: string, payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult | JsonRpcError>> {
    const method = firstPayloadMethod(payload);
    await emitRpcTransportTelemetry("attempt", rpcUrl, method);

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const json = await Promise.race([
        (async () => {
          const response = await fetch(rpcUrl, {
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
      await emitRpcTransportTelemetry("result", rpcUrl, method, { count: result.length });
      return result;
    } catch (error) {
      const err = error as { name?: string; message?: string };
      await emitRpcTransportTelemetry("error", rpcUrl, method, {
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
 * We handle rotation internally in NativeFetchJsonRpcProvider if the primary URL
 * hits a 429 or timeout.
 */
export function createJsonRpcProvider(rpcUrl: string, network?: Networkish): JsonRpcApiProvider {
  const fallbacks = (process.env.RPC_FALLBACK_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  
  const urls = [rpcUrl.trim(), ...fallbacks.map(u => u.trim())];

  return new NativeFetchJsonRpcProvider(urls, network, {
    batchMaxCount: 1,
    staticNetwork: network == null ? null : true,
    cacheTimeout: positiveIntEnv("RPC_CACHE_TIMEOUT_MS", 1_000),
  });
}
