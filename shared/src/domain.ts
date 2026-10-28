/** D1 wire types. IDs are opaque; all timestamps are ISO 8601 UTC. */
export type Id = string;
export type Timestamp = string;
export type Role = 'admin' | 'operator';
export const permissions = {
  admin: [
    'tasks:write',
    'approval:write',
    'publish:write',
    'memory:write',
    'evaluation:write',
    'settings:write',
  ],
  operator: ['tasks:write', 'approval:write', 'publish:write', 'memory:write', 'evaluation:write'],
} as const;
export type Permission = (typeof permissions.admin)[number];
export type Lifecycle = 'open' | 'terminated' | 'published';
export type ExecutionStatus =
  | 'awaiting_clarification'
  | 'queued'
  | 'running'
  | 'manual_required'
  | 'ready'
  | 'failed'
  | 'cancelled';
export type ApprovalState = 'not_requested' | 'pending' | 'approved' | 'invalidated';
export type PublicationStatus =
  'awaiting_manual' | 'publishing' | 'verification_required' | 'published' | 'failed';
export type ReviewStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ReviewOutcome = 'pass' | 'changes_required' | 'manual_required';
export type ReflectionStatus = 'processing' | 'completed' | 'failed';
export type MemoryType = 'account_preference' | 'task_fact' | 'candidate' | 'confirmed_experience';
export type MemoryStatus = 'active' | 'disabled' | 'deleted';
export type MemoryPurpose = 'creation' | 'reflection' | 'experiment' | 'management';
export type SyncStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface Member {
  id: Id;
  teamId: Id;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
  version: number;
}
export interface Session {
  member: Member;
  permissions: Permission[];
  csrfToken: string;
  expiresAt: Timestamp;
}
export interface Account {
  id: Id;
  displayName: string;
  platform: 'weibo';
  authorizationStatus: 'unconfigured' | 'valid' | 'expired';
  officialPublishAvailable: boolean;
}
export interface Failure {
  code: string;
  message: string;
  retryable: boolean;
}
export interface SourceRef {
  id: Id;
  label: string;
  url: string | null;
}
export interface MemoryRef {
  id: Id;
  version: number;
}
export interface Clarification {
  questionId: Id;
  question: string;
  answer: string | null;
}
export interface Task {
  id: Id;
  teamId: Id;
  accountId: Id;
  title: string;
  originalRequest: string;
  referenceInputs: SourceRef[];
  clarifications: Clarification[];
  lifecycle: Lifecycle;
  revision: number;
  currentAttemptId: Id | null;
  currentContentVersionId: Id | null;
  currentReviewCycleId: Id | null;
  currentApprovalId: Id | null;
  activePublishOperationId: Id | null;
  publishedOperationId: Id | null;
  sourceTaskId: Id | null;
  createdBy: Id;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  terminatedBy: Id | null;
  terminatedAt: Timestamp | null;
  terminationReason: string | null;
}
export interface ExecutionAttempt {
  id: Id;
  taskId: Id;
  attemptNo: number;
  status: ExecutionStatus;
  currentStep: string | null;
  autoRevisionCount: number;
  configVersion: number;
  requestedBy: Id;
  createdAt: Timestamp;
  cancelScope: 'stop_attempt' | 'terminate_task' | null;
  cancelRequestedAt: Timestamp | null;
  cancelRequestedBy: Id | null;
  cancelReason: string | null;
  stoppedAt: Timestamp | null;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  error: Failure | null;
  traceUrl: string | null;
}
export interface ContentVersion {
  id: Id;
  taskId: Id;
  originAttemptId: Id | null;
  parentVersionId: Id | null;
  versionNo: number;
  body: string;
  contentHash: string;
  sourceKind: 'agent' | 'manual';
  revisionRoundId: Id | null;
  sourceRefs: SourceRef[];
  usedMemoryRefs: MemoryRef[];
  createdBy: Id;
  createdAt: Timestamp;
}
export interface ReviewIssue {
  id: Id;
  kind: 'deterministic' | 'factual' | 'subjective';
  message: string;
  resolved: boolean;
}
export interface ReviewRecord {
  id: Id;
  cycleId: Id;
  contentVersionId: Id;
  outcome: ReviewOutcome;
  checks: string[];
  blockingIssues: ReviewIssue[];
  scores: { name: string; value: number; source: 'model' | 'human' | 'rule' }[];
  sourceRefs: SourceRef[];
  createdAt: Timestamp;
}
export interface ReviewCycle {
  id: Id;
  taskId: Id;
  attemptId: Id | null;
  trigger: 'initial_generation' | 'manual_submit';
  inputVersionId: Id;
  currentVersionId: Id;
  status: ReviewStatus;
  records: ReviewRecord[];
  requestedBy: Id;
  configVersion: number;
  createdAt: Timestamp;
  finishedAt: Timestamp | null;
  error: Failure | null;
}
export interface ManualDecision {
  id: Id;
  reviewRecordId: Id;
  actorId: Id;
  reason: string;
  acceptedIssues: Id[];
  unresolvedIssues: Id[];
  evidenceRefs: SourceRef[];
  createdAt: Timestamp;
}
export interface Approval {
  id: Id;
  taskId: Id;
  contentVersionId: Id;
  contentHash: string;
  accountId: Id;
  reviewCycleId: Id;
  status: 'approved' | 'invalidated';
  approvedBy: Id;
  approvedAt: Timestamp;
  invalidatedAt: Timestamp | null;
  invalidatedReason: string | null;
}
export type PublishChannel = 'official_api' | 'manual';
export interface PublishDispatch {
  id: Id;
  operationId: Id;
  dispatchNo: number;
  approvalId: Id;
  channel: PublishChannel;
  status: PublicationStatus;
  startedBy: Id;
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
  providerRequestId: string | null;
  platformPostId: string | null;
  url: string | null;
  error: Failure | null;
}
export interface VerificationRecord {
  id: Id;
  operationId: Id;
  dispatchId: Id;
  actorId: Id;
  accountId: Id;
  contentVersionId: Id;
  method: 'official_query' | 'manual';
  conclusion: 'published' | 'not_published' | 'unknown';
  platformPostId: string | null;
  url: string | null;
  evidenceRefs: SourceRef[];
  observedContentHash: string | null;
  mismatchNote: string | null;
  createdAt: Timestamp;
}
export interface PublishOperation {
  id: Id;
  taskId: Id;
  contentVersionId: Id;
  contentHash: string;
  accountId: Id;
  status: PublicationStatus;
  currentDispatchId: Id;
  dispatches: PublishDispatch[];
  verifications: VerificationRecord[];
  createdBy: Id;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export interface Memory {
  id: Id;
  teamId: Id;
  accountId: Id;
  type: MemoryType;
  body: string | null;
  version: number;
  status: MemoryStatus;
  scope: string;
  sourceTaskId: Id | null;
  sourceVersionId: Id | null;
  sourceReflectionId: Id | null;
  sourceCandidateId: Id | null;
  evidenceRefs: SourceRef[];
  uncertainties: string[];
  confirmedBy: Id | null;
  confirmedAt: Timestamp | null;
  confirmationReason: string | null;
  syncStatus: SyncStatus;
  deletedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export interface MemorySyncJob {
  id: Id;
  memoryId: Id;
  targetVersion: number;
  action: 'upsert' | 'disable' | 'delete';
  status: SyncStatus;
  targetScopes: string[];
  attemptCount: number;
  lastError: Failure | null;
  createdAt: Timestamp;
  finishedAt: Timestamp | null;
}
export interface Reflection {
  id: Id;
  taskId: Id;
  attemptId: Id;
  retryOfReflectionId: Id | null;
  status: ReflectionStatus;
  requestedBy: Id;
  inputSnapshotRefs: Id[];
  evidenceRefs: SourceRef[];
  observations: string[];
  hypotheses: string[];
  alternativeExplanations: string[];
  suggestedValidation: { id: Id; text: string }[];
  uncertainties: string[];
  candidateMemoryIds: Id[];
  error: Failure | null;
  createdAt: Timestamp;
  finishedAt: Timestamp | null;
}
export interface AgentStep {
  id: Id;
  attemptId: Id;
  reviewCycleId: Id | null;
  role: 'supervisor' | 'research' | 'content' | 'review';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  inputVersionRefs: Id[];
  outputVersionRefs: Id[];
  sourceRefs: SourceRef[];
  usedMemoryRefs: MemoryRef[];
  durationMs: number | null;
  error: Failure | null;
  traceUrl: string | null;
}
export interface WorkLock {
  ownerType: 'attempt' | 'manual_review';
  ownerId: Id;
  generation: number;
  cancelRequested: boolean;
}
export interface AuditEvent {
  id: Id;
  teamId: Id;
  taskId: Id | null;
  actorType: 'member' | 'worker' | 'system';
  actorId: Id;
  action: string;
  targetType: string;
  targetId: Id;
  beforeRevision: number | null;
  afterRevision: number | null;
  outcome: 'succeeded' | 'rejected' | 'failed';
  reason: string | null;
  evidenceRefs: SourceRef[];
  createdAt: Timestamp;
}
export type TaskAction =
  | 'save'
  | 'start'
  | 'stop'
  | 'terminate'
  | 'retry'
  | 'copy'
  | 'review'
  | 'approve'
  | 'publish'
  | 'backfill'
  | 'verify'
  | 'retry_publish'
  | 'reflect';
export interface ActionAvailability {
  allowed: boolean;
  reason: string | null;
}
export interface TaskSummary {
  task: Task;
  execution: ExecutionStatus | null;
  approval: ApprovalState;
  publication: PublicationStatus | 'not_published';
  reflection: ReflectionStatus | 'not_triggered';
  currentStep: string | null;
}
export interface TaskDetail extends TaskSummary {
  currentAttempt: ExecutionAttempt | null;
  currentContent: ContentVersion | null;
  currentReview: ReviewCycle | null;
  currentApproval: Approval | null;
  currentPublication: PublishOperation | null;
  latestReflection: Reflection | null;
  workLock: WorkLock | null;
  actions: Record<TaskAction, ActionAvailability>;
  account: Account;
}
export interface ConfigVersion {
  version: number;
  accountId: Id;
  profile: string;
  tone: string;
  forbiddenTopics: string[];
  rules: { id: Id; description: string; deterministic: boolean }[];
  modelRef: string;
  promptVersion: string;
  toolVersion: string;
  maxAutoRevisions: 3;
  updatedBy: Id;
  updatedAt: Timestamp;
}
export interface Experiment {
  id: Id;
  title: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  configVersion: number;
  datasetVersion: string;
  offline: true;
  sampleCount: number;
  failedSampleCount: number;
  quality: number | null;
  cost: number | null;
  durationMs: number | null;
  limitations: string[];
  traceUrl: string | null;
}
/** No arm labels, model names, trace links or strategy identity before blind scoring. */
export interface BlindItem {
  id: Id;
  experimentId: Id;
  version: number;
  prompt: string;
  choices: { id: Id; body: string }[];
}
