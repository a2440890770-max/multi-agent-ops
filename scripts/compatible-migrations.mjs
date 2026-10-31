/** A previously shipped additive editorial branch. Its original ledger entry stays intact. */
export const editorialMigration = {
  hash: 'e615920dc941b85a1c6513c63ae5857cfd14d408c91ccf51a380502ade7cb6a1',
  createdAt: 1793328115377,
};
export function isCompatibleMigration(row) {
  return (
    row.hash === editorialMigration.hash && Number(row.created_at) === editorialMigration.createdAt
  );
}

// This branch created separate tables and immutable-history triggers. It did not
// alter the shared tasks or audit columns used by the D4 migration chain.
const expected = {
  content_approvals: [
    ['id', 'uuid', true],
    ['task_id', 'uuid', true],
    ['data', 'jsonb', true],
  ],
  content_versions: [
    ['id', 'uuid', true],
    ['task_id', 'uuid', true],
    ['version_no', 'integer', true],
    ['parent_version_id', 'uuid', false],
    ['data', 'jsonb', true],
  ],
  editorial_attempts: [
    ['id', 'uuid', true],
    ['task_id', 'uuid', true],
    ['data', 'jsonb', true],
  ],
  editorial_tasks: [
    ['id', 'uuid', true],
    ['team_id', 'uuid', true],
    ['account_id', 'uuid', true],
    ['data', 'jsonb', true],
  ],
  manual_decisions: [
    ['id', 'uuid', true],
    ['task_id', 'uuid', true],
    ['review_id', 'uuid', true],
    ['data', 'jsonb', true],
  ],
  publication_operations: [
    ['id', 'uuid', true],
    ['task_id', 'uuid', true],
    ['data', 'jsonb', true],
  ],
  review_cycles: [
    ['id', 'uuid', true],
    ['task_id', 'uuid', true],
    ['data', 'jsonb', true],
  ],
};
export async function verifyCompatibleMigration(client) {
  for (const [table, columns] of Object.entries(expected)) {
    const result = await client.query(
      `SELECT attname, format_type(atttypid,atttypmod) AS type, attnotnull FROM pg_attribute
      WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped ORDER BY attnum`,
      ['public.' + table],
    );
    const actual = result.rows.map((r) => [r.attname, r.type, r.attnotnull]);
    if (JSON.stringify(actual) !== JSON.stringify(columns))
      throw new Error(`已知人工版本迁移结构不匹配：${table}；拒绝继续升级。`);
  }
  const triggers = await client.query(`SELECT c.relname AS table_name, t.tgname AS trigger_name
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled='O'`);
  for (const [table, name] of [
    ['content_versions', 'content_versions_immutable'],
    ['review_cycles', 'review_cycles_immutable'],
    ['manual_decisions', 'manual_decisions_immutable'],
    ['editorial_attempts', 'editorial_attempts_immutable'],
    ['config_versions', 'config_versions_immutable'],
    ['content_approvals', 'content_approvals_binding'],
  ])
    if (!triggers.rows.some((r) => r.table_name === table && r.trigger_name === name))
      throw new Error(`已知人工版本迁移缺少保护触发器：${table}；拒绝继续升级。`);
}
