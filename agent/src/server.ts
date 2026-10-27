import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeAgent } from './index.js';

const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const rawPort = process.env.AGENT_PORT || '3002';
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('AGENT_PORT 必须为 1—65535 的整数');
}
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (request.method === 'GET' && request.url === '/health') {
    response.end(JSON.stringify(describeAgent()));
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'Not found' }));
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Agent 空壳已启动：http://127.0.0.1:${port}/health；尚无任务执行能力。`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
