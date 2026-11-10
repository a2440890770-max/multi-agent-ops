import type {
  Account,
  AccountRegistration,
  Approval,
  AuditEvent,
  BlindItem,
  ConfigVersion,
  ContentVersion,
  Experiment,
  ManualDecision,
  Member,
  Memory,
  MemorySyncJob,
  PublishOperation,
  Reflection,
  ReviewCycle,
  Session,
  TaskDetail,
  TaskSummary,
  AgentStep,
  ExecutionAttempt,
  ExecutionCall,
  ExecutionBudget,
  ClarificationAnswer,
} from './domain.js';
import type { ApiError, Page, SaveContentResult, ResearchCommandResult } from './api.js';

/** OpenAPI response schemas are generated from this map; do not duplicate DTOs in the backend. */
export interface ResponseModels {
  Session: Session;
  Logout: { signedOut: true };
  Member: Member;
  Members: Page<Member>;
  Account: Account;
  AccountRegistration: AccountRegistration;
  ManualPublicationEntry: {
    account: Account;
    content: ContentVersion;
    approval: Approval;
    revision: number;
  };
  AuthorizationSession: { authorizationUrl: string; state: string; expiresAt: string };
  TaskDetail: TaskDetail;
  Tasks: Page<TaskSummary>;
  SaveContent: SaveContentResult;
  ResearchCommand: ResearchCommandResult;
  ResearchResult: import('./schemas/research.js').ResearchAcceptedResult;
  ResearchResults: Page<{
    id: string;
    attemptId: string;
    version: number;
    parentResultId: string | null;
    status: 'completed' | 'partial';
    summary: string;
    createdAt: string;
  }>;
  ResearchSubmission: {
    id: string;
    attemptId: string;
    authorizationId: string;
    baseResultId: string;
    questionIds: string[];
    gapIds: string[];
    officialSiteGrants: { origin: string; pathPrefix: string }[];
    submittedBy: string;
    submittedAt: string;
    records: import('./schemas/research-commands.js').ResearchSubmissionRecord[];
  };
  ContentVersion: ContentVersion;
  ContentVersions: Page<ContentVersion>;
  CompareVersions: {
    from: ContentVersion;
    to: ContentVersion;
    changes: { kind: 'equal' | 'insert' | 'delete'; text: string }[];
  };
  Review: ReviewCycle;
  Reviews: Page<ReviewCycle>;
  Decision: { decision: ManualDecision; task: TaskDetail };
  Decisions: Page<ManualDecision>;
  ApprovalResult: { approval: Approval; task: TaskDetail };
  Publication: { operation: PublishOperation; task: TaskDetail };
  Publications: Page<PublishOperation>;
  Memory: Memory;
  Memories: Page<Memory>;
  MemoryMutation: { memory: Memory; syncJob: MemorySyncJob };
  ConfirmedMemory: { candidate: Memory; confirmed: Memory; syncJob: MemorySyncJob };
  SyncJobs: Page<MemorySyncJob>;
  SyncJob: MemorySyncJob;
  Reflection: Reflection;
  Reflections: Page<Reflection>;
  Config: ConfigVersion;
  Experiments: Page<Experiment>;
  Experiment: Experiment;
  BlindItem: { item: BlindItem | null; remaining: number };
  BlindScore: { id: string; itemId: string; submittedAt: string };
  History: {
    attempts: ExecutionAttempt[];
    calls?: ExecutionCall[];
    budget?: ExecutionBudget | null;
    steps: AgentStep[];
    clarificationAnswers: ClarificationAnswer[];
    audit: Page<AuditEvent>;
  };
  ApiError: ApiError;
}
