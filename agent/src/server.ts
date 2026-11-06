import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { executeWorkflow } from './workflow.js';
import { describeAgent } from './index.js';

const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const rawPort = process.env.AGENT_PORT || '3002';
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('AGENT_PORT 必须为 1—65535 的整数');
}
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (request.method === 'GET' && request.url === '/health') {
    response.end(JSON.stringify(describeAgent()));
  } else if (request.method === 'POST' && request.url === '/workflow') {
    try {
      request.setEncoding('utf8');
      let body = '';
      for await (const chunk of request) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 1000000) throw new Error('Request too large');
      }
      response.end(JSON.stringify(await executeWorkflow(JSON.parse(body))));
    } catch {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: '结构化生成或审核失败，未采用未经校验的输出。' }));
    }
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'Not found' }));
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Agent 已启动：http://127.0.0.1:${port}/health；已提供结构化文案生成与审核。`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
