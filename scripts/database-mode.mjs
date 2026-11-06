import net from 'node:net';

export function readDatabaseMode(env) {
  const mode = env.DATABASE_MODE?.trim() || 'compose';
  if (!['compose', 'external'].includes(mode))
    throw new Error('DATABASE_MODE 仅支持 compose 或 external。');
  return mode;
}
export function databaseEndpoint(env) {
  if (!env.DATABASE_URL)
    throw new Error('缺少 DATABASE_URL；external 模式需要显式配置现有业务数据库连接。');
  const url = new URL(env.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1)
  )
    throw new Error('DATABASE_URL 必须指定 PostgreSQL 业务数据库。');
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
  };
}
export async function assertComposePortAvailable(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('POSTGRES_PORT 必须为有效端口。');
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) =>
      reject(
        new Error(
          error.code === 'EADDRINUSE'
            ? `127.0.0.1:${port} 已被占用，尚未启动或拉取数据库容器。若使用已有数据库，请在 .env 设置 DATABASE_MODE=external；若新建容器，请同时调整 POSTGRES_PORT 和 DATABASE_URL 的端口。`
            : '无法检查数据库端口，请检查本机网络权限。',
        ),
      ),
    );
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
}
