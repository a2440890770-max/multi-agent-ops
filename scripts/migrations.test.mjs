import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { businessTables, inspectBusinessSchema } from './migration-catalog.mjs';
import { migrationsFolder, runMigrations, validateBusinessTarget } from './migrations.mjs';

const root = new URL('../', import.meta.url);
const envPath = new URL('.env', root);
const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL
  ? new URL(process.env.MIGRATION_TEST_ADMIN_URL)
  : new URL(`postgresql://127.0.0.1:${env.POSTGRES_PORT || '5432'}/postgres`);
if (!process.env.MIGRATION_TEST_ADMIN_URL) {
  if (!env.POSTGRES_USER || !env.POSTGRES_PASSWORD)
    throw new Error(
      'db:test 需要本地 .env 管理配置或 MIGRATION_TEST_ADMIN_URL；测试只创建/删除独立临时库。',
    );
  adminUrl.username = env.POSTGRES_USER;
  adminUrl.password = env.POSTGRES_PASSWORD;
}
const admin = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
before(() => admin.connect());
after(() => admin.end());

async function database(t) {
  const name = `d3_migration_test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  t.after(async () => {
    await client.end();
    await admin.query(`DROP DATABASE "${name}"`);
  });
  await client.connect();
  return client;
}

async function seed(client) {
  const team = (
    await client.query("INSERT INTO teams(name) VALUES ('migration-test') RETURNING id")
  ).rows[0].id;
  const member = (
    await client.query(
      `INSERT INTO members(team_id,login,password_hash,display_name,role)
     VALUES ($1,'Admin','synthetic-hash','Test admin','admin') RETURNING id`,
      [team],
    )
  ).rows[0].id;
  const account = (
    await client.query(
      "INSERT INTO accounts(team_id,display_name) VALUES ($1,'Test account') RETURNING id",
      [team],
    )
  ).rows[0].id;
  await client.query(
    `INSERT INTO config_versions(account_id,version,profile,tone,model_ref,prompt_version,
       tool_version,change_reason,updated_by) VALUES ($1,1,'test','test','model','p1','t1','test',$2)`,
    [account, member],
  );
  await client.query('UPDATE accounts SET current_config_version=1 WHERE id=$1', [account]);
  await client.query(
    `INSERT INTO sessions(member_id,token_hash,csrf_secret,issued_auth_version)
     VALUES ($1,'synthetic-token-hash',$2,1)`,
    [member, Buffer.alloc(32, 7)],
  );
  await client.query(
    `INSERT INTO audit_events(team_id,actor_type,actor_id,action,target_type,outcome,request_id)
     VALUES ($1,'member',$2,'test','test','succeeded','synthetic-request')`,
    [team, member],
  );
  await client.query(
    `INSERT INTO idempotency_records(scope_hash,key_hash,request_fingerprint,expires_at)
     VALUES ('synthetic-scope','synthetic-key','synthetic-fingerprint',CURRENT_TIMESTAMP+interval '1 day')`,
  );
  await client.query(
    "INSERT INTO tasks(title,original_request) VALUES ('preserve me','synthetic request')",
  );
  return { team, member, account };
}

async function dataFingerprint(client) {
  const rows = {};
  for (const name of businessTables)
    rows[name] = (
      await client.query(
        `SELECT md5(string_agg(row_to_json(t)::text, '' ORDER BY id)) AS hash FROM public."${name}" t`,
      )
    ).rows[0].hash;
  return rows;
}

test('空库初始化完整结构，重复迁移不变更结构或数据', async (t) => {
  const c = await database(t);
  assert.deepEqual(await runMigrations(c, 'migrate'), { applied: 1, pending: 0 });
  const manifest = JSON.parse(
    await readFile(join(migrationsFolder, '0000_baseline.catalog.json'), 'utf8'),
  );
  assert.equal(manifest.sqlHash, readMigrationFiles({ migrationsFolder })[0].hash);
  assert.deepEqual(await inspectBusinessSchema(c), manifest.schema);
  await seed(c);
  const before = await dataFingerprint(c);
  assert.deepEqual(await runMigrations(c, 'migrate'), { applied: 0, pending: 0 });
  assert.deepEqual(await dataFingerprint(c), before);
  assert.deepEqual(await runMigrations(c, 'status'), { applied: 1, pending: 0 });
});

test('已有未登记表必须核对基线；接管完整保留所有表数据', async (t) => {
  const c = await database(t);
  await runMigrations(c, 'migrate');
  await seed(c);
  await c.query('DROP SCHEMA drizzle CASCADE');
  const before = await dataFingerprint(c);
  await assert.rejects(runMigrations(c, 'migrate'), /db:baseline/);
  assert.equal(
    (await c.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS name")).rows[0].name,
    null,
  );
  assert.deepEqual(await runMigrations(c, 'baseline'), { baselined: true, tablesVerified: 8 });
  assert.deepEqual(await runMigrations(c, 'baseline'), { baselined: false, alreadyApplied: true });
  assert.deepEqual(await runMigrations(c, 'migrate'), { applied: 0, pending: 0 });
  assert.deepEqual(await dataFingerprint(c), before);
});

test('pg_dump 恢复时 CHECK 表达式的等价重解析仍能通过基线核对', async (t) => {
  const c = await database(t);
  await runMigrations(c, 'migrate');
  await seed(c);
  const before = await dataFingerprint(c);
  await c.query('DROP SCHEMA drizzle CASCADE');
  const checks = await c.query(`SELECT c.relname AS table_name, p.conname AS name,
    pg_get_constraintdef(p.oid) AS definition FROM pg_constraint p
    JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND p.contype='c' ORDER BY c.relname,p.conname`);
  const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
  for (const check of checks.rows) {
    await c.query(
      `ALTER TABLE public.${quote(check.table_name)} DROP CONSTRAINT ${quote(check.name)}`,
    );
    await c.query(
      `ALTER TABLE public.${quote(check.table_name)} ADD CONSTRAINT ${quote(check.name)} ${check.definition}`,
    );
  }
  assert.deepEqual(await runMigrations(c, 'baseline'), { baselined: true, tablesVerified: 8 });
  assert.deepEqual(await dataFingerprint(c), before);
  // A different value is a real schema change, not a harmless cast rewrite.
  await c.query('DROP SCHEMA drizzle CASCADE');
  await c.query(
    "ALTER TABLE members DROP CONSTRAINT members_role_check; ALTER TABLE members ADD CONSTRAINT members_role_check CHECK(role IN ('admin','operator','owner'))",
  );
  await assert.rejects(runMigrations(c, 'baseline'), /结构与初始迁移不一致/);
});

test('缺字段/约束/索引/触发器或默认值不符时拒绝接管，不写迁移记录', async (t) => {
  const c = await database(t);
  await runMigrations(c, 'migrate');
  await c.query('DROP SCHEMA drizzle CASCADE');
  const cases = [
    'ALTER TABLE members DROP COLUMN display_name',
    'ALTER TABLE members DROP CONSTRAINT members_role_check',
    'DROP INDEX members_login_normalized_unique_idx',
    'DROP TRIGGER teams_set_updated_at_trg ON teams',
    'ALTER TABLE members ALTER COLUMN auth_version SET DEFAULT 2',
    'ALTER TABLE teams RENAME TO missing_teams',
  ];
  for (const sql of cases) {
    // Rebuild only this disposable database's schema after each drift case.
    await c.query(sql);
    await assert.rejects(runMigrations(c, 'baseline'));
    assert.equal(
      (await c.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS name")).rows[0].name,
      null,
    );
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await runMigrations(c, 'migrate');
    await c.query('DROP SCHEMA drizzle CASCADE');
  }
});

test('数据库真实执行唯一性、外键、检查约束、默认过期时间和更新时间触发器', async (t) => {
  const c = await database(t);
  await runMigrations(c, 'migrate');
  const { team, member, account } = await seed(c);
  await assert.rejects(
    c.query(
      `INSERT INTO members(team_id,login,password_hash,display_name,role)
     VALUES ($1,' admin ','test','test','operator')`,
      [team],
    ),
    { code: '23505' },
  );
  await assert.rejects(c.query("UPDATE members SET role='owner' WHERE id=$1", [member]), {
    code: '23514',
  });
  await assert.rejects(
    c.query('UPDATE accounts SET current_config_version=2 WHERE id=$1', [account]),
    { code: '23503' },
  );
  await assert.rejects(c.query('DELETE FROM teams WHERE id=$1', [team]), { code: '23503' });
  await assert.rejects(c.query('UPDATE config_versions SET max_auto_revisions=4'), {
    code: '23514',
  });
  await assert.rejects(c.query("UPDATE config_versions SET rules='{}'::jsonb"), { code: '23514' });
  const session = (
    await c.query(
      'SELECT extract(epoch FROM expires_at-created_at)::int AS lifetime,csrf_secret FROM sessions',
    )
  ).rows[0];
  assert.equal(session.lifetime, 8 * 3600);
  assert.deepEqual(session.csrf_secret, Buffer.alloc(32, 7));
  for (const name of ['teams', 'members', 'accounts']) {
    await c.query(`UPDATE ${name} SET updated_at='2000-01-01'`);
    const row = (
      await c.query(`SELECT updated_at > '2020-01-01'::timestamptz AS updated FROM ${name}`)
    ).rows[0];
    assert.equal(row.updated, true);
  }
});

test('后续新增字段按版本升级；失败回滚 DDL 和记录，修改过的历史 SQL 被拒绝', async (t) => {
  const c = await database(t);
  await runMigrations(c, 'migrate');
  await seed(c);
  const original = await dataFingerprint(c);
  const dir = await mkdtemp(join(tmpdir(), 'ops-migrations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.entries.push({
    idx: 1,
    version: '7',
    when: journal.entries[0].when + 1,
    tag: '0001_test_upgrade',
    breakpoints: true,
  });
  await writeFile(journalPath, JSON.stringify(journal));
  const upgrade = join(dir, '0001_test_upgrade.sql');
  await writeFile(
    upgrade,
    'ALTER TABLE tasks ADD COLUMN migration_note text;\n--> statement-breakpoint\nSELECT 1/0;',
  );
  await assert.rejects(runMigrations(c, 'migrate', dir), { code: '22012' });
  assert.deepEqual(await dataFingerprint(c), original);
  assert.equal(
    (
      await c.query(
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='tasks' AND column_name='migration_note'",
      )
    ).rows[0].n,
    0,
  );
  assert.deepEqual(await runMigrations(c, 'status', dir), { applied: 1, pending: 1 });
  await writeFile(upgrade, 'ALTER TABLE tasks ADD COLUMN migration_note text;');
  assert.deepEqual(await runMigrations(c, 'migrate', dir), { applied: 1, pending: 0 });
  assert.equal((await c.query('SELECT migration_note FROM tasks')).rows[0].migration_note, null);
  await writeFile(
    upgrade,
    '-- edited after application\nALTER TABLE tasks ADD COLUMN migration_note text;',
  );
  await assert.rejects(runMigrations(c, 'migrate', dir), /迁移历史与本地 SQL 不一致/);
});

test('业务迁移入口拒绝记忆库与系统库', () => {
  for (const name of ['postgres', 'template1', 'agent_memory', 'multi_agent_memory', 'mem0_test'])
    assert.throws(() => validateBusinessTarget({ DATABASE_URL: `postgresql://localhost/${name}` }));
  assert.throws(() =>
    validateBusinessTarget({
      DATABASE_URL: 'postgresql://localhost/custom_memory',
      MEM0_DATABASE_URL: 'postgresql://another-host/custom_memory',
    }),
  );
  assert.equal(
    validateBusinessTarget({ DATABASE_URL: 'postgresql://localhost/agent_ops' }).pathname,
    '/agent_ops',
  );
});

test('两个迁移进程串行执行，初始版本只应用一次', async (t) => {
  const first = await database(t);
  const name = (await first.query('SELECT current_database() AS name')).rows[0].name;
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  const second = new pg.Client({ connectionString: url.href });
  await second.connect();
  try {
    const results = await Promise.all([
      runMigrations(first, 'migrate'),
      runMigrations(second, 'migrate'),
    ]);
    assert.deepEqual(results.map((r) => r.applied).sort(), [0, 1]);
    assert.equal(
      (await first.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n,
      1,
    );
  } finally {
    await second.end();
  }
});

test('独立非超级用户可初始化自己拥有的业务库', async (t) => {
  const suffix = randomBytes(8).toString('hex');
  const role = 'd3_migration_role_' + suffix;
  const name = 'd3_migration_test_' + suffix;
  const password = randomBytes(24).toString('hex');
  await admin.query(
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  );
  let client;
  t.after(async () => {
    if (client) await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE "${role}"`);
  });
  await admin.query(`CREATE DATABASE "${name}" OWNER "${role}"`);
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  url.username = role;
  url.password = password;
  client = new pg.Client({ connectionString: url.href });
  await client.connect();
  assert.equal(
    (await client.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]
      .rolsuper,
    false,
  );
  assert.deepEqual(await runMigrations(client, 'migrate'), { applied: 1, pending: 0 });
  await seed(client);
  await client.query('DROP SCHEMA drizzle CASCADE');
  assert.deepEqual(await runMigrations(client, 'baseline'), { baselined: true, tablesVerified: 8 });
});
