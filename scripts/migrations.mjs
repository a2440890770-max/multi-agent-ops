import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { loadEnvironment, safeError } from './postgres-admin.mjs';
import { businessTables, firstDifference, inspectBusinessSchema } from './migration-catalog.mjs';

export const migrationsFolder = fileURLToPath(new URL('../backend/drizzle/', import.meta.url));
const ledger = 'drizzle.__drizzle_migrations';

export function validateBusinessTarget(env) {
  if (!env.DATABASE_URL) throw new Error('缺少业务 DATABASE_URL。');
  const url = new URL(env.DATABASE_URL);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !database)
    throw new Error('DATABASE_URL 必须明确指定 PostgreSQL 业务数据库。');
  const memoryName = env.MEM0_DATABASE_URL
    ? decodeURIComponent(new URL(env.MEM0_DATABASE_URL).pathname.slice(1))
    : null;
  if (
    ['postgres', 'template0', 'template1', 'agent_memory', 'multi_agent_memory'].includes(
      database,
    ) ||
    database.startsWith('mem0_') ||
    database === memoryName
  )
    throw new Error('禁止向系统数据库或记忆数据库应用业务迁移。');
  return url;
}

async function readHistory(client) {
  const exists = await client.query('SELECT to_regclass($1) AS name', [ledger]);
  if (!exists.rows[0].name) return [];
  return (await client.query(`SELECT hash, created_at FROM ${ledger} ORDER BY created_at, id`))
    .rows;
}

function validateHistory(history, migrations) {
  for (const [i, row] of history.entries()) {
    const file = migrations[i];
    if (!file || row.hash !== file.hash || Number(row.created_at) !== file.folderMillis)
      throw new Error(
        '迁移历史与本地 SQL 不一致；请恢复原迁移文件或使用对应版本的源码，禁止覆盖已应用的迁移。',
      );
  }
}

async function createLedger(client) {
  await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
  await client.query(`CREATE TABLE IF NOT EXISTS ${ledger} (
    id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
  )`);
}

// One connection, transaction and advisory lock cover inspection, DDL and ledger.
// No runtime startup imports this module to run migrations automatically.
export async function runMigrations(client, action, folder = migrationsFolder) {
  if (!['migrate', 'baseline', 'status'].includes(action))
    throw new Error('只支持 migrate / baseline / status。');
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  if (!migrations.length) throw new Error('没有可应用的 SQL 迁移。');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SET LOCAL search_path = public, pg_catalog');
    await client.query('SELECT pg_advisory_xact_lock(1835100527, 168101)');
    const history = await readHistory(client);
    validateHistory(history, migrations);
    if (action === 'status') {
      await client.query('COMMIT');
      return { applied: history.length, pending: migrations.length - history.length };
    }
    if (action === 'baseline') {
      if (history.length) {
        await client.query('COMMIT');
        return { baselined: false, alreadyApplied: true };
      }
      // Prevent concurrent DDL/writes while checking and adopting existing tables.
      // Missing tables or non-table relations fail before any ledger is written.
      for (const name of businessTables)
        await client.query(`LOCK TABLE public."${name}" IN SHARE MODE`);
      const manifest = JSON.parse(
        await readFile(resolve(folder, '0000_baseline.catalog.json'), 'utf8'),
      );
      if (manifest.sqlHash !== migrations[0].hash)
        throw new Error('初始 SQL 与结构核对文件不一致，拒绝登记基线。');
      const actual = await inspectBusinessSchema(client);
      const difference = firstDifference(manifest.schema, actual);
      if (difference)
        throw new Error(`现有结构与初始迁移不一致：${difference}；未修改表或登记基线。`);
      await createLedger(client);
      await client.query(`INSERT INTO ${ledger} (hash, created_at) VALUES ($1, $2)`, [
        migrations[0].hash,
        migrations[0].folderMillis,
      ]);
      await client.query('COMMIT');
      return { baselined: true, tablesVerified: businessTables.length };
    }
    if (!history.length) {
      const existing = await client.query(
        "SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass('public.' || name) IS NOT NULL",
        [businessTables],
      );
      if (existing.rowCount)
        throw new Error(
          '发现已有业务表但没有迁移记录；请先备份，再运行 npm run db:baseline 核对并登记，禁止重复建表。',
        );
    }
    await createLedger(client);
    for (const migration of migrations.slice(history.length)) {
      for (const statement of migration.sql) if (statement.trim()) await client.query(statement);
      await client.query(`INSERT INTO ${ledger} (hash, created_at) VALUES ($1, $2)`, [
        migration.hash,
        migration.folderMillis,
      ]);
    }
    await client.query('COMMIT');
    return { applied: migrations.length - history.length, pending: 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  loadEnvironment();
  const url = validateBusinessTarget(process.env);
  const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await runMigrations(client, process.argv[2]);
    console.log(JSON.stringify({ database: decodeURIComponent(url.pathname.slice(1)), ...result }));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
