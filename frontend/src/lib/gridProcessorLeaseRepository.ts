import {
  emptyGridProcessorLease,
  type GridProcessorLease,
} from './gridProcessorLease';
import { eq } from 'drizzle-orm';
import { db, gridProcessorLeases } from '@/db';

const globalForLeaseRepo = globalThis as typeof globalThis & {
  __yieldsenseGridProcessorLeases?: Map<string, GridProcessorLease>;
};

const memoryLeases =
  globalForLeaseRepo.__yieldsenseGridProcessorLeases ||
  (globalForLeaseRepo.__yieldsenseGridProcessorLeases = new Map());

function leaseKey(chainId: number) {
  return `grid_processor_lease_${chainId}`;
}

function isMissingNetlifyDatabase(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Missing Netlify Database connection');
}

export async function getGridProcessorLease(chainId: number): Promise<GridProcessorLease> {
  const key = leaseKey(chainId);
  try {
    const rows = await db
      .select({ lease: gridProcessorLeases.lease })
      .from(gridProcessorLeases)
      .where(eq(gridProcessorLeases.chainId, chainId))
      .limit(1);
    if (rows[0]?.lease) return rows[0].lease;
  } catch (error) {
    if (!isMissingNetlifyDatabase(error)) throw error;
  }

  return memoryLeases.get(key) ?? emptyGridProcessorLease(chainId);
}

export async function saveGridProcessorLease(lease: GridProcessorLease): Promise<GridProcessorLease> {
  const next = { ...lease, version: lease.version + 1, updatedAt: new Date().toISOString() };
  const key = leaseKey(next.chainId);
  try {
    await db
      .insert(gridProcessorLeases)
      .values({
        chainId: next.chainId,
        version: next.version,
        state: next.state,
        lease: next,
        updatedAt: new Date(next.updatedAt),
      })
      .onConflictDoUpdate({
        target: gridProcessorLeases.chainId,
        set: {
          version: next.version,
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
