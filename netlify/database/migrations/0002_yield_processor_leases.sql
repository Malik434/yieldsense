CREATE TABLE IF NOT EXISTS yield_processor_leases (
  chain_id integer PRIMARY KEY,
  version integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT false,
  state text NOT NULL CHECK (state IN ('disabled', 'inactive', 'deploying', 'active', 'updating', 'handoff', 'failed')),
  lease jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS yield_processor_leases_enabled_state_idx
  ON yield_processor_leases (enabled, state);

CREATE INDEX IF NOT EXISTS yield_processor_leases_updated_at_idx
  ON yield_processor_leases (updated_at DESC);
