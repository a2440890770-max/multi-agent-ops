import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { createBusinessDatabase } from './database.js';
import { auditEvents, members, teams } from './schema.js';
import { hashPassword } from './password.js';

export class BootstrapError extends Error {}

export interface BootstrapInput {
  login: string;
  password: string;
  teamName: string;
  displayName: string;
}

export function validateBootstrapInput(input: BootstrapInput): BootstrapInput {
  const normalized = {
    login: input.login.trim().toLowerCase(),
    password: input.password,
    teamName: input.teamName.trim(),
    displayName: input.displayName.trim(),
  };
  if (!normalized.login || normalized.login.length > 254 || /\s/.test(normalized.login))
    throw new BootstrapError('登录账号须为 1—254 个字符且不能包含空白。');
  if (!normalized.teamName || normalized.teamName.length > 100)
    throw new BootstrapError('团队名称须为 1—100 个字符。');
  if (!normalized.displayName || normalized.displayName.length > 100)
    throw new BootstrapError('显示名称须为 1—100 个字符。');
  if (normalized.password.length < 8 || normalized.password.length > 256)
    throw new BootstrapError('密码长度必须为 8—256 个字符。');
  return normalized;
}

/** Explicit one-time operation. Importing this module never connects or writes. */
export async function bootstrapAdmin(
  db: ReturnType<typeof createBusinessDatabase>['db'],
  input: BootstrapInput,
) {
  const value = validateBootstrapInput(input);
  const passwordHash = await hashPassword(value.password);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
    await tx.execute(sql`SET LOCAL search_path = public, pg_catalog`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1835100527, 168102)`);
    // Also serialize ordinary INSERT/UPDATE paths that do not use the advisory lock.
    await tx.execute(sql`LOCK TABLE public.teams, public.members IN SHARE ROW EXCLUSIVE MODE`);
    const existingMembers = await tx.select({ id: members.id }).from(members).limit(1);
    if (existingMembers.length)
      throw new BootstrapError('已有成员，拒绝重复初始化或覆盖密码；请使用成员管理流程。');
    const existingTeams = await tx.select({ id: teams.id, name: teams.name }).from(teams).limit(2);
    if (existingTeams.length > 1)
      throw new BootstrapError('发现多个团队，拒绝自动选择；请先确认目标团队。');
    let team = existingTeams[0];
    if (team && team.name !== value.teamName)
      throw new BootstrapError('现有团队名称与指定名称不同；请明确指定现有团队名称后重试。');
    if (!team)
      [team] = await tx
        .insert(teams)
        .values({ name: value.teamName })
        .returning({ id: teams.id, name: teams.name });
    if (!team) throw new BootstrapError('团队创建失败，初始化已回滚。');
    const [member] = await tx
      .insert(members)
      .values({
        teamId: team.id,
        login: value.login,
        passwordHash,
        displayName: value.displayName,
        role: 'admin',
        status: 'active',
        version: 1,
        authVersion: 1,
        createdBy: null,
      })
      .returning({
        id: members.id,
        login: members.login,
        displayName: members.displayName,
        role: members.role,
        status: members.status,
      });
    if (!member) throw new BootstrapError('管理员创建失败，初始化已回滚。');
    await tx.insert(auditEvents).values({
      teamId: team.id,
      actorType: 'system',
      actorId: 'bootstrap',
      action: 'member.bootstrapped',
      targetType: 'member',
      targetId: member.id,
      afterRevision: 1,
      outcome: 'succeeded',
      reason: '初始化首个管理员',
      requestId: randomUUID(),
    });
    // Public result deliberately excludes password hashes and credentials.
    return { team, member };
  });
}
