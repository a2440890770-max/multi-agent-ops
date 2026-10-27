import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { Ollama } from 'ollama';
import { buildMemorySdkConfig, readMemoryConfig } from './memory-config.js';

export async function checkMemoryInfrastructure(env: NodeJS.ProcessEnv = process.env) {
  const config = readMemoryConfig(env);
  const ollama = new Ollama({ host: config.ollamaUrl });
  const models = await ollama.list();
  const modelInfo = models.models.find((item) => item.name === `${config.model}:latest`);
  if (!modelInfo)
    throw new Error(`本机未安装 ${config.model}；请先运行 ollama pull ${config.model}。`);
  const embedded = await ollama.embed({
    model: config.model,
    input: 'D2 embedding dimension probe',
  });
  const vector = embedded.embeddings[0];
  if (!vector || vector.length !== config.dimension || vector.some((n) => !Number.isFinite(n)))
    throw new Error('真实嵌入结果缺失或维度不匹配。');
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const available = await client.query(
      "SELECT default_version FROM pg_available_extensions WHERE name = 'vector'",
    );
    if (!available.rowCount) throw new Error('PostgreSQL 未安装 pgvector 扩展文件。');
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('multi-agent-ops-mem0-profile'))");
    await client.query(`CREATE TABLE IF NOT EXISTS mem0_embedding_profiles (
      collection_name TEXT PRIMARY KEY, model TEXT NOT NULL,
      dimension INTEGER NOT NULL, model_digest TEXT NOT NULL
    )`);
    const profile = await client.query(
      'SELECT model, dimension, model_digest FROM mem0_embedding_profiles WHERE collection_name = $1',
      [config.collectionName],
    );
    const existing = profile.rows[0];
    if (
      existing &&
      (existing.model !== config.model ||
        existing.dimension !== config.dimension ||
        existing.model_digest !== modelInfo.digest)
    )
      throw new Error('已有集合的嵌入模型、维度或模型摘要不同；请使用新集合并迁移数据。');
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
      `INSERT INTO mem0_embedding_profiles VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [config.collectionName, config.model, config.dimension, modelInfo.digest],
    );
    await client.query('COMMIT');
    return {
      embeddingProvider: 'ollama-local',
      embeddingModel: config.model,
      embeddingDimension: vector.length,
      modelDigest: modelInfo.digest,
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
