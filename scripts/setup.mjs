import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (!existsSync(envPath)) {
  const password = randomBytes(24).toString('hex');
  writeFileSync(
    envPath,
    `# 本地生成，不要提交；修改密码后请同时更新 DATABASE_URL。\nPOSTGRES_DB=agent_ops\nPOSTGRES_USER=agent_ops\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_PORT=5432\nDATABASE_URL=postgresql://agent_ops:${password}@127.0.0.1:5432/agent_ops\nFRONTEND_PORT=5173\nBACKEND_PORT=3001\nAGENT_PORT=3002\nAGENT_BASE_URL=http://127.0.0.1:3002\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log('已创建本地 .env，使用随机数据库密码；密码未输出。');
} else console.log('保留已有 .env，不覆盖配置。');
const result = spawnSync(process.execPath, ['scripts/database.mjs', 'up'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
