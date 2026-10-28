import type { Id, TaskDetail, ContentVersion } from './domain.js';
import type { OperationBodies } from './generated/request-models.js';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'WORK_LOCKED'
  | 'PUBLICATION_LOCKED'
  | 'INVALID_STATE'
  | 'REVIEW_BLOCKED'
  | 'APPROVAL_INVALID'
  | 'ACCOUNT_UNAUTHORIZED'
  | 'RESULT_UNKNOWN'
  | 'RATE_LIMITED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'NOT_IMPLEMENTED';
export interface ApiSuccess<T> {
  data: T;
  meta: { requestId: string; replayed: boolean };
}
export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    fieldErrors: { field: string; message: string }[];
    conflict: {
      expectedRevision: number;
      actualRevision: number;
      currentContentVersionId: Id | null;
      latestVersionUrl: string | null;
      taskUrl: string;
    } | null;
    operationId: Id | null;
    dispatchId: Id | null;
  };
  meta: { requestId: string };
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface TaskCommand {
  expectedRevision: number;
}
export interface VersionCommand extends TaskCommand {
  contentVersionId: Id;
}
export type SaveContentRequest = OperationBodies['saveContent'];
export interface SaveContentResult {
  task: TaskDetail;
  content: ContentVersion;
  message: '新版本已保存，需要提交审核';
}
export type PublishRequest = OperationBodies['publishContent'];
export type VerificationRequest = OperationBodies['verifyPublication'];
