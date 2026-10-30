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
import {
  migrationsFolder,
  runMigrations as runLatestMigrations,
  validateBusinessTarget,
} from './migrations.mjs';

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
let initialFolder;
let d4MetadataFolder;
before(async () => {
  await admin.connect();
  initialFolder = await mkdtemp(join(tmpdir(), 'ops-initial-migration-'));
  await cp(migrationsFolder, initialFolder, { recursive: true });
  const path = join(initialFolder, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  journal.entries = journal.entries.slice(0, 1);
  await writeFile(path, JSON.stringify(journal));
  d4MetadataFolder = await mkdtemp(join(tmpdir(), 'ops-d4-metadata-'));
  await cp(migrationsFolder, d4MetadataFolder, { recursive: true });
  const d4Path = join(d4MetadataFolder, 'meta/_journal.json');
  const d4Journal = JSON.parse(await readFile(d4Path, 'utf8'));
  d4Journal.entries = d4Journal.entries.slice(0, 2);
  await writeFile(d4Path, JSON.stringify(d4Journal));
});
after(async () => {
  await admin.end();
  if (initialFolder) await rm(initialFolder, { recursive: true, force: true });
  if (d4MetadataFolder) await rm(d4MetadataFolder, { recursive: true, force: true });
});

function runAllMigrations(client, action, folder = d4MetadataFolder) {
  return runLatestMigrations(client, action, folder);
}

// Keep historical D3 baseline cases pinned to their original migration.
function runMigrations(client, action, folder = initialFolder) {
  return runAllMigrations(client, action, folder);
}

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
  await assert.rejects(c.query('DELETE FROM teams WHERE id=$1', [team]), (error) =>
    ['23503', '23001'].includes(error.code),
  );
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
  await cp(initialFolder, dir, { recursive: true });
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
  // PostgreSQL 16 requires SET ROLE membership when assigning a database owner.
  await admin.query(`GRANT "${role}" TO CURRENT_USER`);
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

async function applyManualTaskMetadata(client) {
  const migration = readMigrationFiles({ migrationsFolder })[1];
  for (const statement of migration.sql) if (statement.trim()) await client.query(statement);
}

test('D4 空库执行完整迁移，字段、外键和索引与核对文件一致', async (t) => {
  const c = await database(t);
  assert.deepEqual(await runAllMigrations(c, 'migrate'), { applied: 2, pending: 0 });
  const manifest = JSON.parse(
    await readFile(join(migrationsFolder, '0001_d4_task_metadata.catalog.json'), 'utf8'),
  );
  assert.equal(manifest.sqlHash, readMigrationFiles({ migrationsFolder })[1].hash);
  assert.deepEqual(await inspectBusinessSchema(c), manifest.schema);
  const { team, member } = await seed(c);
  await c.query(
    `UPDATE tasks SET created_by=$1, team_id=$2, current_step='research', error_message='test'`,
    [member, team],
  );
  await assert.rejects(
    c.query("UPDATE tasks SET created_by='00000000-0000-0000-0000-000000000000'"),
    { code: '23503' },
  );
  await assert.rejects(c.query("UPDATE tasks SET team_id='00000000-0000-0000-0000-000000000000'"), {
    code: '23503',
  });
  const before = await dataFingerprint(c);
  assert.deepEqual(await runAllMigrations(c, 'migrate'), { applied: 0, pending: 0 });
  assert.deepEqual(await dataFingerprint(c), before);
});

test('D3 增量升级保留历史任务及原始要求，新字段默认空值', async (t) => {
  const c = await database(t);
  await runMigrations(c, 'migrate');
  await seed(c);
  const before = (await c.query('SELECT * FROM tasks')).rows;
  assert.deepEqual(await runAllMigrations(c, 'migrate'), { applied: 1, pending: 0 });
  const after = (await c.query('SELECT * FROM tasks')).rows;
  assert.deepEqual(
    after,
    before.map((row) => ({
      ...row,
      created_by: null,
      team_id: null,
      current_step: null,
      error_message: null,
    })),
  );
});

test('手动新增字段核对后只登记增量记录，重复接管和迁移不修改业务数据', async (t) => {
  const c = await database(t);
  await runMigrations(c, 'migrate');
  await seed(c);
  await applyManualTaskMetadata(c);
  const before = await dataFingerprint(c);
  const schema = await inspectBusinessSchema(c);
  assert.deepEqual(await runAllMigrations(c, 'status'), { applied: 1, pending: 1 });
  assert.deepEqual(await runAllMigrations(c, 'adopt'), {
    adopted: true,
    migration: '0001_d4_task_metadata',
    tablesVerified: 8,
  });
  assert.deepEqual(await runAllMigrations(c, 'adopt'), { adopted: false, alreadyApplied: true });
  assert.deepEqual(await runAllMigrations(c, 'migrate'), { applied: 0, pending: 0 });
  assert.deepEqual(await dataFingerprint(c), before);
  assert.deepEqual(await inspectBusinessSchema(c), schema);
  assert.deepEqual(await runAllMigrations(c, 'status'), { applied: 2, pending: 0 });
});

test('增量接管拒绝字段、外键、索引或已有结构偏差，不写迁移记录', async (t) => {
  const cases = [
    'ALTER TABLE tasks ALTER COLUMN current_step TYPE varchar(100)',
    "ALTER TABLE tasks ALTER COLUMN error_message SET DEFAULT 'unexpected'",
    'ALTER TABLE tasks ALTER COLUMN created_by SET NOT NULL',
    'ALTER TABLE tasks DROP CONSTRAINT tasks_created_by_fkey',
    'ALTER TABLE tasks DROP CONSTRAINT tasks_team_id_fkey',
    'DROP INDEX tasks_team_created_at_idx',
    'DROP INDEX tasks_created_by_idx',
    'ALTER TABLE tasks DROP COLUMN current_step',
    'ALTER TABLE members ALTER COLUMN auth_version SET DEFAULT 2',
  ];
  for (const sql of cases) {
    const c = await database(t);
    await runMigrations(c, 'migrate');
    const { member, team } = await seed(c);
    await applyManualTaskMetadata(c);
    await c.query(
      `UPDATE tasks SET created_by=$1, team_id=$2, current_step='research', error_message='test'`,
      [member, team],
    );
    await c.query(sql);
    const before = await dataFingerprint(c);
    await assert.rejects(runAllMigrations(c, 'adopt'), /现有结构与增量迁移不一致/);
    assert.deepEqual(await runAllMigrations(c, 'status'), { applied: 1, pending: 1 });
    assert.deepEqual(await dataFingerprint(c), before);
  }
});

test('增量接管核对 SQL 哈希且要求已有初始基线', async (t) => {
  const c = await database(t);
  await assert.rejects(runAllMigrations(c, 'adopt'), /先核对并登记初始基线/);
  assert.equal(
    (await c.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS name")).rows[0].name,
    null,
  );
  await runMigrations(c, 'migrate');
  await applyManualTaskMetadata(c);
  const dir = await mkdtemp(join(tmpdir(), 'ops-adoption-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(migrationsFolder, dir, { recursive: true });
  const file = join(dir, '0001_d4_task_metadata.sql');
  await writeFile(file, (await readFile(file, 'utf8')) + '\n-- changed SQL\n');
  await assert.rejects(runAllMigrations(c, 'adopt', dir), /增量 SQL 与结构核对文件不一致/);
  assert.deepEqual(await runAllMigrations(c, 'status'), { applied: 1, pending: 1 });
});

test('创建草稿迁移保留旧任务，新增任务无执行状态，账号与输入约束真实生效', async (t) => {
  const c = await database(t);
  await runAllMigrations(c, 'migrate');
  const { account } = await seed(c);
  const before = (await c.query('SELECT * FROM tasks')).rows;
  assert.deepEqual(await runLatestMigrations(c, 'migrate'), { applied: 4, pending: 0 });
  assert.deepEqual(
    (await c.query('SELECT * FROM tasks')).rows,
    before.map((row) => ({
      ...row,
      account_id: null,
      reference_inputs: [],
      lifecycle: 'open',
      revision: 1,
      current_attempt_id: null,
      current_content_version_id: null,
      current_review_cycle_id: null,
      current_approval_id: null,
      approval_status: 'not_requested',
      work_generation: 0,
    })),
  );
  const [draft] = (
    await c.query(
      `INSERT INTO tasks(title,original_request,account_id)
    VALUES ('draft','original request',$1) RETURNING *`,
      [account],
    )
  ).rows;
  assert.equal(draft.execution_status, null);
  assert.equal(draft.current_step, null);
  assert.deepEqual(draft.reference_inputs, []);
  await assert.rejects(
    c.query("UPDATE tasks SET account_id='00000000-0000-0000-0000-000000000000' WHERE id=$1", [
      draft.id,
    ]),
    { code: '23503' },
  );
  for (const sql of [
    "UPDATE tasks SET reference_inputs='{}'::jsonb",
    "UPDATE tasks SET lifecycle='invalid'",
    'UPDATE tasks SET revision=0',
  ])
    await assert.rejects(c.query(sql), { code: '23514' });
  const fingerprint = await dataFingerprint(c);
  assert.deepEqual(await runLatestMigrations(c, 'migrate'), { applied: 0, pending: 0 });
  assert.deepEqual(await dataFingerprint(c), fingerprint);
});

test('已知人工版本分支与当前任务迁移兼容，保留原历史、内容和密码散列；重复升级不变更数据', async (t) => {
  const { editorialMigration } = await import('./compatible-migrations.mjs');
  const c = await database(t);
  await runMigrations(c, 'migrate');
  const seeded = await seed(c);
  const ddl = [
    'CREATE TABLE content_approvals (id uuid NOT NULL,task_id uuid NOT NULL,data jsonb NOT NULL)',
    'CREATE TABLE content_versions (id uuid NOT NULL,task_id uuid NOT NULL,version_no integer NOT NULL,parent_version_id uuid,data jsonb NOT NULL)',
    'CREATE TABLE editorial_attempts (id uuid NOT NULL,task_id uuid NOT NULL,data jsonb NOT NULL)',
    'CREATE TABLE editorial_tasks (id uuid NOT NULL,team_id uuid NOT NULL,account_id uuid NOT NULL,data jsonb NOT NULL)',
    'CREATE TABLE manual_decisions (id uuid NOT NULL,task_id uuid NOT NULL,review_id uuid NOT NULL,data jsonb NOT NULL)',
    'CREATE TABLE publication_operations (id uuid NOT NULL,task_id uuid NOT NULL,data jsonb NOT NULL)',
    'CREATE TABLE review_cycles (id uuid NOT NULL,task_id uuid NOT NULL,data jsonb NOT NULL)',
    "CREATE FUNCTION keep_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END; $$",
  ];
  for (const sql of ddl) await c.query(sql);
  for (const [table, trigger] of [
    ['content_versions', 'content_versions_immutable'],
    ['review_cycles', 'review_cycles_immutable'],
    ['manual_decisions', 'manual_decisions_immutable'],
    ['editorial_attempts', 'editorial_attempts_immutable'],
    ['config_versions', 'config_versions_immutable'],
    ['content_approvals', 'content_approvals_binding'],
  ])
    await c.query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION keep_history()`,
    );
  await c.query(
    'INSERT INTO editorial_tasks VALUES(gen_random_uuid(),$1,$2,\'{"body":"原有文案"}\'::jsonb)',
    [seeded.team, seeded.account],
  );
  await c.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)', [
    editorialMigration.hash,
    editorialMigration.createdAt,
  ]);
  const originalHistory = (
    await c.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')
  ).rows;
  assert.deepEqual(await runLatestMigrations(c, 'status'), {
    applied: 1,
    pending: 5,
    retainedCompatible: 1,
  });
  assert.deepEqual(await runLatestMigrations(c, 'migrate'), { applied: 5, pending: 0 });
  for (const entry of originalHistory)
    assert.equal(
      (
        await c.query(
          'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE hash=$1 AND created_at=$2',
          [entry.hash, entry.created_at],
        )
      ).rows[0].n,
      1,
    );
  assert.equal(
    (await c.query('SELECT password_hash FROM members WHERE id=$1', [seeded.member])).rows[0]
      .password_hash,
    'synthetic-hash',
  );
  assert.equal(
    (await c.query("SELECT data->>'body' AS body FROM editorial_tasks")).rows[0].body,
    '原有文案',
  );
  const before = await dataFingerprint(c);
  assert.deepEqual(await runLatestMigrations(c, 'migrate'), { applied: 0, pending: 0 });
  assert.deepEqual(await dataFingerprint(c), before);
  // A matching timestamp alone never permits an unknown/edited migration hash.
  await c.query('UPDATE drizzle.__drizzle_migrations SET hash=$1 WHERE hash=$2', [
    'bad-history',
    editorialMigration.hash,
  ]);
  await assert.rejects(runLatestMigrations(c, 'migrate'), /迁移历史与本地 SQL 不一致/);
});
