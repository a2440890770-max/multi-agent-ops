import { readExecutionPricing } from './execution-pricing.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readAuthConfig } from './auth-config.js';
import { readExecutorMode, readExecutorPolicy, readExecutionLimits } from './execution-config.js';
import { readAgentConfiguration, readAgentExecutionLimits } from './agent-execution-config.js';

const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

export function readPort(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('服务端口必须为 1—65535 的整数');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('服务端口必须为 1—65535 的整数');
  return port;
}

const executorMode = readExecutorMode(process.env);
const agentServiceToken = process.env.AGENT_SERVICE_TOKEN?.trim();
if (executorMode === 'agent' && (!agentServiceToken || !/^[a-f0-9]{64}$/.test(agentServiceToken)))
  throw new Error('真实执行需要有效的 AGENT_SERVICE_TOKEN。');
export const config = {
  port: readPort(process.env.BACKEND_PORT, 3001),
  agentBaseUrl:
    process.env.AGENT_BASE_URL || `http://127.0.0.1:${readPort(process.env.AGENT_PORT, 3002)}`,
  databaseUrl: process.env.DATABASE_URL || undefined,
  auth: readAuthConfig(process.env),
  taskExecutorMode: executorMode,
  agentServiceToken,
  agentConfiguration: executorMode === 'agent' ? readAgentConfiguration(process.env) : undefined,
  executionLimits:
    executorMode === 'agent'
      ? readAgentExecutionLimits(process.env)
      : readExecutionLimits(process.env),
  executionPricing: readExecutionPricing(process.env),
  taskExecutorPolicy: readExecutorPolicy(process.env),
};
