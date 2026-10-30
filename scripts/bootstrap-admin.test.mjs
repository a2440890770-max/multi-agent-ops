import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createBusinessDatabase } from '../backend/src/database.ts';
import {
  bootstrapAdmin,
  BootstrapError,
  validateBootstrapInput,
} from '../backend/src/bootstrap-admin.ts';
import { verifyPassword } from '../backend/src/password.ts';
import { parseBootstrapArgs } from './bootstrap-admin.mjs';
import { runMigrations } from './migrations.mjs';

// These tests never read the project's .env and refuse every real business database.
const rawUrl = process.env.BOOTSTRAP_TEST_DATABASE_URL;
if (!rawUrl) throw new Error('请提供独立临时库 BOOTSTRAP_TEST_DATABASE_URL。');
const url = new URL(rawUrl);
if (!/^bootstrap_test_[a-f0-9]{12}$/.test(url.pathname.slice(1)))
  throw new Error('管理员测试仅允许 bootstrap_test_<12位随机十六进制> 临时数据库。');
const client = new pg.Client({ connectionString: rawUrl, connectionTimeoutMillis: 5000 });
const database = createBusinessDatabase(rawUrl);
const input = {
  login: ' Synthetic.Admin ',
  password: 'synthetic-bootstrap-password',
  teamName: '运营团队',
  displayName: '系统管理员',
};
before(async () => {
  await client.connect();
  await runMigrations(client, 'migrate');
});
beforeEach(async () => {
  await client.query('TRUNCATE public.teams, public.idempotency_records, public.tasks CASCADE');
});
after(async () => {
  await database.close();
  await client.end();
});

test('空库创建管理员、团队和无凭据审计，不创建会话或账号', async () => {
  const result = await bootstrapAdmin(database.db, input);
  assert.equal(result.member.login, 'synthetic.admin');
  assert.equal(result.member.role, 'admin');
  assert.equal(result.member.status, 'active');
  assert.equal(result.team.name, input.teamName);
  assert.ok(!JSON.stringify(result).includes(input.password));
  assert.ok(!('passwordHash' in result.member));
  const row = (await client.query('SELECT * FROM members')).rows[0];
  assert.equal(await verifyPassword(input.password, row.password_hash), true);
  assert.equal(await verifyPassword('wrong-synthetic-password', row.password_hash), false);
  assert.equal(row.created_by, null);
  assert.equal(row.version, 1);
  assert.equal(row.auth_version, 1);
  const events = (await client.query('SELECT * FROM audit_events')).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].target_id, row.id);
  assert.equal(events[0].action, 'member.bootstrapped');
  assert.ok(!JSON.stringify(events).includes(row.password_hash));
  assert.ok(!JSON.stringify(events).includes(input.password));
  assert.equal((await client.query('SELECT count(*)::int AS n FROM accounts')).rows[0].n, 0);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 0);
});

test('重复执行拒绝覆盖密码，不创建额外团队、成员或审计', async () => {
  await bootstrapAdmin(database.db, input);
  const before = (await client.query('SELECT row_to_json(m) AS row FROM members m')).rows;
  await assert.rejects(
    bootstrapAdmin(database.db, { ...input, password: 'different-synthetic-password' }),
    BootstrapError,
  );
  assert.deepEqual(
    (await client.query('SELECT row_to_json(m) AS row FROM members m')).rows,
    before,
  );
  for (const table of ['teams', 'members', 'audit_events'])
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 1);
});

test('并发初始化只有一次成功', async () => {
  const results = await Promise.allSettled([
    bootstrapAdmin(database.db, input),
    bootstrapAdmin(database.db, { ...input, login: 'other.synthetic.admin' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  for (const table of ['teams', 'members', 'audit_events'])
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 1);
});

test('复用同名唯一团队，不修改其信息；团队名称不匹配或多团队时拒绝', async () => {
  await client.query('INSERT INTO teams(name) VALUES ($1)', [input.teamName]);
  const original = (await client.query('SELECT * FROM teams')).rows[0];
  await assert.rejects(
    bootstrapAdmin(database.db, { ...input, teamName: 'other' }),
    BootstrapError,
  );
  assert.equal((await client.query('SELECT count(*)::int AS n FROM members')).rows[0].n, 0);
  const result = await bootstrapAdmin(database.db, input);
  assert.equal(result.team.id, original.id);
  assert.deepEqual((await client.query('SELECT * FROM teams')).rows[0], original);
  await client.query('TRUNCATE teams CASCADE');
  await client.query("INSERT INTO teams(name) VALUES ('first'), ('second')");
  await assert.rejects(bootstrapAdmin(database.db, input), BootstrapError);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM members')).rows[0].n, 0);
});

test('已有运营或禁用管理员时也拒绝首次初始化，不能绕过成员管理', async () => {
  const first = await bootstrapAdmin(database.db, input);
  await client.query("UPDATE members SET role='operator', status='disabled' WHERE id=$1", [
    first.member.id,
  ]);
  await assert.rejects(bootstrapAdmin(database.db, input), BootstrapError);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM members')).rows[0].n, 1);
});

test('审计写入失败时团队和管理员一起回滚', async () => {
  await client.query(`CREATE FUNCTION bootstrap_test_audit_failure() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$`);
  await client.query(`CREATE TRIGGER bootstrap_test_audit_failure
    BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION bootstrap_test_audit_failure()`);
  try {
    await assert.rejects(bootstrapAdmin(database.db, input));
    for (const table of ['teams', 'members', 'audit_events'])
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  } finally {
    await client.query('DROP TRIGGER bootstrap_test_audit_failure ON audit_events');
    await client.query('DROP FUNCTION bootstrap_test_audit_failure()');
  }
});

test('参数校验和 CLI 不接受密码参数，错误输出不回显传入值', async () => {
  assert.equal(parseBootstrapArgs(['--login', 'test']).team, '运营团队');
  const secret = randomBytes(24).toString('hex');
  assert.throws(
    () => parseBootstrapArgs(['--login', 'test', '--password', secret]),
    BootstrapError,
  );
  for (const change of [
    { login: ' ' },
    { login: 'internal whitespace' },
    { password: 'short' },
    { teamName: '' },
    { displayName: 'x'.repeat(101) },
  ]) {
    assert.throws(() => validateBootstrapInput({ ...input, ...change }), BootstrapError);
    await assert.rejects(bootstrapAdmin(database.db, { ...input, ...change }), BootstrapError);
  }
  const cli = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/bootstrap-admin.mjs', '--login', 'test', '--password', secret],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' },
  );
  assert.equal(cli.status, 1);
  assert.ok(!(cli.stdout + cli.stderr).includes(secret));
  assert.equal((await client.query('SELECT count(*)::int AS n FROM teams')).rows[0].n, 0);
});

test('普通 DML 业务角色可初始化，无需拥有表或创建库权限', async () => {
  const role = 'bootstrap_app_' + randomBytes(6).toString('hex');
  const password = randomBytes(24).toString('hex');
  let app;
  await client.query(
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
  );
  try {
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(`GRANT SELECT, INSERT, UPDATE ON teams, members, audit_events TO "${role}"`);
    const appUrl = new URL(rawUrl);
    appUrl.username = role;
    appUrl.password = password;
    app = createBusinessDatabase(appUrl.href);
    const result = await bootstrapAdmin(app.db, input);
    assert.equal(result.member.role, 'admin');
    assert.equal(result.member.status, 'active');
  } finally {
    if (app) await app.close();
    await client.query(`DROP OWNED BY "${role}"`);
    await client.query(`DROP ROLE "${role}"`);
  }
});
