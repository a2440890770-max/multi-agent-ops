import { eq, sql } from 'drizzle-orm';
import type { createBusinessDatabase } from './database.js';
import { taskApprovals, tasks } from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
export type EditorialTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export async function lockEditorialTeam(tx: EditorialTransaction, teamId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${'editorial:' + teamId}, 0))`,
  );
}
export async function invalidateApproval(
  tx: EditorialTransaction,
  task: typeof tasks.$inferSelect,
  now: Date,
  reason: string,
) {
  if (!task.currentApprovalId) return;
  const [approval] = await tx
    .select()
    .from(taskApprovals)
    .where(eq(taskApprovals.id, task.currentApprovalId));
  if (approval?.data.status === 'approved')
    await tx
      .update(taskApprovals)
      .set({
        data: {
          ...approval.data,
          status: 'invalidated',
          invalidatedAt: now.toISOString(),
          invalidatedReason: reason,
        },
      })
      .where(eq(taskApprovals.id, approval.id));
}
