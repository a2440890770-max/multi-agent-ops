import { z } from 'zod';
import { AgentExecutionLeaseSchema } from './agent-service.js';
import {
  ExecutionRefSchema,
  ResearchContextSchema,
  ResearchAcceptedResultSchema,
} from './research.js';
import { ResearchWebSnapshotSchema } from './research-web.js';

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = {
  protocolVersion: z.literal(1),
  runId: z.uuid(),
  lease: AgentExecutionLeaseSchema,
  execution: ExecutionRefSchema,
  researchExecution: ExecutionRefSchema,
  authorizationId: z.uuid(),
  dispatchToolUseId: id,
  sdkSessionId: id,
};
export const ResearchExecutionCallbackSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...identity, operation: z.literal('claim'), context: ResearchContextSchema }),
  z.strictObject({ ...identity, operation: z.literal('start'), agentId: id }),
  z.strictObject({
    ...identity,
    operation: z.literal('registry'),
    agentId: id,
    registryRevision: z.int().positive(),
    snapshotHash: hash,
    snapshot: ResearchWebSnapshotSchema,
  }),
  z.strictObject({
    ...identity,
    operation: z.literal('result'),
    agentId: id,
    result: ResearchAcceptedResultSchema,
    snapshot: ResearchWebSnapshotSchema,
  }),
]);
export type ResearchExecutionCallback = z.infer<typeof ResearchExecutionCallbackSchema>;
