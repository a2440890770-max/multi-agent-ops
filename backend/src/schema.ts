import { sql } from 'drizzle-orm';
import type { Clarification, Failure, SourceRef } from '@multi-agent-ops/shared';
import {
  type PgTableExtraConfigValue,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () =>
  time('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`);
const updatedAt = () =>
  time('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`);

// SQL migrations also maintain set_updated_at() and the three UPDATE triggers.
export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id').notNull(),
    login: varchar('login', { length: 254 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: varchar('display_name', { length: 100 }).notNull(),
    role: varchar('role', { length: 20 }).$type<'admin' | 'operator'>().notNull(),
    status: varchar('status', { length: 20 })
      .$type<'active' | 'disabled'>()
      .notNull()
      .default('active'),
    version: integer('version').notNull().default(1),
    authVersion: integer('auth_version').notNull().default(1),
    passwordChangedAt: time('password_changed_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('members_login_key').on(t.login),
    uniqueIndex('members_login_normalized_unique_idx').on(sql`lower(btrim(${t.login}::text))`),
    index('members_team_id_idx').on(t.teamId),
    check('members_role_check', sql`${t.role} IN ('admin', 'operator')`),
    check('members_status_check', sql`${t.status} IN ('active', 'disabled')`),
    check('members_version_check', sql`${t.version} >= 1`),
    check('members_auth_version_check', sql`${t.authVersion} >= 1`),
    foreignKey({
      name: 'members_team_id_fkey',
      columns: [t.teamId],
      foreignColumns: [teams.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'members_created_by_fkey',
      columns: [t.createdBy],
      foreignColumns: [t.id],
    }).onDelete('set null'),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    csrfSecret: bytea('csrf_secret').notNull(),
    issuedAuthVersion: integer('issued_auth_version').notNull(),
    createdAt: createdAt(),
    expiresAt: time('expires_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP + interval '8 hours'`),
    revokedAt: time('revoked_at'),
    revokeReason: varchar('revoke_reason', { length: 50 }),
  },
  (t) => [
    unique('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_member_id_idx').on(t.memberId),
    index('sessions_expires_at_idx').on(t.expiresAt),
    check('sessions_issued_auth_version_check', sql`${t.issuedAuthVersion} >= 1`),
    check('sessions_expiry_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
    foreignKey({
      name: 'sessions_member_id_fkey',
      columns: [t.memberId],
      foreignColumns: [members.id],
    }).onDelete('restrict'),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id').notNull(),
    platform: varchar('platform', { length: 20 }).$type<'weibo'>().notNull().default('weibo'),
    platformAccountId: varchar('platform_account_id', { length: 128 }),
    displayName: varchar('display_name', { length: 100 }).notNull(),
    authorizationStatus: varchar('authorization_status', { length: 20 })
      .$type<'unconfigured' | 'valid' | 'expired'>()
      .notNull()
      .default('unconfigured'),
    officialPublishAvailable: boolean('official_publish_available').notNull().default(false),
    credentialRef: text('credential_ref'),
    authorizationExpiresAt: time('authorization_expires_at'),
    lastVerifiedAt: time('last_verified_at'),
    currentConfigVersion: integer('current_config_version'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('accounts_team_id_key').on(t.teamId),
    check('accounts_platform_check', sql`${t.platform} = 'weibo'`),
    check(
      'accounts_authorization_status_check',
      sql`${t.authorizationStatus} IN ('unconfigured', 'valid', 'expired')`,
    ),
    check('accounts_current_config_version_check', sql`${t.currentConfigVersion} >= 1`),
    foreignKey({
      name: 'accounts_team_id_fkey',
      columns: [t.teamId],
      foreignColumns: [teams.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'accounts_current_config_version_fk',
      columns: [t.id, t.currentConfigVersion],
      foreignColumns: [configVersions.accountId, configVersions.version],
    }),
  ],
);

export const configVersions = pgTable(
  'config_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull(),
    version: integer('version').notNull(),
    profile: text('profile').notNull(),
    tone: text('tone').notNull(),
    forbiddenTopics: jsonb('forbidden_topics')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    rules: jsonb('rules')
      .$type<{ id: string; description: string; deterministic: boolean }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    modelRef: varchar('model_ref', { length: 128 }).notNull(),
    promptVersion: varchar('prompt_version', { length: 128 }).notNull(),
    toolVersion: varchar('tool_version', { length: 128 }).notNull(),
    maxAutoRevisions: integer('max_auto_revisions').notNull().default(3),
    changeReason: text('change_reason').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('config_versions_account_version_unique').on(t.accountId, t.version),
    foreignKey({
      name: 'config_versions_account_id_fkey',
      columns: [t.accountId],
      foreignColumns: [accounts.id],
    }).onDelete('restrict'),
    index('config_versions_updated_by_idx').on(t.updatedBy),
    check('config_versions_version_check', sql`${t.version} >= 1`),
    check(
      'config_versions_forbidden_topics_check',
      sql`jsonb_typeof(${t.forbiddenTopics}) = 'array'`,
    ),
    check('config_versions_rules_check', sql`jsonb_typeof(${t.rules}) = 'array'`),
    check('config_versions_max_auto_revisions_check', sql`${t.maxAutoRevisions} = 3`),
    foreignKey({
      name: 'config_versions_updated_by_fkey',
      columns: [t.updatedBy],
      foreignColumns: [members.id],
    }).onDelete('restrict'),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id'),
    taskId: uuid('task_id'),
    actorType: varchar('actor_type', { length: 20 })
      .$type<'member' | 'worker' | 'system'>()
      .notNull(),
    actorId: varchar('actor_id', { length: 128 }),
    action: varchar('action', { length: 100 }).notNull(),
    targetType: varchar('target_type', { length: 50 }).notNull(),
    targetId: varchar('target_id', { length: 128 }),
    beforeRevision: integer('before_revision'),
    afterRevision: integer('after_revision'),
    outcome: varchar('outcome', { length: 20 })
      .$type<'succeeded' | 'rejected' | 'failed'>()
      .notNull(),
    reason: text('reason'),
    requestId: varchar('request_id', { length: 128 }).notNull(),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    index('audit_events_task_time_idx').on(t.taskId, t.createdAt.desc(), t.id.desc()),
    foreignKey({
      name: 'audit_events_task_fk',
      columns: [t.taskId],
      foreignColumns: [tasks.id],
    }).onDelete('restrict'),
    index('audit_events_request_id_idx').on(t.requestId),
    index('audit_events_team_time_idx').on(t.teamId, t.createdAt.desc().nullsFirst()),
    check('audit_events_actor_type_check', sql`${t.actorType} IN ('member', 'worker', 'system')`),
    check('audit_events_outcome_check', sql`${t.outcome} IN ('succeeded', 'rejected', 'failed')`),
    foreignKey({
      name: 'audit_events_team_id_fkey',
      columns: [t.teamId],
      foreignColumns: [teams.id],
    }).onDelete('set null'),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scopeHash: text('scope_hash').notNull(),
    keyHash: text('key_hash').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    status: varchar('status', { length: 20 })
      .$type<'processing' | 'completed'>()
      .notNull()
      .default('processing'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    encryptedReplay: bytea('encrypted_replay'),
    createdAt: createdAt(),
    expiresAt: time('expires_at').notNull(),
  },
  (t) => [
    unique('idempotency_scope_key_unique').on(t.scopeHash, t.keyHash),
    index('idempotency_records_expires_at_idx').on(t.expiresAt),
    check('idempotency_records_status_check', sql`${t.status} IN ('processing', 'completed')`),
    check(
      'idempotency_records_response_status_check',
      sql`${t.responseStatus} >= 100 AND ${t.responseStatus} <= 599`,
    ),
    check('idempotency_expiry_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

// Preserve prototype data. D4 adds task ownership and execution metadata; this
// is still not the full workflow model in shared/domain.ts.
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    originalRequest: text('original_request').notNull(),
    executionStatus: text('execution_status').$type<
      | 'awaiting_clarification'
      | 'queued'
      | 'running'
      | 'needs_human'
      | 'ready'
      | 'failed'
      | 'cancelled'
    >(),
    createdAt: time('created_at').notNull().defaultNow(),
    updatedAt: time('updated_at').notNull().defaultNow(),
    createdBy: uuid('created_by'),
    teamId: uuid('team_id'),
    currentStep: text('current_step'),
    errorMessage: text('error_message'),
    accountId: uuid('account_id'),
    referenceInputs: jsonb('reference_inputs')
      .$type<SourceRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    lifecycle: text('lifecycle')
      .$type<'open' | 'terminated' | 'published'>()
      .notNull()
      .default('open'),
    revision: integer('revision').notNull().default(1),
    currentAttemptId: uuid('current_attempt_id'),
    currentContentVersionId: uuid('current_content_version_id'),
    workGeneration: integer('work_generation').notNull().default(0),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'tasks_current_attempt_fk',
      columns: [t.id, t.currentAttemptId],
      foreignColumns: [executionAttempts.taskId, executionAttempts.id],
    }),
    foreignKey({
      name: 'tasks_current_content_fk',
      columns: [t.id, t.currentContentVersionId],
      foreignColumns: [taskContents.taskId, taskContents.id],
    }),
    check('tasks_work_generation_check', sql`${t.workGeneration} >= 0`),
    foreignKey({
      name: 'tasks_created_by_fkey',
      columns: [t.createdBy],
      foreignColumns: [members.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tasks_team_id_fkey',
      columns: [t.teamId],
      foreignColumns: [teams.id],
    }).onDelete('restrict'),
    index('tasks_team_created_at_idx').on(t.teamId, t.createdAt.desc().nullsFirst()),
    index('tasks_created_by_idx').on(t.createdBy),
    foreignKey({
      name: 'tasks_account_id_fkey',
      columns: [t.accountId],
      foreignColumns: [accounts.id],
    }).onDelete('restrict'),
    check('tasks_reference_inputs_check', sql`jsonb_typeof(${t.referenceInputs}) = 'array'`),
    check('tasks_lifecycle_check', sql`${t.lifecycle} IN ('open', 'terminated', 'published')`),
    check('tasks_revision_check', sql`${t.revision} >= 1`),
    check(
      'tasks_execution_status_check',
      sql`${t.executionStatus} IN ('awaiting_clarification', 'queued', 'running', 'needs_human', 'ready', 'failed', 'cancelled')`,
    ),
  ],
);

export type SimulationScenario = 'success' | 'failure' | 'clarification';
export interface MockSnapshot {
  executorVersion: 1;
  mode: 'mock';
  scenario: SimulationScenario;
  originalRequest: string;
  referenceInputs: SourceRef[];
  inputRevision: number;
  stepDelayMs: number;
}

export const executionAttempts = pgTable(
  'execution_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    generation: integer('generation').notNull(),
    status: text('status')
      .$type<'queued' | 'running' | 'awaiting_clarification' | 'ready' | 'failed' | 'cancelled'>()
      .notNull(),
    currentStep: text('current_step'),
    autoRevisionCount: integer('auto_revision_count').notNull().default(0),
    configVersion: integer('config_version').notNull().default(1),
    executorMode: text('executor_mode').$type<'mock'>().notNull().default('mock'),
    simulationScenario: text('simulation_scenario').$type<SimulationScenario>().notNull(),
    configSnapshot: jsonb('config_snapshot').$type<MockSnapshot>().notNull(),
    clarifications: jsonb('clarifications')
      .$type<Clarification[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    requestedBy: uuid('requested_by').notNull(),
    createdAt: createdAt(),
    startedAt: time('started_at'),
    finishedAt: time('finished_at'),
    cancelScope: text('cancel_scope').$type<'stop_attempt'>(),
    cancelRequestedAt: time('cancel_requested_at'),
    cancelRequestedBy: uuid('cancel_requested_by'),
    cancelReason: text('cancel_reason'),
    stoppedAt: time('stopped_at'),
    error: jsonb('error').$type<Failure>(),
    nextRunAt: time('next_run_at'),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('execution_attempts_task_id_id_key').on(t.taskId, t.id),
    unique('execution_attempts_task_no_key').on(t.taskId, t.attemptNo),
    uniqueIndex('execution_attempts_active_task_idx')
      .on(t.taskId)
      .where(sql`${t.status} IN ('queued', 'running', 'awaiting_clarification')`),
    index('execution_attempts_due_idx')
      .on(t.nextRunAt)
      .where(sql`${t.status} IN ('queued', 'running')`),
    foreignKey({
      name: 'execution_attempts_task_fk',
      columns: [t.taskId],
      foreignColumns: [tasks.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'execution_attempts_requested_by_fk',
      columns: [t.requestedBy],
      foreignColumns: [members.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'execution_attempts_cancel_by_fk',
      columns: [t.cancelRequestedBy],
      foreignColumns: [members.id],
    }).onDelete('restrict'),
    check(
      'execution_attempts_counts_check',
      sql`${t.attemptNo} >= 1 AND ${t.generation} >= 1 AND ${t.configVersion} >= 1 AND ${t.autoRevisionCount} = 0`,
    ),
    check(
      'execution_attempts_status_check',
      sql`${t.status} IN ('queued', 'running', 'awaiting_clarification', 'ready', 'failed', 'cancelled')`,
    ),
    check('execution_attempts_mode_check', sql`${t.executorMode} = 'mock'`),
    check(
      'execution_attempts_scenario_check',
      sql`${t.simulationScenario} IN ('success', 'failure', 'clarification')`,
    ),
    check(
      'execution_attempts_cancel_scope_check',
      sql`${t.cancelScope} IS NULL OR ${t.cancelScope} = 'stop_attempt'`,
    ),
    check(
      'execution_attempts_snapshot_check',
      sql`jsonb_typeof(${t.configSnapshot}) = 'object' AND jsonb_typeof(${t.clarifications}) = 'array'`,
    ),
    check(
      'execution_attempts_finish_check',
      sql`(${t.status} IN ('ready','failed','cancelled')) = (${t.finishedAt} IS NOT NULL)`,
    ),
  ],
);

export const executionSteps = pgTable(
  'execution_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attemptId: uuid('attempt_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    role: text('role').$type<'supervisor' | 'research' | 'content' | 'review'>().notNull(),
    status: text('status')
      .$type<'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>()
      .notNull()
      .default('queued'),
    startedAt: time('started_at'),
    finishedAt: time('finished_at'),
    durationMs: integer('duration_ms'),
    error: jsonb('error').$type<Failure>(),
  },
  (t) => [
    unique('execution_steps_attempt_ordinal_key').on(t.attemptId, t.ordinal),
    foreignKey({
      name: 'execution_steps_attempt_fk',
      columns: [t.attemptId],
      foreignColumns: [executionAttempts.id],
    }).onDelete('restrict'),
    check('execution_steps_ordinal_check', sql`${t.ordinal} BETWEEN 0 AND 3`),
    check(
      'execution_steps_role_check',
      sql`${t.role} IN ('supervisor','research','content','review')`,
    ),
    check(
      'execution_steps_status_check',
      sql`${t.status} IN ('queued','running','completed','failed','cancelled')`,
    ),
    check('execution_steps_duration_check', sql`${t.durationMs} >= 0`),
  ],
);

export const clarificationAnswers = pgTable(
  'clarification_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    questionId: uuid('question_id').notNull(),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    answeredBy: uuid('answered_by').notNull(),
    answeredAt: time('answered_at').notNull().defaultNow(),
  },
  (t) => [
    unique('clarification_answers_attempt_question_key').on(t.attemptId, t.questionId),
    index('clarification_answers_task_idx').on(t.taskId),
    foreignKey({
      name: 'clarification_answers_attempt_fk',
      columns: [t.taskId, t.attemptId],
      foreignColumns: [executionAttempts.taskId, executionAttempts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'clarification_answers_member_fk',
      columns: [t.answeredBy],
      foreignColumns: [members.id],
    }).onDelete('restrict'),
    check(
      'clarification_answers_text_check',
      sql`char_length(${t.answer}) BETWEEN 1 AND 4000 AND char_length(btrim(${t.answer})) > 0 AND char_length(${t.question}) BETWEEN 1 AND 4000`,
    ),
  ],
);

export const taskContents = pgTable(
  'task_contents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull(),
    originAttemptId: uuid('origin_attempt_id').notNull(),
    versionNo: integer('version_no').notNull(),
    body: text('body').notNull(),
    contentHash: text('content_hash').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('task_contents_task_id_id_key').on(t.taskId, t.id),
    unique('task_contents_task_version_key').on(t.taskId, t.versionNo),
    unique('task_contents_attempt_key').on(t.originAttemptId),
    foreignKey({
      name: 'task_contents_task_fk',
      columns: [t.taskId],
      foreignColumns: [tasks.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'task_contents_attempt_fk',
      columns: [t.taskId, t.originAttemptId],
      foreignColumns: [executionAttempts.taskId, executionAttempts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'task_contents_creator_fk',
      columns: [t.createdBy],
      foreignColumns: [members.id],
    }).onDelete('restrict'),
    check('task_contents_version_check', sql`${t.versionNo} >= 1`),
    check('task_contents_hash_check', sql`${t.contentHash} ~ '^[a-f0-9]{64}$'`),
  ],
);
