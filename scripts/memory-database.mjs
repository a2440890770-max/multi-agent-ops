import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = fileURLToPath(new URL('../.env.memory', import.meta.url));
const action = process.argv[2];
if (!['setup', 'up', 'down', 'recreate'].includes(action))
  throw new Error('只支持 setup / up / down / recreate；不删除数据卷。');
if (!existsSync(env) && action === 'setup') {
  const password = randomBytes(24).toString('hex');
  writeFileSync(
    env,
    `# 本地记忆数据库配置；不提交，不覆盖已有业务数据库。\nMEM0_POSTGRES_DB=agent_memory\nMEM0_POSTGRES_USER=agent_memory\nMEM0_POSTGRES_PASSWORD=${password}\nMEM0_POSTGRES_PORT=55432\nMEM0_DATABASE_URL=postgresql://agent_memory:${password}@127.0.0.1:55432/agent_memory\nMEM0_EMBEDDING_MODEL=nomic-embed-text\nMEM0_EMBEDDING_DIMENSION=768\nMEM0_OLLAMA_URL=http://127.0.0.1:11434\nMEM0_COLLECTION=mem0_ops_nomic_v1\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log('已创建 .env.memory 和随机密码；凭据未输出。');
}
if (!existsSync(env)) throw new Error('缺少 .env.memory；请先运行 npm run memory:setup。');
const args = [
  'compose',
  '--project-directory',
  root,
  '--env-file',
  env,
  '-f',
  'infra/memory-compose.yml',
];
if (action === 'down') args.push('down');
else {
  args.push('up', '-d', '--wait', '--wait-timeout', '120');
  if (action === 'recreate') args.push('--force-recreate');
}
const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
if (result.error) console.error('无法运行 Docker；请确认 Docker Engine 与 Compose 可用。');
process.exitCode = result.status ?? 1;
