import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { businessTables, firstDifference, inspectBusinessSchema } from './migration-catalog.mjs';

export const legacyManualMigration = {
  hash: '05484f8b9990ef1df7f40a7c7881977bcc769c2c3ec845064df13d14722ab616',
  createdAt: 1793351546786,
};
export const isLegacyManualMigration = (row) =>
  row.hash === legacyManualMigration.hash &&
  Number(row.created_at) === legacyManualMigration.createdAt;
export const legacyManagedTables = [
  ...businessTables,
  'execution_attempts',
  'execution_steps',
  'task_contents',
  'clarification_answers',
  'task_review_cycles',
  'task_review_decisions',
  'task_version_approvals',
];
const functions = [
  'editorial_history_immutable_v5',
  'editorial_approval_binding_v5',
  'editorial_parent_guard_v5',
];

// pg_dump/reparse flattens only the leading associative AND group produced
// by BETWEEN here. Recognize the two exact equivalent clauses, preserving every
// operand, bound, function and the remaining parenthesis structure.
const originalClarificationCheck =
  'CHECK ((((char_length(answer) >= 1) AND (char_length(answer) <= 4000)) AND (char_length(btrim(answer)) > 0) AND ((char_length(question) >= 1) AND (char_length(question) <= 4000))))';
const restoredClarificationCheck =
  'CHECK (((char_length(answer) >= 1) AND (char_length(answer) <= 4000) AND (char_length(btrim(answer)) > 0) AND ((char_length(question) >= 1) AND (char_length(question) <= 4000))))';
export function normalizeLegacyClarificationCheck(value) {
  return value === restoredClarificationCheck ? originalClarificationCheck : value;
}

export async function inspectLegacySchema(client) {
  const schema = await inspectBusinessSchema(client, legacyManagedTables);
  for (const check of schema.tables.clarification_answers.constraints)
    if (check.name === 'clarification_answers_text_check')
      check.definition = normalizeLegacyClarificationCheck(check.definition);
  // The independently verified standalone branch owns this optional trigger.
  // Both versions forbid config mutation; all other triggers remain exact checks.
  schema.tables.config_versions.triggers = schema.tables.config_versions.triggers.filter(
    (t) => t.name !== 'config_versions_immutable',
  );
  schema.manualFunctions = (
    await client.query(
      `SELECT p.proname AS name,btrim(p.prosrc) AS source,p.prosecdef AS security_definer,p.provolatile AS volatility,l.lanname AS language FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname=ANY($1::text[]) AND p.pronargs=0 ORDER BY p.proname`,
      [functions],
    )
  ).rows;
  return schema;
}

export async function legacyMigrationPlan(mainline, folder) {
  const journal = JSON.parse(await readFile(resolve(folder, 'meta/_journal.json'), 'utf8')).entries;
  if (journal[7]?.tag !== '0007_workflow_namespace')
    throw new Error('当前源码缺少已知分支的兼容升级，不能跳过迁移历史。');
  const read = async (name, when) => {
    const bytes = await readFile(resolve(folder, 'compat', name + '.sql'), 'utf8');
    return {
      sql: bytes.split('--> statement-breakpoint'),
      hash: createHash('sha256').update(bytes).digest('hex'),
      folderMillis: when,
    };
  };
  const manual = await read('0005_manual_editorial', legacyManualMigration.createdAt);
  if (manual.hash !== legacyManualMigration.hash)
    throw new Error('已发布的人工审核迁移文件被修改，拒绝升级。');
  const bridge = await read('0006_legacy_workflow_bridge', journal[7].when);
  return { migrations: [...mainline.slice(0, 5), manual, bridge, ...mainline.slice(8)], bridge };
}

export async function verifyLegacyBeforeBridge(client, folder) {
  // The catalog was generated on an isolated DB from the original SQL, never
  // inferred from the database being upgraded.
  const manifest = JSON.parse(
    await readFile(resolve(folder, 'compat/0005_manual_editorial.catalog.json'), 'utf8'),
  );
  if (manifest.sqlHash !== legacyManualMigration.hash)
    throw new Error('兼容分支核对文件与已发布 SQL 不匹配。');
  for (const name of legacyManagedTables)
    await client.query(`LOCK TABLE public."${name}" IN ACCESS EXCLUSIVE MODE`);
  const configGuard = (
    await client.query(
      `SELECT t.tgenabled,t.tgtype FROM pg_trigger t WHERE t.tgrelid='config_versions'::regclass AND t.tgname='config_versions_immutable' AND NOT t.tgisinternal`,
    )
  ).rows[0];
  if (!configGuard || configGuard.tgenabled !== 'O' || configGuard.tgtype !== 27)
    throw new Error('旧分支缺少有效的配置不可变保护；拒绝升级。');
  const difference = firstDifference(manifest.schema, await inspectLegacySchema(client));
  if (difference)
    throw new Error(`人工审核旧分支结构存在差异：${difference}；未更改结构或迁移记录。`);
  for (const name of ['task_review_cycles', 'task_review_decisions', 'task_version_approvals']) {
    if ((await client.query(`SELECT EXISTS(SELECT 1 FROM ${name}) AS present`)).rows[0].present)
      throw new Error('旧分支已有审核、裁决或批准记录，需要专门迁移这些记录；未执行升级。');
  }
  if (
    (
      await client.query(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE current_review_cycle_id IS NOT NULL OR current_approval_id IS NOT NULL OR approval_status<>'not_requested') AS present",
      )
    ).rows[0].present
  )
    throw new Error('旧任务仍有审核或批准引用；请先使用对应版本处理，未执行升级。');
  if (
    (
      await client.query(
        "SELECT EXISTS(SELECT 1 FROM execution_attempts WHERE status IN ('queued','running','awaiting_clarification')) AS present",
      )
    ).rows[0].present
  )
    throw new Error('仍有旧执行在进行，请先用旧版本停止执行再升级。');
}
