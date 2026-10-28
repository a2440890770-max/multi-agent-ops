import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

/** Lazy pool: importing/constructing does not open a connection or migrate anything. */
export function createBusinessDatabase(databaseUrl: string) {
  if (!databaseUrl) throw new Error('缺少业务 DATABASE_URL。');
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
