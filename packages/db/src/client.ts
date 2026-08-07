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

/**
 * A database handle that is either the root client or an open transaction, for
 * helpers that must run in both contexts. A drizzle transaction handle exposes
 * the same query/insert/update/delete/transaction surface as the root client
 * (a nested `transaction` becomes a savepoint), so a helper typed on this can be
 * called standalone or threaded into a caller's transaction without a cast.
 */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
