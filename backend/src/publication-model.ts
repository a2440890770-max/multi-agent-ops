import type { PublishOperation, VerificationRecord } from '@multi-agent-ops/shared';
import type { publicationDispatches, publicationOperations } from './schema.js';

export function publicationModel(
  operation: typeof publicationOperations.$inferSelect,
  dispatches: (typeof publicationDispatches.$inferSelect)[],
  verifications: VerificationRecord[] = [],
): PublishOperation {
  if (!dispatches.some((d) => d.id === operation.currentDispatchId))
    throw new Error('Publication dispatch is missing');
  return {
    id: operation.id,
    taskId: operation.taskId,
    contentVersionId: operation.contentVersionId,
    contentHash: operation.contentHash,
    accountId: operation.accountId,
    snapshot: operation.snapshot,
    status: operation.status,
    currentDispatchId: operation.currentDispatchId,
    dispatches: dispatches.map((d) => ({
      ...d,
      startedAt: d.startedAt.toISOString(),
      finishedAt: d.finishedAt?.toISOString() ?? null,
    })),
    verifications,
    createdBy: operation.createdBy,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
  };
}
