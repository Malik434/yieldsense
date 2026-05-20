import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ethers } from "ethers";

type StorageRecord = Record<string, string>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for mobile Acurast simulation.`);
  return value;
}

function parseStorage(filePath: string): StorageRecord {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as StorageRecord)
      : {};
  } catch {
    return {};
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function persistStorage(filePath: string, storage: StorageRecord, maxBytes: number): void {
  const bytes = serializedBytes(storage);
  if (bytes > maxBytes) {
    throw new Error(`Acurast simulated storage quota exceeded: ${bytes} > ${maxBytes} bytes.`);
  }
  writeFileSync(filePath, JSON.stringify(storage, null, 2), "utf8");
}

function parseBigIntExtra(extra: Record<string, string | undefined>, key: string): bigint | undefined {
  const value = extra[key]?.trim();
  return value ? BigInt(value) : undefined;
}

function requireBigIntExtra(extra: Record<string, string | undefined>, key: string): bigint {
  const value = parseBigIntExtra(extra, key);
  if (value === undefined) {
    throw new Error(`Acurast fulfill ${key} is required for local transaction signing.`);
  }
  return value;
}

function installConstrainedFetch(): void {
  const originalFetch = globalThis.fetch?.bind(globalThis);
  if (!originalFetch) return;

  const latencyMs = intEnv("ACURAST_SIM_NETWORK_LATENCY_MS", 250);
  const jitterMs = intEnv("ACURAST_SIM_NETWORK_JITTER_MS", 250);
  const timeoutMs = intEnv("ACURAST_SIM_FETCH_TIMEOUT_MS", 12_000);
  const maxRequestBytes = intEnv("ACURAST_SIM_MAX_REQUEST_BYTES", 256 * 1024);
  const maxResponseBytes = intEnv("ACURAST_SIM_MAX_RESPONSE_BYTES", 1024 * 1024);
  const bandwidthBytesPerSec = intEnv("ACURAST_SIM_BANDWIDTH_BYTES_PER_SEC", 128 * 1024);
  const maxRequests = intEnv("ACURAST_SIM_MAX_FETCH_REQUESTS", 80);
  let requestCount = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requestCount += 1;
    if (maxRequests > 0 && requestCount > maxRequests) {
      throw new Error(`Acurast simulated network request limit exceeded: ${requestCount} > ${maxRequests}.`);
    }

    const body = init?.body;
    const requestBytes =
      typeof body === "string"
        ? Buffer.byteLength(body, "utf8")
        : body instanceof Uint8Array
          ? body.byteLength
          : 0;
    if (requestBytes > maxRequestBytes) {
      throw new Error(`Acurast simulated request body limit exceeded: ${requestBytes} > ${maxRequestBytes} bytes.`);
    }

    const controller = new AbortController();
    const callerSignal = init?.signal;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortFromCaller();
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const delay = latencyMs + (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0);

    try {
      if (delay > 0) await sleep(delay);
      const response = await originalFetch(input, { ...init, signal: controller.signal });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxResponseBytes) {
        throw new Error(`Acurast simulated response body limit exceeded: ${bytes.byteLength} > ${maxResponseBytes} bytes.`);
      }
      if (bandwidthBytesPerSec > 0) {
        await sleep(Math.ceil((bytes.byteLength / bandwidthBytesPerSec) * 1000));
      }
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
}

function installMobileAcurastStd(): void {
  const wallet = new ethers.Wallet(requiredEnv("ACURAST_WORKER_KEY"));
  const storagePath =
    process.env.LOCAL_ACURAST_STORAGE_PATH?.trim() ||
    join(tmpdir(), "yieldsense-mobile-acurast-storage.json");
  const storageMaxBytes = intEnv("ACURAST_SIM_STORAGE_MAX_BYTES", 64 * 1024);
  const storageOpLatencyMs = intEnv("ACURAST_SIM_STORAGE_LATENCY_MS", 25);
  const storage = parseStorage(storagePath);
  const broadcastEnabled = process.env.ACURAST_SIM_BROADCAST === "true";

  (globalThis as any)._STD_ = {
    signers: {
      secp256k1: {
        sign: (payloadHex: string) => {
          const digest = payloadHex.startsWith("0x") ? payloadHex : `0x${payloadHex}`;
          return wallet.signingKey.sign(digest).serialized;
        },
      },
    },
    chains: {
      ethereum: {
        getAddress: () => wallet.address,
        fulfill: async (
          url: string,
          destination: string,
          payload: string,
          extra: Record<string, string | undefined>,
          success: (operationHash: string) => void,
          error: (messages: string[]) => void
        ) => {
          try {
            const methodSignature = extra.methodSignature;
            if (!methodSignature) throw new Error("Acurast fulfill methodSignature is required.");
            const selector = ethers.id(methodSignature).slice(0, 10);
            const data = `${selector}${payload.replace(/^0x/, "")}`;
            if (!ethers.isHexString(data)) {
              throw new Error(`Acurast fulfill calldata is not valid hex: ${data.length - 2} hex chars.`);
            }

            requireBigIntExtra(extra, "gasLimit");
            requireBigIntExtra(extra, "maxFeePerGas");
            requireBigIntExtra(extra, "maxPriorityFeePerGas");

            if (!broadcastEnabled) {
              const syntheticHash = ethers.keccak256(
                ethers.toUtf8Bytes(`${destination}:${data}:${Date.now()}`)
              );
              console.log(
                `[ACURAST_SIM] Fulfill accepted without broadcast hash=${syntheticHash} ` +
                  `bytes=${(data.length - 2) / 2} selector=${selector}`
              );
              success(syntheticHash);
              return;
            }

            const chainId = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : 8453;
            const provider = new ethers.JsonRpcProvider(url, chainId, {
              batchMaxCount: 1,
              staticNetwork: true,
            });
            const nonce = await provider.getTransactionCount(wallet.address, "pending");
            const rawTransaction = await wallet.signTransaction({
              type: 2,
              chainId,
              nonce,
              to: ethers.getAddress(destination),
              data,
              value: 0n,
              gasLimit: requireBigIntExtra(extra, "gasLimit"),
              maxFeePerGas: requireBigIntExtra(extra, "maxFeePerGas"),
              maxPriorityFeePerGas: requireBigIntExtra(extra, "maxPriorityFeePerGas"),
            });
            const tx = await provider.broadcastTransaction(rawTransaction);
            success(tx.hash);
          } catch (err) {
            error([err instanceof Error ? err.message : String(err)]);
          }
        },
      },
    },
    storage: {
      get: (key: string) => {
        if (storageOpLatencyMs > 0) {
          const started = Date.now();
          while (Date.now() - started < storageOpLatencyMs) {
            // Acurast storage is synchronous; this models small blocking IO latency.
          }
        }
        return storage[key] ?? null;
      },
      set: (key: string, value: string) => {
        storage[key] = value;
        persistStorage(storagePath, storage, storageMaxBytes);
      },
      remove: (key: string) => {
        delete storage[key];
        persistStorage(storagePath, storage, storageMaxBytes);
      },
    },
  };

  console.log(`[ACURAST_SIM] Installed constrained mobile _STD_ for ${wallet.address}`);
  console.log(`[ACURAST_SIM] Storage path: ${storagePath}`);
  console.log(
    `[ACURAST_SIM] Limits storage=${storageMaxBytes}B broadcast=${broadcastEnabled} ` +
      `fetchTimeout=${intEnv("ACURAST_SIM_FETCH_TIMEOUT_MS", 12_000)}ms`
  );
}

installConstrainedFetch();
installMobileAcurastStd();
await import("../src/index.js");
