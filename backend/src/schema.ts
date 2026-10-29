import { sql } from 'drizzle-orm';
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
  (t) => [
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

// Preserve the existing prototype table and its data. This is NOT the full Task
// workflow model in shared/domain.ts; its later upgrade requires a new migration.
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    originalRequest: text('original_request').notNull(),
    executionStatus: text('execution_status')
      .$type<
        | 'awaiting_clarification'
        | 'queued'
        | 'running'
        | 'needs_human'
        | 'ready'
        | 'failed'
        | 'cancelled'
      >()
      .notNull()
      .default('queued'),
    createdAt: time('created_at').notNull().defaultNow(),
    updatedAt: time('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'tasks_execution_status_check',
      sql`${t.executionStatus} IN ('awaiting_clarification', 'queued', 'running', 'needs_human', 'ready', 'failed', 'cancelled')`,
    ),
  ],
);
