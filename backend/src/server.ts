import pg from 'pg';
import type { AgentHealth } from '@multi-agent-ops/shared';
import { createApp } from './app.js';
import { config } from './config.js';
import { createBusinessDatabase } from './database.js';
import { AuthService } from './auth.js';
import { TaskService } from './task-service.js';
import { MockTaskExecutor } from './mock-task-executor.js';

const business = config.databaseUrl ? createBusinessDatabase(config.databaseUrl) : undefined;
const auth = business && config.auth ? new AuthService(business.db, config.auth) : undefined;
const executor =
  business && config.taskExecutorMode === 'mock' ? new MockTaskExecutor(business.db) : undefined;

const pool = config.databaseUrl
  ? new pg.Pool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
    })
  : undefined;
pool?.on('error', () => console.error('数据库空闲连接异常，请检查本地数据库状态。'));
const app = createApp({
  ...(auth ? { auth } : {}),
  ...(business
    ? {
        tasks: new TaskService(business.db, () => new Date(), {
          executorMode: config.taskExecutorMode,
        }),
      }
    : {}),
  async checkDatabase() {
    if (!pool) return { status: 'not_ready', database: 'unconfigured' };
    try {
      await pool.query('SELECT 1');
      return { status: 'ready', database: 'connected' };
    } catch {
      return { status: 'not_ready', database: 'unavailable' };
    }
  },
  async checkAgent() {
    const response = await fetch(new URL('/health', config.agentBaseUrl), {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('Agent unavailable');
    return (await response.json()) as AgentHealth;
  },
});
if (business && !config.auth)
  app.log.warn('登录服务未启用：缺少 AUTH_SECRET。请运行 npm run env:setup 后重启后端。');
app.addHook('onReady', async () => {
  executor?.start();
});
app.addHook('onClose', async () => {
  await executor?.stop();
  await pool?.end();
  await business?.close();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
await app.listen({ port: config.port, host: '127.0.0.1' });
