import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { permissions } from '@multi-agent-ops/shared';
import type { ErrorCode, Role, Session } from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import type { AuthConfig } from './auth-config.js';
import { auditEvents, idempotencyRecords, members, sessions } from './schema.js';
import { hashPassword, verifyPassword } from './password.js';

export const SESSION_MILLISECONDS = 8 * 60 * 60 * 1000;
const REPLAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Connection = Database | Transaction;

export class AuthError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

export function cookieToken(header: string | undefined): string | undefined {
  if (!header || header.length > 8192) return undefined;
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('ops_session='))
    .map((part) => part.slice('ops_session='.length));
  return values.length === 1 && tokenPattern.test(values[0]!) ? values[0] : undefined;
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function equal(first: string, second: string) {
  const a = Buffer.from(first);
  const b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}

function unauthenticated() {
  return new AuthError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录。');
}

export class AuthService {
  private encryptionKey: Buffer;
  private fingerprintKey: Buffer;
  private dummyHash: Promise<string> | undefined;
  private now: () => Date;
  private accountAttempts: number;
  private ipAttempts: number;
  private rateWindow: number;

  constructor(
    private db: Database,
    public config: AuthConfig,
    options: {
      now?: () => Date;
      accountAttempts?: number;
      ipAttempts?: number;
      rateWindow?: number;
    } = {},
  ) {
    this.encryptionKey = Buffer.from(
      hkdfSync('sha256', config.secret, 'ops-auth-v1', 'replay', 32),
    );
    this.fingerprintKey = Buffer.from(
      hkdfSync('sha256', config.secret, 'ops-auth-v1', 'fingerprint', 32),
    );
    this.now = options.now ?? (() => new Date());
    this.accountAttempts = options.accountAttempts ?? 5;
    this.ipAttempts = options.ipAttempts ?? 30;
    this.rateWindow = options.rateWindow ?? 15 * 60 * 1000;
  }

  private fingerprint(domain: string, value: unknown) {
    return createHmac('sha256', this.fingerprintKey)
      .update(JSON.stringify([domain, value]))
      .digest('hex');
  }

  private async lock(tx: Transaction, value: string) {
    const key = Buffer.from(digest(value), 'hex').readBigInt64BE().toString();
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${key}::bigint)`);
  }

  private async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      return work(tx);
    });
  }

  assertOrigin(origin: string | undefined) {
    if (!origin || !this.config.trustedOrigins.includes(origin))
      throw new AuthError(403, 'FORBIDDEN', '请求来源不受信任。');
  }

  // Durable, cross-process rate accounting. Only keyed digests enter the security audit.
  private async consumeAttempt(login: string, ip: string, requestId: string) {
    const account = this.fingerprint('rate-account', login);
    const address = this.fingerprint('rate-ip', ip);
    const now = this.now();
    await this.transaction(async (tx) => {
      for (const key of [`account:${account}`, `ip:${address}`].sort()) await this.lock(tx, key);
      const [counts] = await tx
        .select({
          account: sql<number>`count(*) FILTER (WHERE ${auditEvents.actorId} = ${account})::int`,
          ip: sql<number>`count(*) FILTER (WHERE ${auditEvents.targetId} = ${address})::int`,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'auth.login_attempt'),
            gt(auditEvents.createdAt, new Date(now.getTime() - this.rateWindow)),
            sql`(${auditEvents.actorId} = ${account} OR ${auditEvents.targetId} = ${address})`,
          ),
        );
      if (!counts || counts.account >= this.accountAttempts || counts.ip >= this.ipAttempts)
        throw new AuthError(
          429,
          'RATE_LIMITED',
          '登录尝试过于频繁，请稍后再试。',
          Math.ceil(this.rateWindow / 1000),
        );
      await tx.insert(auditEvents).values({
        actorType: 'system',
        actorId: account,
        action: 'auth.login_attempt',
        targetType: 'auth',
        targetId: address,
        outcome: 'succeeded',
        reason: '登录尝试已登记，不代表认证成功',
        requestId,
        createdAt: now,
      });
    });
  }

  private encrypt(token: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from('ops-login-replay-v1'));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
  }

  private decrypt(value: Buffer): string {
    if (value.length !== 72 || value[0] !== 1)
      throw new AuthError(500, 'INTERNAL_ERROR', '登录重放记录不可用，请重新发起登录。');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, value.subarray(1, 13));
      decipher.setAAD(Buffer.from('ops-login-replay-v1'));
      decipher.setAuthTag(value.subarray(13, 29));
      const token = Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString(
        'utf8',
      );
      if (!tokenPattern.test(token)) throw new Error('invalid');
      return token;
    } catch {
      throw new AuthError(500, 'INTERNAL_ERROR', '登录重放记录不可用，请重新发起登录。');
    }
  }

  private async current(token: string, connection: Connection = this.db) {
    const [row] = await connection
      .select({ session: sessions, member: members })
      .from(sessions)
      .innerJoin(members, eq(sessions.memberId, members.id))
      .where(eq(sessions.tokenHash, digest(token)))
      .limit(1);
    if (
      !row ||
      row.session.revokedAt ||
      row.session.expiresAt.getTime() <= this.now().getTime() ||
      row.member.status !== 'active' ||
      row.member.authVersion !== row.session.issuedAuthVersion ||
      row.member.passwordChangedAt.getTime() > row.session.createdAt.getTime()
    )
      throw unauthenticated();
    return row;
  }

  private response(row: Awaited<ReturnType<AuthService['current']>>): Session {
    const member = row.member;
    return {
      member: {
        id: member.id,
        teamId: member.teamId,
        displayName: member.displayName,
        role: member.role,
        status: member.status,
        version: member.version,
      },
      permissions: [...permissions[member.role]],
      csrfToken: createHmac('sha256', row.session.csrfSecret)
        .update(`ops-csrf-v1:${row.session.id}`)
        .digest('base64url'),
      expiresAt: row.session.expiresAt.toISOString(),
    };
  }

  async me(token: string | undefined): Promise<Session> {
    if (!token) throw unauthenticated();
    return this.response(await this.current(token));
  }

  async authorize(
    token: string,
    roles: readonly Role[],
    write?: { origin: string | undefined; csrf: string | undefined },
  ): Promise<Session> {
    // Read the current member on every request; never trust a client-supplied role.
    const session = await this.me(token);
    if (!roles.includes(session.member.role))
      throw new AuthError(403, 'FORBIDDEN', '当前成员无权执行此操作。');
    if (write) {
      this.assertOrigin(write.origin);
      if (!write.csrf || !equal(write.csrf, session.csrfToken))
        throw new AuthError(403, 'FORBIDDEN', 'CSRF 校验失败。');
    }
    return session;
  }

  async login(input: {
    login: string;
    password: string;
    key: string;
    origin: string;
    ip: string;
    requestId: string;
  }): Promise<{ data: Session; token: string; replayed: boolean }> {
    const login = input.login.trim().toLowerCase();
    await this.consumeAttempt(login, input.ip, input.requestId);
    const [candidate] = await this.db
      .select()
      .from(members)
      .where(sql`lower(btrim(${members.login}::text)) = ${login}`)
      .limit(1);
    // Unknown accounts take the same expensive verification path; no account-existence hint.
    if (!this.dummyHash) this.dummyHash = hashPassword(randomBytes(32).toString('hex'));
    const dummy = await this.dummyHash;
    const hash = candidate?.passwordHash ?? dummy;
    const correct = await verifyPassword(input.password, hash);
    if (!correct || !candidate || candidate.status !== 'active') {
      await this.db.insert(auditEvents).values({
        actorType: 'system',
        action: 'auth.login',
        targetType: 'auth',
        outcome: 'rejected',
        reason: '账号或密码错误',
        requestId: input.requestId,
        createdAt: this.now(),
      });
      throw new AuthError(401, 'UNAUTHENTICATED', '账号或密码错误。');
    }
    const scopeHash = this.fingerprint('login-scope', [login, input.origin]);
    const keyHash = digest(input.key);
    const requestFingerprint = this.fingerprint('login-request', [input.login, input.password]);
    return this.transaction(async (tx) => {
      await this.lock(tx, `${scopeHash}:${keyHash}`);
      const [member] = await tx
        .select()
        .from(members)
        .where(eq(members.id, candidate.id))
        .for('update');
      if (
        !member ||
        member.status !== 'active' ||
        member.authVersion !== candidate.authVersion ||
        member.passwordHash !== candidate.passwordHash
      )
        throw new AuthError(401, 'UNAUTHENTICATED', '账号或密码错误。');
      const now = this.now();
      const [existing] = await tx
        .select()
        .from(idempotencyRecords)
        .where(
          and(eq(idempotencyRecords.scopeHash, scopeHash), eq(idempotencyRecords.keyHash, keyHash)),
        );
      if (existing && existing.expiresAt.getTime() > now.getTime()) {
        if (!equal(existing.requestFingerprint, requestFingerprint))
          throw new AuthError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            '同一动作标识不能用于不同的登录请求。',
          );
        if (existing.status !== 'completed' || !existing.encryptedReplay)
          throw new AuthError(409, 'INVALID_STATE', '登录请求尚未完成，请稍后查询。');
        const token = this.decrypt(existing.encryptedReplay);
        const row = await this.current(token, tx);
        if (row.member.id !== member.id) throw unauthenticated();
        return { data: this.response(row), token, replayed: true };
      }
      if (existing)
        await tx.delete(idempotencyRecords).where(eq(idempotencyRecords.id, existing.id));
      const token = randomBytes(32).toString('base64url');
      const [session] = await tx
        .insert(sessions)
        .values({
          id: randomUUID(),
          memberId: member.id,
          tokenHash: digest(token),
          csrfSecret: randomBytes(32),
          issuedAuthVersion: member.authVersion,
          createdAt: now,
          expiresAt: new Date(now.getTime() + SESSION_MILLISECONDS),
        })
        .returning();
      if (!session) throw new Error('session insert failed');
      await tx.insert(idempotencyRecords).values({
        scopeHash,
        keyHash,
        requestFingerprint,
        status: 'completed',
        responseStatus: 200,
        encryptedReplay: this.encrypt(token),
        createdAt: now,
        expiresAt: new Date(now.getTime() + REPLAY_MILLISECONDS),
      });
      await tx.insert(auditEvents).values({
        teamId: member.teamId,
        actorType: 'member',
        actorId: member.id,
        action: 'auth.login',
        targetType: 'session',
        targetId: session.id,
        outcome: 'succeeded',
        requestId: input.requestId,
        createdAt: now,
      });
      return { data: this.response({ session, member }), token, replayed: false };
    });
  }

  async logout(token: string | undefined, csrf: string | undefined, requestId: string) {
    if (!token) return;
    await this.transaction(async (tx) => {
      const [row] = await tx
        .select({ session: sessions, member: members })
        .from(sessions)
        .innerJoin(members, eq(sessions.memberId, members.id))
        .where(eq(sessions.tokenHash, digest(token)))
        .for('update');
      if (!row || row.session.revokedAt) return;
      const active =
        row.session.expiresAt.getTime() > this.now().getTime() &&
        row.member.status === 'active' &&
        row.member.authVersion === row.session.issuedAuthVersion &&
        row.member.passwordChangedAt.getTime() <= row.session.createdAt.getTime();
      if (active && (!csrf || !equal(csrf, this.response(row).csrfToken)))
        throw new AuthError(403, 'FORBIDDEN', 'CSRF 校验失败。');
      await tx
        .update(sessions)
        .set({ revokedAt: this.now(), revokeReason: 'logout' })
        .where(and(eq(sessions.id, row.session.id), isNull(sessions.revokedAt)));
      await tx.insert(auditEvents).values({
        teamId: row.member.teamId,
        actorType: 'member',
        actorId: row.member.id,
        action: 'auth.logout',
        targetType: 'session',
        targetId: row.session.id,
        outcome: 'succeeded',
        requestId,
        createdAt: this.now(),
      });
    });
  }
}
