import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DEEPSEEK_BASE_URL, readDeepSeekConfig } from './model-config.js';
import { queryDeepSeekStructured } from './structured-model.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const envPath = resolve(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const { values } = parseArgs({
  options: { report: { type: 'string' }, role: { type: 'string', default: 'primary' } },
});
if (values.role !== 'primary' && values.role !== 'review')
  throw new Error('role 必须为 primary 或 review');
const role = values.role;
const startedAt = new Date();
const started = performance.now();
const nonce = randomUUID();
const schema = z.strictObject({
  checkId: z.string(),
  answer: z.number().int(),
  checks: z.strictObject({ correct: z.boolean(), source: z.enum(['synthetic']) }),
  notes: z.array(z.string()),
});
const report: Record<string, unknown> = {
  checkedAt: startedAt.toISOString(),
  runtime: process.version,
  provider: 'DeepSeek official',
  baseUrl: DEEPSEEK_BASE_URL,
  role,
  sdk: '@anthropic-ai/claude-agent-sdk',
  mode: 'sdk-outputFormat-and-zod-validation',
  queryStarted: false,
  passed: false,
  schemaPassed: false,
  challengePassed: false,
  checkId: nonce,
  builtinTools: [],
  applicationRetries: 0,
  sdkInternalRetryCount: 'not independently measured',
};
try {
  const config = readDeepSeekConfig();
  report.requestedModel = role === 'review' ? config.reviewModel : config.model;
  const sdkPath = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkMetadata = JSON.parse(await readFile(new URL('./package.json', sdkPath), 'utf8'));
  report.sdkVersion = sdkMetadata.version;
  report.bundledClaudeCodeVersion = sdkMetadata.claudeCodeVersion;
  const zodMetadata = JSON.parse(
    await readFile(new URL('./package.json', import.meta.resolve('zod')), 'utf8'),
  );
  report.zodVersion = zodMetadata.version;
  report.jsonSchema = z.toJSONSchema(schema, { target: 'draft-7' });
  report.queryStarted = true;
  const result = await queryDeepSeekStructured(
    `Synthetic test: compute 6 * 7. Return checkId=${nonce}, the integer answer, checks.correct=true, checks.source=synthetic, and notes=["D2 schema check"]. Use StructuredOutput. No files, network search or external tools are needed.`,
    schema,
    {
      role,
      onMetadata: (metadata) => {
        report.run = metadata;
      },
    },
  );
  report.schemaPassed = true;
  const value = result.data;
  const challengePassed =
    value.checkId === nonce &&
    value.answer === 42 &&
    value.checks.correct === true &&
    value.notes.length === 1 &&
    value.notes[0] === 'D2 schema check';
  if (!challengePassed) throw new Error('结构化类型通过，但随机值或测试语义不匹配。');
  report.challengePassed = true;
  report.validatedOutput = value;
  report.passed = true;
} catch (error) {
  let message = error instanceof Error ? error.message : 'Unknown verification error';
  const key = process.env.DEEPSEEK_API_KEY;
  if (key) message = message.split(key).join('[REDACTED]');
  report.error = message.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 600);
  process.exitCode = 1;
}
report.elapsedMs = Math.round(performance.now() - started);
report.scope =
  'Real SDK structured output verification only; search, memory, publishing and Trace remain unverified.';
const reportPath = values.report
  ? resolve(values.report)
  : resolve(
      root,
      'artifacts/model',
      `deepseek-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`,
    );
await mkdir(dirname(reportPath), { recursive: true });
const serialized = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(reportPath, serialized, { flag: 'wx', mode: 0o600 });
console.log(serialized);
console.log(`Report: ${reportPath}`);
