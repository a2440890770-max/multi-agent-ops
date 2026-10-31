import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (!existsSync(envPath)) {
  const port = process.env.POSTGRES_PORT || '5432';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('POSTGRES_PORT 必须为有效端口。');
  const password = randomBytes(24).toString('hex');
  const businessPassword = randomBytes(24).toString('hex');
  writeFileSync(
    envPath,
    `# 本地生成，不要提交；修改密码后请同时更新 DATABASE_URL。\nPOSTGRES_DB=postgres\nPOSTGRES_USER=agent_ops_admin\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_PORT=${port}\nDATABASE_URL=postgresql://agent_ops:${businessPassword}@127.0.0.1:${port}/agent_ops\nFRONTEND_PORT=5173\nBACKEND_PORT=3001\nAGENT_PORT=3002\nAGENT_BASE_URL=http://127.0.0.1:3002\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log('已创建本地 .env，使用随机数据库密码；密码未输出。');
} else console.log('保留已有 .env 和数据库配置。');
const source = readFileSync(envPath, 'utf8');
const env = { ...parseEnv(source), ...process.env };
if (!env.AUTH_SECRET) {
  if (env.NODE_ENV === 'production')
    throw new Error('生产认证服务需要显式配置 AUTH_SECRET，不自动生成部署密钥。');
  const secret = randomBytes(32).toString('hex');
  const assignment = `AUTH_SECRET=${secret}`;
  const updated = source.replace(
    /^[\t ]*(?:export[\t ]+)?AUTH_SECRET[\t ]*=[^\r\n]*/gm,
    assignment,
  );
  writeFileSync(
    envPath,
    updated === source ? `${source}${source.endsWith('\n') ? '' : '\n'}${assignment}\n` : updated,
    { mode: 0o600 },
  );
  console.log('已补齐本地认证密钥；密钥未输出。已运行的后端需重启后生效。');
}
const result = spawnSync(process.execPath, ['scripts/database.mjs', 'up'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
