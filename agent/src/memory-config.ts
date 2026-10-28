import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryConfig } from 'mem0ai/oss';
import { readDeepSeekConfig } from './model-config.js';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSION = 1536;
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export function readMemoryConfig(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.MEM0_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('缺少 MEM0_DATABASE_URL；请运行 npm run memory:setup。');
  let database: URL;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new Error('MEM0_DATABASE_URL 必须为 PostgreSQL 连接地址。');
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !database.hostname ||
    !database.pathname.slice(1)
  )
    throw new Error('MEM0_DATABASE_URL 必须明确指定 PostgreSQL 数据库。');
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('缺少 OPENAI_API_KEY；尚未发起嵌入调用。');
  const model = env.MEM0_EMBEDDING_MODEL?.trim() || EMBEDDING_MODEL;
  if (model !== EMBEDDING_MODEL) throw new Error('嵌入模型必须为 text-embedding-3-small。');
  const dimension = EMBEDDING_DIMENSION;
  if (env.MEM0_EMBEDDING_DIMENSION && env.MEM0_EMBEDDING_DIMENSION !== String(dimension))
    throw new Error('嵌入维度必须为 1536；旧集合必须重新生成向量后迁移。');
  if (env.MEM0_OLLAMA_URL || env.MEM0_POSTGRES_PORT)
    throw new Error('发现旧独立实例/Ollama 配置；请按 memory.md 迁移 .env.memory。');
  if (!env.DATABASE_URL) throw new Error('缺少业务 DATABASE_URL，无法确认记忆库同实例隔离。');
  const businessUrl = new URL(env.DATABASE_URL);
  if (
    businessUrl &&
    (businessUrl.hostname !== database.hostname ||
      (businessUrl.port || '5432') !== (database.port || '5432') ||
      businessUrl.pathname === database.pathname ||
      businessUrl.username === database.username)
  )
    throw new Error('记忆库必须与业务库同实例、不同数据库和专用角色。');
  const collectionName = env.MEM0_COLLECTION?.trim() || 'mem0_ops_openai_small_v1';
  if (!/^mem0_[a-z0-9_]{1,45}$/.test(collectionName))
    throw new Error('集合名必须以 mem0_ 开头，且只使用小写字母、数字和下划线。');
  const historyPath = resolve(
    projectRoot,
    env.MEM0_HISTORY_PATH || 'artifacts/memory/history.sqlite',
  );
  if (historyPath === ':memory:' || historyPath.endsWith('/:memory:'))
    throw new Error('历史记录必须持久化到文件。');
  return {
    databaseUrl,
    collectionName,
    model,
    dimension,
    apiKey,
    embeddingBaseUrl: OPENAI_BASE_URL,
    historyPath,
    stateDirectory: resolve(projectRoot, 'artifacts/memory/sdk'),
  };
}

export function buildMemorySdkConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const config = readMemoryConfig(env);
  const deepseek = readDeepSeekConfig(env);
  return {
    embedder: {
      provider: 'openai',
      config: {
        apiKey: config.apiKey,
        model: config.model,
        baseURL: config.embeddingBaseUrl,
        embeddingDims: config.dimension,
      },
    },
    vectorStore: {
      provider: 'pgvector',
      config: {
        connectionString: config.databaseUrl,
        collectionName: config.collectionName,
        dimension: config.dimension,
        embeddingModelDims: config.dimension,
      },
    },
    // Mem0 requires an LLM configuration even for infer:false. D2's storage probe
    // skips inference; Agent model calls still use the existing Claude Agent SDK.
    llm: {
      provider: 'deepseek',
      config: {
        apiKey: deepseek.apiKey,
        baseURL: 'https://api.deepseek.com',
        model: deepseek.model,
        timeout: 45000,
      },
    },
    historyStore: { provider: 'sqlite', config: { historyDbPath: config.historyPath } },
    disableHistory: false,
  };
}
