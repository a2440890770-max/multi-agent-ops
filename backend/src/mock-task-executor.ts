import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Failure } from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import { mockStages } from './execution-model.js';
import { auditEvents, executionAttempts, executionSteps, taskContents, tasks } from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
const duration = (started: Date | null, now: Date) =>
  started ? Math.min(2147483647, Math.max(0, now.getTime() - started.getTime())) : null;

/** No model, network, search, platform or in-memory job queue. Each small transition
 * commits its durable checkpoint with the task, steps, output and audit event. */
export class MockTaskExecutor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private reportedFailure = false;
  constructor(
    private db: Database,
    private options: { now?: () => Date; pollMs?: number; onError?: () => void } = {},
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.poll().finally(() => {
        this.running = undefined;
        this.schedule(this.options.pollMs ?? 500);
      });
    }, delay);
    this.timer.unref();
  }
  private async poll() {
    try {
      for (let i = 0; i < 20 && !this.stopped; i++) if (!(await this.tick())) break;
      this.reportedFailure = false;
    } catch {
      if (!this.reportedFailure) {
        this.reportedFailure = true;
        if (this.options.onError) this.options.onError();
        else console.error('模拟执行器暂不可用，将从数据库检查点重试；请检查数据库和迁移状态。');
      }
    }
  }

  /** Public single-transition entry for deterministic DB integration tests. */
  async tick(): Promise<boolean> {
    const now = this.options.now?.() ?? new Date();
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      const [job] = await tx
        .select({ task: tasks, attempt: executionAttempts })
        .from(tasks)
        .innerJoin(
          executionAttempts,
          and(
            eq(executionAttempts.id, tasks.currentAttemptId),
            eq(executionAttempts.taskId, tasks.id),
            eq(executionAttempts.generation, tasks.workGeneration),
          ),
        )
        .where(
          and(
            eq(tasks.lifecycle, 'open'),
            eq(executionAttempts.executorMode, 'mock'),
            inArray(executionAttempts.status, ['queued', 'running']),
            lte(executionAttempts.nextRunAt, now),
          ),
        )
        .orderBy(asc(executionAttempts.nextRunAt), asc(executionAttempts.id))
        .limit(1)
        .for('update', { of: tasks, skipLocked: true });
      if (!job) return false;
      const { task, attempt } = job;
      const steps = await tx
        .select()
        .from(executionSteps)
        .where(eq(executionSteps.attemptId, attempt.id))
        .orderBy(executionSteps.ordinal);
      const nextDue = new Date(now.getTime() + attempt.configSnapshot.stepDelayMs);
      let status: typeof attempt.status = 'running';
      let currentStep: string;
      let error: Failure | null = null;
      let contentId: string | null = null;
      let action: string;
      if (attempt.status === 'queued') {
        const first = steps.find((step) => step.status === 'queued');
        if (!first || first.status !== 'queued') throw new Error('invalid mock checkpoint');
        currentStep = mockStages[first.ordinal]!.label;
        action = 'attempt.running';
        await tx
          .update(executionSteps)
          .set({ status: 'running', startedAt: now })
          .where(eq(executionSteps.id, first.id));
        await tx
          .update(executionAttempts)
          .set({ status, currentStep, startedAt: attempt.startedAt ?? now, nextRunAt: nextDue })
          .where(eq(executionAttempts.id, attempt.id));
      } else {
        const current = steps.find((step) => step.status === 'running');
        if (!current) throw new Error('invalid mock checkpoint');
        const failure = attempt.simulationScenario === 'failure' && current.role === 'research';
        const clarification =
          attempt.simulationScenario === 'clarification' &&
          current.role === 'supervisor' &&
          (!attempt.clarifications.length ||
            attempt.clarifications.some((question) => !question.answer?.trim()));
        if (failure) {
          status = 'failed';
          currentStep = '模拟研究资料';
          error = {
            code: 'MOCK_RESEARCH_FAILED',
            message: '模拟执行失败：研究步骤按所选验证情形返回错误，未调用真实搜索或模型。',
            retryable: true,
          };
          action = 'attempt.failed';
          await tx
            .update(executionSteps)
            .set({
              status: 'failed',
              finishedAt: now,
              durationMs: duration(current.startedAt, now),
              error,
            })
            .where(eq(executionSteps.id, current.id));
          await tx
            .update(executionSteps)
            .set({ status: 'cancelled', finishedAt: now })
            .where(
              and(eq(executionSteps.attemptId, attempt.id), eq(executionSteps.status, 'queued')),
            );
          await tx
            .update(executionAttempts)
            .set({ status, currentStep, error, finishedAt: now, nextRunAt: null })
            .where(eq(executionAttempts.id, attempt.id));
        } else {
          await tx
            .update(executionSteps)
            .set({
              status: 'completed',
              finishedAt: now,
              durationMs: duration(current.startedAt, now),
            })
            .where(eq(executionSteps.id, current.id));
          if (clarification) {
            status = 'awaiting_clarification';
            currentStep = '等待澄清';
            action = 'attempt.awaiting_clarification';
            await tx
              .update(executionAttempts)
              .set({
                status,
                currentStep,
                nextRunAt: null,
                clarifications: [
                  {
                    questionId: randomUUID(),
                    question:
                      '【模拟澄清】请补充本次任务的明确主题、目标受众，并确认是否存在相互冲突的要求。',
                    answer: null,
                  },
                ],
              })
              .where(eq(executionAttempts.id, attempt.id));
          } else {
            const next = steps[current.ordinal + 1];
            if (next) {
              if (next.status !== 'queued') throw new Error('invalid next mock step');
              currentStep = mockStages[next.ordinal]!.label;
              action = 'attempt.step_advanced';
              await tx
                .update(executionSteps)
                .set({ status: 'running', startedAt: now })
                .where(eq(executionSteps.id, next.id));
              await tx
                .update(executionAttempts)
                .set({ currentStep, nextRunAt: nextDue })
                .where(eq(executionAttempts.id, attempt.id));
            } else {
              status = 'ready';
              currentStep = '模拟执行完成';
              action = 'attempt.ready';
              const [count] = await tx
                .select({ max: sql<number>`coalesce(max(${taskContents.versionNo}), 0)::integer` })
                .from(taskContents)
                .where(eq(taskContents.taskId, task.id));
              const clarified = attempt.clarifications
                .filter((entry) => entry.answer !== null)
                .map((entry) => `问题：${entry.question}\n答复：${entry.answer}`)
                .join('\n\n');
              const body = `【模拟产出，仅用于流程验证，不代表真实研究或审核结果】\n\n原始要求：\n${attempt.configSnapshot.originalRequest}${clarified ? `\n\n已保存的澄清答复：\n${clarified}` : ''}\n\n模拟执行已完成；真实文案生成将在后续接入。`;
              const [content] = await tx
                .insert(taskContents)
                .values({
                  taskId: task.id,
                  originAttemptId: attempt.id,
                  versionNo: (count?.max ?? 0) + 1,
                  parentVersionId:
                    (
                      await tx
                        .select({ id: taskContents.id })
                        .from(taskContents)
                        .where(eq(taskContents.taskId, task.id))
                        .orderBy(desc(taskContents.versionNo))
                        .limit(1)
                    )[0]?.id ?? null,
                  body,
                  contentHash: createHash('sha256').update(body).digest('hex'),
                  createdBy: attempt.requestedBy,
                  createdAt: now,
                })
                .returning();
              if (!content) throw new Error('mock output insert failed');
              contentId = content.id;
              await tx
                .update(executionAttempts)
                .set({ status, currentStep, finishedAt: now, nextRunAt: null })
                .where(eq(executionAttempts.id, attempt.id));
            }
          }
        }
      }
      await tx
        .update(tasks)
        .set({
          executionStatus: status,
          currentStep,
          errorMessage: error?.message ?? null,
          currentContentVersionId: contentId,
          revision: task.revision + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.currentAttemptId, attempt.id),
            eq(tasks.workGeneration, attempt.generation),
          ),
        );
      await tx.insert(auditEvents).values({
        teamId: task.teamId,
        taskId: task.id,
        actorType: 'worker',
        actorId: 'mock-executor-v1',
        action,
        targetType: 'execution_attempt',
        targetId: attempt.id,
        beforeRevision: task.revision,
        afterRevision: task.revision + 1,
        outcome: failureOutcome(status),
        reason: error?.message ?? null,
        requestId: `mock:${attempt.id}:${task.revision}`,
        createdAt: now,
      });
      return true;
    });
  }
}

const failureOutcome = (status: string) =>
  status === 'failed' ? ('failed' as const) : ('succeeded' as const);
