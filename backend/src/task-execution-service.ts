import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  OperationBodies,
  OperationQueries,
  ResponseModels,
  Session,
  TaskDetail,
} from '@multi-agent-ops/shared';
import { readExecutionLimits, type ExecutionLimits } from './execution-config.js';
import { pauseActiveTime, interruptCalls } from './execution-control.js';
import { AuthError } from './auth.js';
import { invalidateApproval, lockEditorialTeam } from './editorial-state.js';
import type { createBusinessDatabase } from './database.js';
import { activeAttempt, attemptModel, mockStages, stepModel } from './execution-model.js';
import { AgentConfigurationSchema, type AgentConfiguration } from './agent-execution-config.js';
import {
  auditEvents,
  clarificationAnswers,
  executionAttempts,
  executionCalls,
  executionBudgets,
  executionSteps,
  idempotencyRecords,
  members,
  taskContents,
  tasks,
  accounts,
  configVersions,
  projectSelections,
} from './schema.js';
import type { SimulationScenario } from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Connection = Database | Transaction;
type ReadTask = (
  connection: Connection,
  id: string,
  actor: Session['member'],
) => Promise<TaskDetail>;
type Context = { taskId: string; actor: Session['member']; key: string; requestId: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestamp = sql<string>`to_char(${auditEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export class TaskExecutionService {
  constructor(
    private db: Database,
    private read: ReadTask,
    private now: () => Date,
    private options: {
      executorMode?: 'mock' | 'agent' | 'disabled';
      agentConfiguration?: AgentConfiguration;
      stepDelayMs?: number;
      executionLimits?: ExecutionLimits;
    },
  ) {}

  start(input: Context & { body: OperationBodies['startTask'] }) {
    return this.command('start', input);
  }
  retry(input: Context & { body: OperationBodies['retryTask'] }) {
    return this.command('retry', input);
  }
  stop(input: Context & { attemptId: string; body: OperationBodies['stopAttempt'] }) {
    return this.command('stop', input);
  }
  clarify(input: Context & { body: OperationBodies['clarifyTask'] }) {
    return this.command('clarify', input);
  }

  private async command(
    kind: 'start' | 'retry' | 'stop' | 'clarify',
    input: Context & {
      attemptId?: string;
      body: {
        expectedRevision: number;
        simulationScenario?: SimulationScenario;
        previousAttemptId?: string | null;
        restartTerminated?: boolean;
        reason?: string;
        attemptId?: string;
        answers?: { questionId: string; answer: string }[];
      };
    },
  ): Promise<{ data: TaskDetail; replayed: boolean }> {
    const { actor, taskId, body } = input;
    if (!uuid.test(taskId) || (input.attemptId && !uuid.test(input.attemptId)))
      throw new AuthError(404, 'NOT_FOUND', '任务或执行尝试不存在或不可访问。');
    if ((kind === 'stop' || kind === 'retry') && !body.reason?.trim())
      throw new AuthError(400, 'VALIDATION_ERROR', '请填写操作原因。');
    if (
      kind === 'clarify' &&
      (!body.attemptId ||
        !uuid.test(body.attemptId) ||
        !body.answers?.length ||
        body.answers.some((item) => !uuid.test(item.questionId) || !item.answer.trim()) ||
        new Set(body.answers.map((item) => item.questionId.toLowerCase())).size !==
          body.answers.length)
    )
      throw new AuthError(
        400,
        'VALIDATION_ERROR',
        '请提交有效的问题编号和非空答复，每个问题只能提交一次。',
      );
    const path =
      kind === 'clarify'
        ? `/tasks/${taskId}/clarifications`
        : kind === 'stop'
          ? `/tasks/${taskId}/attempts/${input.attemptId}/stop`
          : `/tasks/${taskId}/${kind === 'start' ? 'attempts' : 'attempt-retries'}`;
    const scopeHash = hash([actor.teamId, actor.id, 'POST', path]);
    const keyHash = hash(input.key);
    const requestFingerprint =
      kind === 'clarify'
        ? hash([
            kind,
            body.expectedRevision,
            body.attemptId?.toLowerCase(),
            body.answers
              ?.map((item) => ({ questionId: item.questionId.toLowerCase(), answer: item.answer }))
              .sort((a, b) => a.questionId.localeCompare(b.questionId)),
          ])
        : hash([
            kind,
            body.expectedRevision,
            body.simulationScenario ?? 'success',
            body.previousAttemptId ?? null,
            body.restartTerminated ?? false,
            body.reason ?? '',
          ]);
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
        const lock = Buffer.from(hash([scopeHash, keyHash]), 'hex')
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
              eq(members.role, actor.role),
              eq(members.version, actor.version),
              eq(members.status, 'active'),
            ),
          )
          .for('share');
        if (!member) throw new AuthError(403, 'FORBIDDEN', '成员身份已变更，请刷新身份。');
        const [task] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.teamId, actor.teamId)))
          .for('update');
        if (!task) throw new AuthError(404, 'NOT_FOUND', '任务不存在或不可访问。');
        // Recheck ownership/account integrity before replaying a stored response.
        await this.read(tx, taskId, actor);
        const now = this.now();
        const [existing] = await tx
          .select()
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.scopeHash, scopeHash),
              eq(idempotencyRecords.keyHash, keyHash),
            ),
          );
        if (existing && existing.expiresAt > now) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new AuthError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              '同一动作标识不能用于不同的执行请求。',
            );
          if (
            existing.status !== 'completed' ||
            existing.responseStatus !== 202 ||
            !existing.responseBody
          )
            throw new AuthError(409, 'INVALID_STATE', '操作尚未确认，请使用同一动作标识重试。');
          return { data: existing.responseBody as TaskDetail, replayed: true };
        }
        if (existing)
          await tx.delete(idempotencyRecords).where(eq(idempotencyRecords.id, existing.id));
        if (task.activePublishOperationId || task.publishedOperationId)
          throw new AuthError(423, 'PUBLICATION_LOCKED', '文案已冻结，请先处理原发布交接。');
        if (task.revision !== body.expectedRevision)
          throw new AuthError(409, 'REVISION_CONFLICT', '任务状态已更新，请刷新详情后重新操作。');
        if (task.lifecycle !== 'open')
          throw new AuthError(409, 'INVALID_STATE', '任务已结束，不能执行此操作。');
        const [previous] = task.currentAttemptId
          ? await tx
              .select()
              .from(executionAttempts)
              .where(
                and(
                  eq(executionAttempts.id, task.currentAttemptId),
                  eq(executionAttempts.taskId, taskId),
                ),
              )
          : [];
        let action: string;
        if (kind === 'clarify') {
          if (this.options.executorMode === 'disabled')
            throw new AuthError(
              409,
              'INVALID_STATE',
              '模拟执行器未启用，请先启用后再提交并恢复执行。',
            );
          if (
            !previous ||
            previous.id !== body.attemptId!.toLowerCase() ||
            previous.status !== 'awaiting_clarification' ||
            previous.executorMode !== previous.configSnapshot.mode ||
            previous.executorMode !== (this.options.executorMode ?? 'mock') ||
            previous.cancelRequestedAt ||
            previous.generation !== task.workGeneration
          )
            throw new AuthError(
              409,
              'INVALID_STATE',
              '当前尝试不在待澄清状态，或执行尝试已变化，请刷新详情。',
            );
          const questions = previous.clarifications;
          if (!questions.length)
            throw new AuthError(409, 'INVALID_STATE', '当前尝试没有待答复的问题，请核对执行记录。');
          for (const submitted of body.answers!) {
            const question = questions.find(
              (q) => q.questionId.toLowerCase() === submitted.questionId.toLowerCase(),
            );
            if (!question) throw new AuthError(400, 'VALIDATION_ERROR', '问题不属于当前执行尝试。');
            if (question.answer !== null)
              throw new AuthError(409, 'INVALID_STATE', '该问题已有已保存的答复，不可覆盖历史。');
          }
          const answers = body.answers!.map((submitted) => {
            const question = questions.find(
              (q) => q.questionId.toLowerCase() === submitted.questionId.toLowerCase(),
            )!;
            return {
              taskId,
              attemptId: previous.id,
              questionId: question.questionId,
              question: question.question,
              answer: submitted.answer,
              answeredBy: actor.id,
              answeredAt: now,
            };
          });
          await tx.insert(clarificationAnswers).values(answers);
          const updated = questions.map((question) => ({
            ...question,
            answer:
              answers.find((answer) => answer.questionId === question.questionId)?.answer ??
              question.answer,
          }));
          const complete = updated.every((question) => !!question.answer?.trim());
          const status = complete ? ('queued' as const) : ('awaiting_clarification' as const);
          const real = previous.executorMode === 'agent';
          if (real && complete) {
            const [last] = await tx
              .select()
              .from(executionSteps)
              .where(eq(executionSteps.attemptId, previous.id))
              .orderBy(desc(executionSteps.ordinal))
              .limit(1);
            await tx.insert(executionSteps).values({
              attemptId: previous.id,
              ordinal: (last?.ordinal ?? -1) + 1,
              role: 'supervisor',
              status: 'queued',
              parentStepId: last?.id ?? null,
              runtimeMetadata: { kind: 'supervisor' },
            });
          }
          const currentStep = complete
            ? real
              ? '等待 Supervisor 重新判断答复'
              : '等待继续模拟执行'
            : '等待澄清';
          await tx
            .update(executionAttempts)
            .set({
              clarifications: updated,
              status,
              currentStep,
              nextRunAt: complete
                ? new Date(
                    now.getTime() +
                      (previous.configSnapshot.mode === 'mock'
                        ? previous.configSnapshot.stepDelayMs
                        : 0),
                  )
                : null,
            })
            .where(eq(executionAttempts.id, previous.id));
          await tx
            .update(tasks)
            .set({
              executionStatus: status,
              currentStep,
              errorMessage: null,
              revision: task.revision + 1,
              updatedAt: now,
            })
            .where(eq(tasks.id, taskId));
          action = 'task.clarified';
        } else if (kind === 'stop') {
          if (!previous || previous.id !== input.attemptId || !activeAttempt(previous.status))
            throw new AuthError(409, 'INVALID_STATE', '当前执行尝试已变化或已经结束。');
          await pauseActiveTime(tx, previous, now);
          await interruptCalls(tx, previous.id, now, null);
          // Fence database writes immediately; the worker heartbeat and private Agent
          // callback then abort the SDK session without adopting any late result.
          await tx
            .update(executionAttempts)
            .set({
              status: 'cancelled',
              currentStep: '已停止',
              cancelScope: 'stop_attempt',
              cancelRequestedAt: now,
              cancelRequestedBy: actor.id,
              cancelReason: body.reason!,
              stoppedAt: now,
              finishedAt: now,
              nextRunAt: null,
            })
            .where(eq(executionAttempts.id, previous.id));
          await tx
            .update(executionSteps)
            .set({
              status: 'cancelled',
              finishedAt: now,
              durationMs: sql`CASE WHEN ${executionSteps.startedAt} IS NULL THEN NULL ELSE greatest(0, least(2147483647, floor(extract(epoch FROM (${now}::timestamptz - ${executionSteps.startedAt})) * 1000)))::integer END`,
            })
            .where(
              and(
                eq(executionSteps.attemptId, previous.id),
                inArray(executionSteps.status, ['queued', 'running']),
              ),
            );
          await tx
            .update(tasks)
            .set({
              executionStatus: 'cancelled',
              currentStep: '已停止',
              errorMessage: null,
              workGeneration: task.workGeneration + 1,
              revision: task.revision + 1,
              updatedAt: now,
            })
            .where(eq(tasks.id, taskId));
          action = 'attempt.stopped';
        } else {
          if (kind === 'retry' && previous?.executorMode === 'agent') {
            const [selection] = await tx
              .select({ id: projectSelections.id })
              .from(projectSelections)
              .where(eq(projectSelections.taskId, taskId));
            if (selection)
              throw new AuthError(
                409,
                'INVALID_STATE',
                '已选题任务请使用“重新执行并授权研究”，不能通过旧入口绕过授权。',
              );
          }
          if (this.options.executorMode === 'disabled')
            throw new AuthError(409, 'INVALID_STATE', '模拟执行器未启用。');
          if (previous && activeAttempt(previous.status))
            throw new AuthError(423, 'WORK_LOCKED', '当前执行尝试尚未结束，不能重复启动。');
          if (kind === 'start' && (previous || task.executionStatus !== null))
            throw new AuthError(
              409,
              'INVALID_STATE',
              '已有执行状态，请使用重新执行；历史记录缺失时请先核对。',
            );
          if (
            kind === 'retry' &&
            (!previous || previous.id !== body.previousAttemptId || body.restartTerminated)
          )
            throw new AuthError(
              409,
              'INVALID_STATE',
              '重新执行必须关联当前已结束尝试；D4 尚不支持重启已终止任务。',
            );
          const attemptNo = (previous?.attemptNo ?? 0) + 1;
          if (attemptNo > 100)
            throw new AuthError(
              409,
              'INVALID_STATE',
              '当前版本最多保留 100 次完整执行，请创建新任务。',
            );
          const scenario = body.simulationScenario ?? 'success';
          const real = this.options.executorMode === 'agent';
          if (real && body.simulationScenario)
            throw new AuthError(
              400,
              'VALIDATION_ERROR',
              '真实执行不接受模拟情形，请刷新任务详情。',
            );
          const runtime = real
            ? AgentConfigurationSchema.parse(this.options.agentConfiguration)
            : undefined;
          const [accountConfig] =
            real && task.accountId
              ? await tx
                  .select({
                    description: configVersions.profile,
                    tone: configVersions.tone,
                    prohibitions: configVersions.forbiddenTopics,
                    version: configVersions.version,
                  })
                  .from(accounts)
                  .innerJoin(
                    configVersions,
                    and(
                      eq(configVersions.accountId, accounts.id),
                      eq(configVersions.version, accounts.currentConfigVersion),
                    ),
                  )
                  .where(and(eq(accounts.id, task.accountId), eq(accounts.teamId, actor.teamId)))
              : [];
          await invalidateApproval(tx, task, now, '已启动新的执行，旧批准失效。');
          const delay = real ? 0 : (this.options.stepDelayMs ?? 1000);
          const [attempt] = await tx
            .insert(executionAttempts)
            .values({
              taskId,
              attemptNo,
              generation: task.workGeneration + 1,
              status: 'queued',
              executorMode: real ? 'agent' : 'mock',
              configVersion: accountConfig?.version ?? 1,
              executionLimits: {
                ...(this.options.executionLimits ?? readExecutionLimits({})),
                ...(real
                  ? {
                      callTimeoutMs: 900000,
                      stepTimeoutMs: 900000,
                      attemptTimeoutMs: 1200000,
                      maxRetries: 0,
                    }
                  : {}),
              },
              currentStep: real ? '等待获取 GitHub 热榜' : '等待模拟执行',
              simulationScenario: real ? null : scenario,
              requestedBy: actor.id,
              createdAt: now,
              nextRunAt: new Date(now.getTime() + delay),
              configSnapshot: real
                ? {
                    executorVersion: 1,
                    mode: 'agent',
                    configuration: {
                      runtime,
                      accountContext: {
                        accountId: task.accountId,
                        description: accountConfig?.description ?? null,
                        defaultAudience: null,
                        defaultTone: accountConfig?.tone ?? null,
                        prohibitions: accountConfig?.prohibitions ?? [],
                      },
                    },
                  }
                : {
                    executorVersion: 1,
                    mode: 'mock',
                    scenario,
                    originalRequest: task.originalRequest,
                    referenceInputs: task.referenceInputs,
                    inputRevision: task.revision,
                    stepDelayMs: delay,
                  },
            })
            .returning();
          if (!attempt) throw new Error('attempt insert failed');
          await tx.insert(executionSteps).values(
            real
              ? [
                  {
                    attemptId: attempt.id,
                    ordinal: 0,
                    role: 'supervisor',
                    status: 'queued',
                    runtimeMetadata: { kind: 'github_hot' },
                  },
                  {
                    attemptId: attempt.id,
                    ordinal: 1,
                    role: 'supervisor',
                    status: 'queued',
                    runtimeMetadata: { kind: 'supervisor' },
                  },
                ]
              : mockStages.map((stage, ordinal) => ({
                  attemptId: attempt.id,
                  ordinal,
                  role: stage.role,
                  status: 'queued' as const,
                })),
          );
          await tx
            .update(tasks)
            .set({
              currentAttemptId: attempt.id,
              currentContentVersionId: null,
              currentReviewCycleId: null,
              approvalStatus: task.currentApprovalId ? 'invalidated' : 'not_requested',
              executionStatus: 'queued',
              currentStep: real ? '等待获取 GitHub 热榜' : '等待模拟执行',
              errorMessage: null,
              workGeneration: attempt.generation,
              revision: task.revision + 1,
              updatedAt: now,
            })
            .where(eq(tasks.id, taskId));
          action = kind === 'start' ? 'attempt.started' : 'attempt.retried';
        }
        const data = await this.read(tx, taskId, actor);
        await tx.insert(auditEvents).values({
          teamId: actor.teamId,
          taskId,
          actorType: 'member',
          actorId: actor.id,
          action,
          targetType: 'task',
          targetId: taskId,
          beforeRevision: task.revision,
          afterRevision: data.task.revision,
          outcome: 'succeeded',
          reason: body.reason ?? null,
          requestId: input.requestId,
          createdAt: now,
        });
        await tx.insert(idempotencyRecords).values({
          scopeHash,
          keyHash,
          requestFingerprint,
          status: 'completed',
          responseStatus: 202,
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
        '执行操作暂不可用，请使用同一动作标识重试确认。',
      );
    }
  }

  async history(input: {
    taskId: string;
    actor: Session['member'];
    query: OperationQueries['taskHistory'];
  }): Promise<ResponseModels['History']> {
    const { taskId, actor, query } = input;
    const scope = hash([actor.teamId, taskId]);
    let cursor: { time: string; id: string } | undefined;
    if (query.cursor) {
      try {
        const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
        if (
          value.v !== 1 ||
          value.scope !== scope ||
          typeof value.time !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.time) ||
          !Number.isFinite(Date.parse(value.time)) ||
          typeof value.id !== 'string' ||
          !uuid.test(value.id)
        )
          throw new Error('invalid cursor');
        cursor = value;
      } catch {
        throw new AuthError(400, 'VALIDATION_ERROR', '历史分页位置无效，请重新加载。');
      }
    }
    try {
      return await this.db.transaction(
        async (tx) => {
          await this.read(tx, taskId, actor);
          const attempts = await tx
            .select()
            .from(executionAttempts)
            .where(eq(executionAttempts.taskId, taskId))
            .orderBy(desc(executionAttempts.attemptNo));
          const answers = await tx
            .select()
            .from(clarificationAnswers)
            .where(eq(clarificationAnswers.taskId, taskId))
            .orderBy(clarificationAnswers.answeredAt, clarificationAnswers.id);
          const steps = await tx
            .select({ step: executionSteps, outputId: taskContents.id })
            .from(executionSteps)
            .innerJoin(executionAttempts, eq(executionAttempts.id, executionSteps.attemptId))
            .leftJoin(taskContents, eq(taskContents.originAttemptId, executionAttempts.id))
            .where(eq(executionAttempts.taskId, taskId))
            .orderBy(desc(executionAttempts.attemptNo), executionSteps.ordinal);
          const limit = query.limit ?? 20;
          const audit = await tx
            .select({ event: auditEvents, time: timestamp })
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.taskId, taskId),
                eq(auditEvents.teamId, actor.teamId),
                cursor
                  ? sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${cursor.time}::timestamptz, ${cursor.id}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
            .limit(limit + 1);
          const page = audit.slice(0, limit);
          const last = page.at(-1);
          const calls = await tx
            .select()
            .from(executionCalls)
            .where(eq(executionCalls.taskId, taskId))
            .orderBy(executionCalls.startedAt, executionCalls.id);
          const [budget] = await tx
            .select()
            .from(executionBudgets)
            .where(eq(executionBudgets.taskId, taskId));
          return {
            attempts: attempts.map(attemptModel),
            calls: calls.map((call) => ({
              ...call,
              startedAt: call.startedAt.toISOString(),
              deadlineAt: call.deadlineAt.toISOString(),
              finishedAt: call.finishedAt?.toISOString() ?? null,
            })),
            budget: budget ?? null,
            clarificationAnswers: answers.map((answer) => ({
              ...answer,
              answeredAt: answer.answeredAt.toISOString(),
            })),
            steps: steps.map(({ step, outputId }) => stepModel(step, outputId ?? undefined)),
            audit: {
              items: page.map(({ event }) => ({
                id: event.id,
                teamId: actor.teamId,
                taskId,
                actorType: event.actorType,
                actorId: event.actorId ?? 'system',
                action: event.action,
                targetType: event.targetType,
                targetId: event.targetId ?? taskId,
                beforeRevision: event.beforeRevision,
                afterRevision: event.afterRevision,
                outcome: event.outcome,
                reason: event.reason,
                evidenceRefs: [],
                createdAt: event.createdAt.toISOString(),
              })),
              nextCursor:
                audit.length > limit && last
                  ? Buffer.from(
                      JSON.stringify({ v: 1, scope, time: last.time, id: last.event.id }),
                    ).toString('base64url')
                  : null,
            },
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '执行历史暂不可用，请稍后重试。');
    }
  }
}
