import { sql } from 'drizzle-orm';
import type { createBusinessDatabase } from './database.js';

/** Read-only fail-closed startup check. Startup never applies migrations. */
export async function assertResearchPersistence(
  db: ReturnType<typeof createBusinessDatabase>['db'],
) {
  const result = await db.execute<{ ready: boolean }>(sql`SELECT (
    to_regclass('public.research_submissions') IS NOT NULL AND
    to_regclass('public.research_submission_materials') IS NOT NULL AND
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='research_registries' AND column_name='registry_revision') AND
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.research_authorizations') AND tgname='research_authorizations_pair' AND tgenabled='O')
  ) AS ready`);
  if (result.rows[0]?.ready !== true)
    throw new Error('Research 存储未就绪：需按评审方案应用 0015 迁移，启动不会自动迁移。');
}
