import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureLocalEnv } from './local-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
try {
  const result = ensureLocalEnv(envPath);
  console.log(result.created ? '已创建本地 .env，使用随机数据库密码。' : '保留已有 .env 配置。');
  if (result.authAdded) console.log('已补齐本地登录密钥；密钥未输出，重启后端后生效。');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const result = spawnSync(process.execPath, ['scripts/database.mjs', 'up'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
