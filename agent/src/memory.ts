import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { buildMemorySdkConfig, readMemoryConfig } from './memory-config.js';

export function assertEmbeddingVector(
  vector: number[] | undefined,
  dimension: number,
): asserts vector is number[] {
  if (
    !vector ||
    vector.length !== dimension ||
    vector.some((n) => !Number.isFinite(n)) ||
    !vector.some((n) => n !== 0)
  )
    throw new Error('真实嵌入结果缺失、无效或维度不匹配。');
}

export async function checkMemoryInfrastructure(env: NodeJS.ProcessEnv = process.env) {
  const config = readMemoryConfig(env);
  const openai = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.embeddingBaseUrl,
    maxRetries: 0,
    timeout: 15000,
  });
  const embedded = await openai.embeddings.create({
    model: config.model,
    dimensions: config.dimension,
    input: 'D2 中文嵌入维度验证',
    encoding_format: 'float',
  });
  const vector = embedded.data[0]?.embedding;
  assertEmbeddingVector(vector, config.dimension);
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(['openai', config.embeddingBaseUrl, config.model, config.dimension, 'v1']),
    )
    .digest('hex');
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const available = await client.query(
      "SELECT extversion AS default_version FROM pg_extension WHERE extname = 'vector'",
    );
    if (!available.rowCount)
      throw new Error('记忆数据库未启用 vector 扩展；请运行 npm run memory:setup。');
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('multi-agent-ops-mem0-profile'))");
    await client.query(`CREATE TABLE IF NOT EXISTS mem0_embedding_profiles_v2 (
      collection_name TEXT PRIMARY KEY, model TEXT NOT NULL,
      dimension INTEGER NOT NULL, config_fingerprint TEXT NOT NULL
    )`);
    const profile = await client.query(
      'SELECT model, dimension, config_fingerprint FROM mem0_embedding_profiles_v2 WHERE collection_name = $1',
      [config.collectionName],
    );
    const existing = profile.rows[0];
    if (
      existing &&
      (existing.model !== config.model ||
        existing.dimension !== config.dimension ||
        existing.config_fingerprint !== fingerprint)
    )
      throw new Error('已有集合的嵌入模型、维度或配置指纹不同；请使用新集合并迁移数据。');
    const column = await client.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = $1 AND a.attname = 'vector' AND NOT a.attisdropped`,
      [config.collectionName],
    );
    if (column.rowCount && !existing)
      throw new Error('已有向量表没有嵌入模型锁定记录；请使用新的集合名。');
    if (column.rowCount && column.rows[0].type !== `vector(${config.dimension})`)
      throw new Error('PostgreSQL 向量列维度与配置不一致。');
    await client.query(
      `INSERT INTO mem0_embedding_profiles_v2 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [config.collectionName, config.model, config.dimension, fingerprint],
    );
    await client.query('COMMIT');
    return {
      embeddingProvider: 'openai',
      embeddingModel: config.model,
      embeddingDimension: vector.length,
      configurationFingerprint: fingerprint,
      pgvectorAvailableVersion: available.rows[0].default_version as string,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** Lazy embedded OSS client. No memory network calls occur during ordinary app startup. */
export async function createProjectMemory(env: NodeJS.ProcessEnv = process.env) {
  const config = readMemoryConfig(env);
  const sdkConfig = buildMemorySdkConfig(env);
  await checkMemoryInfrastructure(env);
  await mkdir(dirname(config.historyPath), { recursive: true, mode: 0o700 });
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  // Mem0 reads this at module evaluation. Import only after disabling telemetry;
  // keep SDK identity/notice files inside this project, away from ~/.mem0.
  process.env.MEM0_TELEMETRY = 'false';
  process.env.MEM0_DIR = config.stateDirectory;
  const { Memory } = await import('mem0ai/oss');
  return new Memory(sdkConfig);
}
