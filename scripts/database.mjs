import pg from 'pg';
import {
  readDatabaseMode,
  databaseEndpoint,
  assertComposePortAvailable,
} from './database-mode.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnvironment, provisionDatabase, safeError } from './postgres-admin.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = fileURLToPath(new URL('../.env', import.meta.url));
const action = process.argv[2];
if (!['up', 'down'].includes(action)) throw new Error('只支持 up / down；本脚本不删除数据卷。');
if (!existsSync(env)) {
  console.error('缺少 .env，请先运行 npm run env:setup。');
  process.exit(1);
}
loadEnvironment();
const mode = readDatabaseMode(process.env);
if (mode === 'external') {
  if (action === 'down') console.log('当前使用已有数据库；本项目未停止外部数据库服务。');
  else {
    try {
      const endpoint = databaseEndpoint(process.env);
      const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5000,
      });
      try {
        await client.connect();
        await client.query('SELECT 1');
        console.log(
          `已连接已有 PostgreSQL：${endpoint.host}:${endpoint.port}/${endpoint.database}；未启动容器或修改数据。`,
        );
      } finally {
        await client.end();
      }
    } catch (error) {
      console.error(safeError(error));
      process.exitCode = 1;
    }
  }
} else {
  const probe = spawnSync('docker', ['compose', 'version'], { cwd: root, encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.error(
      '需要 Docker Engine 和 Compose v2。macOS/Windows 请安装并启动 Docker Desktop，再运行 npm run env:setup。',
    );
    process.exit(1);
  }
  const args = [
    'compose',
    '--project-directory',
    root,
    '--env-file',
    env,
    '-f',
    'infra/docker-compose.yml',
    action,
  ];
  if (action === 'up') {
    // Check before Compose can spend time downloading an image. A running service
    // owned by this exact Compose project is already allowed to hold its own port.
    const owned = spawnSync(
      'docker',
      [...args.slice(0, -1), 'ps', '--status', 'running', '-q', 'postgres'],
      { cwd: root, encoding: 'utf8' },
    );
    if (owned.status !== 0) {
      console.error('无法核对本项目数据库容器状态；未启动容器。');
      process.exit(1);
    }
    if (!owned.stdout.trim()) {
      try {
        await assertComposePortAvailable(Number(process.env.POSTGRES_PORT || 5432));
      } catch (error) {
        console.error(safeError(error));
        process.exit(1);
      }
    }
    args.push('-d', '--wait', '--wait-timeout', '120');
  }
  const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;

  if (result.status === 0 && action === 'up') {
    loadEnvironment();
    // Legacy .env files remain usable for health checks until explicitly migrated.
    if (
      process.env.DATABASE_URL &&
      new URL(process.env.DATABASE_URL).username !== process.env.POSTGRES_USER
    ) {
      try {
        await provisionDatabase(process.env.DATABASE_URL);
      } catch (error) {
        console.error(safeError(error));
        process.exitCode = 1;
      }
    }
  }
}
