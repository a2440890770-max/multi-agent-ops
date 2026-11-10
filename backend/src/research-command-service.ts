import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  GithubHotListSchema,
  ResearchAcceptedResultSchema,
  ResearchAuthorizationPolicySchema,
  ResearchAuthorizationScopeSchema,
  ResearchSubmissionRecordSchema,
  RetryResearchAndAuthorizeSchema,
  SelectProjectAndAuthorizeResearchSchema,
  SubmitMaterialsAndAuthorizeResearchSchema,
  normalizeResearchSiteGrant,
  type OperationBodies,
  type ResearchAuthorizationPolicy,
  type ResearchAuthorizationScope,
  type ResearchCommandResult,
  type ResearchSubmissionRecord,
  type SelectedProject,
  type Session,
  type TaskDetail,
} from '@multi-agent-ops/shared';
import { AgentConfigurationSchema, type AgentConfiguration } from './agent-execution-config.js';
import type { createBusinessDatabase } from './database.js';
import { databaseErrorCode } from './database-errors.js';
import { AuthError } from './auth.js';
import { invalidateApproval, lockEditorialTeam } from './editorial-state.js';
import { executionNow } from './execution-ownership.js';
import type { ExecutionLimits } from './execution-config.js';
import {
  accounts,
  auditEvents,
  configVersions,
  executionAttempts,
  executionBudgets,
  executionCalls,
  executionSteps,
  githubHotSnapshots,
  idempotencyRecords,
  members,
  projectSelections,
  researchAuthorizations,
  researchSubmissionMaterials,
  researchSubmissions,
  tasks,
} from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Connection = Database | Transaction;
type ReadTask = (
  connection: Connection,
  taskId: string,
  actor: Session['member'],
) => Promise<TaskDetail>;
type Context = { taskId: string; actor: Session['member']; key: string; requestId: string };
type Command =
  | 'selectProjectAndAuthorizeResearch'
  | 'retryResearchAndAuthorize'
  | 'submitMaterialsAndAuthorizeResearch';
type Request = { [K in Command]: Context & { operation: K; body: OperationBodies[K] } }[Command];
type Attempt = typeof executionAttempts.$inferSelect;
const paths = {
  selectProjectAndAuthorizeResearch: 'project-selection',
  retryResearchAndAuthorize: 'research-attempt-retries',
  submitMaterialsAndAuthorizeResearch: 'research-supplements',
};
const schemas = {
  selectProjectAndAuthorizeResearch: SelectProjectAndAuthorizeResearchSchema,
  retryResearchAndAuthorize: RetryResearchAndAuthorizeSchema,
  submitMaterialsAndAuthorizeResearch: SubmitMaterialsAndAuthorizeResearchSchema,
};
const actions = {
  selectProjectAndAuthorizeResearch: 'research.project_selected_and_authorized',
  retryResearchAndAuthorize: 'research.attempt_retried_and_authorized',
  submitMaterialsAndAuthorizeResearch: 'research.materials_submitted_and_authorized',
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const contentHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function invalid(message: string, field?: string): never {
  throw new AuthError(409, 'INVALID_STATE', message, undefined, {
    conflict: null,
    fieldErrors: field ? [{ field, message }] : [],
  });
}

/** No production composition root supplies researchPolicy until the execution chain is ready.
 * Tests inject it with an offline worker; there is deliberately no HTTP/environment bypass. */
export class ResearchCommandService {
  constructor(
    private db: Database,
    private read: ReadTask,
    private options: {
      executorMode?: 'mock' | 'agent' | 'disabled';
      agentConfiguration?: AgentConfiguration;
      researchPolicy?: ResearchAuthorizationPolicy;
      executionLimits?: ExecutionLimits;
    } = {},
  ) {}

  async handle(input: Request): Promise<{ data: ResearchCommandResult; replayed: boolean }> {
    if (!uuid.test(input.taskId)) throw new AuthError(404, 'NOT_FOUND', '任务不存在或不可访问。');
    if (!['admin', 'operator'].includes(input.actor.role))
      throw new AuthError(403, 'FORBIDDEN', '当前成员无研究操作权限。');
    if (input.key.length < 16 || input.key.length > 128)
      throw new AuthError(400, 'VALIDATION_ERROR', '动作标识长度无效。');
    const parsed = schemas[input.operation].safeParse(input.body);
    if (!parsed.success)
      throw new AuthError(
        400,
        'VALIDATION_ERROR',
        '研究请求的字段、资料或授权范围无效。',
        undefined,
        {
          conflict: null,
          fieldErrors: parsed.error.issues.map((issue) => ({
            field: `body/${issue.path.join('/')}`,
            message: issue.message,
          })),
        },
      );
    // Normalize only IDs and unordered scope lists. Never normalize the actual material text.
    input = { ...input, taskId: input.taskId.toLowerCase(), body: parsed.data } as Request;
    if (input.operation === 'submitMaterialsAndAuthorizeResearch')
      input = {
        ...input,
        body: {
          ...input.body,
          attemptId: input.body.attemptId.toLowerCase(),
          questionIds: [...input.body.questionIds].sort(),
          gapIds: [...input.body.gapIds].sort(),
          officialSiteGrants: input.body.officialSiteGrants
            .map(normalizeResearchSiteGrant)
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          confirmExistingMaterials: [...input.body.confirmExistingMaterials].sort((a, b) =>
            a.materialId.localeCompare(b.materialId),
          ),
        },
      };
    else if (input.operation === 'selectProjectAndAuthorizeResearch')
      input = {
        ...input,
        body: {
          ...input.body,
          attemptId: input.body.attemptId.toLowerCase(),
          hotListSnapshotId: input.body.hotListSnapshotId.toLowerCase(),
        },
      };
    else
      input = {
        ...input,
        body: { ...input.body, previousAttemptId: input.body.previousAttemptId.toLowerCase() },
      };
    const { actor, taskId, operation, body } = input;
    const scopeHash = digest([
      actor.teamId,
      actor.id,
      'POST',
      `/api/v1/tasks/${taskId}/${paths[operation]}`,
    ]);
    const keyHash = digest(input.key),
      fingerprint = digest(body);
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
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
              eq(members.status, 'active'),
              eq(members.role, actor.role),
              eq(members.version, actor.version),
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
        await this.read(tx, taskId, actor); // Recheck bound account integrity before replay.
        const now = await executionNow(tx);
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
          if (existing.requestFingerprint !== fingerprint)
            throw new AuthError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              '同一动作标识不能用于不同研究请求。',
            );
          if (
            existing.status !== 'completed' ||
            existing.responseStatus !== 202 ||
            !existing.responseBody
          )
            invalid('动作尚未确认，请使用同一标识重试。');
          return { data: existing.responseBody as ResearchCommandResult, replayed: true };
        }
        // Failed readiness checks do not save selection, materials, authorization or keys.
        if (this.options.executorMode !== 'agent' || !this.options.researchPolicy)
          throw new AuthError(
            503,
            'DEPENDENCY_UNAVAILABLE',
            'Research 执行链尚未接通，研究操作暂未开放。',
          );
        const policy = ResearchAuthorizationPolicySchema.parse(this.options.researchPolicy);
        if (task.revision !== body.expectedRevision)
          throw new AuthError(
            409,
            'REVISION_CONFLICT',
            '任务状态已变化，请刷新后确认新动作。',
            undefined,
            {
              fieldErrors: [],
              conflict: {
                expectedRevision: body.expectedRevision,
                actualRevision: task.revision,
                currentContentVersionId: task.currentContentVersionId,
                taskUrl: `/api/v1/tasks/${taskId}`,
                latestVersionUrl: null,
              },
            },
          );
        if (task.lifecycle !== 'open') invalid('任务已经结束。');
        if (task.activePublishOperationId || task.publishedOperationId)
          throw new AuthError(423, 'PUBLICATION_LOCKED', '任务存在发布交接或成功发布锁。');
        if (!task.currentAttemptId) invalid('任务没有当前执行尝试。');
        const [previous] = await tx
          .select()
          .from(executionAttempts)
          .where(
            and(
              eq(executionAttempts.id, task.currentAttemptId),
              eq(executionAttempts.taskId, taskId),
            ),
          )
          .for('update');
        if (
          !previous ||
          previous.executorMode !== 'agent' ||
          previous.configSnapshot.mode !== 'agent' ||
          previous.status !== task.executionStatus
        )
          invalid('当前真实执行尝试或任务状态不一致。');
        const steps = await tx
          .select()
          .from(executionSteps)
          .where(eq(executionSteps.attemptId, previous.id))
          .orderBy(executionSteps.ordinal)
          .for('update');
        if (steps.some((s) => s.status === 'queued' || s.status === 'running'))
          throw new AuthError(423, 'WORK_LOCKED', '当前尝试仍有排队或运行步骤。');
        const [runningCall] = await tx
          .select({ id: executionCalls.id })
          .from(executionCalls)
          .where(
            and(eq(executionCalls.attemptId, previous.id), eq(executionCalls.status, 'running')),
          )
          .limit(1);
        if (runningCall) throw new AuthError(423, 'WORK_LOCKED', '当前尝试仍有未结束的调用。');
        const [selectionRow] = await tx
          .select()
          .from(projectSelections)
          .where(eq(projectSelections.taskId, taskId));
        const [pending] = await tx
          .select()
          .from(researchAuthorizations)
          .where(
            and(
              eq(researchAuthorizations.attemptId, previous.id),
              isNull(researchAuthorizations.consumedAt),
            ),
          )
          .for('update');
        const [budget] = await tx
          .select()
          .from(executionBudgets)
          .where(eq(executionBudgets.taskId, taskId))
          .for('update');
        if (!budget) invalid('任务缺少已冻结预算，不能建立新的研究授权。');
        if (
          budget.chargedCostMicrosCny >= budget.limits.maxCostMicrosCny ||
          budget.calls >= budget.limits.maxCalls ||
          budget.chargedTokens >= budget.limits.maxTokens
        )
          invalid('任务累计预算已用尽，不能通过重试重置。');
        let attempt = previous,
          selection: SelectedProject,
          mode: 'initial' | 'supplement' = 'initial';
        let submissionId: string | null = null;
        let baseResult: { id: string; version: number } | null = null;
        let supplementScope: ResearchAuthorizationScope['supplementScope'] = null;
        let records: { clientRef: string | null; record: ResearchSubmissionRecord }[] = [];
        let grants: { origin: string; pathPrefix: string }[] = [];
        let ordinal = (steps.at(-1)?.ordinal ?? -1) + 1;
        const authorizationId = randomUUID();
        if (input.operation === 'selectProjectAndAuthorizeResearch') {
          this.waiting(task.workGeneration, previous, input.body.attemptId, ['awaiting_selection']);
          if (selectionRow) invalid('该任务已选定项目；更换项目需要新建任务。');
          if (pending) invalid('当前尝试已有待用研究授权。');
          const [hot] = await tx
            .select()
            .from(githubHotSnapshots)
            .where(
              and(
                eq(githubHotSnapshots.id, input.body.hotListSnapshotId),
                eq(githubHotSnapshots.taskId, taskId),
                eq(githubHotSnapshots.attemptId, previous.id),
              ),
            );
          if (!hot) invalid('榜单不属于当前执行尝试。');
          const list = GithubHotListSchema.parse(hot.snapshot.list);
          const candidate = list.items.find((item) => item.id === input.body.candidateId);
          if (!candidate) invalid('候选不属于当前冻结榜单。');
          selection = {
            selectionId: randomUUID(),
            hotListSnapshotId: hot.id,
            candidateId: candidate.id,
            name: candidate.title,
            repositoryUrl: candidate.repositoryUrl,
          };
          await tx.insert(projectSelections).values({
            id: selection.selectionId,
            taskId,
            attemptId: previous.id,
            hotListSnapshotId: hot.id,
            candidateId: candidate.id,
            project: selection,
            selectedBy: actor.id,
            selectedAt: now,
          });
        } else {
          if (!selectionRow) invalid('任务尚未选定研究项目。');
          selection = selectionRow.project;
          if (input.operation === 'retryResearchAndAuthorize') {
            if (
              previous.id !== input.body.previousAttemptId ||
              !['failed', 'cancelled'].includes(previous.status)
            )
              invalid('重新执行必须关联当前已失败或停止的尝试。');
            if (previous.attemptNo >= 100) invalid('当前版本最多保留 100 次完整尝试。');
            const runtime = AgentConfigurationSchema.parse(this.options.agentConfiguration);
            const [accountConfig] = task.accountId
              ? await tx
                  .select({
                    version: configVersions.version,
                    description: configVersions.profile,
                    tone: configVersions.tone,
                    prohibitions: configVersions.forbiddenTopics,
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
            if (task.accountId && !accountConfig) invalid('任务绑定的账号配置不可用。');
            if (!previous.executionLimits) invalid('历史尝试缺少执行限制。');
            const [created] = await tx
              .insert(executionAttempts)
              .values({
                taskId,
                attemptNo: previous.attemptNo + 1,
                generation: task.workGeneration + 1,
                status: 'queued',
                executorMode: 'agent',
                simulationScenario: null,
                configVersion: accountConfig?.version ?? 1,
                executionLimits: this.options.executionLimits ?? previous.executionLimits,
                configSnapshot: {
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
                },
                requestedBy: actor.id,
                createdAt: now,
                nextRunAt: now,
                currentStep: '等待 Supervisor 判断研究任务',
              })
              .returning();
            if (!created) throw new Error('attempt insert failed');
            attempt = created;
            ordinal = 0;
            // The v14 live guard requires this pointer before authorization INSERT.
            await tx
              .update(tasks)
              .set({ currentAttemptId: attempt.id, workGeneration: attempt.generation })
              .where(eq(tasks.id, taskId));
            await invalidateApproval(tx, task, now, '重新执行研究，旧批准失效。');
          } else {
            this.waiting(task.workGeneration, previous, input.body.attemptId, [
              'awaiting_materials',
              'awaiting_content',
            ]);
            if (pending) invalid('当前尝试已有待用授权，请先处理当前操作。');
            const latest = steps
              .filter((s) => s.resultId !== null)
              .sort((a, b) => (b.resultVersion ?? 0) - (a.resultVersion ?? 0))[0];
            if (
              !latest ||
              latest.resultId !== input.body.baseResultId ||
              latest.status !== 'completed'
            )
              invalid('报告基版已变化，请重新读取当前最新报告。', 'body/baseResultId');
            const report = ResearchAcceptedResultSchema.parse(latest.validatedOutput);
            if (
              report.execution.taskId !== taskId ||
              report.execution.attemptId !== attempt.id ||
              report.selectedProject.selectionId !== selection.selectionId
            )
              invalid('研究报告归属不一致。');
            const questions = input.body.questionIds.map((id) =>
              report.report.questions.find((q) => q.id === id),
            );
            const gaps = input.body.gapIds.map((id) => report.report.gaps.find((g) => g.id === id));
            if (
              questions.some((q) => !q) ||
              gaps.some(
                (g) => !g || g.questionIds.some((id) => !input.body.questionIds.includes(id)),
              )
            )
              invalid('补查只能选择最新报告已有问题及其关联缺口。');
            supplementScope = {
              questions: questions.map((q) => ({
                id: q!.id,
                question: q!.question,
                severity: q!.severity,
                reason: q!.reason,
              })),
              gaps: gaps.map((g) => g!),
            };
            mode = 'supplement';
            baseResult = { id: report.id, version: report.version };
            submissionId = randomUUID();
            grants = input.body.officialSiteGrants;
            records = input.body.materials.map((m) => {
              const sourceId = randomUUID(),
                materialId = m.text === null ? null : randomUUID();
              return {
                clientRef: m.clientRef,
                record: ResearchSubmissionRecordSchema.parse({
                  source: {
                    id: sourceId,
                    label: m.label,
                    url: m.sourceUrl,
                    nature: 'user_provided',
                    author: null,
                    publishedAt: null,
                  },
                  material:
                    materialId === null
                      ? null
                      : {
                          id: materialId,
                          sourceId,
                          version: 1,
                          kind: 'pasted_text',
                          content: m.text,
                          assetIds: [],
                          segments: [],
                          framePositions: [],
                          capturedAt: now.toISOString(),
                          truncated: false,
                          coverage: null,
                          firstHandConfirmation: m.confirmFirstHand
                            ? {
                                userId: actor.id,
                                confirmedAt: now.toISOString(),
                                materialVersion: 1,
                              }
                            : null,
                        },
                  lineageRootMaterialId: materialId,
                  contentSha256: m.text === null ? null : contentHash(m.text),
                  previousMaterial: null,
                }),
              };
            });
            for (const confirm of input.body.confirmExistingMaterials) {
              const old = report.materials.find((m) => m.id === confirm.materialId);
              const source = old && report.sources.find((s) => s.id === old.sourceId);
              if (
                !old ||
                !source ||
                source.nature !== 'user_provided' ||
                old.kind !== 'pasted_text' ||
                !old.content ||
                old.version !== confirm.materialVersion ||
                contentHash(old.content) !== confirm.contentSha256
              )
                invalid('待确认资料不属于基版用户文本，或版本/哈希已变化。');
              const [stored] = await tx
                .select()
                .from(researchSubmissionMaterials)
                .where(
                  and(
                    eq(researchSubmissionMaterials.taskId, taskId),
                    eq(researchSubmissionMaterials.materialId, old.id),
                  ),
                );
              const root = stored?.lineageRootMaterialId ?? old.id;
              const [lastVersion] = await tx
                .select()
                .from(researchSubmissionMaterials)
                .where(
                  and(
                    eq(researchSubmissionMaterials.taskId, taskId),
                    eq(researchSubmissionMaterials.lineageRootMaterialId, root),
                  ),
                )
                .orderBy(desc(researchSubmissionMaterials.materialVersion))
                .limit(1);
              if (lastVersion && lastVersion.materialVersion !== old.version)
                invalid('资料已有新版本，请选择当前材料快照。');
              const version = old.version + 1;
              records.push({
                clientRef: null,
                record: ResearchSubmissionRecordSchema.parse({
                  source,
                  material: {
                    ...old,
                    id: randomUUID(),
                    version,
                    capturedAt: now.toISOString(),
                    firstHandConfirmation: {
                      userId: actor.id,
                      confirmedAt: now.toISOString(),
                      materialVersion: version,
                    },
                  },
                  lineageRootMaterialId: root,
                  contentSha256: confirm.contentSha256,
                  previousMaterial: {
                    materialId: old.id,
                    version: old.version,
                    contentSha256: confirm.contentSha256,
                  },
                }),
              });
            }
          }
        }
        const runtime = AgentConfigurationSchema.parse(
          attempt.configSnapshot.mode === 'agent'
            ? attempt.configSnapshot.configuration.runtime
            : null,
        );
        const taskInput = {
          title: task.title,
          originalRequest: task.originalRequest,
          inputRevision: task.revision,
          referenceInputs: task.referenceInputs,
          clarifications: attempt.clarifications,
        };
        const scope = ResearchAuthorizationScopeSchema.parse({
          schemaVersion: '1.0',
          taskId,
          attemptId: attempt.id,
          generation: attempt.generation,
          selection,
          mode,
          baseResult,
          taskInput: { ...taskInput, sha256: digest(taskInput) },
          researchMethod: { ...policy, configVersion: attempt.configVersion },
          supplementScope,
          submissionId,
          submissionRecordCount: records.length,
          materialRefs: records.flatMap(({ record }) =>
            record.material
              ? [
                  {
                    materialId: record.material.id,
                    version: record.material.version,
                    contentSha256: record.contentSha256,
                  },
                ]
              : [],
          ),
          sources: {
            repositoryUrl: selection.repositoryUrl,
            requiredSearchSites: ['bilibili', 'xiaohongshu', 'douyin'],
            officialSites: grants,
          },
          tools: ['WebSearch', 'WebFetch'],
          budget: {
            taskId,
            maxCostMicrosCny: budget.limits.maxCostMicrosCny,
            maxCalls: budget.limits.maxCalls,
            maxTokens: budget.limits.maxTokens,
            ...(runtime.research
              ? { webRequestMicrosCny: runtime.research.webRequestMicrosCny }
              : {}),
            pricing: runtime.pricing,
          },
        });
        await tx.insert(researchAuthorizations).values({
          id: authorizationId,
          taskId,
          attemptId: attempt.id,
          selectionId: selection.selectionId,
          mode,
          scope,
          baseResultId: baseResult?.id ?? null,
          authorizedBy: actor.id,
          authorizedAt: now,
        });
        if (input.operation === 'submitMaterialsAndAuthorizeResearch' && submissionId) {
          await tx.insert(researchSubmissions).values({
            id: submissionId,
            taskId,
            attemptId: attempt.id,
            authorizationId,
            baseResultId: input.body.baseResultId,
            questionIds: input.body.questionIds,
            gapIds: input.body.gapIds,
            officialSiteGrants: grants,
            submittedBy: actor.id,
            submittedAt: now,
          });
          if (records.length)
            await tx.insert(researchSubmissionMaterials).values(
              records.map(({ clientRef, record }) => ({
                id: randomUUID(),
                taskId,
                attemptId: attempt.id,
                submissionId,
                clientRef,
                sourceId: record.source.id,
                materialId: record.material?.id ?? null,
                materialVersion: record.material?.version ?? null,
                lineageRootMaterialId: record.lineageRootMaterialId,
                contentSha256: record.contentSha256,
                record,
                confirmedBy: record.material?.firstHandConfirmation?.userId ?? null,
                confirmedAt: record.material?.firstHandConfirmation ? now : null,
              })),
            );
        }
        await tx.insert(executionSteps).values({
          attemptId: attempt.id,
          ordinal,
          role: 'supervisor',
          status: 'queued',
          authorizationId,
          parentStepId: attempt.id === previous.id ? (steps.at(-1)?.id ?? null) : null,
          runtimeMetadata: {
            kind: 'supervisor',
            trigger:
              input.operation === 'selectProjectAndAuthorizeResearch'
                ? 'project_selected'
                : input.operation === 'retryResearchAndAuthorize'
                  ? 'research_retried'
                  : 'materials_submitted',
            authorizationId,
            submissionId,
          },
        });
        await tx
          .update(executionAttempts)
          .set({
            status: 'queued',
            currentStep: '等待 Supervisor 判断研究任务',
            nextRunAt: now,
            error: null,
          })
          .where(eq(executionAttempts.id, attempt.id));
        await tx
          .update(tasks)
          .set({
            executionStatus: 'queued',
            currentStep: '等待 Supervisor 判断研究任务',
            errorMessage: null,
            revision: task.revision + 1,
            updatedAt: now,
            ...(input.operation === 'retryResearchAndAuthorize'
              ? {
                  currentContentVersionId: null,
                  currentReviewCycleId: null,
                  currentApprovalId: null,
                  approvalStatus: task.currentApprovalId
                    ? ('invalidated' as const)
                    : ('not_requested' as const),
                }
              : {}),
          })
          .where(eq(tasks.id, taskId));
        const data: ResearchCommandResult = {
          task: await this.read(tx, taskId, actor),
          selection,
          authorization: {
            id: authorizationId,
            attemptId: attempt.id,
            mode,
            baseResultId: baseResult?.id ?? null,
            consumedAt: null,
          },
          submissionId,
        };
        await tx.insert(auditEvents).values({
          teamId: actor.teamId,
          taskId,
          actorType: 'member',
          actorId: actor.id,
          action: actions[operation],
          targetType: 'research_authorization',
          targetId: authorizationId,
          beforeRevision: task.revision,
          afterRevision: task.revision + 1,
          outcome: 'succeeded',
          reason: `${input.operation === 'retryResearchAndAuthorize' ? input.body.reason + '；' : ''}scope-sha256:${digest(scope)}`,
          requestId: input.requestId,
          createdAt: now,
        });
        if (existing)
          await tx.delete(idempotencyRecords).where(eq(idempotencyRecords.id, existing.id));
        await tx.insert(idempotencyRecords).values({
          scopeHash,
          keyHash,
          requestFingerprint: fingerprint,
          status: 'completed',
          responseStatus: 202,
          responseBody: data,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 86_400_000),
        });
        return { data, replayed: false };
      });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (databaseErrorCode(error) === '23505')
        throw new AuthError(409, 'INVALID_STATE', '研究动作已存在或状态已变化，请读取当前任务。');
      throw new AuthError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '研究操作暂不可用，请使用同一动作标识重试确认。',
      );
    }
  }

  private waiting(generation: number, attempt: Attempt, expectedId: string, statuses: string[]) {
    if (
      attempt.id !== expectedId ||
      attempt.generation !== generation ||
      !statuses.includes(attempt.status) ||
      attempt.cancelRequestedAt ||
      attempt.finishedAt ||
      attempt.executorId ||
      attempt.claimToken ||
      attempt.claimedAt ||
      attempt.heartbeatAt ||
      attempt.leaseExpiresAt ||
      attempt.activeSince ||
      attempt.nextRunAt
    )
      invalid('当前尝试不在可提交的等待状态，或执行权已变化。');
  }
}
