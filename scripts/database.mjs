import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = fileURLToPath(new URL('../.env', import.meta.url));
const action = process.argv[2];
if (!['up', 'down'].includes(action)) throw new Error('只支持 up / down；本脚本不删除数据卷。');
if (!existsSync(env)) {
  console.error('缺少 .env，请先运行 pnpm env:setup。');
  process.exit(1);
}
const probe = spawnSync('docker', ['compose', 'version'], { cwd: root, encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.error(
    '需要 Docker Engine 和 Compose v2。macOS/Windows 请安装并启动 Docker Desktop，再运行 pnpm env:setup。',
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
process.exit(result.status ?? 1);
