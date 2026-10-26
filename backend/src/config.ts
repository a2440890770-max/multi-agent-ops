import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

export function readPort(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('服务端口必须为 1—65535 的整数');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('服务端口必须为 1—65535 的整数');
  return port;
}

export const config = {
  port: readPort(process.env.BACKEND_PORT, 3001),
  agentBaseUrl:
    process.env.AGENT_BASE_URL || `http://127.0.0.1:${readPort(process.env.AGENT_PORT, 3002)}`,
  databaseUrl: process.env.DATABASE_URL || undefined,
};
