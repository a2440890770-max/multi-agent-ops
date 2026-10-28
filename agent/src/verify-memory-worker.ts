import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { createProjectMemory } from './memory.js';
import { projectRoot, readMemoryConfig } from './memory-config.js';

for (const name of ['.env', '.env.memory']) {
  const path = resolve(projectRoot, name);
  if (existsSync(path)) process.loadEnvFile(path);
}
const { values } = parseArgs({
  options: {
    phase: { type: 'string' },
    probe: { type: 'string' },
    report: { type: 'string' },
    previous: { type: 'string' },
  },
});
if (!values.probe || !values.report || !['write', 'reopen'].includes(values.phase || ''))
  throw new Error('需要 phase、probe 和 report。');
const probe = values.probe;
const userId = `d2-probe-${probe}`;
const text = 'The test account prefers short science fiction recommendations without spoilers.';
const query = 'What kind of movie recommendations does this account like?';
const started = performance.now();
const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  pid: process.pid,
  phase: values.phase,
  probe,
  passed: false,
  syntheticInput: true,
  simulatedEmbedding: false,
  infer: false,
  modelInferenceCalled: false,
};
try {
  const config = readMemoryConfig();
  const memory = await createProjectMemory();
  let memoryId: string;
  if (values.phase === 'write') {
    const added = await memory.add(text, {
      userId,
      infer: false,
      metadata: { purpose: 'D2 technical probe', probe },
    });
    assert.equal(added.results.length, 1, '真实写入未返回唯一记忆');
    memoryId = added.results[0]!.id;
    await memory.add('The test account tracks bicycle maintenance appointments.', {
      userId,
      infer: false,
      metadata: { purpose: 'D2 technical probe', probe },
    });
    await memory.add(text, {
      userId: `${userId}-other`,
      infer: false,
      metadata: { purpose: 'D2 isolation probe', probe },
    });
  } else {
    if (!values.previous) throw new Error('reopen 需要 previous 写入报告。');
    const previous = JSON.parse(await readFile(values.previous, 'utf8'));
    assert.equal(previous.passed, true);
    assert.equal(previous.probe, probe);
    assert.notEqual(previous.pid, process.pid, '持久化检查必须使用新进程');
    memoryId = previous.memoryId;
    assert.equal(typeof memoryId, 'string');
  }
  const found = await memory.search(query, { filters: { user_id: userId }, topK: 2 });
  assert.equal(found.results[0]?.id, memoryId, '语义检索的第一条结果不符合测试偏好');
  const isolated = await memory.search(query, {
    filters: { user_id: `${userId}-empty` },
    topK: 2,
  });
  assert.equal(isolated.results.length, 0, '隔离用户检索到了其他用户记忆');
  const stored = await memory.get(memoryId);
  assert.equal(stored?.memory, text);
  const history = await memory.history(memoryId);
  assert.ok(history.some((item) => item.action === 'ADD' && item.new_value === text));
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    // Collection identifiers pass readMemoryConfig's strict allowlist; values use parameters.
    const rows = await client.query(
      `SELECT id, vector_dims(vector) AS dimension, vector_norm(vector) AS norm,
       payload->>'data' AS data, payload->>'user_id' AS user_id
       FROM "${config.collectionName}" WHERE id = $1`,
      [memoryId],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].dimension, config.dimension);
    assert.ok(Number(rows.rows[0].norm) > 0);
    assert.equal(rows.rows[0].data, text);
    assert.equal(rows.rows[0].user_id, userId);
    const version = await client.query(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    report.pgvectorVersion = version.rows[0]?.extversion;
    const profile = await client.query(
      'SELECT config_fingerprint FROM mem0_embedding_profiles_v2 WHERE collection_name = $1',
      [config.collectionName],
    );
    report.embeddingConfigurationFingerprint = profile.rows[0]?.config_fingerprint;
    report.postgresEvidence = { rowExists: true, dimension: config.dimension, nonzeroVector: true };
  } finally {
    await client.end();
  }
  const sqlite = new DatabaseSync(config.historyPath, { readOnly: true });
  try {
    const rows = sqlite
      .prepare('SELECT action, new_value FROM memory_history WHERE memory_id = ?')
      .all(memoryId);
    assert.ok(rows.some((item) => item.action === 'ADD' && item.new_value === text));
    report.sqliteHistoryRowCount = rows.length;
  } finally {
    sqlite.close();
  }
  Object.assign(report, {
    passed: true,
    memoryId,
    collection: config.collectionName,
    embeddingModel: config.model,
    embeddingDimension: config.dimension,
    inputSha256: createHash('sha256').update(text).digest('hex'),
    topResult: { id: found.results[0]?.id, score: found.results[0]?.score },
    scopeIsolationPassed: true,
    sdkHistoryRowCount: history.length,
    sdkTelemetryDisabled: process.env.MEM0_TELEMETRY === 'false',
    historyPath: config.historyPath,
  });
} catch (error) {
  let message = error instanceof Error ? error.message : 'Memory verification failed';
  for (const name of [
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'MEM0_DATABASE_URL',
    'MEM0_POSTGRES_PASSWORD',
  ]) {
    const value = process.env[name];
    if (value) message = message.split(value).join('[REDACTED]');
  }
  report.error = message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[REDACTED DATABASE URL]')
    .slice(0, 600);
}
report.elapsedMs = Math.round(performance.now() - started);
await mkdir(dirname(resolve(values.report)), { recursive: true, mode: 0o700 });
await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
// Mem0 3.3.1 has no public Memory.close(). This isolated probe process exits
// only after reports/SQLite writes complete; the OS releases its PG connections.
process.exit(report.passed ? 0 : 1);
