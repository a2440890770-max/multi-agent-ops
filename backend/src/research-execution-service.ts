import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  ResearchExecutionCallbackSchema,
  ResearchAuthorizationScopeSchema,
  SupervisorContextSchema,
  ResearchContextSchema,
  ResearchWebSnapshotSchema,
  validateResearchContext,
  validateResearchResult,
  type ResearchExecutionCallback,
  type ResearchContext,
  type ResearchWebSnapshot,
} from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import { executionNow } from './execution-ownership.js';
import { AgentConfigurationSchema } from './agent-execution-config.js';
import {
  executionAttempts,
  executionSteps,
  executionCalls,
  researchAuthorizations,
  researchRegistries,
  tasks,
  auditEvents,
} from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const researchPayloadHash = (value: unknown) =>
  createHash('sha256').update(stable(value)).digest('hex');
const textHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Private callbacks are fenced in the database; the Agent process has no database credentials. */
export class ResearchExecutionService {
  constructor(
    private db: Database,
    private onRejected?: (error: unknown) => void,
  ) {}

  async handle(
    value: unknown,
  ): Promise<{ accepted: boolean; replayed?: boolean; execute?: boolean }> {
    const parsed = ResearchExecutionCallbackSchema.safeParse(value);
    if (!parsed.success) return { accepted: false };
    const request = parsed.data;
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
        const [task] = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, request.execution.taskId))
          .for('update');
        const [attempt] = await tx
          .select()
          .from(executionAttempts)
          .where(
            and(
              eq(executionAttempts.id, request.execution.attemptId),
              eq(executionAttempts.taskId, request.execution.taskId),
            ),
          )
          .for('update');
        const [parent] = await tx
          .select()
          .from(executionSteps)
          .where(
            and(
              eq(executionSteps.id, request.execution.stepId),
              eq(executionSteps.attemptId, request.execution.attemptId),
            ),
          )
          .for('update');
        requireThat(task && attempt && parent, 'missing execution');
        const context = SupervisorContextSchema.parse(parent.frozenInput);
        const [child] = await tx
          .select()
          .from(executionSteps)
          .where(
            and(
              eq(executionSteps.id, request.researchExecution.stepId),
              eq(executionSteps.attemptId, attempt.id),
            ),
          )
          .for('update');
        const [auth] = await tx
          .select()
          .from(researchAuthorizations)
          .where(
            and(
              eq(researchAuthorizations.id, request.authorizationId),
              eq(researchAuthorizations.taskId, task.id),
              eq(researchAuthorizations.attemptId, attempt.id),
            ),
          )
          .for('update');
        requireThat(
          auth &&
            same(request.execution, context.execution) &&
            context.researchContext.authorizationId === auth.id &&
            request.researchExecution.taskId === task.id &&
            request.researchExecution.attemptId === attempt.id &&
            request.researchExecution.inputSnapshotId === context.execution.inputSnapshotId &&
            request.researchExecution.stepId === context.researchContext.inputs?.stepId,
          'callback ownership',
        );
        const scope = ResearchAuthorizationScopeSchema.parse(auth.scope);
        requireThat(
          scope.generation === attempt.generation &&
            scope.selection.selectionId === auth.selectionId,
          'scope generation',
        );
        const childIdentity =
          !!child &&
          child.role === 'research' &&
          child.authorizationId === auth.id &&
          child.parentStepId === parent.id &&
          child.runtimeMetadata?.parentRunId === request.runId &&
          child.runtimeMetadata?.dispatchToolUseId === request.dispatchToolUseId &&
          child.runtimeMetadata?.sdkSessionId === request.sdkSessionId &&
          child.runtimeMetadata?.leaseHash === researchPayloadHash(request.lease);
        // Completed receipts may be read after lease release; they never grant execution again.
        if (request.operation === 'result' && childIdentity && child!.validatedOutput) {
          requireThat(
            child!.runtimeMetadata?.agentId === request.agentId &&
              child!.runtimeMetadata?.acceptedResultHash === researchPayloadHash(request.result),
            'different result replay',
          );
          return { accepted: true, replayed: true, execute: false };
        }
        if (request.operation === 'claim' && childIdentity && auth.consumedByStepId === child!.id) {
          requireThat(same(child!.frozenInput, request.context), 'different claim replay');
          return { accepted: true, replayed: true, execute: false };
        }
        const now = await executionNow(tx);
        const [call] = await tx
          .select()
          .from(executionCalls)
          .where(
            and(
              eq(executionCalls.id, request.runId),
              eq(executionCalls.stepId, parent.id),
              eq(executionCalls.attemptId, attempt.id),
            ),
          )
          .for('update');
        requireThat(
          task.lifecycle === 'open' &&
            !task.activePublishOperationId &&
            !task.publishedOperationId &&
            task.currentAttemptId === attempt.id &&
            task.workGeneration === attempt.generation &&
            attempt.executorMode === 'agent' &&
            attempt.status === 'running' &&
            !attempt.cancelRequestedAt &&
            attempt.executorId === request.lease.executorId &&
            attempt.claimToken === request.lease.claimToken &&
            attempt.generation === request.lease.generation &&
            attempt.leaseExpiresAt &&
            attempt.leaseExpiresAt > now &&
            parent.status === 'running' &&
            parent.runtimeMetadata?.agentDispatchClaimed === true &&
            call &&
            call.status === 'running' &&
            call.kind === 'model' &&
            call.deadlineAt > now,
          'execution authority lost',
        );
        requireThat(
          call.sdkSessionId === null || call.sdkSessionId === request.sdkSessionId,
          'SDK session mismatch',
        );
        if (call.sdkSessionId === null)
          await tx
            .update(executionCalls)
            .set({ sdkSessionId: request.sdkSessionId })
            .where(eq(executionCalls.id, call.id));
        const config = AgentConfigurationSchema.parse(
          attempt.configSnapshot.mode === 'agent'
            ? attempt.configSnapshot.configuration.runtime
            : null,
        );
        requireThat(config.research, 'research not configured');
        if (request.operation === 'claim') {
          requireThat(
            !child && !auth.consumedAt && !auth.consumedByStepId,
            'authorization already consumed',
          );
          const inputs = context.researchContext.inputs!;
          const latest = await this.latest(tx, attempt.id);
          requireThat(auth.baseResultId === (latest?.id ?? null), 'stale research base');
          const expected = validateResearchContext(
            ResearchContextSchema.parse({
              schemaVersion: '1.0',
              execution: request.researchExecution,
              authorization: { id: auth.id, mode: auth.mode },
              selectedProject: scope.selection,
              request: request.context.request,
              contentContext: inputs.contentContext,
              referenceMaterials: inputs.referenceMaterials,
              previousReport: auth.mode === 'supplement' ? latest : null,
              supplementScope: inputs.supplementScope,
              runtimeContext: inputs.runtimeContext,
            }),
          );
          requireThat(same(expected, request.context), 'unfrozen research context');
          const topic = expected.request.topic.toLowerCase();
          requireThat(
            topic.includes(scope.selection.name.toLowerCase()) ||
              topic.includes(
                new URL(scope.selection.repositoryUrl).pathname.slice(1).toLowerCase(),
              ),
            'unrelated project topic',
          );
          if (scope.supplementScope)
            requireThat(
              same(
                expected.request.questions.map((q) => q.id).sort(),
                scope.supplementScope.questions.map((q) => q.id).sort(),
              ),
              'expanded supplement',
            );
          const [last] = await tx
            .select({ ordinal: executionSteps.ordinal })
            .from(executionSteps)
            .where(eq(executionSteps.attemptId, attempt.id))
            .orderBy(desc(executionSteps.ordinal))
            .limit(1);
          await tx.insert(executionSteps).values({
            id: expected.execution.stepId,
            attemptId: attempt.id,
            ordinal: (last?.ordinal ?? -1) + 1,
            role: 'research',
            status: 'running',
            parentStepId: parent.id,
            authorizationId: auth.id,
            inputSnapshotId: expected.execution.inputSnapshotId,
            frozenInput: expected,
            startedAt: now,
            runtimeMetadata: {
              kind: 'research',
              parentRunId: call.id,
              dispatchToolUseId: request.dispatchToolUseId,
              sdkSessionId: request.sdkSessionId,
              leaseHash: researchPayloadHash(request.lease),
            },
          });
          const updated = await tx
            .update(researchAuthorizations)
            .set({ consumedAt: now, consumedByStepId: expected.execution.stepId })
            .where(
              and(
                eq(researchAuthorizations.id, auth.id),
                isNull(researchAuthorizations.consumedAt),
              ),
            )
            .returning({ id: researchAuthorizations.id });
          requireThat(updated.length === 1, 'authorization claim failed');
          await tx.insert(auditEvents).values({
            teamId: task.teamId,
            taskId: task.id,
            actorType: 'worker',
            actorId: attempt.executorId,
            action: 'research.authorization_consumed',
            targetType: 'research_authorization',
            targetId: auth.id,
            outcome: 'succeeded',
            requestId: `research-claim:${call.id}`,
            createdAt: now,
          });
          return { accepted: true, replayed: false, execute: true };
        }
        requireThat(
          childIdentity &&
            child!.status === 'running' &&
            auth.consumedByStepId === child!.id &&
            auth.consumedAt,
          'invalid research step',
        );
        if (request.operation === 'start') {
          requireThat(
            !child!.runtimeMetadata?.agentId || child!.runtimeMetadata.agentId === request.agentId,
            'different subagent',
          );
          await tx
            .update(executionSteps)
            .set({ runtimeMetadata: { ...child!.runtimeMetadata, agentId: request.agentId } })
            .where(eq(executionSteps.id, child!.id));
          return { accepted: true };
        }
        requireThat(child!.runtimeMetadata?.agentId === request.agentId, 'unknown subagent');
        const research = validateResearchContext(child!.frozenInput);
        const [registry] = await tx
          .select()
          .from(researchRegistries)
          .where(eq(researchRegistries.authorizationId, auth.id))
          .for('update');
        const snapshot = ResearchWebSnapshotSchema.parse(request.snapshot);
        this.validateSnapshot(
          snapshot,
          research,
          scope.sources.officialSites.map((g) => ({
            ...g,
            approvedBy: 'user_confirmation',
            approvalRef: auth.id,
          })),
          registry?.snapshot,
          config.research.webConfig,
        );
        if (request.operation === 'registry') {
          requireThat(
            request.snapshotHash === researchPayloadHash(snapshot),
            'snapshot hash mismatch',
          );
          if (registry && request.registryRevision === registry.registryRevision) {
            requireThat(same(registry.snapshot, snapshot), 'different registry replay');
            return { accepted: true, replayed: true };
          }
          requireThat(
            request.registryRevision === (registry?.registryRevision ?? 0) + 1,
            'registry revision conflict',
          );
          await this.saveRegistry(tx, request, snapshot, request.registryRevision, registry?.id);
          return { accepted: true };
        }
        requireThat(
          auth.baseResultId === ((await this.latest(tx, attempt.id))?.id ?? null),
          'result base changed',
        );
        const result = validateResearchResult(request.result, research);
        requireThat(
          result.metadata.parentToolUseId === request.dispatchToolUseId &&
            result.metadata.promptVersion === scope.researchMethod.promptVersion &&
            result.metadata.toolPolicyVersion === scope.researchMethod.toolPolicyVersion &&
            same(
              result.metadata.skills,
              scope.researchMethod.skills.map(({ name, version }) => ({ name, version })),
            ) &&
            same(
              result.sources,
              snapshot.sources.map((s) => s.source),
            ) &&
            same(
              result.materials,
              snapshot.materials.map((m) => m.material),
            ),
          'result/registry metadata mismatch',
        );
        requireThat(!snapshot.calls.some((c) => c.status === 'running'), 'unfinished tools');
        const expectedCalls = snapshot.calls
          .filter((c) => c.countsTowardLimit)
          .map((c) => ({
            id: c.id,
            toolUseId: c.toolUseId,
            toolName: c.toolName,
            site: c.site,
            query: c.query,
            sourceId: c.sourceId,
            status: c.status,
            errorCode: c.errorCode,
            startedAt: c.startedAt,
            finishedAt: c.finishedAt,
          }));
        requireThat(same(result.toolAttempts, expectedCalls), 'tool records mismatch');
        await this.saveRegistry(
          tx,
          request,
          snapshot,
          (registry?.registryRevision ?? 0) + 1,
          registry?.id,
        );
        await tx
          .update(executionSteps)
          .set({
            status: 'completed',
            validatedOutput: result,
            resultId: result.id,
            resultVersion: result.version,
            parentResultId: result.parentResultId,
            finishedAt: now,
            durationMs: Math.max(0, now.getTime() - child!.startedAt!.getTime()),
            runtimeMetadata: {
              ...child!.runtimeMetadata,
              acceptedResultHash: researchPayloadHash(result),
            },
          })
          .where(eq(executionSteps.id, child!.id));
        await tx.insert(auditEvents).values({
          teamId: task.teamId,
          taskId: task.id,
          actorType: 'worker',
          actorId: attempt.executorId,
          action: 'research.result_accepted',
          targetType: 'research_result',
          targetId: result.id,
          outcome: 'succeeded',
          requestId: `research-result:${result.id}`,
          createdAt: now,
        });
        return { accepted: true, replayed: false };
      });
    } catch (error) {
      try {
        this.onRejected?.(error);
      } catch {
        /* Observation never changes the decision. */
      }
      return { accepted: false };
    }
  }

  private async latest(tx: Transaction, attemptId: string) {
    const [row] = await tx
      .select()
      .from(executionSteps)
      .where(
        and(eq(executionSteps.attemptId, attemptId), sql`${executionSteps.resultId} IS NOT NULL`),
      )
      .orderBy(desc(executionSteps.resultVersion))
      .limit(1);
    return row?.validatedOutput && 'report' in row.validatedOutput ? row.validatedOutput : null;
  }
  private async saveRegistry(
    tx: Transaction,
    request: ResearchExecutionCallback,
    snapshot: ResearchWebSnapshot,
    registryRevision: number,
    id?: string,
  ) {
    if (id)
      await tx
        .update(researchRegistries)
        .set({ snapshot, registryRevision })
        .where(eq(researchRegistries.id, id));
    else
      await tx.insert(researchRegistries).values({
        taskId: request.execution.taskId,
        attemptId: request.execution.attemptId,
        stepId: request.researchExecution.stepId,
        authorizationId: request.authorizationId,
        inputSnapshotId: request.researchExecution.inputSnapshotId,
        snapshot,
        registryRevision,
      });
  }
  private validateSnapshot(
    snapshot: ResearchWebSnapshot,
    context: ResearchContext,
    officialSites: unknown,
    previous?: ResearchWebSnapshot,
    webConfig?: Omit<ResearchWebSnapshot['policy']['config'], 'root'>,
  ) {
    requireThat(
      same(snapshot.execution, context.execution) &&
        snapshot.authorizationId === context.authorization.id &&
        same(snapshot.selectedProject, context.selectedProject) &&
        same(snapshot.policy.officialSites, officialSites),
      'registry ownership',
    );
    requireThat(
      snapshot.policy.config.maxSearchCalls <= context.runtimeContext.limits.maxSearchCalls &&
        snapshot.policy.config.maxFetchCalls <= context.runtimeContext.limits.maxFetchCalls,
      'expanded web limits',
    );
    if (webConfig) {
      const actual = Object.fromEntries(
        Object.entries(snapshot.policy.config).filter(([key]) => key !== 'root'),
      );
      requireThat(
        same(actual, {
          ...webConfig,
          maxSearchCalls: Math.min(
            webConfig.maxSearchCalls,
            context.runtimeContext.limits.maxSearchCalls,
          ),
          maxFetchCalls: Math.min(
            webConfig.maxFetchCalls,
            context.runtimeContext.limits.maxFetchCalls,
          ),
        }),
        'web configuration changed',
      );
    }
    const grantList = officialSites as { origin: string; pathPrefix: string }[];
    const repository = new URL(context.selectedProject.repositoryUrl),
      repoPath = repository.pathname.replace(/\/$/, '');
    const inPath = (path: string, prefix: string) =>
      prefix === '/' ||
      path === prefix.replace(/\/$/, '') ||
      path.startsWith(prefix.replace(/\/$/, '') + '/');
    const official = (raw: string) => {
      const url = new URL(raw);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        ((['github.com', 'raw.githubusercontent.com'].includes(url.hostname) &&
          inPath(url.pathname, repoPath)) ||
          grantList.some((g) => url.origin === g.origin && inPath(url.pathname, g.pathPrefix)))
      );
    };
    const platform = (raw: string) => {
      const host = new URL(raw).hostname;
      return [
        'bilibili.com',
        'b23.tv',
        'xiaohongshu.com',
        'xhslink.com',
        'douyin.com',
        'iesdouyin.com',
      ].some((h) => host === h || host.endsWith('.' + h));
    };
    const seededSources = [
      ...context.referenceMaterials.sources,
      ...(context.previousReport?.sources ?? []),
    ];
    const seededMaterials = [
      ...context.referenceMaterials.materials,
      ...(context.previousReport?.materials ?? []),
    ];
    for (const { source } of snapshot.sources)
      if (!seededSources.some((s) => s.id === source.id))
        requireThat(
          source.url &&
            (source.nature === 'primary'
              ? official(source.url)
              : source.nature === 'third_party'
                ? platform(source.url)
                : source.nature === 'unknown'),
          'unregistered source provenance',
        );
    for (const key of ['sources', 'materials', 'calls'] as const) {
      const ids = snapshot[key].map((r) =>
        'source' in r ? r.source.id : 'material' in r ? r.material.id : r.id,
      );
      requireThat(new Set(ids).size === ids.length, 'duplicate registry IDs');
    }
    requireThat(
      new Set(snapshot.calls.map((c) => c.toolUseId)).size === snapshot.calls.length,
      'duplicate tool IDs',
    );
    for (const record of snapshot.materials) {
      requireThat(
        snapshot.sources.some((s) => s.source.id === record.material.sourceId) &&
          record.contentSha256 ===
            textHash(record.material.content ?? JSON.stringify(record.material.assetIds)) &&
          ['pasted_text', 'webpage_text', 'search_snippet', 'sdk_processed'].includes(
            record.material.kind,
          ),
        'invalid text material',
      );
      if (!seededMaterials.some((m) => m.id === record.material.id)) {
        const call = snapshot.calls.find(
          (c) =>
            c.toolUseId === record.toolUseId &&
            c.countsTowardLimit &&
            c.materialIds.includes(record.material.id),
        );
        requireThat(call && call.status !== 'running', 'material without completed tool record');
        requireThat(
          record.material.firstHandConfirmation === null,
          'tool cannot confirm user material',
        );
        if (record.material.kind === 'webpage_text')
          requireThat(
            call.toolName === 'WebFetch' &&
              record.method === 'independent_body' &&
              record.responseSha256 &&
              record.finalUrl &&
              (official(record.finalUrl) || platform(record.finalUrl)) &&
              record.redirects.every((url) => official(url) || platform(url)),
            'unverified fetched original',
          );
        else
          requireThat(
            (record.material.kind === 'sdk_processed' &&
              call.toolName === 'WebFetch' &&
              record.method === 'sdk_processed') ||
              (record.material.kind === 'search_snippet' &&
                call.toolName === 'WebSearch' &&
                record.method === 'search_snippet'),
            'tool material kind mismatch',
          );
      }
    }
    for (const call of snapshot.calls.filter((c) => c.countsTowardLimit)) {
      requireThat(
        call.sourceIds.every((id) => snapshot.sources.some((s) => s.source.id === id)) &&
          call.materialIds.every((id) => snapshot.materials.some((m) => m.material.id === id)),
        'invalid call references',
      );
      if (call.toolName === 'WebFetch') {
        const source = snapshot.sources.find((s) => s.source.id === call.sourceId)?.source;
        requireThat(
          source?.url && (official(source.url) || platform(source.url)),
          'fetch outside current grant',
        );
      }
    }
    const search = snapshot.calls.filter(
      (c) => c.toolName === 'WebSearch' && c.countsTowardLimit,
    ).length;
    const fetch = snapshot.calls.filter(
      (c) => c.toolName === 'WebFetch' && c.countsTowardLimit,
    ).length;
    requireThat(
      search <= context.runtimeContext.limits.maxSearchCalls &&
        fetch <= context.runtimeContext.limits.maxFetchCalls,
      'web quota exceeded',
    );
    if (previous) {
      for (const source of previous.sources)
        requireThat(
          snapshot.sources.some((s) => same(source, s)),
          'source history changed',
        );
      for (const material of previous.materials)
        requireThat(
          snapshot.materials.some((m) => same(material, m)),
          'material history changed',
        );
      for (const old of previous.calls) {
        const call = snapshot.calls.find((c) => c.id === old.id);
        requireThat(call, 'call history lost');
        if (old.status !== 'running') requireThat(same(old, call), 'terminal call changed');
        else
          for (const key of [
            'id',
            'toolUseId',
            'toolName',
            'query',
            'site',
            'sourceId',
            'startedAt',
            'deadlineAt',
            'countsTowardLimit',
          ] as const)
            requireThat(same(old[key], call[key]), 'call identity changed');
      }
    }
    for (const source of [
      ...context.referenceMaterials.sources,
      ...(context.previousReport?.sources ?? []),
    ])
      requireThat(
        snapshot.sources.some((s) => same(s.source, source)),
        'input source changed',
      );
    for (const material of [
      ...context.referenceMaterials.materials,
      ...(context.previousReport?.materials ?? []),
    ])
      requireThat(
        snapshot.materials.some((m) => same(m.material, material)),
        'input material changed',
      );
  }
}
