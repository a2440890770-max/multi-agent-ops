import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app.js';
import { endpoints, getOpenApiDocument } from '@multi-agent-ops/shared';

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

test('所有业务路由优先拒绝未登录请求，公开契约不受影响且不访问依赖', async () => {
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
      if (['login', 'getMe', 'logout'].includes(endpoint.operationId)) continue;
      const response = await app.inject({
        method: endpoint.method,
        url: `/api/v1${endpoint.path.replace(/:[A-Za-z]+/g, 'id')}`,
      });
      assert.equal(response.statusCode, 401, `${endpoint.operationId}: ${response.body}`);
      assert.equal(response.json().error.code, 'UNAUTHENTICATED');
      assert.ok(response.json().meta.requestId);
      assert.equal(response.json().error.retryable, false);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal(dependencyCalls, 0);
  } finally {
    await app.close();
  }
});

test('未登录时忽略伪造角色并优先于正文、动作键和 JSON 格式校验返回 401', async () => {
  const app = createApp({
    checkDatabase: async () => ({ status: 'not_ready', database: 'unconfigured' }),
    checkAgent: async () => agent,
  });
  try {
    for (const payload of [{ role: 'admin' }, '{broken-json']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/tasks/task-demo/content-versions',
        headers: { 'content-type': 'application/json', 'x-role': 'admin', 'x-member-id': 'admin' },
        payload,
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, 'UNAUTHENTICATED');
    }
    const unavailable = await app.inject({
      url: '/api/v1/tasks',
      headers: { cookie: `ops_session=${'a'.repeat(43)}` },
    });
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.json().error.code, 'DEPENDENCY_UNAVAILABLE');
  } finally {
    await app.close();
  }
});
