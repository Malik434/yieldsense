import { drizzle } from 'drizzle-orm/netlify-db';
import * as schema from './schema';

function createDb() {
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
