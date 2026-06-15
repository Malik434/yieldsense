import { sql } from 'drizzle-orm';
import {
  check,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { GridProcessorLease } from '@/lib/gridProcessorLease';
import type { YieldProcessorLease } from '@/lib/yieldProcessorLease';

export const gridStrategies = pgTable(
  'grid_strategies',
  {
    strategyId: text('strategy_id').primaryKey(),
    ownerAddress: text('owner_address').notNull(),
    chainId: integer('chain_id').notNull(),
    pairId: text('pair_id').notNull(),
    status: text('status').notNull(),
    lowerPrice: doublePrecision('lower_price').notNull(),
    upperPrice: doublePrecision('upper_price').notNull(),
    gridMode: text('grid_mode').notNull(),
    gridCount: integer('grid_count').notNull(),
    tradeSizeQuote: text('trade_size_quote').notNull(),
    triggerPrice: doublePrecision('trigger_price'),
    stopLossPrice: doublePrecision('stop_loss_price'),
    takeProfitPrice: doublePrecision('take_profit_price'),
    maxSlippageBps: integer('max_slippage_bps').notNull(),
    executionIntervalSec: integer('execution_interval_sec').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      'grid_strategies_status_check',
      sql`${table.status} IN ('draft', 'funded', 'active', 'paused', 'gas_paused', 'archived', 'closed')`
    ),
    check('grid_strategies_grid_mode_check', sql`${table.gridMode} IN ('arithmetic', 'geometric')`),
    index('grid_strategies_chain_status_idx').on(table.chainId, table.status),
    index('grid_strategies_owner_chain_idx').on(table.ownerAddress, table.chainId),
    index('grid_strategies_active_idx')
      .on(table.chainId, table.strategyId)
      .where(sql`${table.status} = 'active'`),
  ]
);

export const gridProcessorLeases = pgTable(
  'grid_processor_leases',
  {
    chainId: integer('chain_id').primaryKey(),
    version: integer('version').notNull().default(0),
    state: text('state').notNull(),
    lease: jsonb('lease').$type<GridProcessorLease>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('grid_processor_leases_state_idx').on(table.state),
    index('grid_processor_leases_updated_at_idx').on(table.updatedAt.desc()),
  ]
);

export const yieldProcessorLeases = pgTable(
  'yield_processor_leases',
  {
    chainId: integer('chain_id').primaryKey(),
    version: integer('version').notNull().default(0),
    enabled: boolean('enabled').notNull().default(false),
    state: text('state').notNull(),
    lease: jsonb('lease').$type<YieldProcessorLease>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'yield_processor_leases_state_check',
      sql`${table.state} IN ('disabled', 'inactive', 'deploying', 'active', 'updating', 'handoff', 'failed')`
    ),
    index('yield_processor_leases_enabled_state_idx').on(table.enabled, table.state),
    index('yield_processor_leases_updated_at_idx').on(table.updatedAt.desc()),
  ]
);

export type GridStrategyRow = typeof gridStrategies.$inferSelect;
export type NewGridStrategyRow = typeof gridStrategies.$inferInsert;
export type GridProcessorLeaseRow = typeof gridProcessorLeases.$inferSelect;
export type YieldProcessorLeaseRow = typeof yieldProcessorLeases.$inferSelect;
