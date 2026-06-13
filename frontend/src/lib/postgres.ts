import type { Pool, QueryResult, QueryResultRow } from 'pg';

const globalForPostgres = globalThis as typeof globalThis & {
  __yieldsensePgPool?: Pool;
};

function databaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NETLIFY_DATABASE_URL ||
    ''
  ).trim();
}

function shouldUseSsl(url: string) {
  return Boolean(url) && !url.includes('localhost') && !url.includes('127.0.0.1');
}

export function isPostgresConfigured() {
  return Boolean(databaseUrl());
}

export async function getPostgresPool(): Promise<Pool | null> {
  const url = databaseUrl();
  if (!url) return null;

  if (!globalForPostgres.__yieldsensePgPool) {
    const { Pool } = await import('pg');
    globalForPostgres.__yieldsensePgPool = new Pool({
      connectionString: url,
      max: Number(process.env.POSTGRES_POOL_MAX || '3'),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      ssl: shouldUseSsl(url) ? { rejectUnauthorized: false } : undefined,
    });
  }

  return globalForPostgres.__yieldsensePgPool;
}

export async function queryPostgres<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<QueryResult<T> | null> {
  const pool = await getPostgresPool();
  if (!pool) return null;
  return pool.query<T>(text, values);
}
