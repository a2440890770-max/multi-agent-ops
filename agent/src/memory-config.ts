import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryConfig } from 'mem0ai/oss';
import { readDeepSeekConfig } from './model-config.js';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const embeddingModels = {
  'nomic-embed-text': 768,
  'bge-m3': 1024,
} as const;

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
  const model = env.MEM0_EMBEDDING_MODEL?.trim() || 'nomic-embed-text';
  if (!Object.hasOwn(embeddingModels, model))
    throw new Error('本地嵌入模型支持 nomic-embed-text 或 bge-m3。');
  const dimension = embeddingModels[model as keyof typeof embeddingModels];
  if (env.MEM0_EMBEDDING_DIMENSION && Number(env.MEM0_EMBEDDING_DIMENSION) !== dimension)
    throw new Error('嵌入维度与模型不一致；禁止向原集合写入不同维度的向量。');
  const ollamaUrl = new URL(env.MEM0_OLLAMA_URL || 'http://127.0.0.1:11434');
  if (
    !['http:', 'https:'].includes(ollamaUrl.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(ollamaUrl.hostname) ||
    ollamaUrl.username ||
    ollamaUrl.password ||
    ollamaUrl.search ||
    ollamaUrl.hash ||
    ollamaUrl.pathname !== '/'
  )
    throw new Error('本地嵌入服务必须使用本机 Ollama 根地址。');
  const collectionName = env.MEM0_COLLECTION?.trim() || 'mem0_ops_nomic_v1';
  if (!/^mem0_[a-z0-9_]{1,35}$/.test(collectionName))
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
    ollamaUrl: ollamaUrl.origin,
    historyPath,
    stateDirectory: resolve(projectRoot, 'artifacts/memory/sdk'),
  };
}

export function buildMemorySdkConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const config = readMemoryConfig(env);
  const deepseek = readDeepSeekConfig(env);
  return {
    embedder: {
      provider: 'ollama',
      config: { model: config.model, url: config.ollamaUrl, embeddingDims: config.dimension },
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
    // skips inference; Agent extraction still uses the existing Claude Agent SDK.
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
