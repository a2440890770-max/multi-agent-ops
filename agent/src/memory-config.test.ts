import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMemorySdkConfig, readMemoryConfig } from './memory-config.js';
import { assertEmbeddingVector } from './memory.js';

const env = {
  DEEPSEEK_API_KEY: 'synthetic-deepseek-key',
  OPENAI_API_KEY: 'synthetic-openai-key',
  DATABASE_URL: 'postgresql://agent_ops:synthetic@127.0.0.1:5432/agent_ops',
  MEM0_DATABASE_URL: 'postgresql://agent_memory:synthetic@127.0.0.1:5432/multi_agent_memory',
};

test('memory refuses missing credentials and incompatible embedding profiles before any network call', () => {
  assert.throws(() => readMemoryConfig({}), /MEM0_DATABASE_URL/);
  assert.throws(() => readMemoryConfig({ ...env, OPENAI_API_KEY: '' }), /OPENAI_API_KEY/);
  assert.throws(() => readMemoryConfig({ ...env, MEM0_DATABASE_URL: 'redis://localhost/' }));
  assert.throws(() => readMemoryConfig({ ...env, MEM0_EMBEDDING_DIMENSION: '768' }), /维度/);
  assert.throws(() => readMemoryConfig({ ...env, MEM0_EMBEDDING_MODEL: 'nomic-embed-text' }));
  assert.throws(() => readMemoryConfig({ ...env, MEM0_HISTORY_PATH: ':memory:' }));
});

test('memory rejects legacy topology, shared roles/databases and injectable SQL identifiers', () => {
  assert.throws(() => readMemoryConfig({ ...env, MEM0_OLLAMA_URL: 'http://127.0.0.1:11434' }));
  assert.throws(() => readMemoryConfig({ ...env, MEM0_POSTGRES_PORT: '55432' }));
  for (const url of [
    'postgresql://agent_memory:x@127.0.0.1:55432/multi_agent_memory',
    'postgresql://agent_memory:x@127.0.0.1:5432/agent_ops',
    'postgresql://agent_ops:x@127.0.0.1:5432/multi_agent_memory',
  ])
    assert.throws(() => readMemoryConfig({ ...env, MEM0_DATABASE_URL: url }), /同实例/);
  assert.throws(() => readMemoryConfig({ ...env, MEM0_COLLECTION: 'mem0_x;DROP TABLE x' }));
});

test('SDK selects official OpenAI 1536 dimensions, pgvector and persistent SQLite, preserving DeepSeek inference config', () => {
  const config = buildMemorySdkConfig({ ...env, OPENAI_BASE_URL: 'https://untrusted.example' });
  assert.equal(config.vectorStore.provider, 'pgvector');
  assert.equal(config.vectorStore.config.embeddingModelDims, 1536);
  assert.equal(config.embedder.provider, 'openai');
  assert.equal(config.embedder.config.model, 'text-embedding-3-small');
  assert.equal(config.embedder.config.apiKey, env.OPENAI_API_KEY);
  assert.equal(config.embedder.config.baseURL, 'https://api.openai.com/v1');
  assert.equal(config.disableHistory, false);
  assert.equal(config.historyStore?.provider, 'sqlite');
  assert.equal(config.llm.config.baseURL, 'https://api.deepseek.com');
  assert.equal(readMemoryConfig(env).collectionName, 'mem0_ops_openai_small_v1');
});

test('embedding gate rejects missing, wrong-dimensional, zero and non-finite vectors', () => {
  for (const vector of [
    undefined,
    [],
    [1],
    Array(1536).fill(0),
    [...Array(1535).fill(1), NaN],
    [...Array(1535).fill(1), Infinity],
  ])
    assert.throws(() => assertEmbeddingVector(vector, 1536));
  assert.doesNotThrow(() => assertEmbeddingVector(Array(1536).fill(0.1), 1536));
});

test('embedding probe uses the fixed official API and rejects wrong output dimensions before touching PostgreSQL', async () => {
  const { checkMemoryInfrastructure } = await import('./memory.js');
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    calls++;
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, 'https://api.openai.com/v1/embeddings');
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, 'text-embedding-3-small');
    assert.equal(body.dimensions, 1536);
    return new Response(
      JSON.stringify({
        data: [{ embedding: [1, 2, 3], index: 0 }],
        model: body.model,
        object: 'list',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    await assert.rejects(checkMemoryInfrastructure(env), /维度/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
