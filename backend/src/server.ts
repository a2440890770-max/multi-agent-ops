import pg from 'pg';
import type { AgentHealth } from '@multi-agent-ops/shared';
import { createApp } from './app.js';
import { config } from './config.js';
import { createBusinessDatabase } from './database.js';
import { AuthService } from './auth.js';

const business = config.databaseUrl ? createBusinessDatabase(config.databaseUrl) : undefined;
const auth = business && config.auth ? new AuthService(business.db, config.auth) : undefined;

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
app.addHook('onClose', async () => {
  await pool?.end();
  await business?.close();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
await app.listen({ port: config.port, host: '127.0.0.1' });
