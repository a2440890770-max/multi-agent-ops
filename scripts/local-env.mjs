import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

export function ensureLocalEnv(envPath, env = process.env) {
  const original = existsSync(envPath) ? readFileSync(envPath, 'utf8') : undefined;
  const values = parseEnv(original ?? '');
  const secret = env.AUTH_SECRET ?? values.AUTH_SECRET;
  if (secret && !/^[a-fA-F0-9]{64}$/.test(secret))
    throw new Error(
      'AUTH_SECRET 必须为 32 字节随机值的 64 位十六进制编码；保留已有配置，请修正后重试。',
    );
  if (!secret && (env.NODE_ENV ?? values.NODE_ENV) === 'production')
    throw new Error('生产认证服务需要通过秘密配置提供 AUTH_SECRET，不自动生成开发密钥。');
  if (env.AUTH_SECRET === '')
    throw new Error('环境变量 AUTH_SECRET 为空；请取消这个空值，让本地 .env 提供认证密钥。');

  const authAdded = !secret;
  const authLine = authAdded ? `AUTH_SECRET=${randomBytes(32).toString('hex')}\n` : '';
  if (original === undefined) {
    const port = env.POSTGRES_PORT || '5432';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
      throw new Error('POSTGRES_PORT 必须为有效端口。');
    const password = randomBytes(24).toString('hex');
    const businessPassword = randomBytes(24).toString('hex');
    writeFileSync(
      envPath,
      `# 本地生成，不要提交；修改密码后请同时更新 DATABASE_URL。\nPOSTGRES_DB=postgres\nPOSTGRES_USER=agent_ops_admin\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_PORT=${port}\nDATABASE_URL=postgresql://agent_ops:${businessPassword}@127.0.0.1:${port}/agent_ops\nFRONTEND_PORT=5173\nBACKEND_PORT=3001\nAGENT_PORT=3002\nAGENT_BASE_URL=http://127.0.0.1:3002\n${authLine}`,
      { flag: 'wx', mode: 0o600 },
    );
  } else if (authAdded) {
    // Append so dotenv parsing preserves unrelated configuration and fills empty placeholders.
    const separator = original.endsWith('\n') || original === '' ? '' : '\n';
    chmodSync(envPath, 0o600);
    writeFileSync(envPath, `${original}${separator}${authLine}`, { mode: 0o600 });
  }
  return { created: original === undefined, authAdded };
}
