import { and, desc, eq, lt, isNotNull } from 'drizzle-orm';
import {
  ResearchAcceptedResultSchema,
  ResearchSubmissionRecordSchema,
  type OperationQueries,
  type ResponseModels,
  type Session,
  type TaskDetail,
} from '@multi-agent-ops/shared';
import { createHash } from 'node:crypto';
import type { createBusinessDatabase } from './database.js';
import {
  executionAttempts,
  executionSteps,
  researchSubmissions,
  researchSubmissionMaterials,
} from './schema.js';
import { AuthError } from './auth.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Context = { taskId: string; actor: Session['member'] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new AuthError(404, 'NOT_FOUND', '研究记录不存在或不可访问。');
export class ResearchReadService {
  constructor(
    private db: Database,
    private read: (input: Context) => Promise<TaskDetail>,
  ) {}
  async list(
    input: Context & { query: OperationQueries['listResearchResults'] },
  ): Promise<ResponseModels['ResearchResults']> {
    const detail = await this.read(input);
    const attemptId = input.query.attemptId ?? detail.task.currentAttemptId;
    if (!attemptId) return { items: [], nextCursor: null };
    if (!uuid.test(attemptId)) throw notFound();
    const [attempt] = await this.db
      .select({ id: executionAttempts.id })
      .from(executionAttempts)
      .where(and(eq(executionAttempts.id, attemptId), eq(executionAttempts.taskId, input.taskId)));
    if (!attempt) throw notFound();
    const scope = createHash('sha256')
      .update(JSON.stringify([input.actor.teamId, input.taskId, attemptId]))
      .digest('hex');
    let before: number | undefined;
    if (input.query.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(input.query.cursor, 'base64url').toString('utf8'));
        if (cursor.scope !== scope || !Number.isSafeInteger(cursor.before) || cursor.before < 1)
          throw new Error();
        before = cursor.before;
      } catch {
        throw new AuthError(400, 'VALIDATION_ERROR', '报告分页位置无效或执行尝试已变化。');
      }
    }
    const limit = input.query.limit ?? 20;
    const rows = await this.db
      .select()
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.attemptId, attemptId),
          eq(executionSteps.role, 'research'),
          eq(executionSteps.status, 'completed'),
          isNotNull(executionSteps.resultId),
          before ? lt(executionSteps.resultVersion, before) : undefined,
        ),
      )
      .orderBy(desc(executionSteps.resultVersion))
      .limit(limit + 1);
    const items = rows
      .slice(0, limit)
      .filter((r) => r.validatedOutput && 'report' in r.validatedOutput)
      .map((r) => {
        const result = ResearchAcceptedResultSchema.parse(r.validatedOutput);
        return {
          id: result.id,
          attemptId,
          version: result.version,
          parentResultId: result.parentResultId,
          status: result.report.status,
          summary: result.report.summary,
          createdAt: r.finishedAt!.toISOString(),
        };
      });
    return {
      items,
      nextCursor:
        rows.length > limit && items.length
          ? Buffer.from(JSON.stringify({ scope, before: items.at(-1)!.version })).toString(
              'base64url',
            )
          : null,
    };
  }
  async get(input: Context & { resultId: string }): Promise<ResponseModels['ResearchResult']> {
    await this.read(input);
    const [row] = await this.db
      .select({ result: executionSteps.validatedOutput })
      .from(executionSteps)
      .innerJoin(executionAttempts, eq(executionSteps.attemptId, executionAttempts.id))
      .where(
        and(
          eq(executionAttempts.taskId, input.taskId),
          eq(executionSteps.resultId, input.resultId),
          eq(executionSteps.status, 'completed'),
        ),
      );
    if (!row?.result || !('report' in row.result)) throw notFound();
    return ResearchAcceptedResultSchema.parse(row.result);
  }
  async submission(
    input: Context & { submissionId: string },
  ): Promise<ResponseModels['ResearchSubmission']> {
    await this.read(input);
    if (!uuid.test(input.submissionId)) throw notFound();
    const [row] = await this.db
      .select()
      .from(researchSubmissions)
      .where(
        and(
          eq(researchSubmissions.taskId, input.taskId),
          eq(researchSubmissions.id, input.submissionId),
        ),
      );
    if (!row) throw notFound();
    const materials = await this.db
      .select()
      .from(researchSubmissionMaterials)
      .where(eq(researchSubmissionMaterials.submissionId, row.id));
    return {
      id: row.id,
      attemptId: row.attemptId,
      authorizationId: row.authorizationId,
      baseResultId: row.baseResultId,
      questionIds: row.questionIds,
      gapIds: row.gapIds,
      officialSiteGrants: row.officialSiteGrants,
      submittedBy: row.submittedBy,
      submittedAt: row.submittedAt.toISOString(),
      records: materials.map((r) => ResearchSubmissionRecordSchema.parse(r.record)),
    };
  }
}
