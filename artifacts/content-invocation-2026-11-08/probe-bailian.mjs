import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createContentModelOptions } from '../../agent/src/content-model-config.ts';

const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const connection = createContentModelOptions(process.env);
if (connection.provider !== 'bailian')
  throw new Error('This probe requires explicit Bailian configuration.');
const apiKey = process.env.DASHSCOPE_API_KEY;
const endpoint = new URL(connection.baseUrl);
const report = {
  checkedAt: new Date().toISOString(),
  provider: 'bailian',
  model: connection.options.model,
  checks: [],
};
const safeCode = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;

for (const [kind, path, method] of [
  ['model_list', '/compatible-mode/v1/models', 'GET'],
  ['anthropic_route_validation', '/apps/anthropic/v1/messages', 'POST'],
]) {
  try {
    const response = await fetch(`${endpoint.origin}${path}`, {
      method,
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      // Deliberately invalid: protocol/auth validation only, no creative request.
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    const body = await response.json().catch(() => ({}));
    const models = Array.isArray(body.data)
      ? body.data.map((item) => safeCode(item.id)).filter(Boolean)
      : [];
    const check = {
      kind,
      endpoint: `${endpoint.origin}${path}`,
      status: response.status,
      errorType: safeCode(body.error?.type),
      errorCode: safeCode(body.error?.code ?? body.code),
      ...(kind === 'model_list'
        ? {
            availableModels: models,
            configuredModelListed: models.includes(connection.options.model),
          }
        : {}),
    };
    report.checks.push(check);
    console.log(JSON.stringify(check));
  } catch (error) {
    const check = { kind, failed: true, name: error.name, code: error.cause?.code };
    report.checks.push(check);
    console.log(JSON.stringify(check));
  }
}
await writeFile(
  new URL('./bailian-connectivity.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
