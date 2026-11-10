import type {
  GithubHotList,
  SelectedProject,
  ResearchAcceptedResult,
  ResearchContext,
  ResearchWebSnapshot,
  SupervisorContext,
  SupervisorOutput,
  ResearchAuthorizationScope,
  ResearchSubmissionRecord,
  PublicationSnapshot,
  PublicationStatus,
} from '@multi-agent-ops/shared';
import { sql } from 'drizzle-orm';
import type {
  Approval,
  Clarification,
  Failure,
  ManualDecision,
  ReviewCycle,
  SourceRef,
  VerificationRecord,
} from '@multi-agent-ops/shared';
import {
  type PgTableExtraConfigValue,
  boolean,
  bigint,
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
    manualPublishEnabled: boolean('manual_publish_enabled').notNull().default(false),
    registrationVersion: integer('registration_version').notNull().default(0),
    registeredBy: uuid('registered_by').references(() => members.id),
    registeredAt: time('registered_at'),
    credentialRef: text('credential_ref'),
    authorizationExpiresAt: time('authorization_expires_at'),
    lastVerifiedAt: time('last_verified_at'),
    currentConfigVersion: integer('current_config_version'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('accounts_team_id_key').on(t.teamId),
    check('accounts_registration_version_check', sql`${t.registrationVersion} >= 0`),
    check(
      'accounts_manual_registration_check',
      sql`NOT ${t.manualPublishEnabled} OR (${t.registrationVersion} > 0 AND ${t.platformAccountId} IS NOT NULL AND ${t.platformAccountId} ~ '^[1-9][0-9]{0,19}$' AND ${t.registeredBy} IS NOT NULL AND ${t.registeredAt} IS NOT NULL)`,
    ),
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
      | 'awaiting_selection'
      | 'awaiting_materials'
      | 'awaiting_content'
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
    currentReviewCycleId: uuid('current_review_cycle_id'),
    currentApprovalId: uuid('current_approval_id'),
    activePublishOperationId: uuid('active_publish_operation_id'),
    publishedOperationId: uuid('published_operation_id'),
    approvalStatus: text('approval_status')
      .$type<'not_requested' | 'pending' | 'approved' | 'invalidated'>()
      .notNull()
      .default('not_requested'),
    workGeneration: integer('work_generation').notNull().default(0),
    terminatedBy: uuid('terminated_by').references(() => members.id),
    terminatedAt: time('terminated_at'),
    terminationReason: text('termination_reason'),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'tasks_active_publication_fk',
      columns: [t.id, t.activePublishOperationId],
      foreignColumns: [publicationOperations.taskId, publicationOperations.id],
    }),
    foreignKey({
      name: 'tasks_published_publication_fk',
      columns: [t.id, t.publishedOperationId],
      foreignColumns: [publicationOperations.taskId, publicationOperations.id],
    }),
    check(
      'tasks_approval_status_check',
      sql`"tasks"."approval_status" IN ('not_requested','pending','approved','invalidated')`,
    ),
    foreignKey({
      name: 'tasks_current_review_fk',
      columns: [t.id, t.currentReviewCycleId],
      foreignColumns: [taskReviews.taskId, taskReviews.id],
    }),
    foreignKey({
      name: 'tasks_current_approval_fk',
      columns: [t.id, t.currentApprovalId],
      foreignColumns: [taskApprovals.taskId, taskApprovals.id],
    }),
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
    check('tasks_work_generation_check', sql`"tasks"."work_generation" >= 0`),
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
    check('tasks_reference_inputs_check', sql`jsonb_typeof("tasks"."reference_inputs") = 'array'`),
    check('tasks_lifecycle_check', sql`"tasks"."lifecycle" IN ('open', 'terminated', 'published')`),
    check(
      'tasks_termination_record_check',
      sql`("tasks"."terminated_by" IS NULL AND "tasks"."terminated_at" IS NULL AND "tasks"."termination_reason" IS NULL) OR ("tasks"."lifecycle" = 'terminated' AND "tasks"."terminated_by" IS NOT NULL AND "tasks"."terminated_at" IS NOT NULL AND "tasks"."termination_reason" IS NOT NULL AND length(btrim("tasks"."termination_reason")) > 0)`,
    ),
    check('tasks_revision_check', sql`"tasks"."revision" >= 1`),
    check(
      'tasks_execution_status_check',
      sql`"tasks"."execution_status" IN ('awaiting_clarification', 'awaiting_selection', 'awaiting_materials', 'awaiting_content', 'queued', 'running', 'needs_human', 'ready', 'failed', 'cancelled')`,
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
      .$type<
        | 'queued'
        | 'running'
        | 'awaiting_clarification'
        | 'awaiting_selection'
        | 'awaiting_materials'
        | 'awaiting_content'
        | 'ready'
        | 'failed'
        | 'cancelled'
      >()
      .notNull(),
    currentStep: text('current_step'),
    autoRevisionCount: integer('auto_revision_count').notNull().default(0),
    configVersion: integer('config_version').notNull().default(1),
    executorMode: text('executor_mode').$type<'mock' | 'agent'>().notNull().default('mock'),
    simulationScenario: text('simulation_scenario').$type<SimulationScenario>(),
    configSnapshot: jsonb('config_snapshot').$type<MockSnapshot | AgentSnapshot>().notNull(),
    clarifications: jsonb('clarifications')
      .$type<Clarification[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    requestedBy: uuid('requested_by').notNull(),
    createdAt: createdAt(),
    startedAt: time('started_at'),
    finishedAt: time('finished_at'),
    cancelScope: text('cancel_scope').$type<'stop_attempt' | 'terminate_task'>(),
    cancelRequestedAt: time('cancel_requested_at'),
    cancelRequestedBy: uuid('cancel_requested_by'),
    cancelReason: text('cancel_reason'),
    stoppedAt: time('stopped_at'),
    error: jsonb('error').$type<Failure>(),
    nextRunAt: time('next_run_at'),
    executorId: uuid('executor_id'),
    claimToken: uuid('claim_token'),
    claimedAt: time('claimed_at'),
    heartbeatAt: time('heartbeat_at'),
    leaseExpiresAt: time('lease_expires_at'),
    runtimePolicy: jsonb('runtime_policy').$type<import('./execution-config.js').ExecutorPolicy>(),
    executionLimits:
      jsonb('execution_limits').$type<import('./execution-config.js').ExecutionLimits>(),
    activeElapsedMs: integer('active_elapsed_ms').notNull().default(0),
    activeSince: time('active_since'),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('execution_attempts_task_id_id_key').on(t.taskId, t.id),
    unique('execution_attempts_task_no_key').on(t.taskId, t.attemptNo),
    uniqueIndex('execution_attempts_active_task_idx')
      .on(t.taskId)
      .where(
        sql`${t.status} IN ('queued', 'running', 'awaiting_clarification', 'awaiting_selection', 'awaiting_materials', 'awaiting_content')`,
      ),
    index('execution_attempts_due_idx')
      .on(t.nextRunAt)
      .where(sql`${t.status} IN ('queued', 'running')`),
    check('execution_attempts_elapsed_check', sql`"execution_attempts"."active_elapsed_ms" >= 0`),
    index('execution_attempts_lease_idx')
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} = 'running'`),
    check(
      'execution_attempts_lease_check',
      sql`("execution_attempts"."executor_id" IS NULL AND "execution_attempts"."claim_token" IS NULL AND "execution_attempts"."claimed_at" IS NULL AND "execution_attempts"."heartbeat_at" IS NULL AND "execution_attempts"."lease_expires_at" IS NULL) OR ("execution_attempts"."executor_id" IS NOT NULL AND "execution_attempts"."claim_token" IS NOT NULL AND "execution_attempts"."claimed_at" IS NOT NULL AND "execution_attempts"."heartbeat_at" IS NOT NULL AND "execution_attempts"."lease_expires_at" IS NOT NULL AND "execution_attempts"."lease_expires_at" >= "execution_attempts"."heartbeat_at" AND "execution_attempts"."heartbeat_at" >= "execution_attempts"."claimed_at")`,
    ),
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
      sql`"execution_attempts"."attempt_no" >= 1 AND "execution_attempts"."generation" >= 1 AND "execution_attempts"."config_version" >= 1 AND "execution_attempts"."auto_revision_count" = 0`,
    ),
    check(
      'execution_attempts_status_check',
      sql`"execution_attempts"."status" IN ('queued', 'running', 'awaiting_clarification', 'awaiting_selection', 'awaiting_materials', 'awaiting_content', 'ready', 'failed', 'cancelled')`,
    ),
    check(
      'execution_attempts_mode_check',
      sql`"execution_attempts"."executor_mode" IN ('mock','agent')`,
    ),
    check(
      'execution_attempts_scenario_check',
      sql`(("execution_attempts"."executor_mode" = 'mock' AND "execution_attempts"."simulation_scenario" IN ('success', 'failure', 'clarification')) OR ("execution_attempts"."executor_mode" = 'agent' AND "execution_attempts"."simulation_scenario" IS NULL)) IS TRUE`,
    ),
    check(
      'execution_attempts_cancel_scope_check',
      sql`"execution_attempts"."cancel_scope" IS NULL OR "execution_attempts"."cancel_scope" IN ('stop_attempt','terminate_task')`,
    ),
    check(
      'execution_attempts_snapshot_check',
      sql`jsonb_typeof("execution_attempts"."config_snapshot") = 'object' AND jsonb_typeof("execution_attempts"."clarifications") = 'array'`,
    ),
    check(
      'execution_attempts_agent_snapshot_check',
      sql`"execution_attempts"."executor_mode" <> 'agent' OR ("execution_attempts"."config_snapshot"->>'mode' = 'agent' AND "execution_attempts"."config_snapshot"->>'executorVersion' = '1' AND jsonb_typeof("execution_attempts"."config_snapshot"->'configuration') = 'object') IS TRUE`,
    ),
    check(
      'execution_attempts_wait_check',
      sql`("execution_attempts"."status" NOT IN ('awaiting_selection','awaiting_materials','awaiting_content') OR "execution_attempts"."executor_mode" = 'agent') AND ("execution_attempts"."executor_mode" <> 'agent' OR "execution_attempts"."status" NOT IN ('awaiting_clarification','awaiting_selection','awaiting_materials','awaiting_content') OR ("execution_attempts"."executor_id" IS NULL AND "execution_attempts"."active_since" IS NULL AND "execution_attempts"."next_run_at" IS NULL))`,
    ),
    check(
      'execution_attempts_finish_check',
      sql`("execution_attempts"."status" IN ('ready','failed','cancelled')) = ("execution_attempts"."finished_at" IS NOT NULL)`,
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
    retryCount: integer('retry_count').notNull().default(0),
    nextCallAt: time('next_call_at'),
    error: jsonb('error').$type<Failure>(),
    parentStepId: uuid('parent_step_id'),
    authorizationId: uuid('authorization_id'),
    inputSnapshotId: uuid('input_snapshot_id'),
    frozenInput: jsonb('frozen_input').$type<SupervisorContext | ResearchContext>(),
    validatedOutput: jsonb('validated_output').$type<SupervisorOutput | ResearchAcceptedResult>(),
    runtimeMetadata: jsonb('runtime_metadata').$type<Record<string, unknown>>(),
    resultId: text('result_id'),
    resultVersion: integer('result_version'),
    parentResultId: text('parent_result_id'),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('execution_steps_attempt_id_key').on(t.attemptId, t.id),
    unique('execution_steps_attempt_ordinal_key').on(t.attemptId, t.ordinal),
    unique('execution_steps_input_key').on(t.attemptId, t.id, t.inputSnapshotId),
    unique('execution_steps_authorized_key').on(t.attemptId, t.id, t.authorizationId),
    unique('execution_steps_result_key').on(t.attemptId, t.resultId),
    unique('execution_steps_result_version_key').on(t.attemptId, t.resultVersion),
    unique('execution_steps_result_parent_key').on(t.attemptId, t.parentResultId),
    uniqueIndex('execution_steps_research_authorization_idx')
      .on(t.authorizationId)
      .where(sql`${t.role} = 'research' AND ${t.authorizationId} IS NOT NULL`),
    foreignKey({
      name: 'execution_steps_parent_fk',
      columns: [t.attemptId, t.parentStepId],
      foreignColumns: [t.attemptId, t.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'execution_steps_authorization_fk',
      columns: [t.attemptId, t.authorizationId],
      foreignColumns: [researchAuthorizations.attemptId, researchAuthorizations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'execution_steps_result_parent_fk',
      columns: [t.attemptId, t.parentResultId],
      foreignColumns: [t.attemptId, t.resultId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'execution_steps_attempt_fk',
      columns: [t.attemptId],
      foreignColumns: [executionAttempts.id],
    }).onDelete('restrict'),
    check('execution_steps_ordinal_check', sql`"execution_steps"."ordinal" >= 0`),
    check(
      'execution_steps_parent_check',
      sql`"execution_steps"."parent_step_id" IS NULL OR "execution_steps"."parent_step_id" <> "execution_steps"."id"`,
    ),
    check(
      'execution_steps_input_check',
      sql`("execution_steps"."input_snapshot_id" IS NULL AND "execution_steps"."frozen_input" IS NULL) OR ("execution_steps"."input_snapshot_id" IS NOT NULL AND (jsonb_typeof("execution_steps"."frozen_input") = 'object' AND "execution_steps"."frozen_input"->'execution'->>'attemptId' = "execution_steps"."attempt_id"::text AND "execution_steps"."frozen_input"->'execution'->>'stepId' = "execution_steps"."id"::text AND "execution_steps"."frozen_input"->'execution'->>'inputSnapshotId' = "execution_steps"."input_snapshot_id"::text) IS TRUE)`,
    ),
    check(
      'execution_steps_output_check',
      sql`"execution_steps"."validated_output" IS NULL OR ("execution_steps"."status" = 'completed' AND "execution_steps"."frozen_input" IS NOT NULL AND jsonb_typeof("execution_steps"."validated_output") = 'object')`,
    ),
    check(
      'execution_steps_metadata_check',
      sql`"execution_steps"."runtime_metadata" IS NULL OR jsonb_typeof("execution_steps"."runtime_metadata") = 'object'`,
    ),
    check(
      'execution_steps_result_check',
      sql`("execution_steps"."result_id" IS NULL AND "execution_steps"."result_version" IS NULL AND "execution_steps"."parent_result_id" IS NULL AND ("execution_steps"."role" <> 'research' OR "execution_steps"."validated_output" IS NULL)) OR ("execution_steps"."role" = 'research' AND "execution_steps"."authorization_id" IS NOT NULL AND "execution_steps"."result_id" IS NOT NULL AND "execution_steps"."result_version" >= 1 AND (("execution_steps"."result_version" = 1 AND "execution_steps"."parent_result_id" IS NULL) OR ("execution_steps"."result_version" > 1 AND "execution_steps"."parent_result_id" IS NOT NULL AND "execution_steps"."parent_result_id" <> "execution_steps"."result_id")) AND ("execution_steps"."validated_output"->>'id' = "execution_steps"."result_id" AND ("execution_steps"."validated_output"->>'version')::integer = "execution_steps"."result_version" AND "execution_steps"."validated_output"->>'parentResultId' IS NOT DISTINCT FROM "execution_steps"."parent_result_id" AND "execution_steps"."validated_output"->'execution'->>'attemptId' = "execution_steps"."attempt_id"::text AND "execution_steps"."validated_output"->'execution'->>'stepId' = "execution_steps"."id"::text AND "execution_steps"."validated_output"->'execution'->>'inputSnapshotId' = "execution_steps"."input_snapshot_id"::text AND "execution_steps"."validated_output"->>'authorizationId' = "execution_steps"."authorization_id"::text) IS TRUE) IS TRUE`,
    ),
    check(
      'execution_steps_role_check',
      sql`"execution_steps"."role" IN ('supervisor','research','content','review')`,
    ),
    check(
      'execution_steps_status_check',
      sql`"execution_steps"."status" IN ('queued','running','completed','failed','cancelled')`,
    ),
    check(
      'execution_steps_retry_check',
      sql`"execution_steps"."retry_count" >= 0 AND "execution_steps"."retry_count" <= 10`,
    ),
    check('execution_steps_duration_check', sql`"execution_steps"."duration_ms" >= 0`),
    check(
      'execution_steps_frozen_time_check',
      sql`"execution_steps"."frozen_input" IS NULL OR ((("execution_steps"."status" IN ('queued','running')) = ("execution_steps"."finished_at" IS NULL)) AND ("execution_steps"."status" <> 'running' OR "execution_steps"."started_at" IS NOT NULL) AND ("execution_steps"."status" <> 'completed' OR "execution_steps"."started_at" IS NOT NULL) AND ("execution_steps"."started_at" IS NULL OR "execution_steps"."finished_at" IS NULL OR "execution_steps"."finished_at" >= "execution_steps"."started_at"))`,
    ),
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
    originAttemptId: uuid('origin_attempt_id'),
    parentVersionId: uuid('parent_version_id'),
    sourceKind: text('source_kind').$type<'agent' | 'manual'>().notNull().default('agent'),
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
    check(
      'task_contents_source_check',
      sql`${t.sourceKind} IN ('agent','manual') AND (${t.sourceKind} <> 'agent' OR ${t.originAttemptId} IS NOT NULL)`,
    ),
    foreignKey({
      name: 'task_contents_parent_fk',
      columns: [t.taskId, t.parentVersionId],
      foreignColumns: [t.taskId, t.id],
    }).onDelete('restrict'),
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
    check(
      'task_contents_body_hash_check',
      sql`${t.contentHash} = encode(sha256(convert_to(${t.body}, 'UTF8')), 'hex')`,
    ),
  ],
);

export const taskReviews = pgTable(
  'task_review_cycles',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id').notNull(),
    contentVersionId: uuid('content_version_id').notNull(),
    configVersion: integer('config_version').notNull(),
    data: jsonb('data').$type<ReviewCycle>().notNull(),
  },
  (t) => [
    unique('task_reviews_task_id_key').on(t.taskId, t.id),
    foreignKey({
      name: 'task_reviews_content_fk',
      columns: [t.taskId, t.contentVersionId],
      foreignColumns: [taskContents.taskId, taskContents.id],
    }).onDelete('restrict'),
    check(
      'task_reviews_binding_check',
      sql`${t.data}->>'id' = ${t.id}::text AND ${t.data}->>'taskId' = ${t.taskId}::text AND ${t.data}->>'currentVersionId' = ${t.contentVersionId}::text AND (${t.data}->>'configVersion')::integer = ${t.configVersion}`,
    ),
  ],
);

export const taskDecisions = pgTable(
  'task_review_decisions',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id').notNull(),
    reviewId: uuid('review_id').notNull(),
    data: jsonb('data').$type<ManualDecision>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'task_decisions_review_fk',
      columns: [t.taskId, t.reviewId],
      foreignColumns: [taskReviews.taskId, taskReviews.id],
    }).onDelete('restrict'),
    check(
      'task_decisions_binding_check',
      sql`${t.data}->>'id' = ${t.id}::text AND length(btrim(${t.data}->>'reason')) > 0`,
    ),
  ],
);

export const taskApprovals = pgTable(
  'task_version_approvals',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id').notNull(),
    contentVersionId: uuid('content_version_id').notNull(),
    reviewCycleId: uuid('review_cycle_id').notNull(),
    accountId: uuid('account_id').notNull(),
    configVersion: integer('config_version').notNull(),
    data: jsonb('data').$type<Approval>().notNull(),
  },
  (t) => [
    unique('task_approvals_task_id_key').on(t.taskId, t.id),
    foreignKey({
      name: 'task_approvals_content_fk',
      columns: [t.taskId, t.contentVersionId],
      foreignColumns: [taskContents.taskId, taskContents.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'task_approvals_review_fk',
      columns: [t.taskId, t.reviewCycleId],
      foreignColumns: [taskReviews.taskId, taskReviews.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'task_approvals_config_fk',
      columns: [t.accountId, t.configVersion],
      foreignColumns: [configVersions.accountId, configVersions.version],
    }).onDelete('restrict'),
    check(
      'task_approvals_binding_check',
      sql`${t.data}->>'id' = ${t.id}::text AND ${t.data}->>'taskId' = ${t.taskId}::text AND ${t.data}->>'contentVersionId' = ${t.contentVersionId}::text AND ${t.data}->>'reviewCycleId' = ${t.reviewCycleId}::text AND ${t.data}->>'accountId' = ${t.accountId}::text AND ${t.data}->>'status' IN ('approved','invalidated')`,
    ),
  ],
);

export const publicationOperations = pgTable(
  'task_publication_operations',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    contentVersionId: uuid('content_version_id').notNull(),
    contentHash: text('content_hash').notNull(),
    accountId: uuid('account_id').notNull(),
    approvalId: uuid('approval_id').notNull(),
    configVersion: integer('config_version').notNull(),
    snapshot: jsonb('snapshot').$type<PublicationSnapshot>().notNull(),
    status: text('status').$type<PublicationStatus>().notNull(),
    currentDispatchId: uuid('current_dispatch_id').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => members.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('publication_operations_task_id_key').on(t.taskId, t.id),
    unique('publication_operations_business_key').on(t.taskId, t.contentVersionId, t.accountId),
    unique('publication_operations_approval_key').on(t.id, t.approvalId),
    uniqueIndex('publication_operations_active_task_idx')
      .on(t.taskId)
      .where(sql`${t.status} IN ('awaiting_manual','publishing','verification_required')`),
    uniqueIndex('publication_operations_published_task_idx')
      .on(t.taskId)
      .where(sql`${t.status} = 'published'`),
    foreignKey({
      name: 'publication_operations_content_fk',
      columns: [t.taskId, t.contentVersionId],
      foreignColumns: [taskContents.taskId, taskContents.id],
    }),
    foreignKey({
      name: 'publication_operations_approval_fk',
      columns: [t.taskId, t.approvalId],
      foreignColumns: [taskApprovals.taskId, taskApprovals.id],
    }),
    foreignKey({
      name: 'publication_operations_config_fk',
      columns: [t.accountId, t.configVersion],
      foreignColumns: [configVersions.accountId, configVersions.version],
    }),
    foreignKey({
      name: 'publication_operations_current_dispatch_fk',
      columns: [t.id, t.currentDispatchId],
      foreignColumns: [publicationDispatches.operationId, publicationDispatches.id],
    }),
    check(
      'publication_operations_status_check',
      sql`${t.status} IN ('awaiting_manual','publishing','verification_required','published','failed')`,
    ),
    check(
      'publication_operations_snapshot_check',
      sql`(${t.snapshot}->'content'->>'id' = ${t.contentVersionId}::text AND ${t.snapshot}->'content'->>'taskId' = ${t.taskId}::text AND ${t.snapshot}->'content'->>'contentHash' = ${t.contentHash} AND ${t.contentHash} = encode(sha256(convert_to(${t.snapshot}->'content'->>'body','UTF8')),'hex') AND ${t.snapshot}->'account'->>'id' = ${t.accountId}::text AND ${t.snapshot}->'account'->>'platformAccountId' ~ '^[1-9][0-9]{0,19}$' AND ${t.snapshot}->'approval'->>'id' = ${t.approvalId}::text AND ${t.snapshot}->'approval'->>'contentVersionId' = ${t.contentVersionId}::text AND ${t.snapshot}->'approval'->>'accountId' = ${t.accountId}::text AND ${t.snapshot}->'approval'->>'contentHash' = ${t.contentHash} AND (${t.snapshot}->>'configVersion')::integer = ${t.configVersion}) IS TRUE`,
    ),
  ],
);
export const publicationDispatches = pgTable(
  'task_publication_dispatches',
  {
    id: uuid('id').primaryKey(),
    operationId: uuid('operation_id').notNull(),
    dispatchNo: integer('dispatch_no').notNull(),
    previousDispatchId: uuid('previous_dispatch_id'),
    reason: text('reason'),
    approvalId: uuid('approval_id').notNull(),
    channel: text('channel').$type<'manual' | 'official_api' | 'simulation'>().notNull(),
    status: text('status').$type<PublicationStatus>().notNull(),
    startedBy: uuid('started_by')
      .notNull()
      .references(() => members.id),
    startedAt: time('started_at').notNull(),
    finishedAt: time('finished_at'),
    providerRequestId: text('provider_request_id'),
    platformPostId: text('platform_post_id'),
    url: text('url'),
    error: jsonb('error').$type<Failure>(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('publication_dispatches_operation_id_key').on(t.operationId, t.id),
    unique('publication_dispatches_number_key').on(t.operationId, t.dispatchNo),
    uniqueIndex('publication_dispatches_active_operation_idx')
      .on(t.operationId)
      .where(sql`${t.status} IN ('awaiting_manual','publishing','verification_required')`),
    unique('publication_dispatches_previous_key').on(t.operationId, t.previousDispatchId),
    foreignKey({
      name: 'publication_dispatches_previous_fk',
      columns: [t.operationId, t.previousDispatchId],
      foreignColumns: [publicationDispatches.operationId, publicationDispatches.id],
    }),
    check(
      'publication_dispatches_retry_check',
      sql`(${t.dispatchNo}=1 AND ${t.previousDispatchId} IS NULL AND ${t.reason} IS NULL) OR (${t.dispatchNo}>1 AND ${t.previousDispatchId} IS NOT NULL AND length(btrim(${t.reason}))>0 AND ${t.reason} IS NOT NULL)`,
    ),
    foreignKey({
      name: 'publication_dispatches_operation_approval_fk',
      columns: [t.operationId, t.approvalId],
      foreignColumns: [publicationOperations.id, publicationOperations.approvalId],
    }),
    check('publication_dispatches_number_check', sql`${t.dispatchNo} >= 1`),
    check(
      'publication_dispatches_channel_check',
      sql`${t.channel} IN ('manual','official_api','simulation')`,
    ),
    check(
      'publication_dispatches_status_check',
      sql`${t.status} IN ('awaiting_manual','publishing','verification_required','published','failed')`,
    ),
  ],
);

export const publicationVerifications = pgTable(
  'task_publication_verifications',
  {
    id: uuid('id').primaryKey(),
    operationId: uuid('operation_id').notNull(),
    dispatchId: uuid('dispatch_id').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => members.id),
    factHash: text('fact_hash').notNull(),
    data: jsonb('data').$type<VerificationRecord>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('publication_verifications_fact_key').on(t.operationId, t.factHash),
    foreignKey({
      name: 'publication_verifications_dispatch_fk',
      columns: [t.operationId, t.dispatchId],
      foreignColumns: [publicationDispatches.operationId, publicationDispatches.id],
    }),
    check(
      'publication_verifications_binding_check',
      sql`(${t.data}->>'id' = ${t.id}::text AND ${t.data}->>'operationId' = ${t.operationId}::text AND ${t.data}->>'dispatchId' = ${t.dispatchId}::text AND ${t.data}->>'actorId' = ${t.actorId}::text AND ${t.data}->>'method' = 'manual' AND ${t.data}->>'conclusion' IN ('published','not_published','unknown') AND length(btrim(${t.data}->>'note')) > 0 AND ${t.data}->>'resultingStatus' IN ('verification_required','published','failed') AND ${t.factHash} ~ '^[a-f0-9]{64}$') IS TRUE`,
    ),
    check(
      'publication_verifications_body_check',
      sql`${t.data}->>'observedBody' IS NULL OR (${t.data}->>'observedContentHash' = encode(sha256(convert_to(${t.data}->>'observedBody','UTF8')),'hex')) IS TRUE`,
    ),
    check(
      'publication_verifications_confirmation_check',
      sql`(${t.data}->>'conclusion' <> 'published' OR ((${t.data}->>'manualConfirmed')::boolean AND ${t.data}->>'observedBody' IS NOT NULL AND ${t.data}->>'observedAccountUid' IS NOT NULL AND ${t.data}->>'url' IS NOT NULL)) IS TRUE AND (${t.data}->>'conclusion' <> 'not_published' OR ((${t.data}->>'manualConfirmed')::boolean AND (${t.data}->>'previousDispatchFenced')::boolean)) IS TRUE`,
    ),
  ],
);

/** A durable, immutable admission ticket for a single adapter invocation. */
export const publicationSendClaims = pgTable(
  'task_publication_send_claims',
  {
    dispatchId: uuid('dispatch_id').primaryKey(),
    operationId: uuid('operation_id').notNull(),
    claimedAt: createdAt(),
    expiresAt: time('expires_at'),
  },
  (t) => [
    foreignKey({
      name: 'publication_send_claims_dispatch_fk',
      columns: [t.operationId, t.dispatchId],
      foreignColumns: [publicationDispatches.operationId, publicationDispatches.id],
    }),
  ],
);

/** Task-wide usage includes every attempt and any unresolved reservation. */
export const executionBudgets = pgTable(
  'task_execution_budgets',
  {
    taskId: uuid('task_id')
      .primaryKey()
      .references(() => tasks.id),
    limits: jsonb('limits').$type<import('./execution-config.js').ExecutionLimits>().notNull(),
    calls: integer('calls').notNull().default(0),
    chargedTokens: bigint('charged_tokens', { mode: 'number' }).notNull().default(0),
    chargedCostMicrosCny: bigint('charged_cost_micros_cny', { mode: 'number' })
      .notNull()
      .default(0),
  },
  (t) => [
    check(
      'execution_budgets_usage_check',
      sql`${t.calls} >= 0 AND ${t.chargedTokens} >= 0 AND ${t.chargedCostMicrosCny} >= 0`,
    ),
  ],
);

export const executionCalls = pgTable(
  'task_execution_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    stepId: uuid('step_id').notNull(),
    callNo: integer('call_no').notNull(),
    retryNo: integer('retry_no').notNull(),
    kind: text('kind').$type<'simulation' | 'model' | 'search' | 'readonly'>().notNull(),
    status: text('status')
      .$type<'running' | 'succeeded' | 'failed' | 'timed_out' | 'interrupted'>()
      .notNull(),
    pricingRef: text('pricing_ref').notNull(),
    reservedTokens: bigint('reserved_tokens', { mode: 'number' }).notNull(),
    reservedCostMicrosCny: bigint('reserved_cost_micros_cny', { mode: 'number' }).notNull(),
    chargedTokens: bigint('charged_tokens', { mode: 'number' }).notNull(),
    chargedCostMicrosCny: bigint('charged_cost_micros_cny', { mode: 'number' }).notNull(),
    tokensKnown: boolean('tokens_known').notNull().default(false),
    costKnown: boolean('cost_known').notNull().default(false),
    startedAt: time('started_at').notNull(),
    deadlineAt: time('deadline_at').notNull(),
    finishedAt: time('finished_at'),
    error: jsonb('error').$type<Failure>(),
    toolName: text('tool_name'),
    sdkSessionId: text('sdk_session_id'),
    sdkToolUseId: text('sdk_tool_use_id'),
    parentCallId: uuid('parent_call_id'),
    inputSnapshotId: uuid('input_snapshot_id'),
    authorizationId: uuid('authorization_id'),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('execution_calls_scope_id_key').on(t.taskId, t.attemptId, t.id),
    unique('execution_calls_sdk_tool_key').on(t.attemptId, t.sdkSessionId, t.sdkToolUseId),
    foreignKey({
      name: 'execution_calls_parent_fk',
      columns: [t.taskId, t.attemptId, t.parentCallId],
      foreignColumns: [t.taskId, t.attemptId, t.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'execution_calls_input_fk',
      columns: [t.attemptId, t.stepId, t.inputSnapshotId],
      foreignColumns: [executionSteps.attemptId, executionSteps.id, executionSteps.inputSnapshotId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'execution_calls_authorization_fk',
      columns: [t.taskId, t.attemptId, t.authorizationId],
      foreignColumns: [
        researchAuthorizations.taskId,
        researchAuthorizations.attemptId,
        researchAuthorizations.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'execution_calls_step_authorization_fk',
      columns: [t.attemptId, t.stepId, t.authorizationId],
      foreignColumns: [executionSteps.attemptId, executionSteps.id, executionSteps.authorizationId],
    }).onDelete('restrict'),
    check(
      'execution_calls_parent_check',
      sql`"task_execution_calls"."parent_call_id" IS NULL OR "task_execution_calls"."parent_call_id" <> "task_execution_calls"."id"`,
    ),
    check(
      'execution_calls_sdk_check',
      sql`("task_execution_calls"."sdk_tool_use_id" IS NULL OR ("task_execution_calls"."sdk_session_id" IS NOT NULL AND "task_execution_calls"."tool_name" IS NOT NULL)) AND ("task_execution_calls"."tool_name" IS NULL OR length(btrim("task_execution_calls"."tool_name")) > 0) AND ("task_execution_calls"."sdk_session_id" IS NULL OR length(btrim("task_execution_calls"."sdk_session_id")) > 0) AND ("task_execution_calls"."sdk_tool_use_id" IS NULL OR length(btrim("task_execution_calls"."sdk_tool_use_id")) > 0)`,
    ),
    foreignKey({
      name: 'execution_calls_step_fk',
      columns: [t.attemptId, t.stepId],
      foreignColumns: [executionSteps.attemptId, executionSteps.id],
    }),
    foreignKey({
      name: 'execution_calls_attempt_fk',
      columns: [t.taskId, t.attemptId],
      foreignColumns: [executionAttempts.taskId, executionAttempts.id],
    }),
    unique('execution_calls_step_no_key').on(t.stepId, t.callNo),
    uniqueIndex('execution_calls_active_step_idx')
      .on(t.stepId)
      .where(sql`${t.status} = 'running'`),
    index('execution_calls_task_idx').on(t.taskId, t.startedAt),
    check(
      'execution_calls_counts_check',
      sql`"task_execution_calls"."call_no" >= 1 AND "task_execution_calls"."retry_no" >= 0 AND "task_execution_calls"."reserved_tokens" >= 0 AND "task_execution_calls"."reserved_cost_micros_cny" >= 0 AND "task_execution_calls"."charged_tokens" >= 0 AND "task_execution_calls"."charged_cost_micros_cny" >= 0`,
    ),
    check(
      'execution_calls_kind_check',
      sql`"task_execution_calls"."kind" IN ('simulation','model','search','readonly')`,
    ),
    check(
      'execution_calls_status_check',
      sql`"task_execution_calls"."status" IN ('running','succeeded','failed','timed_out','interrupted')`,
    ),
    check(
      'execution_calls_time_check',
      sql`"task_execution_calls"."deadline_at" > "task_execution_calls"."started_at" AND ("task_execution_calls"."status" = 'running') = ("task_execution_calls"."finished_at" IS NULL)`,
    ),
  ],
);

export const researchAssets = pgTable(
  'research_assets',
  {
    // Existing tools return opaque video_/audio_/transcript_/frame_ IDs, not bare UUIDs.
    id: text('id').primaryKey(),
    taskId: uuid('task_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    authorizationId: uuid('authorization_id').notNull(),
    sourceId: text('source_id').notNull(),
    parentAssetId: text('parent_asset_id'),
    kind: text('kind').$type<'video' | 'audio' | 'transcript' | 'frame'>().notNull(),
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('research_assets_scope_id_key').on(t.attemptId, t.authorizationId, t.sourceId, t.id),
    unique('research_assets_storage_key').on(t.storageKey),
    index('research_assets_source_idx').on(t.authorizationId, t.sourceId),
    foreignKey({
      name: 'research_assets_authorization_fk',
      columns: [t.taskId, t.attemptId, t.authorizationId],
      foreignColumns: [
        researchAuthorizations.taskId,
        researchAuthorizations.attemptId,
        researchAuthorizations.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'research_assets_parent_fk',
      columns: [t.attemptId, t.authorizationId, t.sourceId, t.parentAssetId],
      foreignColumns: [t.attemptId, t.authorizationId, t.sourceId, t.id],
    }).onDelete('restrict'),
    check(
      'research_assets_kind_check',
      sql`"research_assets"."kind" IN ('video','audio','transcript','frame')`,
    ),
    check(
      'research_assets_identity_check',
      sql`length(btrim("research_assets"."id")) > 0 AND length(btrim("research_assets"."source_id")) > 0 AND ("research_assets"."parent_asset_id" IS NULL OR "research_assets"."parent_asset_id" <> "research_assets"."id")`,
    ),
    check('research_assets_hash_check', sql`"research_assets"."sha256" ~ '^[a-f0-9]{64}$'`),
    check(
      'research_assets_metadata_check',
      sql`jsonb_typeof("research_assets"."metadata") = 'object'`,
    ),
    check(
      'research_assets_storage_check',
      sql`length(btrim("research_assets"."storage_key")) > 0 AND "research_assets"."storage_key" !~ '^/' AND "research_assets"."storage_key" !~ '(^|/)\\.\\.(/|$)' AND position(chr(92) in "research_assets"."storage_key") = 0`,
    ),
  ],
);

export const researchRegistries = pgTable(
  'research_registries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    authorizationId: uuid('authorization_id').notNull(),
    stepId: uuid('step_id').notNull(),
    inputSnapshotId: uuid('input_snapshot_id').notNull(),
    snapshot: jsonb('snapshot').$type<ResearchWebSnapshot>().notNull(),
    registryRevision: integer('registry_revision').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('research_registries_authorization_key').on(t.authorizationId),
    foreignKey({
      name: 'research_registries_authorization_fk',
      columns: [t.taskId, t.attemptId, t.authorizationId],
      foreignColumns: [
        researchAuthorizations.taskId,
        researchAuthorizations.attemptId,
        researchAuthorizations.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'research_registries_step_fk',
      columns: [t.attemptId, t.stepId, t.authorizationId],
      foreignColumns: [executionSteps.attemptId, executionSteps.id, executionSteps.authorizationId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'research_registries_input_fk',
      columns: [t.attemptId, t.stepId, t.inputSnapshotId],
      foreignColumns: [executionSteps.attemptId, executionSteps.id, executionSteps.inputSnapshotId],
    }).onDelete('restrict'),
    check(
      'research_registries_snapshot_check',
      sql`(jsonb_typeof("research_registries"."snapshot") = 'object' AND "research_registries"."snapshot"->>'schemaVersion' = '1.0' AND "research_registries"."snapshot"->'execution'->>'taskId' = "research_registries"."task_id"::text AND "research_registries"."snapshot"->'execution'->>'attemptId' = "research_registries"."attempt_id"::text AND "research_registries"."snapshot"->'execution'->>'stepId' = "research_registries"."step_id"::text AND "research_registries"."snapshot"->'execution'->>'inputSnapshotId' = "research_registries"."input_snapshot_id"::text AND "research_registries"."snapshot"->>'authorizationId' = "research_registries"."authorization_id"::text AND jsonb_typeof("research_registries"."snapshot"->'sources') = 'array' AND jsonb_typeof("research_registries"."snapshot"->'materials') = 'array' AND jsonb_typeof("research_registries"."snapshot"->'calls') = 'array') IS TRUE`,
    ),
    check(
      'research_registries_time_check',
      sql`"research_registries"."updated_at" >= "research_registries"."created_at"`,
    ),
    check(
      'research_registries_revision_check',
      sql`"research_registries"."registry_revision" >= 0`,
    ),
  ],
);

export const researchSubmissionMaterials = pgTable(
  'research_submission_materials',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    submissionId: uuid('submission_id').notNull(),
    clientRef: text('client_ref'),
    sourceId: text('source_id').notNull(),
    materialId: text('material_id'),
    materialVersion: integer('material_version'),
    lineageRootMaterialId: text('lineage_root_material_id'),
    contentSha256: text('content_sha256'),
    record: jsonb('record').$type<ResearchSubmissionRecord>().notNull(),
    confirmedBy: uuid('confirmed_by').references(() => members.id),
    confirmedAt: time('confirmed_at'),
  },
  (t) => [
    foreignKey({
      name: 'research_submission_materials_submission_fk',
      columns: [t.taskId, t.attemptId, t.submissionId],
      foreignColumns: [
        researchSubmissions.taskId,
        researchSubmissions.attemptId,
        researchSubmissions.id,
      ],
    }).onDelete('restrict'),
    unique('research_submission_materials_snapshot_key').on(t.taskId, t.materialId),
    unique('research_submission_materials_lineage_key').on(
      t.taskId,
      t.lineageRootMaterialId,
      t.materialVersion,
    ),
    unique('research_submission_materials_client_key').on(t.submissionId, t.clientRef),
    check(
      'research_submission_materials_record_check',
      sql`(jsonb_typeof("research_submission_materials"."record") = 'object' AND "research_submission_materials"."record"->'source'->>'id' = "research_submission_materials"."source_id" AND "research_submission_materials"."record"->'source'->>'nature' = 'user_provided') IS TRUE`,
    ),
    check(
      'research_submission_materials_shape_check',
      sql`((
      "research_submission_materials"."material_id" IS NULL AND "research_submission_materials"."material_version" IS NULL AND "research_submission_materials"."lineage_root_material_id" IS NULL AND "research_submission_materials"."content_sha256" IS NULL AND "research_submission_materials"."confirmed_by" IS NULL AND "research_submission_materials"."confirmed_at" IS NULL AND "research_submission_materials"."record"->'material' = 'null'::jsonb AND length("research_submission_materials"."record"->'source'->>'url') > 0
    ) OR (
      "research_submission_materials"."material_id" IS NOT NULL AND "research_submission_materials"."material_version" >= 1 AND "research_submission_materials"."lineage_root_material_id" IS NOT NULL AND "research_submission_materials"."content_sha256" ~ '^[a-f0-9]{64}$' AND
      "research_submission_materials"."record"->'material'->>'id' = "research_submission_materials"."material_id" AND ("research_submission_materials"."record"->'material'->>'version')::integer = "research_submission_materials"."material_version" AND "research_submission_materials"."record"->'material'->>'sourceId' = "research_submission_materials"."source_id" AND "research_submission_materials"."record"->'material'->>'kind' = 'pasted_text' AND length(btrim("research_submission_materials"."record"->'material'->>'content')) > 0 AND
      "research_submission_materials"."content_sha256" = encode(sha256(convert_to("research_submission_materials"."record"->'material'->>'content','UTF8')),'hex') AND "research_submission_materials"."record"->>'contentSha256' = "research_submission_materials"."content_sha256" AND "research_submission_materials"."record"->>'lineageRootMaterialId' = "research_submission_materials"."lineage_root_material_id"
    )) IS TRUE`,
    ),
    check(
      'research_submission_materials_confirmation_check',
      sql`((
      "research_submission_materials"."confirmed_by" IS NULL AND "research_submission_materials"."confirmed_at" IS NULL AND ("research_submission_materials"."record"->'material' = 'null'::jsonb OR "research_submission_materials"."record"->'material'->'firstHandConfirmation' = 'null'::jsonb)
    ) OR (
      "research_submission_materials"."confirmed_by" IS NOT NULL AND "research_submission_materials"."confirmed_at" IS NOT NULL AND "research_submission_materials"."material_id" IS NOT NULL AND "research_submission_materials"."record"->'material'->'firstHandConfirmation'->>'userId' = "research_submission_materials"."confirmed_by"::text AND ("research_submission_materials"."record"->'material'->'firstHandConfirmation'->>'confirmedAt')::timestamptz = "research_submission_materials"."confirmed_at" AND ("research_submission_materials"."record"->'material'->'firstHandConfirmation'->>'materialVersion')::integer = "research_submission_materials"."material_version"
    )) IS TRUE`,
    ),
  ],
);

export const researchSubmissions = pgTable(
  'research_submissions',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    authorizationId: uuid('authorization_id').notNull(),
    baseResultId: text('base_result_id').notNull(),
    questionIds: jsonb('question_ids').$type<string[]>().notNull(),
    gapIds: jsonb('gap_ids').$type<string[]>().notNull(),
    officialSiteGrants: jsonb('official_site_grants')
      .$type<{ origin: string; pathPrefix: string }[]>()
      .notNull(),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => members.id),
    submittedAt: time('submitted_at').notNull(),
  },
  (t) => [
    unique('research_submissions_scope_id_key').on(t.taskId, t.attemptId, t.id),
    unique('research_submissions_authorization_key').on(t.authorizationId),
    foreignKey({
      name: 'research_submissions_authorization_fk',
      columns: [t.taskId, t.attemptId, t.authorizationId],
      foreignColumns: [
        researchAuthorizations.taskId,
        researchAuthorizations.attemptId,
        researchAuthorizations.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'research_submissions_result_fk',
      columns: [t.attemptId, t.baseResultId],
      foreignColumns: [executionSteps.attemptId, executionSteps.resultId],
    }).onDelete('restrict'),
    check(
      'research_submissions_arrays_check',
      sql`jsonb_typeof("research_submissions"."question_ids") = 'array' AND jsonb_array_length("research_submissions"."question_ids") > 0 AND jsonb_typeof("research_submissions"."gap_ids") = 'array' AND jsonb_typeof("research_submissions"."official_site_grants") = 'array'`,
    ),
    index('research_submissions_task_idx').on(t.taskId, t.submittedAt),
  ],
);

export const researchAuthorizations = pgTable(
  'research_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    selectionId: uuid('selection_id').notNull(),
    mode: text('mode').$type<'initial' | 'supplement'>().notNull(),
    scope: jsonb('scope').$type<ResearchAuthorizationScope | Record<string, unknown>>().notNull(),
    baseResultId: text('base_result_id'),
    authorizedBy: uuid('authorized_by')
      .notNull()
      .references(() => members.id),
    authorizedAt: time('authorized_at').notNull().defaultNow(),
    consumedAt: time('consumed_at'),
    consumedByStepId: uuid('consumed_by_step_id'),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('research_authorizations_attempt_id_key').on(t.attemptId, t.id),
    unique('research_authorizations_scope_key').on(t.taskId, t.attemptId, t.id),
    unique('research_authorizations_step_key').on(t.consumedByStepId),
    uniqueIndex('research_authorizations_initial_idx')
      .on(t.attemptId)
      .where(sql`${t.mode} = 'initial'`),
    uniqueIndex('research_authorizations_pending_idx')
      .on(t.attemptId)
      .where(sql`${t.consumedAt} IS NULL`),
    foreignKey({
      name: 'research_authorizations_attempt_fk',
      columns: [t.taskId, t.attemptId],
      foreignColumns: [executionAttempts.taskId, executionAttempts.id],
    }).onDelete('restrict'),
    // Deliberately task-scoped: a new attempt reuses the original immutable selection.
    foreignKey({
      name: 'research_authorizations_selection_fk',
      columns: [t.taskId, t.selectionId],
      foreignColumns: [projectSelections.taskId, projectSelections.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'research_authorizations_base_result_fk',
      columns: [t.attemptId, t.baseResultId],
      foreignColumns: [executionSteps.attemptId, executionSteps.resultId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'research_authorizations_consumed_step_fk',
      columns: [t.attemptId, t.consumedByStepId, t.id],
      foreignColumns: [executionSteps.attemptId, executionSteps.id, executionSteps.authorizationId],
    }).onDelete('restrict'),
    check(
      'research_authorizations_mode_check',
      sql`"research_authorizations"."mode" IN ('initial','supplement')`,
    ),
    check(
      'research_authorizations_scope_check',
      sql`jsonb_typeof("research_authorizations"."scope") = 'object'`,
    ),
    check(
      'research_authorizations_base_check',
      sql`("research_authorizations"."mode" = 'initial' AND "research_authorizations"."base_result_id" IS NULL) OR ("research_authorizations"."mode" = 'supplement' AND "research_authorizations"."base_result_id" IS NOT NULL)`,
    ),
    check(
      'research_authorizations_consumption_check',
      sql`("research_authorizations"."consumed_at" IS NULL AND "research_authorizations"."consumed_by_step_id" IS NULL) OR ("research_authorizations"."consumed_at" IS NOT NULL AND "research_authorizations"."consumed_by_step_id" IS NOT NULL AND "research_authorizations"."consumed_at" >= "research_authorizations"."authorized_at")`,
    ),
  ],
);

export const projectSelections = pgTable(
  'project_selections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    hotListSnapshotId: uuid('hot_list_snapshot_id').notNull(),
    candidateId: text('candidate_id').notNull(),
    project: jsonb('project').$type<SelectedProject>().notNull(),
    selectedBy: uuid('selected_by')
      .notNull()
      .references(() => members.id),
    selectedAt: time('selected_at').notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('project_selections_task_key').on(t.taskId),
    unique('project_selections_task_id_key').on(t.taskId, t.id),
    foreignKey({
      name: 'project_selections_attempt_fk',
      columns: [t.taskId, t.attemptId],
      foreignColumns: [executionAttempts.taskId, executionAttempts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'project_selections_snapshot_fk',
      columns: [t.taskId, t.attemptId, t.hotListSnapshotId],
      foreignColumns: [
        githubHotSnapshots.taskId,
        githubHotSnapshots.attemptId,
        githubHotSnapshots.id,
      ],
    }).onDelete('restrict'),
    check(
      'project_selections_project_check',
      sql`(length(btrim("project_selections"."candidate_id")) > 0 AND jsonb_typeof("project_selections"."project") = 'object' AND "project_selections"."project"->>'selectionId' = "project_selections"."id"::text AND "project_selections"."project"->>'candidateId' = "project_selections"."candidate_id" AND "project_selections"."project"->>'hotListSnapshotId' = "project_selections"."hot_list_snapshot_id"::text) IS TRUE`,
    ),
  ],
);

export const githubHotSnapshots = pgTable(
  'github_hot_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    provider: text('provider').$type<'xxapi'>().notNull(),
    snapshot: jsonb('snapshot')
      .$type<{
        list: GithubHotList;
        rawResponse: unknown;
        parserVersion: string;
      }>()
      .notNull(),
    fetchedAt: time('fetched_at').notNull(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('github_hot_snapshots_task_id_key').on(t.taskId, t.id),
    unique('github_hot_snapshots_scope_id_key').on(t.taskId, t.attemptId, t.id),
    unique('github_hot_snapshots_attempt_key').on(t.taskId, t.attemptId),
    foreignKey({
      name: 'github_hot_snapshots_attempt_fk',
      columns: [t.taskId, t.attemptId],
      foreignColumns: [executionAttempts.taskId, executionAttempts.id],
    }).onDelete('restrict'),
    check('github_hot_snapshots_provider_check', sql`"github_hot_snapshots"."provider" = 'xxapi'`),
    check(
      'github_hot_snapshots_snapshot_check',
      sql`(jsonb_typeof("github_hot_snapshots"."snapshot") = 'object' AND jsonb_typeof("github_hot_snapshots"."snapshot"->'list') = 'object' AND "github_hot_snapshots"."snapshot"->'list'->>'id' = "github_hot_snapshots"."id"::text AND "github_hot_snapshots"."snapshot"->'list'->>'provider' = "github_hot_snapshots"."provider" AND ("github_hot_snapshots"."snapshot"->'list'->>'fetchedAt')::timestamptz = "github_hot_snapshots"."fetched_at" AND jsonb_typeof("github_hot_snapshots"."snapshot"->'list'->'items') = 'array' AND length(btrim("github_hot_snapshots"."snapshot"->>'parserVersion')) > 0 AND "github_hot_snapshots"."snapshot" ? 'rawResponse') IS TRUE`,
    ),
  ],
);

export interface AgentSnapshot {
  executorVersion: 1;
  mode: 'agent';
  /** Versioned runtime configuration, never a substitute for research persistence. */
  configuration: Record<string, unknown>;
}
