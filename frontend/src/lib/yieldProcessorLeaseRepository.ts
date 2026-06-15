import { eq } from 'drizzle-orm';
import { db, yieldProcessorLeases } from '@/db';
import {
  emptyYieldProcessorLease,
  type YieldProcessorLease,
} from './yieldProcessorLease';

const globalForYieldLeaseRepo = globalThis as typeof globalThis & {
  __yieldsenseYieldProcessorLeases?: Map<string, YieldProcessorLease>;
};

const memoryLeases =
  globalForYieldLeaseRepo.__yieldsenseYieldProcessorLeases ||
  (globalForYieldLeaseRepo.__yieldsenseYieldProcessorLeases = new Map());

function leaseKey(chainId: number) {
  return `yield_processor_lease_${chainId}`;
}

function isMissingNetlifyDatabase(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Missing Netlify Database connection');
}

export async function getYieldProcessorLease(chainId: number): Promise<YieldProcessorLease> {
  const key = leaseKey(chainId);
  try {
    const rows = await db
      .select({ lease: yieldProcessorLeases.lease })
      .from(yieldProcessorLeases)
      .where(eq(yieldProcessorLeases.chainId, chainId))
      .limit(1);
    if (rows[0]?.lease) return rows[0].lease;
  } catch (error) {
    if (!isMissingNetlifyDatabase(error)) throw error;
  }

  return memoryLeases.get(key) ?? emptyYieldProcessorLease(chainId);
}

export async function saveYieldProcessorLease(lease: YieldProcessorLease): Promise<YieldProcessorLease> {
  const next = { ...lease, version: lease.version + 1, updatedAt: new Date().toISOString() };
  const key = leaseKey(next.chainId);
  try {
    await db
      .insert(yieldProcessorLeases)
      .values({
        chainId: next.chainId,
        version: next.version,
        enabled: next.enabled,
        state: next.state,
        lease: next,
        updatedAt: new Date(next.updatedAt),
      })
      .onConflictDoUpdate({
        target: yieldProcessorLeases.chainId,
        set: {
          version: next.version,
          enabled: next.enabled,
          state: next.state,
          lease: next,
          updatedAt: new Date(next.updatedAt),
        },
      });
  } catch (error) {
    if (!isMissingNetlifyDatabase(error)) throw error;
    memoryLeases.set(key, next);
  }
  return next;
}
