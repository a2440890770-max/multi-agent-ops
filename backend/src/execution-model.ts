import type { AgentStep, ContentVersion, ExecutionAttempt } from '@multi-agent-ops/shared';
import { executionAttempts, executionSteps, taskContents } from './schema.js';

export const mockStages = [
  { role: 'supervisor', label: '检查原始要求' },
  { role: 'research', label: '模拟研究资料' },
  { role: 'content', label: '模拟生成文案' },
  { role: 'review', label: '模拟检查产出' },
] as const;
export const activeAttempt = (status: string) =>
  ['queued', 'running', 'awaiting_clarification'].includes(status);

export function attemptModel(row: typeof executionAttempts.$inferSelect): ExecutionAttempt {
  return {
    id: row.id,
    taskId: row.taskId,
    attemptNo: row.attemptNo,
    status: row.status,
    currentStep: row.currentStep,
    autoRevisionCount: row.autoRevisionCount,
    configVersion: row.configVersion,
    executorMode: row.executorMode,
    simulationScenario: row.simulationScenario,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    cancelScope: row.cancelScope,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    cancelRequestedBy: row.cancelRequestedBy,
    cancelReason: row.cancelReason,
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
    error: row.error,
    traceUrl: null,
  };
}

export function contentModel(row: typeof taskContents.$inferSelect): ContentVersion {
  return {
    id: row.id,
    taskId: row.taskId,
    originAttemptId: row.originAttemptId,
    parentVersionId: null,
    versionNo: row.versionNo,
    body: row.body,
    contentHash: row.contentHash,
    sourceKind: 'agent',
    revisionRoundId: null,
    sourceRefs: [],
    usedMemoryRefs: [],
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function stepModel(row: typeof executionSteps.$inferSelect, outputId?: string): AgentStep {
  return {
    id: row.id,
    attemptId: row.attemptId,
    reviewCycleId: null,
    role: row.role,
    status: row.status,
    inputVersionRefs: [],
    outputVersionRefs:
      row.role === 'content' && row.status === 'completed' && outputId ? [outputId] : [],
    sourceRefs: [],
    usedMemoryRefs: [],
    durationMs: row.durationMs,
    error: row.error,
    traceUrl: null,
  };
}
