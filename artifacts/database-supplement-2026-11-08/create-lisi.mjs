import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readPassword } from '../../scripts/bootstrap-admin.mjs';
import { loadEnvironment } from '../../scripts/postgres-admin.mjs';
import { validateBusinessTarget } from '../../scripts/migrations.mjs';
import { hashPassword, verifyPassword } from '../../backend/src/password.ts';

class MemberCreationError extends Error {}

loadEnvironment();
const url = validateBusinessTarget({
  DATABASE_URL: process.env.DATABASE_URL,
  MEM0_DATABASE_URL: process.env.MEM0_DATABASE_URL,
});
const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
const credentials = { password: '' };
try {
  await client.connect();
  const existing = await client.query(
    'SELECT id FROM public.members WHERE lower(btrim(login::text)) = $1',
    ['lisi'],
  );
  if (existing.rowCount) throw new MemberCreationError('lisi 已存在，未修改已有账号或密码。');
  credentials.password = await readPassword('lisi 的密码（隐藏输入）：');
  const passwordHash = await hashPassword(credentials.password);
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '10s'");
  await client.query('SELECT pg_advisory_xact_lock(1835100527, 168102)');
  await client.query('LOCK TABLE public.teams, public.members IN SHARE ROW EXCLUSIVE MODE');
  const admin = await client.query(
    `SELECT m.team_id, t.name AS team_name
     FROM public.members m JOIN public.teams t ON t.id = m.team_id
     WHERE lower(btrim(m.login::text)) = $1 AND m.role = $2 AND m.status = $3`,
    ['admin', 'admin', 'active'],
  );
  if (admin.rowCount !== 1)
    throw new MemberCreationError('未找到唯一的已启用 admin 管理员，未创建成员。');
  const duplicate = await client.query(
    'SELECT id FROM public.members WHERE lower(btrim(login::text)) = $1',
    ['lisi'],
  );
  if (duplicate.rowCount) throw new MemberCreationError('lisi 已存在，未修改已有账号或密码。');
  const result = await client.query(
    `INSERT INTO public.members (team_id, login, password_hash, display_name, role, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, login, display_name, role, status, team_id`,
    [admin.rows[0].team_id, 'lisi', passwordHash, 'lisi', 'operator', 'active'],
  );
  const member = result.rows[0];
  const stored = await client.query('SELECT password_hash FROM public.members WHERE id = $1', [
    member.id,
  ]);
  if (!(await verifyPassword(credentials.password, stored.rows[0].password_hash)))
    throw new MemberCreationError('密码校验失败，创建已回滚。');
  await client.query(
    `INSERT INTO public.audit_events
       (team_id, actor_type, actor_id, action, target_type, target_id,
        after_revision, outcome, reason, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      member.team_id,
      'system',
      'local-maintenance',
      'member.created',
      'member',
      member.id,
      1,
      'succeeded',
      '按用户要求创建普通运营账号',
      randomUUID(),
    ],
  );
  await client.query('COMMIT');
  console.log(
    JSON.stringify({
      created: true,
      member,
      team: admin.rows[0].team_name,
      passwordVerified: true,
    }),
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(
    error instanceof MemberCreationError
      ? error.message
      : '创建失败，未完成的事务已回滚；请检查数据库连接、成员字段及业务角色权限。',
  );
  process.exitCode = 1;
} finally {
  credentials.password = '';
  await client.end();
}
