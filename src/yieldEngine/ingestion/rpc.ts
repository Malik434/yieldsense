import { type Log, JsonRpcProvider } from "ethers";

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** Chunked eth_getLogs with optional checkpoint continuation. */
export async function getLogsChunked(
  provider: JsonRpcProvider,
  filter: {
    address: string;
    topics?: readonly (string | null)[];
  },
  fromBlock: number,
  toBlock: number,
  chunkSize: number
): Promise<{ logs: Log[]; failedChunks: number; totalChunks: number }> {
  const logs: Log[] = [];
  let failedChunks = 0;
  let totalChunks = 0;
  let start = fromBlock;
  const timeoutMs = positiveIntEnv("RPC_LOG_TIMEOUT_MS", 20_000);
  const retries = positiveIntEnv("RPC_LOG_RETRIES", 1);
  const chunkDelayMs = positiveIntEnv("RPC_CHUNK_DELAY_MS", 150);

  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    totalChunks += 1;
    let success = false;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const batch = await withTimeout(
          provider.getLogs({
            address: filter.address as `0x${string}`,
            topics: filter.topics ? [...filter.topics] : undefined,
            fromBlock: start,
            toBlock: end,
          }),
          timeoutMs,
          `eth_getLogs ${start}-${end}`
        );
        logs.push(...batch);
        success = true;
        break;
      } catch {
        if (attempt < retries) {
          await sleep(500 * (attempt + 1));
        }
      }
    }
    if (!success) failedChunks += 1;
    start = end + 1;
    await sleep(chunkDelayMs);
  }
  return { logs, failedChunks, totalChunks };
}

export async function getBlockTimestamp(provider: JsonRpcProvider, blockNumber: number): Promise<number> {
  const block = await withTimeout(
    provider.getBlock(blockNumber),
    positiveIntEnv("RPC_CALL_TIMEOUT_MS", 15_000),
    `eth_getBlockByNumber ${blockNumber}`
  );
  if (!block) throw new Error(`block ${blockNumber} not found`);
  return block.timestamp;
}
