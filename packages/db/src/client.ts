import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/**
 * Creates a Drizzle client bound to a Supabase Postgres connection string.
 * The API owns all DB access; keys never reach the client.
 */
export function createDb(connectionString: string) {
  const client = postgres(connectionString, { prepare: false });
  return drizzle({ client, schema, casing: 'snake_case' });
}

export type Db = ReturnType<typeof createDb>;
