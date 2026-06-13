import {
  emptyGridProcessorLease,
  type GridProcessorLease,
} from './gridProcessorLease';
import { queryPostgres } from './postgres';

const globalForLeaseRepo = globalThis as typeof globalThis & {
  __yieldsenseGridProcessorLeases?: Map<string, GridProcessorLease>;
  __yieldsenseGridProcessorLeaseSchemaReady?: Promise<void>;
};

const memoryLeases =
  globalForLeaseRepo.__yieldsenseGridProcessorLeases ||
  (globalForLeaseRepo.__yieldsenseGridProcessorLeases = new Map());

function leaseKey(chainId: number) {
  return `grid_processor_lease_${chainId}`;
}

type GridProcessorLeaseRow = {
  chain_id: number;
  version: number;
  state: GridProcessorLease['state'];
  lease: GridProcessorLease;
  updated_at: Date | string;
};

async function ensureGridProcessorLeaseSchema() {
  if (!globalForLeaseRepo.__yieldsenseGridProcessorLeaseSchemaReady) {
    globalForLeaseRepo.__yieldsenseGridProcessorLeaseSchemaReady = (async () => {
      const result = await queryPostgres(`
        CREATE TABLE IF NOT EXISTS grid_processor_leases (
          chain_id integer PRIMARY KEY,
          version integer NOT NULL DEFAULT 0,
          state text NOT NULL,
          lease jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      if (!result) return;
      await queryPostgres(`
        CREATE INDEX IF NOT EXISTS grid_processor_leases_state_idx
        ON grid_processor_leases (state)
      `);
      await queryPostgres(`
        CREATE INDEX IF NOT EXISTS grid_processor_leases_updated_at_idx
        ON grid_processor_leases (updated_at DESC)
      `);
    })();
  }
  return globalForLeaseRepo.__yieldsenseGridProcessorLeaseSchemaReady;
}

export async function getGridProcessorLease(chainId: number): Promise<GridProcessorLease> {
  const key = leaseKey(chainId);
  await ensureGridProcessorLeaseSchema();

  const result = await queryPostgres<GridProcessorLeaseRow>(
    'SELECT lease FROM grid_processor_leases WHERE chain_id = $1',
    [chainId]
  );
  if (result?.rows[0]?.lease) return result.rows[0].lease;

  return memoryLeases.get(key) ?? emptyGridProcessorLease(chainId);
}

export async function saveGridProcessorLease(lease: GridProcessorLease): Promise<GridProcessorLease> {
  const next = { ...lease, version: lease.version + 1, updatedAt: new Date().toISOString() };
  const key = leaseKey(next.chainId);
  await ensureGridProcessorLeaseSchema();

  const result = await queryPostgres(
    `
      INSERT INTO grid_processor_leases (chain_id, version, state, lease, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (chain_id) DO UPDATE SET
        version = EXCLUDED.version,
        state = EXCLUDED.state,
        lease = EXCLUDED.lease,
        updated_at = EXCLUDED.updated_at
    `,
    [next.chainId, next.version, next.state, JSON.stringify(next), next.updatedAt]
  );

  if (!result) {
    memoryLeases.set(key, next);
  }
  return next;
}
