import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMemorySdkConfig, readMemoryConfig } from './memory-config.js';

const env = {
  DEEPSEEK_API_KEY: 'synthetic-test-key',
  MEM0_DATABASE_URL: 'postgresql://local:synthetic@127.0.0.1:55432/agent_memory',
};

test('memory refuses missing database and incompatible embedding profiles', () => {
  assert.throws(() => readMemoryConfig({}), /MEM0_DATABASE_URL/);
  assert.throws(() => readMemoryConfig({ ...env, MEM0_DATABASE_URL: 'redis://localhost/' }));
  assert.throws(() => readMemoryConfig({ ...env, MEM0_EMBEDDING_DIMENSION: '1536' }), /维度/);
  assert.throws(() => readMemoryConfig({ ...env, MEM0_EMBEDDING_MODEL: 'deepseek-flash' }));
  assert.throws(() => readMemoryConfig({ ...env, MEM0_HISTORY_PATH: ':memory:' }));
});

test('local embedder rejects remote hosts and SQL names cannot inject identifiers', () => {
  assert.throws(() => readMemoryConfig({ ...env, MEM0_OLLAMA_URL: 'https://example.com' }));
  assert.throws(() => readMemoryConfig({ ...env, MEM0_COLLECTION: 'mem0_x;DROP TABLE x' }));
});

test('embedded SDK always selects pgvector, local embedding and persistent history', () => {
  const config = buildMemorySdkConfig(env);
  assert.equal(config.vectorStore.provider, 'pgvector');
  assert.equal(config.vectorStore.config.embeddingModelDims, 768);
  assert.equal(config.embedder.provider, 'ollama');
  assert.equal(config.disableHistory, false);
  assert.equal(config.historyStore?.provider, 'sqlite');
  assert.equal(config.llm.config.baseURL, 'https://api.deepseek.com');
  const changed = readMemoryConfig({ ...env, MEM0_EMBEDDING_MODEL: 'bge-m3' });
  assert.equal(changed.dimension, 1024);
});
