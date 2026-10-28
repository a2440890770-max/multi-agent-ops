import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app.js';
import { endpoints, getOpenApiDocument } from '@multi-agent-ops/shared';
import type { Schema } from '@multi-agent-ops/shared';

const agent = {
  service: 'agent',
  status: 'ok',
  stage: 'D1',
  mode: 'shell',
  canExecuteTasks: false,
} as const;
test('数据库未配置时保留存活检查，但就绪检查必须返回 503', async () => {
  const app = createApp({
    checkDatabase: async () => ({ status: 'not_ready', database: 'unconfigured' }),
    checkAgent: async () => agent,
  });
  try {
    assert.equal((await app.inject('/api/health')).statusCode, 200);
    const response = await app.inject('/api/ready');
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().database, 'unconfigured');
  } finally {
    await app.close();
  }
});
test('数据库已连接时就绪；Agent 探测失败不会伪报健康', async () => {
  const app = createApp({
    checkDatabase: async () => ({ status: 'ready', database: 'connected' }),
    checkAgent: async () => {
      throw new Error('offline');
    },
  });
  try {
    assert.equal((await app.inject('/api/ready')).statusCode, 200);
    assert.equal((await app.inject('/api/agent-health')).statusCode, 503);
  } finally {
    await app.close();
  }
});

test('OpenAPI 每个接口均有请求、完整响应、角色及状态关联，所有模型引用可解析', async () => {
  const spec = getOpenApiDocument();
  assert.equal(new Set(endpoints.map((e) => e.operationId)).size, endpoints.length);
  assert.equal(
    Object.values(spec.paths).reduce((n, methods) => n + Object.keys(methods).length, 0),
    endpoints.length,
  );
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref')
        assert.ok(
          String(child).slice('#/components/schemas/'.length) in spec.components.schemas,
          `dangling reference ${child}`,
        );
      else visit(child);
    }
  };
  visit(spec);
  for (const endpoint of endpoints) {
    assert.ok(endpoint.conditions.length > 0);
    assert.ok(endpoint.ac.length > 0);
    assert.ok(endpoint.audit.length > 0);
  }
});

function validInput(schema: Schema): unknown {
  if (schema.enum) return schema.enum[0];
  if (Array.isArray(schema.type) && schema.type.includes('null')) return null;
  if (schema.type === 'object')
    return Object.fromEntries(
      (schema.required ?? []).map((name) => [name, validInput(schema.properties![name]!)]),
    );
  if (schema.type === 'array')
    return Array.from({ length: schema.minItems ?? 0 }, () => validInput(schema.items!));
  if (schema.type === 'integer') return schema.minimum ?? 1;
  if (schema.type === 'boolean') return true;
  if (schema.format === 'uri') return 'https://example.com/evidence';
  if (schema.pattern === '^[a-f0-9]{64}$') return 'a'.repeat(64);
  return 'x'.repeat(Math.max(schema.minLength ?? 1, 1));
}

test('所有业务占位路由返回 501，且不访问数据库或 Agent，不能伪造业务成功', async () => {
  let dependencyCalls = 0;
  const app = createApp({
    checkDatabase: async () => {
      dependencyCalls++;
      throw new Error('must not call');
    },
    checkAgent: async () => {
      dependencyCalls++;
      return agent;
    },
  });
  try {
    const spec = await app.inject('/api/v1/openapi.json');
    assert.equal(spec.statusCode, 200);
    for (const endpoint of endpoints) {
      const query = endpoint.query
        ? new URLSearchParams(validInput(endpoint.query) as Record<string, string>).toString()
        : '';
      const response = await app.inject({
        method: endpoint.method,
        url: `/api/v1${endpoint.path.replace(/:[A-Za-z]+/g, 'id')}${query ? `?${query}` : ''}`,
        headers: { 'idempotency-key': 'contract-test-key-0001' },
        ...(endpoint.body ? { payload: validInput(endpoint.body) as Record<string, unknown> } : {}),
      });
      assert.equal(response.statusCode, 501, `${endpoint.operationId}: ${response.body}`);
      assert.equal(response.json().error.code, 'NOT_IMPLEMENTED');
      assert.ok(response.json().meta.requestId);
      assert.equal(response.json().error.retryable, false);
    }
    assert.equal(dependencyCalls, 0);
  } finally {
    await app.close();
  }
});

test('保存文案必须同时提交并发号和基版，拒绝未知字段及不合法正文结构', async () => {
  const app = createApp({
    checkDatabase: async () => ({ status: 'not_ready', database: 'unconfigured' }),
    checkAgent: async () => agent,
  });
  try {
    for (const payload of [
      { body: '新文案' },
      { expectedRevision: 12, body: '新文案' },
      { expectedRevision: 12, baseContentVersionId: 'v3', body: '新文案', status: 'published' },
      { expectedRevision: -1, baseContentVersionId: 'v3', body: '新文案' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/tasks/task-demo/content-versions',
        headers: { 'idempotency-key': 'contract-test-key-0002' },
        payload,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'VALIDATION_ERROR');
      assert.ok(response.json().error.fieldErrors.length > 0);
    }
  } finally {
    await app.close();
  }
});
