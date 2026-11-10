import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  AgentRunCheckSchema,
  SupervisorContextSchema,
  SUPERVISOR_PROMPT_VERSION,
  SUPERVISOR_TOOL_POLICY_VERSION,
  type AgentRunCheck,
  type AgentRunResponse,
  type GithubHotAcquisition,
  type SupervisorContext,
  type Failure,
  ResearchAuthorizationScopeSchema,
  ResearchSubmissionRecordSchema,
  validateResearchResult,
  validateSupervisorDecision,
  type AgentRunRequest,
  type ResearchAcceptedResult,
} from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import { AgentClient, AgentServiceError } from './agent-client.js';
import { AgentConfigurationSchema } from './agent-execution-config.js';
import { readExecutorPolicy, type ExecutorPolicy } from './execution-config.js';
import {
  admitControlledCall,
  endControlledAttempt,
  ensureControlPolicy,
  expireControlledAttempts,
  finishControlledCall,
  pauseActiveTime,
  type CallReservation,
} from './execution-control.js';
import {
  executionNow,
  recoverInterruptedExecutions,
  type ExecutionTransaction,
} from './execution-ownership.js';
import { estimateTokenCostMicrosCny, pricedModelUsage } from './execution-pricing.js';
import { researchPayloadHash } from './research-execution-service.js';
import {
  auditEvents,
  executionAttempts,
  executionBudgets,
  executionCalls,
  executionSteps,
  githubHotSnapshots,
  projectSelections,
  researchAuthorizations,
  researchSubmissionMaterials,
  researchRegistries,
  tasks,
} from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Job = { task: typeof tasks.$inferSelect; attempt: typeof executionAttempts.$inferSelect };
type Step = typeof executionSteps.$inferSelect;
const releaseLease = {
  executorId: null,
  claimToken: null,
  claimedAt: null,
  heartbeatAt: null,
  leaseExpiresAt: null,
  nextRunAt: null,
  activeSince: null,
};
const failure = (code: string): Failure => ({
  code,
  message: `真实执行未完成（${code}），已停止；请核对原因后人工重新执行。`,
  retryable: false,
});

/** Only the backend owns leases, snapshots, accounting and durable task decisions. */
export class AgentTaskExecutor {
  readonly executorId = randomUUID();
  readonly policy: ExecutorPolicy;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | undefined;
  private renewing: Promise<void> | undefined;
  private flights = new Map<string, { controller: AbortController; work: Promise<void> }>();
  constructor(
    private db: Database,
    private client: Pick<AgentClient, 'acquireHotList' | 'runSupervisor'>,
    policy: Partial<ExecutorPolicy> = {},
  ) {
    this.policy = { ...readExecutorPolicy({}), ...policy };
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.heartbeatTimer = setInterval(() => {
      if (this.renewing) return;
      this.renewing = this.heartbeat()
        .catch(() => {
          for (const flight of this.flights.values()) flight.controller.abort();
        })
        .finally(() => {
          this.renewing = undefined;
        });
    }, this.policy.heartbeatMs);
    this.heartbeatTimer.unref();
    this.schedule();
  }
  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.polling = this.poll()
        .catch(() => {
          console.error('真实任务调度失败；未自动重发 Agent 请求。');
        })
        .finally(() => {
          this.polling = undefined;
          this.schedule();
        });
    }, this.policy.pollMs);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const flight of this.flights.values()) flight.controller.abort();
    await this.polling;
    for (const flight of this.flights.values()) flight.controller.abort();
    await this.renewing;
    await Promise.allSettled([...this.flights.values()].map((flight) => flight.work));
    await this.db
      .update(executionAttempts)
      .set({ leaseExpiresAt: executionAttempts.heartbeatAt })
      .where(
        and(
          eq(executionAttempts.executorId, this.executorId),
          eq(executionAttempts.status, 'running'),
        ),
      );
    await recoverInterruptedExecutions(this.db);
  }
  private async heartbeat() {
    const clock = sql`clock_timestamp()`;
    const renewed = await this.db
      .update(executionAttempts)
      .set({
        heartbeatAt: clock,
        leaseExpiresAt: sql`${clock} + ${this.policy.leaseMs} * interval '1 millisecond'`,
      })
      .where(
        and(
          eq(executionAttempts.executorId, this.executorId),
          eq(executionAttempts.status, 'running'),
          isNull(executionAttempts.cancelRequestedAt),
          sql`${executionAttempts.leaseExpiresAt} > ${clock}`,
          sql`EXISTS (SELECT 1 FROM tasks t WHERE t.id=${executionAttempts.taskId} AND t.current_attempt_id=${executionAttempts.id} AND t.work_generation=${executionAttempts.generation} AND t.lifecycle='open')`,
        ),
      )
      .returning({ id: executionAttempts.id });
    const valid = new Set(renewed.map((row) => row.id));
    for (const [id, flight] of this.flights) if (!valid.has(id)) flight.controller.abort();
  }
  /** Private callback: service credentials alone do not prove current execution authority. */
  async checkRun(value: unknown) {
    const parsed = AgentRunCheckSchema.safeParse(value);
    if (!parsed.success) return false;
    const request = parsed.data;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ step: executionSteps, callKind: executionCalls.kind })
        .from(tasks)
        .innerJoin(
          executionAttempts,
          and(
            eq(executionAttempts.id, tasks.currentAttemptId),
            eq(executionAttempts.taskId, tasks.id),
            eq(executionAttempts.generation, tasks.workGeneration),
          ),
        )
        .innerJoin(
          executionSteps,
          and(
            eq(executionSteps.attemptId, executionAttempts.id),
            eq(executionSteps.id, request.execution.stepId),
          ),
        )
        .innerJoin(
          executionCalls,
          and(eq(executionCalls.stepId, executionSteps.id), eq(executionCalls.id, request.runId)),
        )
        .where(
          and(
            eq(tasks.id, request.execution.taskId),
            eq(tasks.lifecycle, 'open'),
            isNull(tasks.activePublishOperationId),
            isNull(tasks.publishedOperationId),
            eq(executionAttempts.id, request.execution.attemptId),
            eq(executionAttempts.executorMode, 'agent'),
            eq(executionAttempts.status, 'running'),
            eq(executionAttempts.executorId, request.lease.executorId),
            eq(executionAttempts.claimToken, request.lease.claimToken),
            eq(executionAttempts.generation, request.lease.generation),
            isNull(executionAttempts.cancelRequestedAt),
            sql`${executionAttempts.leaseExpiresAt} > clock_timestamp()`,
            eq(executionSteps.status, 'running'),
            eq(executionCalls.status, 'running'),
            sql`${executionCalls.deadlineAt} > clock_timestamp()`,
          ),
        )
        .for('update', { of: [tasks, executionAttempts, executionSteps, executionCalls] });
      const valid =
        !!row &&
        (row.step.runtimeMetadata?.kind === 'github_hot'
          ? row.callKind === 'readonly' &&
            request.contextHash === undefined &&
            request.execution.inputSnapshotId === row.step.id
          : row.callKind === 'model' &&
            row.step.inputSnapshotId === request.execution.inputSnapshotId &&
            request.contextHash ===
              createHash('sha256')
                .update(JSON.stringify(SupervisorContextSchema.parse(row.step.frozenInput)))
                .digest('hex'));
      if (!valid) return false;
      if (request.phase === 'begin') {
        if (row.step.runtimeMetadata?.agentDispatchClaimed === true) return false;
        await tx
          .update(executionSteps)
          .set({
            runtimeMetadata: {
              ...row.step.runtimeMetadata,
              agentDispatchClaimed: true,
              agentRunId: request.runId,
            },
          })
          .where(eq(executionSteps.id, row.step.id));
      }
      return true;
    });
  }
  private async current(tx: ExecutionTransaction, job: Job) {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, job.task.id)).for('update');
    const [attempt] = await tx
      .select()
      .from(executionAttempts)
      .where(eq(executionAttempts.id, job.attempt.id))
      .for('update');
    const now = await executionNow(tx);
    if (
      !task ||
      !attempt ||
      task.lifecycle !== 'open' ||
      task.activePublishOperationId ||
      task.publishedOperationId ||
      task.currentAttemptId !== attempt.id ||
      task.workGeneration !== attempt.generation ||
      attempt.status !== 'running' ||
      attempt.cancelRequestedAt ||
      attempt.executorId !== this.executorId ||
      attempt.claimToken !== job.attempt.claimToken ||
      !attempt.leaseExpiresAt ||
      attempt.leaseExpiresAt <= now
    )
      return;
    return { task, attempt, now };
  }
  private async poll() {
    await recoverInterruptedExecutions(this.db);
    await expireControlledAttempts(this.db);
    while (!this.stopped && this.flights.size < this.policy.concurrency) {
      const job = await this.db.transaction(async (tx) => {
        const now = await executionNow(tx);
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
              isNull(tasks.activePublishOperationId),
              isNull(tasks.publishedOperationId),
              eq(executionAttempts.executorMode, 'agent'),
              eq(executionAttempts.status, 'queued'),
              isNull(executionAttempts.cancelRequestedAt),
              isNull(executionAttempts.executorId),
              lte(executionAttempts.nextRunAt, now),
            ),
          )
          .orderBy(asc(executionAttempts.nextRunAt), asc(executionAttempts.id))
          .limit(1)
          .for('update', { of: [tasks, executionAttempts], skipLocked: true });
        if (!job) return;
        await ensureControlPolicy(tx, job, now);
        const [attempt] = await tx
          .update(executionAttempts)
          .set({
            status: 'running',
            executorId: this.executorId,
            claimToken: randomUUID(),
            claimedAt: now,
            heartbeatAt: now,
            leaseExpiresAt: new Date(now.getTime() + this.policy.leaseMs),
            runtimePolicy: this.policy,
            startedAt: job.attempt.startedAt ?? now,
            nextRunAt: now,
          })
          .where(eq(executionAttempts.id, job.attempt.id))
          .returning();
        await tx
          .update(tasks)
          .set({
            executionStatus: 'running',
            currentStep: '真实 Agent 执行中',
            revision: job.task.revision + 1,
            updatedAt: now,
          })
          .where(eq(tasks.id, job.task.id));
        return attempt ? { task: job.task, attempt } : undefined;
      });
      if (!job) break;
      const controller = new AbortController();
      const work = Promise.resolve()
        .then(() => this.execute(job, controller))
        .catch(async () => {
          // An uncertain DB commit is fenced, never retried as an external request.
          controller.abort();
          await this.db
            .update(executionAttempts)
            .set({ leaseExpiresAt: executionAttempts.heartbeatAt })
            .where(
              and(
                eq(executionAttempts.id, job.attempt.id),
                eq(executionAttempts.claimToken, job.attempt.claimToken!),
              ),
            );
        })
        .catch(() => {
          console.error('真实执行状态写入失败；原租约失效后由恢复流程处理。');
        })
        .finally(() => {
          this.flights.delete(job.attempt.id);
        });
      this.flights.set(job.attempt.id, { controller, work });
    }
  }
  private async context(
    tx: ExecutionTransaction,
    job: Job,
    step: Step,
  ): Promise<{
    context: SupervisorContext;
    accepted: ResearchAcceptedResult[];
    binding?: AgentRunRequest['research'];
  }> {
    const [selection] = await tx
      .select()
      .from(projectSelections)
      .where(eq(projectSelections.taskId, job.task.id));
    const [hot] = await tx
      .select()
      .from(githubHotSnapshots)
      .where(
        and(
          eq(githubHotSnapshots.taskId, job.task.id),
          selection
            ? eq(githubHotSnapshots.id, selection.hotListSnapshotId)
            : eq(githubHotSnapshots.attemptId, job.attempt.id),
        ),
      );
    if (!hot?.snapshot.list.items.length || job.attempt.configSnapshot.mode !== 'agent')
      throw new AgentServiceError('GITHUB_HOT_EMPTY');
    const accountContext = SupervisorContextSchema.shape.accountContext.parse(
      job.attempt.configSnapshot.configuration.accountContext,
    );
    const configuration = AgentConfigurationSchema.parse(
      job.attempt.configSnapshot.configuration.runtime,
    );
    const [latest] = await tx
      .select()
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.attemptId, job.attempt.id),
          sql`${executionSteps.resultId} IS NOT NULL`,
        ),
      )
      .orderBy(sql`${executionSteps.resultVersion} DESC`)
      .limit(1);
    const accepted =
      latest?.validatedOutput && 'report' in latest.validatedOutput
        ? [validateResearchResult(latest.validatedOutput)]
        : [];
    const [pending] = await tx
      .select()
      .from(researchAuthorizations)
      .where(
        and(
          eq(researchAuthorizations.attemptId, job.attempt.id),
          isNull(researchAuthorizations.consumedAt),
        ),
      );
    let binding: AgentRunRequest['research'];
    let inputs: SupervisorContext['researchContext']['inputs'] = null;
    if (pending) {
      if (!selection || !configuration.research)
        throw new AgentServiceError('RESEARCH_NOT_CONFIGURED');
      const scope = ResearchAuthorizationScopeSchema.parse(pending.scope);
      if (
        scope.generation !== job.attempt.generation ||
        scope.selection.selectionId !== selection.id ||
        scope.budget.webRequestMicrosCny !== configuration.research.webRequestMicrosCny ||
        scope.baseResult?.id !== (accepted.at(-1)?.id ?? undefined)
      )
        throw new AgentServiceError('RESEARCH_SCOPE_INVALID');
      const rows = scope.submissionId
        ? await tx
            .select()
            .from(researchSubmissionMaterials)
            .where(
              and(
                eq(researchSubmissionMaterials.submissionId, scope.submissionId),
                eq(researchSubmissionMaterials.taskId, job.task.id),
                eq(researchSubmissionMaterials.attemptId, job.attempt.id),
              ),
            )
        : [];
      if (rows.length !== scope.submissionRecordCount)
        throw new AgentServiceError('RESEARCH_MATERIALS_INVALID');
      const records = rows.map((r) => ResearchSubmissionRecordSchema.parse(r.record));
      const sources = new Map<string, (typeof records)[number]['source']>();
      for (const ref of job.task.referenceInputs)
        if (ref.url) {
          const url = new URL(ref.url),
            repository = new URL(selection.project.repositoryUrl);
          const primary =
            url.origin === repository.origin &&
            (url.pathname.replace(/\/$/, '') === repository.pathname.replace(/\/$/, '') ||
              url.pathname.startsWith(repository.pathname.replace(/\/$/, '') + '/'));
          sources.set(ref.id, {
            id: ref.id,
            label: ref.label,
            url: ref.url,
            nature: primary ? 'primary' : 'user_provided',
            author: null,
            publishedAt: null,
          });
        }
      for (const record of records) sources.set(record.source.id, record.source);
      const limits = scope.researchMethod.limits;
      inputs = {
        stepId: randomUUID(),
        mode: scope.mode,
        contentContext: {
          audience: accountContext.defaultAudience ?? '对开源项目感兴趣的用户',
          purpose: job.task.originalRequest,
          platform: 'douyin',
          format: 'image_text',
          prohibitions: accountContext.prohibitions,
        },
        referenceMaterials: {
          sources: [...sources.values()],
          materials: records.flatMap((r) => (r.material ? [r.material] : [])),
        },
        supplementScope: scope.supplementScope
          ? {
              questionIds: scope.supplementScope.questions.map((q) => q.id),
              gapIds: scope.supplementScope.gaps.map((g) => g.id),
            }
          : null,
        runtimeContext: {
          now: (await executionNow(tx)).toISOString(),
          timezone: 'Asia/Shanghai',
          skills: scope.researchMethod.skills.map(({ name, version, requiredSections }) => ({
            name,
            version,
            requiredSections,
          })),
          requiredSearchSites: scope.sources.requiredSearchSites,
          toolPolicyVersion: scope.researchMethod.toolPolicyVersion,
          configVersion: job.attempt.configVersion,
          limits: {
            ...limits,
            maxBudgetUsd: Math.min(0.1, limits.maxBudgetUsd, configuration.supervisor.maxBudgetUsd),
          },
        },
      };
      binding = {
        scope,
        webConfig: {
          ...configuration.research.webConfig,
          maxSearchCalls: Math.min(
            configuration.research.webConfig.maxSearchCalls,
            limits.maxSearchCalls,
          ),
          maxFetchCalls: Math.min(
            configuration.research.webConfig.maxFetchCalls,
            limits.maxFetchCalls,
          ),
        },
      };
    }
    const context = SupervisorContextSchema.parse({
      schemaVersion: '2.0',
      execution: {
        taskId: job.task.id,
        attemptId: job.attempt.id,
        stepId: step.id,
        inputSnapshotId: randomUUID(),
      },
      trigger:
        step.runtimeMetadata?.trigger === 'materials_submitted'
          ? 'additional_research_authorized'
          : job.attempt.clarifications.length
            ? 'clarification_answered'
            : selection
              ? 'project_selected'
              : 'hot_list_loaded',
      hotList: hot.snapshot.list,
      selectedProject: selection?.project ?? null,
      task: {
        title: job.task.title,
        originalRequest: job.task.originalRequest,
        referenceInputs: job.task.referenceInputs,
      },
      clarifications: job.attempt.clarifications,
      accountContext,
      memoryContext: [],
      researchContext: {
        authorizationId: pending?.id ?? null,
        authorizationUsed: false,
        acceptedResultIds: accepted.map((r) => r.id),
        inputs,
      },
      runtimePolicy: {
        stage: 'D9',
        allowedSubagents: binding ? ['research'] : [],
        configVersion: job.attempt.configVersion,
        promptVersion: SUPERVISOR_PROMPT_VERSION,
        toolPolicyVersion: SUPERVISOR_TOOL_POLICY_VERSION,
      },
      contextSelection: {
        includedRefs: [hot.id, ...job.task.referenceInputs.map((ref) => ref.id)],
        omitted: [],
      },
    });
    return { context, accepted, ...(binding ? { binding } : {}) };
  }
  private async execute(job: Job, controller: AbortController) {
    for (let stage = 0; stage < 2 && !controller.signal.aborted; stage++) {
      const prepared = await this.db.transaction(async (tx) => {
        const current = await this.current(tx, job);
        if (!current || current.attempt.configSnapshot.mode !== 'agent') return;
        const [step] = await tx
          .select()
          .from(executionSteps)
          .where(
            and(eq(executionSteps.attemptId, job.attempt.id), eq(executionSteps.status, 'queued')),
          )
          .orderBy(executionSteps.ordinal)
          .limit(1)
          .for('update');
        if (!step) return;
        const configuration = AgentConfigurationSchema.parse(
          current.attempt.configSnapshot.configuration.runtime,
        );
        const hotList = step.runtimeMetadata?.kind === 'github_hot';
        // Selected tasks reuse the original board; only an explicit authorization can research.
        const [selection] = await tx
          .select({ id: projectSelections.id })
          .from(projectSelections)
          .where(eq(projectSelections.taskId, job.task.id));
        if (selection && hotList) {
          await endControlledAttempt(tx, current, current.now, failure('RESEARCH_NOT_ENABLED'));
          return;
        }
        let context: SupervisorContext | undefined;
        let researchInput: Awaited<ReturnType<AgentTaskExecutor['context']>> | undefined;
        try {
          if (!hotList) {
            researchInput = await this.context(tx, current, step);
            context = researchInput.context;
          }
        } catch {
          await endControlledAttempt(
            tx,
            current,
            current.now,
            failure('SUPERVISOR_CONTEXT_INVALID'),
          );
          return;
        }
        await tx
          .update(executionSteps)
          .set({
            status: 'running',
            startedAt: current.now,
            ...(context
              ? { frozenInput: context, inputSnapshotId: context.execution.inputSnapshotId }
              : {}),
          })
          .where(eq(executionSteps.id, step.id));
        const [budget] = await tx
          .select()
          .from(executionBudgets)
          .where(eq(executionBudgets.taskId, job.task.id))
          .for('update');
        if (!budget) throw new Error('Missing execution budget');
        let reservation: CallReservation = {
          kind: 'readonly',
          maxTokens: 0,
          maxCostMicrosCny: 0,
          pricingRef: 'xxapi:provider_fee_unknown:v1',
        };
        const webFee = researchInput?.binding
          ? (researchInput.binding.webConfig.maxSearchCalls +
              researchInput.binding.webConfig.maxFetchCalls) *
            researchInput.binding.scope.budget.webRequestMicrosCny!
          : 0;
        if (!hotList) {
          const price = configuration.pricing;
          const rate = Math.max(price.inputMicrosCnyPerMillion, price.outputMicrosCnyPerMillion);
          const remainingCost =
            budget.limits.maxCostMicrosCny - budget.chargedCostMicrosCny - webFee;
          const maxTokens = Math.min(
            configuration.maxSessionTokens,
            budget.limits.maxTokens - budget.chargedTokens,
            rate ? Math.floor((remainingCost * 1_000_000) / rate) : configuration.maxSessionTokens,
          );
          if (maxTokens < configuration.supervisor.maxOutputTokens || remainingCost < 0) {
            await endControlledAttempt(
              tx,
              current,
              current.now,
              failure('EXECUTION_BUDGET_EXCEEDED'),
            );
            return;
          }
          reservation = {
            kind: 'model',
            maxTokens,
            maxCostMicrosCny:
              webFee +
              estimateTokenCostMicrosCny(maxTokens, 0, {
                ...price,
                inputMicrosCnyPerMillion: rate,
              }),
            pricingRef: `${price.version};input=${price.inputMicrosCnyPerMillion};output=${price.outputMicrosCnyPerMillion};web-reservation=${webFee};reservation=max_rate;unit=microCNY/1M`,
          };
        }
        const admitted = await admitControlledCall(tx, current, current.now, reservation, {
          toolName: hotList ? 'xxapi.githubhot' : 'runSupervisor',
          stepId: step.id,
        });
        if (admitted.failure) {
          await endControlledAttempt(tx, current, current.now, admitted.failure);
          return;
        }
        if (!admitted.call) throw new Error('Agent call admission failed');
        return {
          ...current,
          step,
          context,
          configuration,
          reservation,
          call: admitted.call,
          hotList,
          researchInput,
        };
      });
      if (!prepared) return;
      const identity: AgentRunCheck = {
        runId: prepared.call.id,
        lease: {
          executorId: this.executorId,
          claimToken: job.attempt.claimToken!,
          generation: job.attempt.generation,
        },
        execution: {
          taskId: job.task.id,
          attemptId: job.attempt.id,
          stepId: prepared.step.id,
          inputSnapshotId: prepared.context?.execution.inputSnapshotId ?? prepared.step.id,
        },
      };
      const remainingMs =
        prepared.call.deadlineAt.getTime() - (await executionNow(this.db)).getTime();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(Math.max(1, remainingMs)),
      ]);
      let output: AgentRunResponse | undefined;
      let acquisition: GithubHotAcquisition | undefined;
      let error: Failure | undefined;
      let diagnostic: AgentServiceError['diagnostic'];
      try {
        if (remainingMs <= 0) throw new AgentServiceError('EXECUTION_CALL_TIMEOUT');
        if (prepared.hotList) acquisition = await this.client.acquireHotList(identity, signal);
        else
          output = await this.client.runSupervisor(
            {
              protocolVersion: 1,
              runId: identity.runId,
              lease: identity.lease,
              context: prepared.context!,
              limits: {
                ...prepared.configuration.supervisor,
                timeoutMs: Math.min(remainingMs, prepared.configuration.supervisor.timeoutMs),
              },
              maxTotalTokens: prepared.reservation.maxTokens,
              acceptedResearchResults: prepared.researchInput?.accepted ?? [],
              ...(prepared.researchInput?.binding
                ? { research: prepared.researchInput.binding }
                : {}),
            },
            signal,
          );
      } catch (problem) {
        if (problem instanceof AgentServiceError) diagnostic = problem.diagnostic;
        error = failure(
          problem instanceof AgentServiceError ? problem.code : 'AGENT_EXECUTION_FAILED',
        );
      }
      const advance = await this.db.transaction(async (tx) => {
        const current = await this.current(tx, job);
        if (!current) return false;
        if (diagnostic)
          await tx
            .update(executionSteps)
            .set({
              runtimeMetadata: sql`coalesce(${executionSteps.runtimeMetadata}, '{}'::jsonb) || ${JSON.stringify({ structuredOutputDiagnostic: diagnostic })}::jsonb`,
            })
            .where(eq(executionSteps.id, prepared.step.id));
        const usage = output?.result.metadata.modelUsage;
        if (output?.result.metadata.sessionId)
          await tx
            .update(executionCalls)
            .set({ sdkSessionId: output.result.metadata.sessionId })
            .where(
              and(eq(executionCalls.id, prepared.call.id), eq(executionCalls.status, 'running')),
            );
        const result = usage?.length
          ? pricedModelUsage(
              usage.reduce((sum, row) => sum + row.inputTokens, 0),
              usage.reduce((sum, row) => sum + row.outputTokens, 0),
              prepared.configuration.pricing,
            )
          : undefined;
        if (result?.usage && prepared.researchInput?.binding) {
          const authorizationId = prepared.context!.researchContext.authorizationId!;
          const [registry] = await tx
            .select()
            .from(researchRegistries)
            .where(eq(researchRegistries.authorizationId, authorizationId));
          const calls = registry?.snapshot.calls.filter((c) => c.countsTowardLimit).length ?? 0;
          result.usage.estimatedCostMicrosCny =
            (result.usage.estimatedCostMicrosCny ?? 0) +
            calls * prepared.researchInput.binding.scope.budget.webRequestMicrosCny!;
        }
        const action = await finishControlledCall(tx, current, prepared.call, current.now, {
          result,
          failure: error,
          canRetry: false,
          timedOut: current.now >= prepared.call.deadlineAt,
        });
        if (action !== 'advance') return false;
        if (acquisition) {
          await tx.insert(githubHotSnapshots).values({
            id: acquisition.list.id,
            taskId: job.task.id,
            attemptId: job.attempt.id,
            provider: 'xxapi',
            fetchedAt: new Date(acquisition.list.fetchedAt),
            snapshot: acquisition,
          });
          await tx
            .update(executionSteps)
            .set({
              status: 'completed',
              finishedAt: current.now,
              durationMs: Math.max(0, current.now.getTime() - prepared.now.getTime()),
              runtimeMetadata: {
                kind: 'github_hot',
                provider: 'xxapi',
                parserVersion: acquisition.parserVersion,
                providerFee: 'unknown',
                itemCount: acquisition.list.items.length,
              },
            })
            .where(eq(executionSteps.id, prepared.step.id));
          if (!acquisition.list.items.length) {
            await endControlledAttempt(tx, current, current.now, failure('GITHUB_HOT_EMPTY'));
            return false;
          }
          await tx
            .update(tasks)
            .set({
              currentStep: 'Supervisor 判断任务要求',
              revision: current.task.revision + 1,
              updatedAt: current.now,
            })
            .where(eq(tasks.id, job.task.id));
          return true;
        }
        if (!output) throw new Error('Agent output missing');
        const decision = output.result.output;
        const persisted = await tx
          .select()
          .from(executionSteps)
          .where(
            and(
              eq(executionSteps.attemptId, job.attempt.id),
              sql`${executionSteps.resultId} IS NOT NULL`,
            ),
          )
          .orderBy(sql`${executionSteps.resultVersion} DESC`)
          .limit(1);
        const latestReport =
          persisted[0]?.validatedOutput && 'report' in persisted[0].validatedOutput
            ? persisted[0].validatedOutput
            : null;
        for (const report of output.result.researchResults) {
          const [stored] = await tx
            .select()
            .from(executionSteps)
            .where(
              and(
                eq(executionSteps.attemptId, job.attempt.id),
                eq(executionSteps.resultId, report.id),
              ),
            );
          if (
            !stored ||
            researchPayloadHash(stored.validatedOutput) !== researchPayloadHash(report)
          )
            throw new Error('Uncommitted research response');
        }
        if (latestReport && output.result.researchResults.at(-1)?.id !== latestReport.id)
          throw new Error('Stale research response');
        validateSupervisorDecision(decision, prepared.context!, output.result.researchResults);
        await tx
          .update(executionSteps)
          .set({
            status: 'completed',
            validatedOutput: decision,
            finishedAt: current.now,
            durationMs: Math.max(0, current.now.getTime() - prepared.now.getTime()),
            runtimeMetadata: {
              kind: 'supervisor',
              ...output.result.metadata,
              events: output.events,
            },
          })
          .where(eq(executionSteps.id, prepared.step.id));
        await pauseActiveTime(tx, current.attempt, current.now);
        const status =
          decision.decision === 'needs_clarification'
            ? ('awaiting_clarification' as const)
            : decision.decision === 'awaiting_selection'
              ? ('awaiting_selection' as const)
              : decision.decision === 'needs_materials'
                ? ('awaiting_materials' as const)
                : ('awaiting_content' as const);
        const label =
          status === 'awaiting_clarification'
            ? '等待澄清'
            : status === 'awaiting_selection'
              ? '等待选题'
              : status === 'awaiting_materials'
                ? '等待补充资料或补查授权'
                : '研究完成，等待创作';
        await tx
          .update(executionAttempts)
          .set({
            ...releaseLease,
            status,
            currentStep: label,
            clarifications: [
              ...current.attempt.clarifications,
              ...(decision.decision === 'needs_clarification'
                ? decision.questions.map((question) => ({
                    questionId: randomUUID(),
                    question: `${question.question}\n${question.reason}`,
                    answer: null,
                  }))
                : []),
            ],
          })
          .where(eq(executionAttempts.id, job.attempt.id));
        await tx
          .update(tasks)
          .set({
            executionStatus: status,
            currentStep: label,
            revision: current.task.revision + 1,
            updatedAt: current.now,
          })
          .where(eq(tasks.id, job.task.id));
        await tx.insert(auditEvents).values({
          teamId: job.task.teamId,
          taskId: job.task.id,
          actorType: 'worker',
          actorId: this.executorId,
          action: `attempt.${status}`,
          targetType: 'execution_attempt',
          targetId: job.attempt.id,
          outcome: 'succeeded',
          requestId: `agent-result:${prepared.call.id}`,
          createdAt: current.now,
        });
        return false;
      });
      if (!advance) return;
    }
  }
}
