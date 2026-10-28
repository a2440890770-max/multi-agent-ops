import assert from 'node:assert/strict';
import pg from 'pg';
import { parseArgs } from 'node:util';
import { loadEnvironment, safeError } from './postgres-admin.mjs';

const { values } = parseArgs({
  options: { 'persistence-write': { type: 'boolean' }, 'persistence-read': { type: 'boolean' } },
});
if (values['persistence-write'] && values['persistence-read'])
  throw new Error('写入和重启后读取必须分开执行。');
loadEnvironment();
const business = new URL(process.env.DATABASE_URL || '');
const memory = new URL(process.env.MEM0_DATABASE_URL || '');
assert.equal(memory.host, business.host, '必须同实例');
assert.notEqual(memory.pathname, business.pathname, '必须独立数据库');
assert.notEqual(memory.username, business.username, '必须独立角色');
for (const [url, other] of [
  [business, memory],
  [memory, business],
]) {
  const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user',
    );
    assert.ok(Object.values(role.rows[0]).every((v) => v === false));
    const denied = await client.query(
      'SELECT has_database_privilege(current_user, $1, $2) AS allowed',
      [decodeURIComponent(other.pathname.slice(1)), 'CONNECT'],
    );
    assert.equal(denied.rows[0].allowed, false, '运行角色不得连接另一数据库');
    if (url === memory) {
      const vector = await client.query("SELECT vector_dims('[1,2,3]'::vector) AS dimension");
      assert.equal(vector.rows[0].dimension, 3);
      if (values['persistence-write']) {
        await client.query(
          'CREATE TABLE d2_memory_persistence_probe (id integer PRIMARY KEY, value vector(1536) NOT NULL)',
        );
        await client.query('INSERT INTO d2_memory_persistence_probe VALUES (42, $1::vector)', [
          '[' + Array(1536).fill(0.1).join(',') + ']',
        ]);
      }
      if (values['persistence-read']) {
        const stored = await client.query(
          'SELECT vector_dims(value) AS dimension, vector_norm(value) AS norm FROM d2_memory_persistence_probe WHERE id=42',
        );
        assert.equal(stored.rows[0]?.dimension, 1536);
        assert.ok(Number(stored.rows[0]?.norm) > 0);
        await client.query('DROP TABLE d2_memory_persistence_probe');
      }
    }
  } catch (error) {
    console.error(safeError(error));
    process.exitCode = 1;
  } finally {
    await client.end();
  }
  const cross = new URL(other);
  cross.username = url.username;
  cross.password = url.password;
  const crossClient = new pg.Client({
    connectionString: cross.href,
    connectionTimeoutMillis: 5000,
  });
  try {
    await crossClient.connect();
    throw new Error('角色实际跨库连接未被拒绝');
  } catch (error) {
    if (error.code !== '42501') {
      console.error(safeError(error));
      process.exitCode = 1;
    }
  } finally {
    await crossClient.end();
  }
}
if (!process.exitCode)
  console.log('共享实例、数据库/角色隔离、非超级用户及 pgvector 检查通过；未调用外部 API。');
