import { gridStore, type StoredGridStrategy } from './gridStore';
import { queryPostgres } from './postgres';

const globalForGridStrategyRepo = globalThis as typeof globalThis & {
  __yieldsenseGridStrategyCollections?: Map<number, StoredGridStrategy[]>;
  __yieldsenseGridStrategySchemaReady?: Promise<void>;
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

type GridStrategyRow = {
  strategy_id: string;
  owner_address: string;
  chain_id: number;
  pair_id: string;
  status: StoredGridStrategy['status'];
  lower_price: string | number;
  upper_price: string | number;
  grid_mode: StoredGridStrategy['gridMode'];
  grid_count: number;
  trade_size_quote: string;
  trigger_price: string | number | null;
  stop_loss_price: string | number | null;
  take_profit_price: string | number | null;
  max_slippage_bps: number;
  execution_interval_sec: number;
  created_at: Date | string;
  updated_at: Date | string;
};

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToStrategy(row: GridStrategyRow): StoredGridStrategy {
  return {
    strategyId: row.strategy_id,
    owner: row.owner_address as StoredGridStrategy['owner'],
    chainId: Number(row.chain_id),
    pairId: row.pair_id,
    status: row.status,
    lowerPrice: Number(row.lower_price),
    upperPrice: Number(row.upper_price),
    gridMode: row.grid_mode,
    gridCount: Number(row.grid_count),
    tradeSizeQuote: row.trade_size_quote,
    triggerPrice: row.trigger_price == null ? null : Number(row.trigger_price),
    stopLossPrice: row.stop_loss_price == null ? null : Number(row.stop_loss_price),
    takeProfitPrice: row.take_profit_price == null ? null : Number(row.take_profit_price),
    maxSlippageBps: Number(row.max_slippage_bps),
    executionIntervalSec: Number(row.execution_interval_sec),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function ensureGridStrategySchema() {
  if (!globalForGridStrategyRepo.__yieldsenseGridStrategySchemaReady) {
    globalForGridStrategyRepo.__yieldsenseGridStrategySchemaReady = (async () => {
      const result = await queryPostgres(`
        CREATE TABLE IF NOT EXISTS grid_strategies (
          strategy_id text PRIMARY KEY,
          owner_address text NOT NULL,
          chain_id integer NOT NULL,
          pair_id text NOT NULL,
          status text NOT NULL CHECK (status IN ('draft', 'funded', 'active', 'paused', 'gas_paused', 'archived', 'closed')),
          lower_price double precision NOT NULL,
          upper_price double precision NOT NULL,
          grid_mode text NOT NULL CHECK (grid_mode IN ('arithmetic', 'geometric')),
          grid_count integer NOT NULL,
          trade_size_quote text NOT NULL,
          trigger_price double precision,
          stop_loss_price double precision,
          take_profit_price double precision,
          max_slippage_bps integer NOT NULL,
          execution_interval_sec integer NOT NULL,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        )
      `);
      if (!result) return;
      await queryPostgres(`
        CREATE INDEX IF NOT EXISTS grid_strategies_chain_status_idx
        ON grid_strategies (chain_id, status)
      `);
      await queryPostgres(`
        CREATE INDEX IF NOT EXISTS grid_strategies_owner_chain_idx
        ON grid_strategies (owner_address, chain_id)
      `);
      await queryPostgres(`
        CREATE INDEX IF NOT EXISTS grid_strategies_active_idx
        ON grid_strategies (chain_id, strategy_id)
        WHERE status = 'active'
      `);
    })();
  }
  return globalForGridStrategyRepo.__yieldsenseGridStrategySchemaReady;
}

async function readMemoryStrategies(chainId: number): Promise<StoredGridStrategy[]> {
  return memoryCollections.get(chainId) ?? Array.from(gridStore.strategies.values()).filter((strategy) => strategy.chainId === chainId);
}

export async function listGridStrategies(filters: {
  chainId: number;
  owner?: string | null;
  status?: StoredGridStrategy['status'] | string | null;
}): Promise<StoredGridStrategy[]> {
  await ensureGridStrategySchema();
  const clauses = ['chain_id = $1'];
  const values: unknown[] = [filters.chainId];
  if (filters.owner) {
    values.push(filters.owner.toLowerCase());
    clauses.push(`lower(owner_address) = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }

  const result = await queryPostgres<GridStrategyRow>(
    `SELECT * FROM grid_strategies WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`,
    values
  );
  if (result) return result.rows.map(rowToStrategy);

  const strategies = await readMemoryStrategies(filters.chainId);
  return strategies.filter((strategy) => {
    if (strategy.chainId !== filters.chainId) return false;
    if (filters.owner && strategy.owner.toLowerCase() !== filters.owner.toLowerCase()) return false;
    if (filters.status && strategy.status !== filters.status) return false;
    return true;
  });
}

export async function upsertGridStrategy(strategy: StoredGridStrategy) {
  await ensureGridStrategySchema();
  const result = await queryPostgres(
    `
      INSERT INTO grid_strategies (
        strategy_id, owner_address, chain_id, pair_id, status, lower_price,
        upper_price, grid_mode, grid_count, trade_size_quote, trigger_price,
        stop_loss_price, take_profit_price, max_slippage_bps,
        execution_interval_sec, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (strategy_id) DO UPDATE SET
        owner_address = EXCLUDED.owner_address,
        chain_id = EXCLUDED.chain_id,
        pair_id = EXCLUDED.pair_id,
        status = EXCLUDED.status,
        lower_price = EXCLUDED.lower_price,
        upper_price = EXCLUDED.upper_price,
        grid_mode = EXCLUDED.grid_mode,
        grid_count = EXCLUDED.grid_count,
        trade_size_quote = EXCLUDED.trade_size_quote,
        trigger_price = EXCLUDED.trigger_price,
        stop_loss_price = EXCLUDED.stop_loss_price,
        take_profit_price = EXCLUDED.take_profit_price,
        max_slippage_bps = EXCLUDED.max_slippage_bps,
        execution_interval_sec = EXCLUDED.execution_interval_sec,
        updated_at = EXCLUDED.updated_at
    `,
    [
      strategy.strategyId,
      strategy.owner,
      strategy.chainId,
      strategy.pairId,
      strategy.status,
      strategy.lowerPrice,
      strategy.upperPrice,
      strategy.gridMode,
      strategy.gridCount,
      strategy.tradeSizeQuote,
      strategy.triggerPrice,
      strategy.stopLossPrice,
      strategy.takeProfitPrice,
      strategy.maxSlippageBps,
      strategy.executionIntervalSec,
      strategy.createdAt,
      strategy.updatedAt,
    ]
  );

  if (!result) {
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
  await ensureGridStrategySchema();
  const updatedAt = new Date().toISOString();
  const result = await queryPostgres<GridStrategyRow>(
    `
      UPDATE grid_strategies
      SET status = $3, updated_at = $4
      WHERE chain_id = $1 AND strategy_id = $2
      RETURNING *
    `,
    [chainId, strategyId, status, updatedAt]
  );
  if (result) return result.rows[0] ? rowToStrategy(result.rows[0]) : null;

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
