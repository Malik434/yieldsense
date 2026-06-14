import { gridStore, type StoredGridStrategy } from './gridStore';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, gridStrategies, type GridStrategyRow } from '../../../db';

const globalForGridStrategyRepo = globalThis as typeof globalThis & {
  __yieldsenseGridStrategyCollections?: Map<number, StoredGridStrategy[]>;
};

const memoryCollections =
  globalForGridStrategyRepo.__yieldsenseGridStrategyCollections ||
  (globalForGridStrategyRepo.__yieldsenseGridStrategyCollections = new Map());

function uniqueStrategies(strategies: StoredGridStrategy[]): StoredGridStrategy[] {
  return Array.from(
    strategies
      .reduce((acc, strategy) => acc.set(strategy.strategyId, strategy), new Map<string, StoredGridStrategy>())
      .values()
  );
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToStrategy(row: GridStrategyRow): StoredGridStrategy {
  return {
    strategyId: row.strategyId,
    owner: row.ownerAddress as StoredGridStrategy['owner'],
    chainId: Number(row.chainId),
    pairId: row.pairId,
    status: row.status as StoredGridStrategy['status'],
    lowerPrice: Number(row.lowerPrice),
    upperPrice: Number(row.upperPrice),
    gridMode: row.gridMode as StoredGridStrategy['gridMode'],
    gridCount: Number(row.gridCount),
    tradeSizeQuote: row.tradeSizeQuote,
    triggerPrice: row.triggerPrice == null ? null : Number(row.triggerPrice),
    stopLossPrice: row.stopLossPrice == null ? null : Number(row.stopLossPrice),
    takeProfitPrice: row.takeProfitPrice == null ? null : Number(row.takeProfitPrice),
    maxSlippageBps: Number(row.maxSlippageBps),
    executionIntervalSec: Number(row.executionIntervalSec),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

async function readMemoryStrategies(chainId: number): Promise<StoredGridStrategy[]> {
  return memoryCollections.get(chainId) ?? Array.from(gridStore.strategies.values()).filter((strategy) => strategy.chainId === chainId);
}

function isMissingNetlifyDatabase(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Missing Netlify Database connection');
}

export async function listGridStrategies(filters: {
  chainId: number;
  owner?: string | null;
  status?: StoredGridStrategy['status'] | string | null;
}): Promise<StoredGridStrategy[]> {
  const clauses = [eq(gridStrategies.chainId, filters.chainId)];
  if (filters.owner) {
    clauses.push(eq(sql`lower(${gridStrategies.ownerAddress})`, filters.owner.toLowerCase()));
  }
  if (filters.status) {
    clauses.push(eq(gridStrategies.status, filters.status));
  }

  try {
    const rows = await db
      .select()
      .from(gridStrategies)
      .where(and(...clauses))
      .orderBy(desc(gridStrategies.updatedAt));
    return rows.map(rowToStrategy);
  } catch (error) {
    if (!isMissingNetlifyDatabase(error)) throw error;
  }

  const strategies = await readMemoryStrategies(filters.chainId);
  return strategies.filter((strategy) => {
    if (strategy.chainId !== filters.chainId) return false;
    if (filters.owner && strategy.owner.toLowerCase() !== filters.owner.toLowerCase()) return false;
    if (filters.status && strategy.status !== filters.status) return false;
    return true;
  });
}

export async function upsertGridStrategy(strategy: StoredGridStrategy) {
  try {
    await db
      .insert(gridStrategies)
      .values({
        strategyId: strategy.strategyId,
        ownerAddress: strategy.owner,
        chainId: strategy.chainId,
        pairId: strategy.pairId,
        status: strategy.status,
        lowerPrice: strategy.lowerPrice,
        upperPrice: strategy.upperPrice,
        gridMode: strategy.gridMode,
        gridCount: strategy.gridCount,
        tradeSizeQuote: strategy.tradeSizeQuote,
        triggerPrice: strategy.triggerPrice,
        stopLossPrice: strategy.stopLossPrice,
        takeProfitPrice: strategy.takeProfitPrice,
        maxSlippageBps: strategy.maxSlippageBps,
        executionIntervalSec: strategy.executionIntervalSec,
        createdAt: new Date(strategy.createdAt),
        updatedAt: new Date(strategy.updatedAt),
      })
      .onConflictDoUpdate({
        target: gridStrategies.strategyId,
        set: {
          ownerAddress: strategy.owner,
          chainId: strategy.chainId,
          pairId: strategy.pairId,
          status: strategy.status,
          lowerPrice: strategy.lowerPrice,
          upperPrice: strategy.upperPrice,
          gridMode: strategy.gridMode,
          gridCount: strategy.gridCount,
          tradeSizeQuote: strategy.tradeSizeQuote,
          triggerPrice: strategy.triggerPrice,
          stopLossPrice: strategy.stopLossPrice,
          takeProfitPrice: strategy.takeProfitPrice,
          maxSlippageBps: strategy.maxSlippageBps,
          executionIntervalSec: strategy.executionIntervalSec,
          updatedAt: new Date(strategy.updatedAt),
        },
      });
  } catch (error) {
    if (!isMissingNetlifyDatabase(error)) throw error;
    const existing = await readMemoryStrategies(strategy.chainId);
    memoryCollections.set(strategy.chainId, uniqueStrategies([...existing, strategy]));
  }
  gridStore.strategies.set(strategy.strategyId, strategy);
  return strategy;
}

export async function patchGridStrategyStatus(
  chainId: number,
  strategyId: string,
  status: StoredGridStrategy['status']
): Promise<StoredGridStrategy | null> {
  const updatedAt = new Date().toISOString();
  try {
    const rows = await db
      .update(gridStrategies)
      .set({ status, updatedAt: new Date(updatedAt) })
      .where(and(eq(gridStrategies.chainId, chainId), eq(gridStrategies.strategyId, strategyId)))
      .returning();
    return rows[0] ? rowToStrategy(rows[0]) : null;
  } catch (error) {
    if (!isMissingNetlifyDatabase(error)) throw error;
  }

  const existing = (await readMemoryStrategies(chainId)).find((strategy) => strategy.strategyId === strategyId);
  if (!existing) return null;
  const updated: StoredGridStrategy = { ...existing, status, updatedAt: new Date().toISOString() };
  const strategies = (await readMemoryStrategies(chainId)).map((strategy) =>
    strategy.strategyId === strategyId ? updated : strategy
  );
  memoryCollections.set(chainId, strategies);
  gridStore.strategies.set(strategyId, updated);
  return updated;
}

export async function countActiveGridStrategies(chainId: number) {
  const strategies = await listGridStrategies({ chainId, status: 'active' });
  return strategies.length;
}

export async function listActiveGridStrategyIds(chainId: number) {
  const strategies = await listGridStrategies({ chainId, status: 'active' });
  return strategies.map((strategy) => strategy.strategyId);
}
