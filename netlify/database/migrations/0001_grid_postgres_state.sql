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
);

CREATE INDEX IF NOT EXISTS grid_strategies_chain_status_idx
  ON grid_strategies (chain_id, status);

CREATE INDEX IF NOT EXISTS grid_strategies_owner_chain_idx
  ON grid_strategies (owner_address, chain_id);

CREATE INDEX IF NOT EXISTS grid_strategies_active_idx
  ON grid_strategies (chain_id, strategy_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS grid_processor_leases (
  chain_id integer PRIMARY KEY,
  version integer NOT NULL DEFAULT 0,
  state text NOT NULL,
  lease jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grid_processor_leases_state_idx
  ON grid_processor_leases (state);

CREATE INDEX IF NOT EXISTS grid_processor_leases_updated_at_idx
  ON grid_processor_leases (updated_at DESC);
