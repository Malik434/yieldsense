/**
 * RPC utility helpers for the YieldSense frontend.
 *
 * Key problems solved:
 *  1. Public Base RPC limits eth_getLogs to 10,000 blocks per request.
 *     `getLogsPaginated` chunks the range automatically.
 *  2. Heavy RPC responses (audit/history) are cached in memory so repeated
 *     page-loads and interval polls never fire duplicate requests within the
 *     TTL window.
 */

import type { PublicClient, AbiEvent } from 'viem';

// ─── Chunked getLogs ────────────────────────────────────────────────────────

/** Max blocks the public Base RPC allows per eth_getLogs call (limit is 10,000). */
const CHUNK_SIZE = BigInt(9000);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Global queue to serialize all getLogsPaginated calls across the server
let _rpcQueue = Promise.resolve();

/**
 * Fetch logs over an arbitrarily large block range by splitting into
 * ≤CHUNK_SIZE chunks and merging results.
 *
 * Includes a global mutex queue + 250ms delay to prevent Promise.all() 
 * from instantly hitting the public RPC rate limits.
 */
export async function getLogsPaginated(
  client: PublicClient,
  args: {
    address: `0x${string}`;
    event: AbiEvent;
    fromBlock: bigint;
    toBlock?: bigint | 'latest';
  }
): Promise<any[]> {
  const latestBlock = await client.getBlockNumber();
  const toBlock = args.toBlock === 'latest' || args.toBlock == null ? latestBlock : args.toBlock;

  const results: any[] = [];
  let from = args.fromBlock;

  while (from <= toBlock) {
    const chunkEnd = from + CHUNK_SIZE - BigInt(1);
    const to = chunkEnd < toBlock ? chunkEnd : toBlock;
    
    // Execute RPC call in the global queue to prevent rate-limit bombardment
    const chunk = await new Promise<any[]>((resolve, reject) => {
      _rpcQueue = _rpcQueue.then(async () => {
        try {
          await delay(250); // 250ms spacing between all RPC calls globally
          const res = await client.getLogs({
            address: args.address,
            event: args.event,
            fromBlock: from,
            toBlock: to,
          });
          resolve(res as any[]);
        } catch (err) {
          reject(err);
        }
      });
    });

    results.push(...chunk);
    from = to + BigInt(1);
  }

  return results;
}

// ─── Server-side in-memory cache ────────────────────────────────────────────

type CacheEntry<T> = { data: T; expiresAt: number };
const _cache = new Map<string, CacheEntry<unknown>>();

/**
 * Wraps an async factory with a simple TTL cache.
 * All heavy RPC calls (audit, portfolio-history) should go through this.
 *
 * @param key      Unique cache key (include user address + chainId).
 * @param ttlMs    How long to cache the result (default: 3 minutes).
 * @param factory  Async function that fetches fresh data.
 */
export async function withCache<T>(
  key: string,
  factory: () => Promise<T>,
  ttlMs = 3 * 60 * 1000
): Promise<T> {
  const now = Date.now();
  const hit = _cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.data;

  const data = await factory();
  _cache.set(key, { data, expiresAt: now + ttlMs });
  return data;
}
