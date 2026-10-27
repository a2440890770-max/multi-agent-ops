import type {
  Account,
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
} from './domain.js';
import type { ApiError, Page, SaveContentResult } from './api.js';

/** OpenAPI response schemas are generated from this map; do not duplicate DTOs in the backend. */
export interface ResponseModels {
  Session: Session;
  Logout: { signedOut: true };
  Member: Member;
  Members: Page<Member>;
  Account: Account;
  AuthorizationSession: { authorizationUrl: string; state: string; expiresAt: string };
  TaskDetail: TaskDetail;
  Tasks: Page<TaskSummary>;
  SaveContent: SaveContentResult;
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
  Approval: { approval: Approval; task: TaskDetail };
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
  History: { attempts: ExecutionAttempt[]; steps: AgentStep[]; audit: Page<AuditEvent> };
  ApiError: ApiError;
}
