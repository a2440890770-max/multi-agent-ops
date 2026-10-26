import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const path = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(path)) process.loadEnvFile(path);
if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL，请先运行 pnpm env:setup。');
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(
    'CREATE TEMP TABLE d1_probe (id integer PRIMARY KEY, message text NOT NULL) ON COMMIT DROP',
  );
  await client.query('INSERT INTO d1_probe VALUES ($1, $2)', [1, 'd1-ready']);
  const result = await client.query('SELECT message FROM d1_probe WHERE id = $1', [1]);
  if (result.rows[0]?.message !== 'd1-ready') throw new Error('数据库读写检查失败');
  await client.query('COMMIT');
  console.log('数据库连接及临时表读写检查通过；未写入业务数据。');
} finally {
  await client.end();
}
