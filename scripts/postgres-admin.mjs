import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function loadEnvironment() {
  for (const name of ['.env', '.env.memory']) {
    const path = fileURLToPath(new URL(`../${name}`, import.meta.url));
    if (existsSync(path)) process.loadEnvFile(path);
  }
}
export function identifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value || ''))
    throw new Error('数据库/角色名只允许小写字母、数字和下划线。');
  return `"${value}"`;
}
const literal = (value) => `'${value.replaceAll("'", "''")}'`;

// Only explicit setup commands call this. Runtime roles never receive admin credentials.
export async function provisionDatabase(url, { extension = false } = {}) {
  const target = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(target.protocol))
    throw new Error('需要 PostgreSQL URL。');
  const role = decodeURIComponent(target.username);
  const database = decodeURIComponent(target.pathname.slice(1));
  const roleSql = identifier(role);
  const databaseSql = identifier(database);
  if (!target.password) throw new Error('数据库运行角色必须配置密码。');
  const admin = process.env.POSTGRES_USER;
  if (!admin || !process.env.POSTGRES_PASSWORD || role === admin)
    throw new Error('运行角色必须与 POSTGRES_USER 管理身份分离；旧环境请先按 memory.md 迁移。');
  if (
    target.hostname !== '127.0.0.1' ||
    (target.port || '5432') !== (process.env.POSTGRES_PORT || '5432')
  )
    throw new Error('开发库必须连接共享实例的 127.0.0.1 / POSTGRES_PORT。');
  const client = new pg.Client({
    host: target.hostname,
    port: Number(target.port || 5432),
    user: admin,
    password: process.env.POSTGRES_PASSWORD,
    database: 'postgres',
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const roles = await client.query(
      'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=$1',
      [role],
    );
    if (roles.rowCount) {
      if (Object.values(roles.rows[0]).some(Boolean))
        throw new Error('已有运行角色权限过高，拒绝自动修改；请人工迁移。');
    } else {
      await client.query(
        `CREATE ROLE ${roleSql} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(decodeURIComponent(target.password))}`,
      );
    }
    const databases = await client.query(
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',
      [database],
    );
    if (!databases.rowCount) await client.query(`CREATE DATABASE ${databaseSql} OWNER ${roleSql}`);
    else if (databases.rows[0].owner !== role)
      throw new Error('已有数据库不属于目标运行角色；拒绝自动接管，请先迁移。');
    await client.query(`REVOKE CONNECT ON DATABASE ${databaseSql} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${databaseSql} TO ${roleSql}`);
  } finally {
    await client.end();
  }
  if (extension) {
    const extensionAdmin = new pg.Client({
      host: target.hostname,
      port: Number(target.port || 5432),
      user: admin,
      password: process.env.POSTGRES_PASSWORD,
      database,
      connectionTimeoutMillis: 5000,
    });
    try {
      await extensionAdmin.connect();
      await extensionAdmin.query('CREATE EXTENSION IF NOT EXISTS vector');
    } finally {
      await extensionAdmin.end();
    }
  }
  const runtime = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await runtime.connect();
    await runtime.query('SELECT 1');
  } finally {
    await runtime.end();
  }
}

export function safeError(error) {
  let message = error instanceof Error ? error.message : '数据库配置失败';
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /PASSWORD|API_KEY|DATABASE_URL/.test(key))
      message = message.split(value).join('[REDACTED]');
  }
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[REDACTED DATABASE URL]');
}
