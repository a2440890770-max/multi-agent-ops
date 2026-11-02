import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type {
  Account,
  AccountRegistration,
  OperationBodies,
  Session,
} from '@multi-agent-ops/shared';
import { AuthError } from './auth.js';
import type { createBusinessDatabase } from './database.js';
import { accounts, auditEvents, idempotencyRecords, members, tasks } from './schema.js';
import { invalidateApproval, lockEditorialTeam } from './editorial-state.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function publicAccount(row: typeof accounts.$inferSelect): Account {
  return {
    id: row.id,
    displayName: row.displayName,
    platform: row.platform,
    authorizationStatus: row.authorizationStatus,
    officialPublishAvailable: row.officialPublishAvailable,
    platformAccountId: row.platformAccountId,
    manualPublishEnabled: row.manualPublishEnabled,
    registrationVersion: row.registrationVersion,
  };
}
function registration(row: typeof accounts.$inferSelect | undefined): AccountRegistration {
  return {
    account: row ? publicAccount(row) : null,
    registeredBy: row?.registeredBy ?? null,
    registeredAt: row?.registeredAt?.toISOString() ?? null,
  };
}

export class AccountService {
  constructor(
    private db: Database,
    private now: () => Date,
  ) {}
  async get(actor: Session['member']): Promise<AccountRegistration> {
    try {
      const [member] = await this.db
        .select({ id: members.id })
        .from(members)
        .where(
          and(
            eq(members.id, actor.id),
            eq(members.teamId, actor.teamId),
            eq(members.version, actor.version),
            eq(members.role, actor.role),
            eq(members.status, 'active'),
          ),
        );
      if (!member) throw new AuthError(403, 'FORBIDDEN', '成员身份已变化，请重新登录。');
      const [row] = await this.db.select().from(accounts).where(eq(accounts.teamId, actor.teamId));
      return registration(row);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '目标账号读取失败，请稍后重试。');
    }
  }
  async register(input: {
    body: OperationBodies['registerAccount'];
    actor: Session['member'];
    key: string;
    requestId: string;
  }): Promise<{ data: AccountRegistration; replayed: boolean }> {
    const { body, actor } = input;
    if (actor.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', '仅管理员可登记目标账号。');
    if (
      !body.displayName.trim() ||
      !body.reason.trim() ||
      !/^[1-9][0-9]{0,19}$/.test(body.platformAccountId)
    )
      throw new AuthError(400, 'VALIDATION_ERROR', '请填写微博昵称、有效数字UID和登记原因。');
    if (body.manualPublishEnabled && !body.manualAuthorizationConfirmed)
      throw new AuthError(
        422,
        'VALIDATION_ERROR',
        '启用前请确认团队人员有权登录该账号并手动发布。',
      );
    const scopeHash = digest([actor.teamId, actor.id, 'registerAccount']);
    const keyHash = digest(input.key);
    const requestFingerprint = digest([
      body.expectedVersion,
      body.displayName,
      body.platformAccountId,
      body.manualPublishEnabled,
      body.manualAuthorizationConfirmed,
      body.reason,
    ]);
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
        const lock = Buffer.from(digest([scopeHash, keyHash]), 'hex')
          .readBigInt64BE()
          .toString();
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${lock}::bigint)`);
        await lockEditorialTeam(tx, actor.teamId);
        const [member] = await tx
          .select()
          .from(members)
          .where(
            and(
              eq(members.id, actor.id),
              eq(members.teamId, actor.teamId),
              eq(members.version, actor.version),
              eq(members.role, 'admin'),
              eq(members.status, 'active'),
            ),
          )
          .for('share');
        if (!member) throw new AuthError(403, 'FORBIDDEN', '管理员身份已变化，请刷新身份。');
        const now = this.now();
        const [cached] = await tx
          .select()
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.scopeHash, scopeHash),
              eq(idempotencyRecords.keyHash, keyHash),
            ),
          );
        if (cached && cached.expiresAt > now) {
          if (cached.requestFingerprint !== requestFingerprint)
            throw new AuthError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              '同一动作标识不能提交不同的账号登记。',
            );
          if (!cached.responseBody || cached.responseStatus !== 200)
            throw new AuthError(409, 'INVALID_STATE', '登记结果尚未确认，请重试原请求。');
          return { data: cached.responseBody as AccountRegistration, replayed: true };
        }
        const [current] = await tx
          .select()
          .from(accounts)
          .where(eq(accounts.teamId, actor.teamId))
          .for('update');
        const version = current?.registrationVersion ?? 0;
        if (version !== body.expectedVersion)
          throw new AuthError(
            409,
            'REVISION_CONFLICT',
            '账号登记已更新，请核对服务器账号后再保存。',
          );
        const uidChanged = !!current && current.platformAccountId !== body.platformAccountId;
        if (
          uidChanged &&
          (current.credentialRef ||
            current.officialPublishAvailable ||
            current.authorizationStatus === 'valid')
        )
          throw new AuthError(
            409,
            'ACCOUNT_UNAUTHORIZED',
            '当前账号关联官方授权，请先解除原授权再更换真实UID。',
          );
        const fields = {
          displayName: body.displayName.trim(),
          platformAccountId: body.platformAccountId,
          manualPublishEnabled: body.manualPublishEnabled,
          registrationVersion: version + 1,
          registeredBy: actor.id,
          registeredAt: now,
          updatedAt: now,
        };
        const [row] = current
          ? await tx.update(accounts).set(fields).where(eq(accounts.id, current.id)).returning()
          : await tx
              .insert(accounts)
              .values({ teamId: actor.teamId, ...fields, createdAt: now })
              .returning();
        if (!row) throw new Error('account registration failed');
        const affected = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.teamId, actor.teamId), eq(tasks.accountId, row.id)))
          .orderBy(tasks.id)
          .for('update');
        if (affected.some((task) => task.activePublishOperationId))
          throw new AuthError(423, 'PUBLICATION_LOCKED', '账号存在未完成交接，暂不能变更登记。');
        for (const task of affected) {
          const invalidate = version === 0 || uidChanged || !body.manualPublishEnabled;
          if (invalidate)
            await invalidateApproval(
              tx,
              task,
              now,
              '目标微博账号首次登记、UID变更或人工操作资格已停用，请重新审核批准。',
            );
          await tx
            .update(tasks)
            .set({
              revision: task.revision + 1,
              updatedAt: now,
              ...(invalidate
                ? {
                    currentReviewCycleId: null,
                    approvalStatus: task.currentApprovalId
                      ? ('invalidated' as const)
                      : task.currentContentVersionId
                        ? ('pending' as const)
                        : ('not_requested' as const),
                  }
                : {}),
            })
            .where(eq(tasks.id, task.id));
        }
        await tx.insert(auditEvents).values({
          teamId: actor.teamId,
          actorType: 'member',
          actorId: actor.id,
          action: 'account.registered',
          targetType: 'account',
          targetId: row.id,
          beforeRevision: version,
          afterRevision: version + 1,
          outcome: 'succeeded',
          reason: body.reason.trim(),
          requestId: input.requestId,
          createdAt: now,
        });
        const data = registration(row);
        if (cached) await tx.delete(idempotencyRecords).where(eq(idempotencyRecords.id, cached.id));
        await tx.insert(idempotencyRecords).values({
          scopeHash,
          keyHash,
          requestFingerprint,
          status: 'completed',
          responseStatus: 200,
          responseBody: data,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 86400000),
        });
        return { data, replayed: false };
      });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '登记结果尚未确认，请保留原请求并重试确认。',
      );
    }
  }
}
