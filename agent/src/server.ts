import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAgentService } from './service.js';

const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const rawPort = process.env.AGENT_PORT || '3002';
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('AGENT_PORT 必须为 1—65535 的整数');
}
const service = createAgentService({
  ...(process.env.AGENT_SERVICE_TOKEN?.trim()
    ? { serviceToken: process.env.AGENT_SERVICE_TOKEN.trim() }
    : {}),
  backendBaseUrl:
    process.env.BACKEND_INTERNAL_BASE_URL?.trim() ||
    `http://127.0.0.1:${process.env.BACKEND_PORT || '3001'}`,
  concurrency: Number(process.env.TASK_EXECUTOR_CONCURRENCY || 1),
});
service.server.listen(port, '127.0.0.1', () =>
  console.log(`独立 Agent 服务已启动：http://127.0.0.1:${port}/health。`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void service.close();
  });
