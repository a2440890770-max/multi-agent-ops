import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBusinessTarget } from './migrations.mjs';
import { safeError } from './postgres-admin.mjs';

const runtimeUrl = 'postgresql://agent_ops_app:synthetic-app@localhost:5432/agent_ops';
const adminUrl = 'postgresql://agent_ops:synthetic-admin@localhost:5432/agent_ops';

test('迁移使用独立管理员连接，业务连接保持不变', () => {
  const env = { DATABASE_URL: runtimeUrl, DATABASE_ADMIN_URL: adminUrl };
  assert.equal(validateBusinessTarget(env).username, 'agent_ops');
  assert.equal(env.DATABASE_URL, runtimeUrl);
});

test('未配置或留空管理员连接时兼容原有 DATABASE_URL', () => {
  assert.equal(validateBusinessTarget({ DATABASE_URL: runtimeUrl }).href, runtimeUrl);
  assert.equal(
    validateBusinessTarget({ DATABASE_URL: runtimeUrl, DATABASE_ADMIN_URL: '' }).href,
    runtimeUrl,
  );
});

test('独立迁移进程可以只配置管理员连接', () => {
  assert.equal(validateBusinessTarget({ DATABASE_ADMIN_URL: adminUrl }).href, adminUrl);
  assert.throws(() => validateBusinessTarget({}), /DATABASE_ADMIN_URL/);
});

test('拒绝管理员和应用连接指向不同业务库或实例', () => {
  for (const value of [
    'postgresql://agent_ops:synthetic@other-host:5432/agent_ops',
    'postgresql://agent_ops:synthetic@localhost:5433/agent_ops',
    'postgresql://agent_ops:synthetic@localhost:5432/other_business',
  ]) {
    assert.throws(
      () => validateBusinessTarget({ DATABASE_URL: runtimeUrl, DATABASE_ADMIN_URL: value }),
      /同一主机、端口和业务数据库/,
    );
  }
});

test('两条连接允许协议别名、默认端口和数据库名的等价编码', () => {
  assert.equal(
    validateBusinessTarget({
      DATABASE_URL: runtimeUrl,
      DATABASE_ADMIN_URL: 'postgres://agent_ops:synthetic@localhost/agent%5Fops',
    }).username,
    'agent_ops',
  );
});

test('管理员连接也不能向系统库或记忆库迁移', () => {
  for (const database of [
    'postgres',
    'template0',
    'template1',
    'agent_memory',
    'multi_agent_memory',
    'mem0_test',
  ]) {
    assert.throws(
      () => validateBusinessTarget({ DATABASE_ADMIN_URL: `postgresql://localhost/${database}` }),
      /禁止向系统数据库或记忆数据库/,
    );
  }
  assert.throws(
    () =>
      validateBusinessTarget({
        DATABASE_ADMIN_URL: 'postgresql://localhost/custom_memory',
        MEM0_DATABASE_URL: 'postgresql://another-host/custom_memory',
      }),
    /禁止向系统数据库或记忆数据库/,
  );
});

test('无效管理员连接不能静默回退到业务账号', () => {
  for (const value of ['invalid-url', 'https://localhost/agent_ops', 'postgresql://localhost/']) {
    assert.throws(() =>
      validateBusinessTarget({ DATABASE_URL: runtimeUrl, DATABASE_ADMIN_URL: value }),
    );
  }
});

test('错误信息中的管理员连接也会脱敏', () => {
  const previous = process.env.DATABASE_ADMIN_URL;
  process.env.DATABASE_ADMIN_URL = adminUrl;
  try {
    const message = safeError(new Error(`Failed: ${adminUrl}`));
    assert.ok(!message.includes(adminUrl));
    assert.ok(!message.includes('synthetic-admin'));
    assert.ok(message.includes('[REDACTED]'));
  } finally {
    if (previous === undefined) delete process.env.DATABASE_ADMIN_URL;
    else process.env.DATABASE_ADMIN_URL = previous;
  }
});
