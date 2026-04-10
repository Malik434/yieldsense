import { type Log, JsonRpcProvider } from "ethers";

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
  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    totalChunks += 1;
    try {
      const batch = await provider.getLogs({
        address: filter.address as `0x${string}`,
        topics: filter.topics ? [...filter.topics] : undefined,
        fromBlock: start,
        toBlock: end,
      });
      logs.push(...batch);
    } catch {
      failedChunks += 1;
    }
    start = end + 1;
  }
  return { logs, failedChunks, totalChunks };
}

export async function getBlockTimestamp(provider: JsonRpcProvider, blockNumber: number): Promise<number> {
  const block = await provider.getBlock(blockNumber);
  if (!block) throw new Error(`block ${blockNumber} not found`);
  return block.timestamp;
}
