import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { test } from 'node:test';
import { ensureLocalEnv } from './local-env.mjs';

function fixture(t, original) {
  const directory = mkdtempSync(join(tmpdir(), 'ops-local-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, '.env');
  if (original !== undefined) writeFileSync(path, original);
  return path;
}

test('首次初始化同时生成数据库密码和持久登录密钥，重复执行保持原值', (t) => {
  const path = fixture(t);
  assert.deepEqual(ensureLocalEnv(path, {}), { created: true, authAdded: true });
  const original = readFileSync(path, 'utf8');
  const values = parseEnv(original);
  assert.match(values.AUTH_SECRET, /^[a-f0-9]{64}$/);
  assert.ok(values.DATABASE_URL && values.POSTGRES_PASSWORD);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(ensureLocalEnv(path, {}), { created: false, authAdded: false });
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('已有配置仅补缺失或空白密钥，保留数据库、端口、来源、注释和换行', (t) => {
  for (const placeholder of ['', 'AUTH_SECRET=\n', 'export AUTH_SECRET=""\r\n']) {
    const original = `# 保留现有配置\r\nDATABASE_MODE=external\r\nDATABASE_URL=postgresql://existing:password@localhost:55432/existing\r\nFRONTEND_PORT=55173\r\nAUTH_TRUSTED_ORIGINS=http://localhost:55173\r\n${placeholder}# trailing comment`;
    const path = fixture(t, original);
    assert.deepEqual(ensureLocalEnv(path, {}), { created: false, authAdded: true });
    const updated = readFileSync(path, 'utf8');
    assert.ok(updated.startsWith(`${original}\nAUTH_SECRET=`));
    const { AUTH_SECRET, ...rest } = parseEnv(updated);
    const { AUTH_SECRET: previous, ...expected } = parseEnv(original);
    assert.ok(!previous);
    assert.match(AUTH_SECRET, /^[a-f0-9]{64}$/);
    assert.deepEqual(rest, expected);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    ensureLocalEnv(path, {});
    assert.equal(readFileSync(path, 'utf8'), updated);
  }
});

test('已有有效密钥和外部注入的密钥均不被重新生成或写入文件', (t) => {
  const secret = randomBytes(32).toString('hex');
  for (const [original, env] of [
    [`AUTH_SECRET=${secret}\n`, {}],
    ['DATABASE_MODE=external\n', { AUTH_SECRET: secret }],
  ]) {
    const path = fixture(t, original);
    assert.deepEqual(ensureLocalEnv(path, env), { created: false, authAdded: false });
    assert.equal(readFileSync(path, 'utf8'), original);
  }
});

test('生产环境缺少密钥、已有无效密钥和空环境变量均明确拒绝且不修改文件', (t) => {
  for (const [original, env, message] of [
    ['DATABASE_MODE=external\n', { NODE_ENV: 'production' }, /生产认证服务/],
    ['NODE_ENV=production\nAUTH_SECRET=\n', {}, /生产认证服务/],
    ['AUTH_SECRET=invalid\n', {}, /64 位十六进制/],
    ['DATABASE_MODE=external\n', { AUTH_SECRET: '' }, /环境变量 AUTH_SECRET 为空/],
  ]) {
    const path = fixture(t, original);
    assert.throws(() => ensureLocalEnv(path, env), message);
    assert.equal(readFileSync(path, 'utf8'), original);
  }
});
