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
if (action === 'up') args.push('-d', '--wait', '--wait-timeout', '120');
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
