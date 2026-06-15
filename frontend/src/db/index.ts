import { drizzle } from 'drizzle-orm/netlify-db';
import * as schema from './schema';

const MISSING_NETLIFY_DATABASE_MESSAGE =
  'Missing Netlify Database connection: NETLIFY_DB_URL environment variable is not set.';

function createDb() {
  if (!process.env.NETLIFY_DB_URL?.trim()) {
    return new Proxy(
      {},
      {
        get() {
          throw new Error(MISSING_NETLIFY_DATABASE_MESSAGE);
        },
      }
    ) as ReturnType<typeof drizzle<typeof schema>>;
  }

  return drizzle({ schema });
}

type AppDb = ReturnType<typeof createDb>;

const globalForDrizzle = globalThis as typeof globalThis & {
  __yieldsenseDrizzleDb?: AppDb;
};

export const db =
  globalForDrizzle.__yieldsenseDrizzleDb ||
  (globalForDrizzle.__yieldsenseDrizzleDb = createDb());

export * from './schema';
