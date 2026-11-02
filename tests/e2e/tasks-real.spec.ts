import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import type { TaskDetail } from '@multi-agent-ops/shared';
import { createApp } from '../../backend/src/app.js';
import { AuthService } from '../../backend/src/auth.js';
import { createBusinessDatabase } from '../../backend/src/database.js';
import { hashPassword } from '../../backend/src/password.js';
import { TaskService } from '../../backend/src/task-service.js';
import { MockTaskExecutor } from '../../backend/src/mock-task-executor.js';

const rawAdminUrl = process.env.TASK_E2E_ADMIN_URL;
const password = 'synthetic-browser-tasks-password';
const taskTitle = '真实浏览器创建闭环';
const originalRequest = '  介绍产品的三个核心功能。\n保留换行和原始要求。\n';

test.describe('隔离数据库上的真实创建与详情闭环', () => {
  test.skip(!rawAdminUrl, '需要显式 TASK_E2E_ADMIN_URL，用于创建和删除独立临时测试库。');
  let admin: pg.Client;
  let client: pg.Client;
  let database: ReturnType<typeof createBusinessDatabase>;
  let app: FastifyInstance;
  let serverUrl: string;
  let teamId: string;
  let memberId: string;
  let storedHash: string;
  let roleCreated = false;
  let dbCreated = false;
  let agentCalls = 0;
  let taskClock: Date | null = null;
  const suffix = randomBytes(6).toString('hex');
  const name = 'tasks_ui_test_' + suffix;
  const role = 'tasks_ui_app_' + suffix;

  test.beforeAll(async () => {
    const url = new URL(rawAdminUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('浏览器数据库验收只接受本机测试实例。');
    admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    dbCreated = true;
    const target = new URL(url);
    target.pathname = '/' + name;
    client = new pg.Client({ connectionString: target.href, connectionTimeoutMillis: 5000 });
    await client.connect();
    const folder = fileURLToPath(new URL('../../backend/drizzle', import.meta.url));
    for (const migration of readMigrationFiles({ migrationsFolder: folder }))
      for (const statement of migration.sql) if (statement.trim()) await client.query(statement);
    storedHash = await hashPassword(password);
    const runtimePassword = randomBytes(24).toString('hex');
    await admin.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${runtimePassword}'`,
    );
    roleCreated = true;
    await admin.query(`GRANT "${role}" TO CURRENT_USER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
    );
    const runtimeUrl = new URL(target);
    runtimeUrl.username = role;
    runtimeUrl.password = runtimePassword;
    database = createBusinessDatabase(runtimeUrl.href);
    app = createApp({
      auth: new AuthService(
        database.db,
        {
          secret: randomBytes(32),
          trustedOrigins: ['http://127.0.0.1:5173'],
          secureCookie: false,
        },
        { accountAttempts: 100, ipAttempts: 100 },
      ),
      tasks: new TaskService(database.db, () => taskClock ?? new Date(), { stepDelayMs: 300 }),
      logging: false,
      checkDatabase: async () => ({ status: 'ready', database: 'connected' }),
      checkAgent: async () => {
        agentCalls++;
        throw new Error('创建闭环禁止自动调用执行器');
      },
    });
    const executor = new MockTaskExecutor(database.db, { pollMs: 50 });
    app.addHook('onReady', async () => {
      executor.start();
    });
    app.addHook('onClose', async () => {
      await executor.stop();
    });
    serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  test.beforeEach(async ({ context }) => {
    agentCalls = 0;
    taskClock = null;
    await client.query('TRUNCATE teams,idempotency_records,tasks CASCADE');
    teamId = (
      await client.query("INSERT INTO teams(name) VALUES ('browser test team') RETURNING id")
    ).rows[0].id;
    memberId = (
      await client.query(
        `INSERT INTO members(team_id,login,password_hash,display_name,role)
      VALUES ($1,'browser.tasks',$2,'浏览器验收成员','operator') RETURNING id`,
        [teamId, storedHash],
      )
    ).rows[0].id;
    await proxy(context);
  });
  test.afterAll(async () => {
    if (app) await app.close();
    if (database) await database.close();
    if (client) await client.end();
    if (admin) {
      if (dbCreated) await admin.query(`DROP DATABASE "${name}"`);
      if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
      await admin.end();
    }
  });
  async function proxy(context: BrowserContext) {
    // Forward browser HTTP requests to a real backend using the isolated DB.
    // Responses and session cookies come directly from that backend, without fixtures.
    await context.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url());
      const response = await route.fetch({ url: serverUrl + path.pathname + path.search });
      await route.fulfill({ response });
    });
  }
  async function openForm(page: Page) {
    await page.goto('/tasks/new');
    await expect(page).toHaveURL(/\/login\?next=/);
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
    await page.getByLabel('登录账号', { exact: true }).fill('browser.tasks');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\/new$/);
    await page.getByLabel('任务标题').fill(taskTitle);
    await page.getByLabel('主题与目标').fill(originalRequest);
  }

  async function openClarification(page: Page) {
    await openForm(page);
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await page.getByLabel('模拟情形').selectOption('clarification');
    await page.getByRole('button', { name: '启动模拟执行', exact: true }).click();
    await expect(page.getByLabel('答复 1', { exact: true })).toBeEditable();
    return new URL(page.url()).pathname.split('/').at(-1)!;
  }

  async function api(
    page: Page,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: Record<string, unknown>,
    key = randomUUID(),
  ) {
    const cookie = (await page.context().cookies())
      .filter((c) => c.name === 'ops_session')
      .map((c) => `${c.name}=${c.value}`)
      .join(';');
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    return app.inject({
      method,
      url,
      headers: {
        cookie,
        origin: 'http://127.0.0.1:5173',
        'x-csrf-token': me.json().data.csrfToken,
        'idempotency-key': key,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  }
  async function task(page: Page, id: string): Promise<TaskDetail> {
    const response = await api(page, 'GET', `/api/v1/tasks/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data;
  }
  async function createManual(
    page: Page,
    body = '  欢迎了解本次产品介绍。\n详情以官方说明为准。\n',
  ) {
    await openForm(page);
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\/[a-f0-9-]{36}$/);
    const id = page.url().split('/').at(-1)!;
    await page.getByLabel('文案内容', { exact: true }).fill(body);
    await page.getByRole('button', { name: '保存新版本', exact: true }).click();
    await expect(page.getByTestId('content-version')).toHaveCount(1);
    return id;
  }
  async function reviewApi(page: Page, id: string, note = '') {
    const current = await task(page, id);
    const response = await api(page, 'POST', `/api/v1/tasks/${id}/reviews`, {
      expectedRevision: current.task.revision,
      contentVersionId: current.task.currentContentVersionId,
      subjectiveNote: note,
    });
    expect(response.statusCode, response.body).toBe(202);
    return response.json().data;
  }
  async function approveApi(page: Page, id: string) {
    const d = await task(page, id);
    return api(page, 'POST', `/api/v1/tasks/${id}/approvals`, {
      expectedRevision: d.task.revision,
      contentVersionId: d.task.currentContentVersionId,
      contentHash: d.currentContent?.contentHash,
      reviewCycleId: d.currentReview?.id,
      accountId: d.account?.id,
    });
  }

  test('人工保存不可变版本、父版本和摘要，创建者自批，编辑使旧批准失效且无需 Agent', async ({
    page,
  }) => {
    const body = '  欢迎了解本次产品介绍。\n详情以官方说明为准。\n';
    const id = await createManual(page, body);
    const v1 = (await task(page, id)).currentContent!;
    expect(v1.body).toBe(body);
    expect(v1.parentVersionId).toBeNull();
    expect(v1.contentHash).toBe(createHash('sha256').update(body).digest('hex'));
    await page.getByRole('button', { name: '提交基础审核', exact: true }).click();
    await expect(page.getByRole('button', { name: '批准当前版本', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '批准当前版本', exact: true }).click();
    await expect.poll(async () => (await task(page, id)).approval).toBe('approved');
    const approved = (await task(page, id)).currentApproval!;
    expect(approved.approvedBy).toBe(memberId);
    expect(approved.contentVersionId).toBe(v1.id);
    const approvedRevision = (await task(page, id)).task.revision;
    await page.getByLabel('文案内容', { exact: true }).fill(body + '欢迎查看参考资料。');
    await page.getByRole('button', { name: '保存新版本', exact: true }).click();
    await expect(page.getByTestId('content-version')).toHaveCount(2);
    const d = await task(page, id);
    expect(d.currentContent!.parentVersionId).toBe(v1.id);
    expect(d.approval).toBe('invalidated');
    expect(d.currentApproval?.status).toBe('invalidated');
    const staleApproval = await api(page, 'POST', `/api/v1/tasks/${id}/approvals`, {
      expectedRevision: approvedRevision,
      contentVersionId: v1.id,
      contentHash: v1.contentHash,
      reviewCycleId: approved.reviewCycleId,
      accountId: approved.accountId,
    });
    expect(staleApproval.statusCode).toBe(409);
    const old = await api(page, 'GET', `/api/v1/tasks/${id}/content-versions/${v1.id}`);
    expect(old.json().data).toEqual(v1);
    await expect(
      client.query('UPDATE task_contents SET body=$1 WHERE id=$2', ['篡改', v1.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query('DELETE FROM task_contents WHERE id=$1', [v1.id]),
    ).rejects.toMatchObject({ code: '23514' });
    const publish = await api(page, 'POST', `/api/v1/tasks/${id}/publications`, {
      expectedRevision: d.task.revision,
      contentVersionId: v1.id,
      contentHash: approved.contentHash,
      accountId: approved.accountId,
      approvalId: approved.id,
      channel: 'manual',
    });
    expect(publish.statusCode).toBe(409);
    expect((await client.query('SELECT count(*)::int n FROM execution_attempts')).rows[0].n).toBe(
      0,
    );
    expect(agentCalls).toBe(0);
    await page.getByRole('button', { name: '查看 V1', exact: true }).click();
    await page.getByRole('button', { name: '比较所选版本与当前版本', exact: true }).click();
    await expect(page.getByLabel('已保存版本差异')).toContainText('欢迎查看参考资料');
    await page.reload();
    await expect(page.getByTestId('content-version')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/manual-version-history.png', fullPage: true });
  });

  test('人工基础审核禁止词、超长与 HTML 阻断不可裁决绕过，修改后才可批准', async ({ page }) => {
    const id = await createManual(page, '这是全网最低的产品介绍。');
    const cycle = await reviewApi(page, id, '语气可由人工判断。');
    expect(
      cycle.records[0].blockingIssues.some((i: { kind: string }) => i.kind === 'deterministic'),
    ).toBe(true);
    let d = await task(page, id);
    const forced = await api(page, 'POST', `/api/v1/tasks/${id}/reviews/${cycle.id}/decisions`, {
      expectedRevision: d.task.revision,
      contentVersionId: d.currentContent!.id,
      reviewRecordId: cycle.records[0].id,
      reason: '管理员同意放行',
      acceptedIssues: cycle.records[0].blockingIssues.map((i: { id: string }) => i.id),
      unresolvedIssues: [],
      evidenceIds: [],
    });
    expect(forced.statusCode).toBe(409);
    expect(forced.json().error.code).toBe('REVIEW_BLOCKED');
    expect((await approveApi(page, id)).statusCode).toBe(409);
    for (const text of ['文'.repeat(281), '<b>欢迎了解产品介绍</b>']) {
      d = await task(page, id);
      const save = await api(page, 'POST', `/api/v1/tasks/${id}/content-versions`, {
        expectedRevision: d.task.revision,
        baseContentVersionId: d.currentContent!.id,
        body: text,
      });
      expect(save.statusCode, save.body).toBe(201);
      await reviewApi(page, id);
      expect((await approveApi(page, id)).statusCode).toBe(409);
    }
    d = await task(page, id);
    await api(page, 'POST', `/api/v1/tasks/${id}/content-versions`, {
      expectedRevision: d.task.revision,
      baseContentVersionId: d.currentContent!.id,
      body: '欢迎了解本次产品介绍，详情以官方说明为准。',
    });
    await reviewApi(page, id);
    expect((await approveApi(page, id)).statusCode).toBe(201);
    expect(
      (await client.query('SELECT count(*)::int n FROM task_review_decisions')).rows[0].n,
    ).toBe(0);
  });

  test('人工主观裁决空理由拒绝、未解决仍阻断，理由与审核记录不可变，接受后可自批', async ({
    page,
  }) => {
    taskClock = new Date();
    const id = await createManual(page);
    await page.getByLabel('主观审核意见', { exact: true }).fill('语气是否应更活泼，需要人工判断。');
    await page.getByRole('button', { name: '提交基础审核', exact: true }).click();
    await expect(page.getByLabel('裁决理由', { exact: true })).toBeEditable();
    await page.getByRole('button', { name: '保存人工裁决', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('有效的裁决理由');
    let d = await task(page, id);
    const review = d.currentReview!;
    const record = review.records[0]!;
    const issueIds = record.blockingIssues.map((i) => i.id);
    const decide = (reason: string, accepted: string[], unresolved: string[]) =>
      api(page, 'POST', `/api/v1/tasks/${id}/reviews/${review.id}/decisions`, {
        expectedRevision: d.task.revision,
        contentVersionId: d.currentContent!.id,
        reviewRecordId: record.id,
        reason,
        acceptedIssues: accepted,
        unresolvedIssues: unresolved,
        evidenceIds: [],
      });
    expect((await decide('   ', issueIds, [])).statusCode).toBe(400);
    expect((await decide('需要继续调整语气。', [], issueIds)).statusCode).toBe(201);
    expect((await approveApi(page, id)).statusCode).toBe(409);
    d = await task(page, id);
    expect((await decide('接受适度活泼表达，内容仍保持准确。', issueIds, [])).statusCode).toBe(201);
    expect((await approveApi(page, id)).statusCode).toBe(201);
    expect(
      (await api(page, 'GET', `/api/v1/tasks/${id}/reviews/${review.id}`)).json().data,
    ).toEqual(review);
    await expect(
      client.query(
        'UPDATE task_review_cycles SET data=data || \'{"status":"failed"}\' WHERE id=$1',
        [review.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query('UPDATE task_review_decisions SET data=data || \'{"reason":"篡改"}\''),
    ).rejects.toMatchObject({ code: '23514' });
    await page.reload();
    await expect(page.getByTestId('decision-history')).toHaveCount(2);
    await expect(page.getByTestId('decision-history').first()).toContainText('接受适度活泼表达');
    await expect(
      page.getByText('主观意见已裁决接受。当前版本已批准。', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('裁决理由', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/manual-review-decisions.png', fullPage: true });
  });

  test('人工编辑双浏览器 409 保留草稿并比较，显式更新基础版本后保存为新版本', async ({
    page,
    browser,
  }) => {
    const id = await createManual(page);
    const second = await browser.newContext();
    try {
      await proxy(second);
      const b = await second.newPage();
      await b.goto(page.url());
      await expect(b.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
      await b.getByLabel('登录账号', { exact: true }).fill('browser.tasks');
      await b.getByLabel('密码', { exact: true }).fill(password);
      await b.getByRole('button', { name: '登录', exact: true }).click();
      await expect(b.getByLabel('文案内容', { exact: true })).toBeEditable();
      await b.getByLabel('文案内容', { exact: true }).fill('浏览器 B 尚未保存的文案。');
      await page.getByLabel('文案内容', { exact: true }).fill('浏览器 A 保存的新文案。');
      await page.getByRole('button', { name: '保存新版本', exact: true }).click();
      await expect(page.getByTestId('content-version')).toHaveCount(2);
      const conflict = b.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/content-versions'),
      );
      await b.getByRole('button', { name: '保存新版本', exact: true }).click();
      expect((await conflict).status()).toBe(409);
      await expect(b.getByLabel('我的未保存输入', { exact: true })).toHaveValue(
        '浏览器 B 尚未保存的文案。',
      );
      await expect(b.getByLabel('服务器当前版本', { exact: true })).toHaveValue(
        '浏览器 A 保存的新文案。',
      );
      await b.reload();
      await expect(b.getByLabel('文案内容', { exact: true })).toHaveValue(
        '浏览器 B 尚未保存的文案。',
      );
      await b.getByRole('button', { name: '比较当前版本与我的输入', exact: true }).click();
      await b.getByRole('button', { name: '保留输入并使用当前版本为基础', exact: true }).click();
      const parent = (await task(page, id)).currentContent!.id;
      await b.getByRole('button', { name: '保存新版本', exact: true }).click();
      await expect(b.getByTestId('content-version')).toHaveCount(3);
      expect((await task(page, id)).currentContent!.parentVersionId).toBe(parent);
    } finally {
      await second.close();
    }
  });

  test('人工批准绑定防伪造、跨任务隔离，配置变更与新执行均失效旧批准', async ({ page }) => {
    await client.query("UPDATE members SET role='admin' WHERE id=$1", [memberId]);
    const id = await createManual(page);
    await reviewApi(page, id);
    expect((await approveApi(page, id)).statusCode).toBe(201);
    let d = await task(page, id);
    const approval = d.currentApproval!;
    await expect(
      client.query(
        "UPDATE task_version_approvals SET data=jsonb_set(data,'{contentHash}',to_jsonb(repeat('a',64))) WHERE id=$1",
        [approval.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const config = (await api(page, 'GET', '/api/v1/config')).json().data;
    const changed = await api(page, 'PUT', '/api/v1/config', {
      expectedVersion: config.version,
      profile: '本团队新的账号简介',
      tone: '简明自然',
      forbiddenTopics: ['演示禁词'],
      rules: config.rules,
      modelRef: config.modelRef,
      promptVersion: config.promptVersion,
      toolVersion: config.toolVersion,
      reason: '验证配置版本绑定',
    });
    expect(changed.statusCode, changed.body).toBe(200);
    d = await task(page, id);
    expect(d.approval).toBe('invalidated');
    expect((await approveApi(page, id)).statusCode).toBe(409);
    await reviewApi(page, id);
    expect((await approveApi(page, id)).statusCode).toBe(201);
    d = await task(page, id);
    const started = await api(page, 'POST', `/api/v1/tasks/${id}/attempts`, {
      expectedRevision: d.task.revision,
      simulationScenario: 'clarification',
    });
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json().data.approval).toBe('invalidated');
    const otherId = randomUUID();
    const stolen = await api(
      page,
      'GET',
      `/api/v1/tasks/${otherId}/content-versions/${approval.contentVersionId}`,
    );
    expect(stolen.statusCode).toBe(404);
    await page.goto('/settings');
    await page.getByRole('button', { name: '基础规则与版本', exact: true }).click();
    await expect(page.getByLabel('账号简介', { exact: true })).toHaveValue('本团队新的账号简介');
    await page.getByLabel('语气偏好', { exact: true }).fill('友好清晰');
    await page.getByLabel('变更原因', { exact: true }).fill('浏览器保存配置验证');
    await page.getByRole('button', { name: '保存新配置版本', exact: true }).click();
    await expect(page.getByText('配置已保存。', { exact: false })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '基础规则与版本', exact: true }).click();
    await expect(page.getByLabel('语气偏好', { exact: true })).toHaveValue('友好清晰');
  });

  test('正常执行后从澄清问答直接生成问题，刷新保留情形和答复，提交后继续新尝试', async ({
    page,
  }) => {
    await openForm(page);
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await page.getByRole('button', { name: '启动模拟执行', exact: true }).click();
    await expect(page.getByTestId('mock-output')).toBeVisible();
    await expect(page.getByLabel('答复 1', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '生成澄清问题', exact: true }).click();
    await expect(page.getByLabel('答复 1', { exact: true })).toBeEditable();
    await expect(page.getByLabel('模拟情形')).toHaveValue('clarification');
    await page
      .getByLabel('答复 1', { exact: true })
      .fill('主题：新品介绍；受众：新用户；无冲突要求。');
    await page.reload();
    await expect(page.getByLabel('模拟情形')).toHaveValue('clarification');
    await expect(page.getByLabel('答复 1', { exact: true })).toHaveValue(
      '主题：新品介绍；受众：新用户；无冲突要求。',
    );
    await page
      .getByLabel('答复 1', { exact: true })
      .fill('刷新后仍能编辑：介绍三个功能，面向新用户。');
    await page.getByRole('button', { name: '提交澄清答复', exact: true }).click();
    await expect(page.getByTestId('mock-output')).toContainText('刷新后仍能编辑');
    await expect(page.getByTestId('execution-attempt')).toHaveCount(2);
    expect(
      (
        await client.query('SELECT simulation_scenario FROM execution_attempts ORDER BY attempt_no')
      ).rows.map((row) => row.simulation_scenario),
    ).toEqual(['success', 'clarification']);
    expect((await client.query('SELECT count(*)::int AS n FROM task_contents')).rows[0].n).toBe(2);
  });

  test('执行前选择需要澄清，刷新仍保留选择；停止后刷新重试仍生成可编辑问题', async ({ page }) => {
    await openForm(page);
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await page.getByLabel('模拟情形').selectOption('clarification');
    await page.reload();
    await expect(page.getByLabel('模拟情形')).toHaveValue('clarification');
    await page.getByRole('button', { name: '启动模拟执行', exact: true }).click();
    await expect(page.getByLabel('答复 1', { exact: true })).toBeEditable();
    await page.getByRole('button', { name: '停止本次执行', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新执行', exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByLabel('模拟情形')).toHaveValue('clarification');
    await page.getByRole('button', { name: '重新执行', exact: true }).click();
    await expect(page.getByLabel('答复 1', { exact: true })).toBeEditable();
    await page.getByLabel('答复 1', { exact: true }).fill('第二次澄清可正常输入。');
    await expect(page.getByLabel('答复 1', { exact: true })).toHaveValue('第二次澄清可正常输入。');
    await page.screenshot({
      path: 'test-results/clarification-retry-editable.png',
      fullPage: true,
    });
  });

  test('两个独立浏览器会话生成澄清及提交答复时，旧版本请求均被拒绝且不覆盖新答复', async ({
    page,
    browser,
  }) => {
    await openForm(page);
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\/[a-f0-9-]{36}$/);
    const url = page.url();
    const second = await browser.newContext();
    try {
      await proxy(second);
      const other = await second.newPage();
      await other.goto(url);
      await expect(other.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
      await other.getByLabel('登录账号', { exact: true }).fill('browser.tasks');
      await other.getByLabel('密码', { exact: true }).fill(password);
      await other.getByRole('button', { name: '登录', exact: true }).click();
      await expect(other.getByRole('button', { name: '生成澄清问题', exact: true })).toBeEnabled();

      await page.getByRole('button', { name: '生成澄清问题', exact: true }).click();
      await expect(page.getByLabel('答复 1', { exact: true })).toBeEditable();
      const staleStart = other.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && response.url().endsWith('/attempts'),
      );
      await other.getByRole('button', { name: '生成澄清问题', exact: true }).click();
      expect((await staleStart).status()).toBe(409);
      await expect(other.getByLabel('答复 1', { exact: true })).toBeEditable();
      expect(
        (await client.query('SELECT count(*)::int AS n FROM execution_attempts')).rows[0].n,
      ).toBe(1);

      await page.getByLabel('答复 1', { exact: true }).fill('浏览器 A 保存的主题和受众。');
      await other.getByLabel('答复 1', { exact: true }).fill('浏览器 B 的过期答复，不能写入。');
      await page.getByRole('button', { name: '提交澄清答复', exact: true }).click();
      await expect(page.getByTestId('mock-output')).toContainText('浏览器 A 保存的主题和受众');
      const staleAnswer = other.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && response.url().endsWith('/clarifications'),
      );
      await other.getByRole('button', { name: '提交澄清答复', exact: true }).click();
      expect((await staleAnswer).status()).toBe(409);
      await expect(other.getByTestId('saved-clarification-answer')).toHaveText(
        '浏览器 A 保存的主题和受众。',
      );
      expect((await client.query('SELECT answer FROM clarification_answers')).rows).toEqual([
        { answer: '浏览器 A 保存的主题和受众。' },
      ]);
    } finally {
      await second.close();
    }
  });

  test('填写澄清答复并刷新保留草稿，提交后继续原尝试且保留历史和原始要求', async ({ page }) => {
    const id = await openClarification(page);
    const oldAttempt = (
      await client.query('SELECT * FROM execution_attempts WHERE task_id=$1', [id])
    ).rows[0];
    const answer = '  主题：介绍新品的三个功能。\n受众：新用户；不使用未经验证的效果承诺。\n';
    await page.getByLabel('答复 1', { exact: true }).fill(answer);
    await page.reload();
    await expect(page.getByLabel('答复 1', { exact: true })).toHaveValue(answer);
    await page.getByRole('button', { name: '提交澄清答复', exact: true }).click();
    await expect(page.getByTestId('mock-output')).toContainText('受众：新用户');
    await expect(page.getByTestId('execution-attempt')).toHaveCount(1);
    expect(await page.getByTestId('saved-clarification-answer').textContent()).toBe(answer);
    await expect(page.getByTestId('clarification-history')).toContainText('受众：新用户');
    expect(await page.getByTestId('original-request').textContent()).toBe(originalRequest);
    const row = (await client.query('SELECT * FROM clarification_answers')).rows[0];
    expect(row.task_id).toBe(id);
    expect(row.attempt_id).toBe(oldAttempt.id);
    expect(row.answered_by).toBe(memberId);
    expect(row.answer).toBe(answer);
    expect(
      (await client.query('SELECT count(*)::int AS n FROM execution_attempts')).rows[0].n,
    ).toBe(1);
    const latest = (
      await client.query('SELECT * FROM execution_attempts WHERE id=$1', [oldAttempt.id])
    ).rows[0];
    expect(latest.started_at).toEqual(oldAttempt.started_at);
    expect(latest.config_snapshot).toEqual(oldAttempt.config_snapshot);
    await page.reload();
    await expect(page.getByTestId('saved-clarification-answer')).toHaveText(answer);
    await expect(page.getByTestId('mock-output')).toContainText('受众：新用户');
    await page.screenshot({ path: 'test-results/d4-clarification-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({ path: 'test-results/d4-clarification-mobile.png', fullPage: true });
  });

  test('空白答复不提交，部分答复仍阻断生成，填写剩余问题后继续', async ({ page }) => {
    const id = await openClarification(page);
    let posts = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/clarifications')) posts++;
    });
    await page.getByLabel('答复 1', { exact: true }).fill(' \n\t');
    await page.getByRole('button', { name: '提交澄清答复', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('非空');
    expect(posts).toBe(0);
    const extraId = '12345678-1234-4234-8234-123456789012';
    await client.query(
      'UPDATE execution_attempts SET clarifications=clarifications || $1::jsonb WHERE task_id=$2',
      [JSON.stringify([{ questionId: extraId, question: '明确主要受众。', answer: null }]), id],
    );
    await page.reload();
    await expect(page.getByLabel('答复 2', { exact: true })).toBeEditable();
    await page.getByLabel('答复 1', { exact: true }).fill('主题：新品三个核心功能。');
    await page.getByRole('button', { name: '提交澄清答复', exact: true }).click();
    await expect(page.getByTestId('saved-clarification-answer')).toHaveText(
      '主题：新品三个核心功能。',
    );
    await expect(page.getByLabel('答复 2', { exact: true })).toBeEditable();
    await expect(page.getByTestId('mock-output')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('saved-clarification-answer')).toHaveText(
      '主题：新品三个核心功能。',
    );
    await page.getByLabel('答复 2', { exact: true }).fill('受众：首次接触产品的新用户。');
    await page.getByRole('button', { name: '提交澄清答复', exact: true }).click();
    await expect(page.getByTestId('mock-output')).toContainText('首次接触产品的新用户');
    expect(
      (await client.query('SELECT count(*)::int AS n FROM clarification_answers')).rows[0].n,
    ).toBe(2);
    expect(
      (await client.query('SELECT count(*)::int AS n FROM execution_attempts')).rows[0].n,
    ).toBe(1);
  });

  test('澄清已保存但响应丢失，刷新后复用同一请求确认，答复和执行均不重复', async ({ page }) => {
    await openClarification(page);
    const keys: string[] = [];
    const bodies: unknown[] = [];
    await page.route('**/api/v1/tasks/*/clarifications', async (route) => {
      keys.push(route.request().headers()['idempotency-key']!);
      bodies.push(route.request().postDataJSON());
      if (keys.length === 1) {
        const response = await route.fetch({
          url: serverUrl + new URL(route.request().url()).pathname,
        });
        expect(response.status()).toBe(202);
        return route.abort('failed');
      }
      return route.fallback();
    });
    await page
      .getByLabel('答复 1', { exact: true })
      .fill('主题：新品功能；受众：普通用户，无冲突要求。');
    await page.getByRole('button', { name: '提交澄清答复', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试确认澄清答复', exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole('button', { name: '重试确认澄清答复', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '重试确认澄清答复', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试确认澄清答复', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByTestId('mock-output')).toContainText('普通用户');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(
      (await client.query('SELECT count(*)::int AS n FROM clarification_answers')).rows[0].n,
    ).toBe(1);
    expect(
      (await client.query('SELECT count(*)::int AS n FROM execution_attempts')).rows[0].n,
    ).toBe(1);
    expect((await client.query('SELECT count(*)::int AS n FROM task_contents')).rows[0].n).toBe(1);
  });

  test('页面创建后数据库真实保存，刷新和新标签页重新打开仍能查看无账号任务', async ({
    page,
    context,
  }) => {
    await openForm(page);
    await page.getByLabel('参考资料名称').fill('产品文档');
    await page.getByLabel('参考资料链接').fill('https://example.com/product');
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\/[a-f0-9-]{36}$/);
    await expect(page.getByRole('heading', { name: taskTitle, exact: true })).toBeVisible();
    const taskId = new URL(page.url()).pathname.split('/').at(-1)!;
    const row = (await client.query('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
    expect(row.original_request).toBe(originalRequest);
    expect(row.created_by).toBe(memberId);
    expect(row.team_id).toBe(teamId);
    expect(row.account_id).toBeNull();
    expect(row.execution_status).toBeNull();
    expect(row.reference_inputs).toEqual([
      { id: expect.any(String), label: '产品文档', url: 'https://example.com/product' },
    ]);
    expect(await page.getByTestId('original-request').textContent()).toBe(originalRequest);
    await expect(page.getByTestId('creator-id')).toHaveText(memberId);
    await expect(page.getByTestId('team-id')).toHaveText(teamId);
    await expect(page.getByText('未绑定', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/d4-real-detail-desktop.png', fullPage: true });
    const url = page.url();
    await page.reload();
    await expect(page.getByRole('heading', { name: taskTitle, exact: true })).toBeVisible();
    expect(await page.getByTestId('original-request').textContent()).toBe(originalRequest);
    const other = await context.newPage();
    await other.goto(url);
    await expect(other.getByRole('heading', { name: taskTitle, exact: true })).toBeVisible();
    await expect(other.getByTestId('task-id')).toHaveText(taskId);
    expect(await other.getByTestId('original-request').textContent()).toBe(originalRequest);
    await other.close();
    await page.getByRole('link', { name: '← 返回任务列表' }).click();
    await expect(page.getByRole('link', { name: taskTitle, exact: true })).toBeVisible();
    await expect(page.getByText('尚未执行', { exact: true })).toBeVisible();
    await expect(page.getByText('task-demo', { exact: false })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('link', { name: taskTitle, exact: true })).toBeVisible();
    await page.getByRole('button', { name: '执行中', exact: true }).click();
    await expect(page.getByRole('heading', { name: '没有符合条件的任务' })).toBeVisible();
    await page.getByRole('button', { name: '全部任务', exact: true }).click();
    await page.getByLabel('搜索任务').fill(taskId);
    await expect(page.getByRole('link', { name: taskTitle, exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/d4-real-list-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'test-results/d4-real-list-mobile.png', fullPage: true });
    await page.getByRole('link', { name: taskTitle, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
    expect(await page.getByTestId('original-request').textContent()).toBe(originalRequest);
    expect((await client.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(1);
  });

  test('服务端创建成功但响应丢失，刷新后手动重试仍返回同一任务', async ({ page }) => {
    await openForm(page);
    const keys: string[] = [];
    let firstTaskId: string | undefined;
    await page.route('**/api/v1/tasks', async (route) => {
      keys.push(route.request().headers()['idempotency-key']!);
      if (keys.length === 1) {
        const response = await route.fetch({ url: serverUrl + '/api/v1/tasks' });
        expect(response.status()).toBe(201);
        firstTaskId = ((await response.json()) as { data: TaskDetail }).data.task.id;
        return route.abort('failed');
      }
      return route.fallback();
    });
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试确认本次提交' })).toBeEnabled();
    expect((await client.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(1);
    await page.reload();
    await expect(page.getByRole('button', { name: '重试确认本次提交' })).toBeEnabled();
    expect(keys).toHaveLength(1);
    await page.getByRole('button', { name: '重试确认本次提交' }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${firstTaskId}$`));
    await expect(page.getByRole('heading', { name: taskTitle, exact: true })).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect((await client.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(1);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE action='task.created'",
        )
      ).rows[0].n,
    ).toBe(1);
  });

  test('详情刷新展示数据库最新步骤和错误，原始要求保持可见', async ({ page }) => {
    await openForm(page);
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\/[a-f0-9-]{36}$/);
    await expect(page.getByRole('button', { name: '刷新详情' })).toBeVisible();
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    await client.query(
      "UPDATE tasks SET execution_status='failed',current_step='research',error_message='验收用检索错误' WHERE id=$1",
      [id],
    );
    await page.getByRole('button', { name: '刷新详情' }).click();
    await expect(page.getByRole('alert')).toContainText('验收用检索错误');
    await expect(page.getByText('research', { exact: false })).toBeVisible();
    expect(await page.getByTestId('original-request').textContent()).toBe(originalRequest);
  });

  test('浏览器启动真实保存模拟尝试，刷新后完成并可查看步骤和模拟产出', async ({ page }) => {
    await openForm(page);
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\/[a-f0-9-]{36}$/);
    await page.getByRole('button', { name: '启动模拟执行', exact: true }).click();
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    await expect
      .poll(
        async () =>
          (
            await client.query(
              'SELECT count(*)::int AS n FROM execution_attempts WHERE task_id=$1',
              [id],
            )
          ).rows[0].n,
      )
      .toBe(1);
    await page.reload();
    await expect(page.getByTestId('mock-output')).toContainText('【模拟产出，仅用于流程验证');
    await expect(page.getByTestId('execution-attempt')).toHaveCount(1);
    await expect(page.getByTestId('execution-attempt')).toContainText('正常完成');
    await expect(page.getByTestId('execution-attempt').locator('li')).toHaveCount(4);
    await expect(page.getByRole('button', { name: '发布内容', exact: true })).toBeDisabled();
    await page.screenshot({ path: 'test-results/d4-execution-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({ path: 'test-results/d4-execution-mobile.png', fullPage: true });
    expect(await page.getByTestId('original-request').textContent()).toBe(originalRequest);
    await page.getByRole('link', { name: '← 返回任务列表' }).click();
    await page.getByRole('button', { name: '产出就绪', exact: true }).click();
    await expect(page.getByRole('link', { name: taskTitle, exact: true })).toBeVisible();
    expect(
      (await client.query('SELECT account_id FROM tasks WHERE id=$1', [id])).rows[0].account_id,
    ).toBeNull();
  });

  test('模拟失败显示错误，重新执行保留旧尝试；待澄清刷新后仍阻断，停止后保留记录', async ({
    page,
  }) => {
    await openForm(page);
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await page.getByLabel('模拟情形').selectOption('failure');
    await page.getByRole('button', { name: '启动模拟执行', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新执行', exact: true })).toBeEnabled();
    await expect(page.getByTestId('execution-attempt')).toContainText('模拟执行失败');
    await page.getByLabel('模拟情形').selectOption('clarification');
    await page.getByRole('button', { name: '重新执行', exact: true }).click();
    await expect(
      page.getByText(
        '【模拟澄清】请补充本次任务的明确主题、目标受众，并确认是否存在相互冲突的要求。',
        { exact: true },
      ),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText('任务正在等待澄清，不会继续生成。', { exact: false }),
    ).toBeVisible();
    await expect(page.getByTestId('execution-attempt')).toHaveCount(2);
    await expect(page.getByRole('button', { name: '启动模拟执行', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重新执行', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('mock-output')).toHaveCount(0);
    await page.getByRole('button', { name: '停止本次执行', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新执行', exact: true })).toBeEnabled();
    await expect(page.getByTestId('execution-attempt').first()).toContainText('已取消');
    expect((await client.query('SELECT count(*)::int AS n FROM task_contents')).rows[0].n).toBe(0);
  });

  test('启动已提交但响应丢失，刷新后复用原操作标识确认，不增加执行次数', async ({ page }) => {
    await openForm(page);
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    const keys: string[] = [];
    await page.route('**/api/v1/tasks/*/attempts', async (route) => {
      keys.push(route.request().headers()['idempotency-key']!);
      if (keys.length === 1) {
        const response = await route.fetch({
          url: serverUrl + new URL(route.request().url()).pathname,
        });
        expect(response.status()).toBe(202);
        return route.abort('failed');
      }
      return route.fallback();
    });
    await page.getByRole('button', { name: '启动模拟执行', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试确认上次操作', exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole('button', { name: '重试确认上次操作', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '重试确认上次操作', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试确认上次操作', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByTestId('mock-output')).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(
      (await client.query('SELECT count(*)::int AS n FROM execution_attempts')).rows[0].n,
    ).toBe(1);
  });
  const registrationBody = {
    expectedVersion: 0,
    displayName: '验收微博账号',
    platformAccountId: '1234567890',
    manualPublishEnabled: true,
    manualAuthorizationConfirmed: true,
    reason: '登记隔离测试账号，不执行真实发布',
  };
  async function registerApi(
    page: Page,
    changes: Record<string, unknown> = {},
    key = randomUUID(),
  ) {
    return api(
      page,
      'PUT',
      '/api/v1/account-registration',
      { ...registrationBody, ...changes },
      key,
    );
  }
  async function registrationForm(page: Page) {
    await page.goto('/settings');
    await page.getByRole('button', { name: '目标账号与授权', exact: true }).click();
    await expect(page.getByLabel('微博昵称', { exact: true })).toBeEditable();
    await page.getByLabel('微博昵称', { exact: true }).fill(registrationBody.displayName);
    await page
      .getByLabel('微博主页链接或 UID', { exact: true })
      .fill('https://weibo.com/u/1234567890');
    await page.getByLabel('启用人工操作资格', { exact: true }).check();
    await page.getByLabel('我确认团队指定人员有权登录该账号并手动发布', { exact: true }).check();
    await page.getByLabel('登记或变更原因', { exact: true }).fill(registrationBody.reason);
  }

  test('管理员登记真实目标账号，刷新持久恢复；批准后只读确认面板不创建交接或改变任务', async ({
    page,
  }) => {
    await client.query("UPDATE members SET role='admin' WHERE id=$1", [memberId]);
    const id = await createManual(page);
    const placeholder = (await task(page, id)).account!;
    await registrationForm(page);
    await page.getByRole('button', { name: '保存目标账号登记', exact: true }).click();
    await expect(page.getByText('已登记：验收微博账号', { exact: true })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('account-registration.png'),
      fullPage: true,
    });
    await page.reload();
    await page.getByRole('button', { name: '目标账号与授权', exact: true }).click();
    await expect(page.getByLabel('微博昵称', { exact: true })).toHaveValue('验收微博账号');
    await expect(page.getByLabel('微博主页链接或 UID', { exact: true })).toHaveValue('1234567890');
    const registration = (await api(page, 'GET', '/api/v1/account-registration')).json().data;
    expect(registration.account.id).toBe(placeholder.id);
    expect(registration.account.authorizationStatus).toBe('unconfigured');
    expect(registration.account.officialPublishAvailable).toBe(false);
    expect(registration.registeredBy).toBe(memberId);
    await reviewApi(page, id);
    expect((await approveApi(page, id)).statusCode).toBe(201);
    await page.goto('/tasks/' + id);
    await expect(page.getByRole('button', { name: '人工发布交接', exact: true })).toBeEnabled();
    const before = await task(page, id);
    const eventsBefore = (await client.query('SELECT count(*)::int AS n FROM audit_events')).rows[0]
      .n;
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET' && request.url().includes('/publications'))
        writes.push(request.url());
    });
    await page.getByRole('button', { name: '人工发布交接', exact: true }).click();
    await expect(page.getByRole('heading', { name: '人工发布确认', exact: true })).toBeVisible();
    await expect(page.getByLabel('已批准文案（核对预览）', { exact: true })).toHaveValue(
      before.currentContent!.body,
    );
    await expect(page.getByRole('link', { name: '查看目标微博主页', exact: true })).toHaveAttribute(
      'href',
      'https://weibo.com/u/1234567890',
    );
    await page.screenshot({ path: test.info().outputPath('manual-entry.png'), fullPage: true });
    expect(await task(page, id)).toEqual(before);
    expect((await client.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n).toBe(
      eventsBefore,
    );
    expect(writes).toHaveLength(0);
    expect(agentCalls).toBe(0);
    await page
      .getByLabel('文案内容', { exact: true })
      .fill(before.currentContent!.body + '新增未保存文字');
    await expect(page.getByRole('button', { name: '人工发布交接', exact: true })).toBeDisabled();
    await expect(page.getByRole('heading', { name: '人工发布确认', exact: true })).toHaveCount(0);
  });

  test('运营不能登记；缺少人工操作声明拒绝；并发登记及幂等重放不覆盖更新或伪造官方授权', async ({
    page,
  }) => {
    const id = await createManual(page);
    expect((await registerApi(page)).statusCode).toBe(403);
    await client.query("UPDATE members SET role='admin' WHERE id=$1", [memberId]);
    expect((await registerApi(page, { manualAuthorizationConfirmed: false })).statusCode).toBe(422);
    expect(
      (await registerApi(page, { platformAccountId: 'https://evil.example/u/123' })).statusCode,
    ).toBe(400);
    const key = randomUUID();
    const first = await registerApi(page, {}, key);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await registerApi(page, {}, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().meta.replayed).toBe(true);
    expect(replay.json().data).toEqual(first.json().data);
    expect((await registerApi(page, { displayName: '其他内容' }, key)).statusCode).toBe(409);
    const responses = await Promise.all([
      registerApi(page, { expectedVersion: 1, displayName: '并发登记A' }),
      registerApi(page, { expectedVersion: 1, displayName: '并发登记B' }),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const row = (await client.query('SELECT * FROM accounts')).rows[0];
    expect(row.registration_version).toBe(2);
    expect(row.authorization_status).toBe('unconfigured');
    expect(row.official_publish_available).toBe(false);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE action='account.registered'",
        )
      ).rows[0].n,
    ).toBe(2);
    expect((await task(page, id)).account!.registrationVersion).toBe(2);
    const registration = await api(page, 'GET', '/api/v1/account-registration');
    expect(registration.headers['cache-control']).toBe('no-store');
    expect(registration.body).not.toContain('credentialRef');
    expect(registration.body).not.toContain('credential_ref');
  });

  test('人工发布入口重新核对资格；UID更换或资格停用使旧批准失效，需重新审核批准', async ({
    page,
  }) => {
    await client.query("UPDATE members SET role='admin' WHERE id=$1", [memberId]);
    const id = await createManual(page);
    expect((await registerApi(page)).statusCode).toBe(200);
    await reviewApi(page, id);
    expect((await approveApi(page, id)).statusCode).toBe(201);
    const oldApproval = (await task(page, id)).currentApproval!;
    await page.goto('/tasks/' + id);
    await expect(page.getByRole('button', { name: '人工发布交接', exact: true })).toBeEnabled();
    expect(
      (await registerApi(page, { expectedVersion: 1, platformAccountId: '1234567891' })).statusCode,
    ).toBe(200);
    // The already-open browser still has its old enabled button. GET must reject it.
    await page.getByRole('button', { name: '人工发布交接', exact: true }).click();
    await expect(page.getByRole('button', { name: '人工发布交接', exact: true })).toBeDisabled();
    await expect(page.getByRole('heading', { name: '人工发布确认', exact: true })).toHaveCount(0);
    let current = await task(page, id);
    expect(current.approval).toBe('invalidated');
    expect(current.currentReview).toBeNull();
    const staleApprove = await api(page, 'POST', `/api/v1/tasks/${id}/approvals`, {
      expectedRevision: current.task.revision,
      contentVersionId: current.currentContent!.id,
      contentHash: oldApproval.contentHash,
      reviewCycleId: oldApproval.reviewCycleId,
      accountId: oldApproval.accountId,
    });
    expect(staleApprove.statusCode, staleApprove.body).toBe(409);
    await reviewApi(page, id);
    expect((await approveApi(page, id)).statusCode).toBe(201);
    expect(
      (await api(page, 'GET', `/api/v1/tasks/${id}/manual-publication-entry`)).statusCode,
    ).toBe(200);
    expect(
      (
        await registerApi(page, {
          expectedVersion: 2,
          platformAccountId: '1234567891',
          manualPublishEnabled: false,
          manualAuthorizationConfirmed: false,
        })
      ).statusCode,
    ).toBe(200);
    current = await task(page, id);
    expect(current.actions.manual_publish_entry.allowed).toBe(false);
    expect(
      (await api(page, 'GET', `/api/v1/tasks/${id}/manual-publication-entry`)).statusCode,
    ).toBe(409);
  });

  test('账号登记成功但响应丢失，刷新后使用原请求确认，只保存一次登记', async ({ page }) => {
    await client.query("UPDATE members SET role='admin' WHERE id=$1", [memberId]);
    await createManual(page);
    await registrationForm(page);
    const keys: string[] = [];
    await page.route('**/api/v1/account-registration', async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']!);
      if (keys.length === 1) {
        const response = await route.fetch({ url: serverUrl + '/api/v1/account-registration' });
        expect(response.status()).toBe(200);
        return route.abort('failed');
      }
      return route.fallback();
    });
    await page.getByRole('button', { name: '保存目标账号登记', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试确认账号登记', exact: true })).toBeEnabled();
    await page.reload();
    await page.getByRole('button', { name: '目标账号与授权', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试确认账号登记', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '重试确认账号登记', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存目标账号登记', exact: true })).toBeEnabled();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(
      (await client.query('SELECT registration_version FROM accounts')).rows[0]
        .registration_version,
    ).toBe(1);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE action='account.registered'",
        )
      ).rows[0].n,
    ).toBe(1);
  });

  async function readyHandoff(page: Page) {
    await client.query("UPDATE members SET role='admin' WHERE id=$1", [memberId]);
    const id = await createManual(page);
    expect((await registerApi(page)).statusCode).toBe(200);
    await reviewApi(page, id);
    expect((await approveApi(page, id)).statusCode).toBe(201);
    const before = await task(page, id);
    const body = {
      expectedRevision: before.task.revision,
      accountId: before.account!.id,
      approvalId: before.currentApproval!.id,
      contentVersionId: before.currentContent!.id,
      contentHash: before.currentContent!.contentHash,
      channel: 'manual',
    };
    return { id, before, body, path: `/api/v1/tasks/${id}/publications` };
  }
  async function handoffCounts() {
    return (
      await client.query(
        `SELECT (SELECT count(*)::int FROM task_publication_operations) AS operations, (SELECT count(*)::int FROM task_publication_dispatches) AS dispatches, (SELECT count(*)::int FROM audit_events WHERE action='publication.handed_off') AS audits`,
      )
    ).rows[0];
  }

  test('人工交接保存批准原文和账号快照，冻结后刷新恢复；列表与详情均可读取且不会对外发布', async ({
    page,
  }) => {
    const { id, before, path } = await readyHandoff(page);
    await page.goto('/tasks/' + id);
    await page.getByRole('button', { name: '人工发布交接', exact: true }).click();
    await page.getByRole('button', { name: '确认创建交接并冻结文案', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '人工发布交接记录', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('冻结文案', { exact: true })).toHaveValue(
      before.currentContent!.body,
    );
    await expect(page.getByLabel('文案内容', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '启动模拟执行', exact: true })).toBeDisabled();
    const current = await task(page, id),
      op = current.currentPublication!;
    expect(current.publication).toBe('awaiting_manual');
    expect(current.task.lifecycle).toBe('open');
    expect(current.task.activePublishOperationId).toBe(op.id);
    expect(current.task.publishedOperationId).toBeNull();
    expect(current.task.revision).toBe(before.task.revision + 1);
    expect(op.snapshot.content).toEqual(before.currentContent);
    expect(op.snapshot.account).toEqual(before.account);
    expect(op.snapshot.approval).toEqual(before.currentApproval);
    expect(op.createdBy).toBe(memberId);
    expect(op.dispatches).toHaveLength(1);
    expect(op.dispatches[0]).toMatchObject({
      channel: 'manual',
      status: 'awaiting_manual',
      startedBy: memberId,
      approvalId: before.currentApproval!.id,
      url: null,
      platformPostId: null,
    });
    expect((await api(page, 'GET', path + '/' + op.id)).json().data.operation).toEqual(op);
    expect((await api(page, 'GET', path + '?limit=1')).json().data).toEqual({
      items: [op],
      nextCursor: null,
    });
    const filtered = await api(page, 'GET', '/api/v1/tasks?publication=awaiting_manual');
    expect(filtered.json().data.items.map((x: TaskDetail) => x.task.id)).toEqual([id]);
    expect(
      (await api(page, 'GET', '/api/v1/tasks?publication=not_published')).json().data.items,
    ).toHaveLength(0);
    await page.reload();
    await expect(page.getByLabel('冻结文案', { exact: true })).toHaveValue(
      before.currentContent!.body,
    );
    await expect(
      page.getByText('当前审核不能用于批准，请按最新版本和配置重新审核。', { exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath('manual-handoff-frozen.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath('manual-handoff-mobile.png'),
      fullPage: true,
    });
    expect(await handoffCounts()).toEqual({ operations: 1, dispatches: 1, audits: 1 });
    expect(agentCalls).toBe(0);
  });

  test('仅交接冻结后可复制批准原文，复制及发布指引不改变任务或产生发送', async ({ page }) => {
    // Isolate the browser clipboard to avoid replacing the user's system clipboard.
    await page.addInitScript(() => {
      const writes: string[] = [];
      Object.defineProperty(window, '__clipboardWrites', { value: writes });
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            writes.push(value);
          },
        },
      });
    });
    const { id, body, path, before } = await readyHandoff(page);
    await page.goto('/tasks/' + id);
    await expect(page.getByRole('button', { name: '复制冻结文案', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '人工发布交接', exact: true }).click();
    await expect(page.getByRole('heading', { name: '人工发布确认', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '复制冻结文案', exact: true })).toHaveCount(0);
    expect((await api(page, 'POST', path, body)).statusCode).toBe(202);
    await page.reload();
    const frozen = await task(page, id);
    const commands: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET' && request.url().includes('/api/v1/'))
        commands.push(request.url());
    });
    await expect(page.getByLabel('冻结文案', { exact: true })).not.toBeEditable();
    await page.getByRole('button', { name: '复制冻结文案', exact: true }).click();
    await expect(
      page.getByText('已复制冻结文案，保留原始空格和换行。请在微博粘贴后再次核对内容。', {
        exact: true,
      }),
    ).toBeVisible();
    const writes = await page.evaluate(
      () => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites,
    );
    expect(writes).toEqual([before.currentContent!.body]);
    expect(writes[0]!.startsWith('  ')).toBe(true);
    expect(writes[0]!.endsWith('\n')).toBe(true);
    const guide = page.locator('section[aria-labelledby="manual-publication-guide-title"]');
    await expect(guide.getByRole('listitem')).toHaveCount(5);
    await expect(guide).toContainText(frozen.currentPublication!.snapshot.account.displayName);
    await expect(guide).toContainText(
      frozen.currentPublication!.snapshot.account.platformAccountId!,
    );
    await expect(guide).toContainText('发布后请在下方回填实际账号');
    await expect(guide).toContainText('若内容与批准版不一致');
    await expect(page.getByRole('link', { name: '查看交接账号主页', exact: true })).toHaveAttribute(
      'href',
      'https://weibo.com/u/1234567890',
    );
    expect(await task(page, id)).toEqual(frozen);
    expect(await handoffCounts()).toEqual({ operations: 1, dispatches: 1, audits: 1 });
    expect(commands).toEqual([]);
    await page
      .locator('section[aria-labelledby="frozen-handoff-title"]')
      .screenshot({ path: test.info().outputPath('manual-copy-guide-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page
      .locator('section[aria-labelledby="frozen-handoff-title"]')
      .screenshot({ path: test.info().outputPath('manual-copy-guide-mobile.png') });
    await page.reload();
    await expect(page.getByRole('heading', { name: '人工发布指引', exact: true })).toBeVisible();
    await expect(
      page.getByText('已复制冻结文案，保留原始空格和换行。请在微博粘贴后再次核对内容。', {
        exact: true,
      }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: '复制冻结文案', exact: true }).click();
    expect(
      await page.evaluate(
        () => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites,
      ),
    ).toEqual([before.currentContent!.body]);
    expect(await task(page, id)).toEqual(frozen);
    expect(agentCalls).toBe(0);
  });

  test('剪贴板权限被拒或不支持时明确失败，可手动选中全部冻结原文且不误报复制成功', async ({
    page,
  }) => {
    const { id, body, path } = await readyHandoff(page);
    expect((await api(page, 'POST', path, body)).statusCode).toBe(202);
    await page.goto('/tasks/' + id);
    const frozen = await task(page, id);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new DOMException('synthetic clipboard denial', 'NotAllowedError');
          },
        },
      });
    });
    await page.getByRole('button', { name: '复制冻结文案', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('自动复制失败');
    await expect(
      page.getByText('已复制冻结文案，保留原始空格和换行。请在微博粘贴后再次核对内容。', {
        exact: true,
      }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: '选中全文手动复制', exact: true }).click();
    const field = page.getByLabel('冻结文案', { exact: true });
    await expect(field).toBeFocused();
    expect(
      await field.evaluate((el: HTMLTextAreaElement) => ({
        start: el.selectionStart,
        end: el.selectionEnd,
        value: el.value,
      })),
    ).toEqual({
      start: 0,
      end: frozen.currentPublication!.snapshot.content.body.length,
      value: frozen.currentPublication!.snapshot.content.body,
    });
    await expect(
      page.getByText('已选中冻结文案，请按 ⌘C / Ctrl+C 或使用系统复制菜单。尚未确认复制成功。', {
        exact: true,
      }),
    ).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    });
    await page.getByRole('button', { name: '复制冻结文案', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('自动复制失败');
    expect(await task(page, id)).toEqual(frozen);
    expect(await handoffCounts()).toEqual({ operations: 1, dispatches: 1, audits: 1 });
  });

  test('人工交接并发点击、不同幂等键、键过期及服务重建始终复用一条交接与发送', async ({ page }) => {
    const { id, body, path } = await readyHandoff(page);
    const key = randomUUID();
    const responses = await Promise.all([
      api(page, 'POST', path, body, key),
      api(page, 'POST', path, body, key),
      api(page, 'POST', path, body),
    ]);
    for (const r of responses) expect(r.statusCode, r.body).toBe(202);
    const operation = responses[0]!.json().data.operation;
    expect(new Set(responses.map((r) => r.json().data.operation.id)).size).toBe(1);
    expect(responses.filter((r) => r.json().meta.replayed === false)).toHaveLength(1);
    expect(
      (await api(page, 'POST', path, { ...body, contentHash: '0'.repeat(64) }, key)).json().error
        .code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    taskClock = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const late = await api(page, 'POST', path, body, key);
    expect(late.statusCode, late.body).toBe(202);
    expect(late.json().data.operation).toEqual(operation);
    const me = await api(page, 'GET', '/api/v1/auth/me');
    const replacement = new TaskService(database.db, () => taskClock!);
    const result = await replacement.publish({
      taskId: id,
      actor: me.json().data.member,
      body: { ...body, channel: 'manual' },
      key: randomUUID(),
      requestId: randomUUID(),
    });
    expect(result.data.operation).toEqual(operation);
    expect(result.replayed).toBe(true);
    expect(await handoffCounts()).toEqual({ operations: 1, dispatches: 1, audits: 1 });
  });

  test('交接拒绝过期版本、摘要和账号不符、无资格、官方渠道及越权访问', async ({ page }) => {
    const { id, body, path } = await readyHandoff(page);
    for (const change of [
      { expectedRevision: body.expectedRevision - 1 },
      { approvalId: randomUUID() },
      { contentVersionId: randomUUID() },
      { contentHash: '0'.repeat(64) },
      { accountId: randomUUID() },
    ]) {
      const response = await api(page, 'POST', path, { ...body, ...change });
      expect(response.statusCode, response.body).toBe(409);
    }
    const official = await api(page, 'POST', path, { ...body, channel: 'official_api' });
    expect(official.statusCode, official.body).toBe(501);
    const cookie = (await page.context().cookies())
      .filter((c) => c.name === 'ops_session')
      .map((c) => `${c.name}=${c.value}`)
      .join(';');
    const noCsrf = await app.inject({
      method: 'POST',
      url: path,
      headers: { cookie, origin: 'http://127.0.0.1:5173', 'idempotency-key': randomUUID() },
      payload: body,
    });
    expect(noCsrf.statusCode).toBe(403);
    const otherTeam = (
      await client.query("INSERT INTO teams(name) VALUES ('other team') RETURNING id")
    ).rows[0].id;
    const otherId = (
      await client.query(
        "INSERT INTO tasks(team_id,title,original_request) VALUES ($1,'foreign','foreign request') RETURNING id",
        [otherTeam],
      )
    ).rows[0].id;
    expect(
      (await api(page, 'POST', `/api/v1/tasks/${otherId}/publications`, body)).statusCode,
    ).toBe(404);
    expect((await api(page, 'GET', `/api/v1/tasks/${otherId}/publications`)).statusCode).toBe(404);
    expect(
      (
        await registerApi(page, {
          expectedVersion: 1,
          manualPublishEnabled: false,
          manualAuthorizationConfirmed: false,
        })
      ).statusCode,
    ).toBe(200);
    const d = await task(page, id);
    expect(
      (await api(page, 'POST', path, { ...body, expectedRevision: d.task.revision })).statusCode,
    ).toBe(409);
    expect(await handoffCounts()).toEqual({ operations: 0, dispatches: 0, audits: 0 });
    expect((await api(page, 'GET', path + '/' + randomUUID())).statusCode).toBe(404);
    expect((await api(page, 'GET', path + '?cursor=bad')).statusCode).toBe(400);
  });

  test('冻结在后端阻断改稿、审核批准、执行、账号和配置变更；数据库禁止篡改或删除交接', async ({
    page,
  }) => {
    const { id, body, path } = await readyHandoff(page);
    const response = await api(page, 'POST', path, body);
    expect(response.statusCode, response.body).toBe(202);
    const d = await task(page, id),
      op = d.currentPublication!,
      rev = d.task.revision;
    const commands: [string, Record<string, unknown>][] = [
      [
        `/api/v1/tasks/${id}/content-versions`,
        {
          expectedRevision: rev,
          baseContentVersionId: d.currentContent!.id,
          body: '新文案',
        },
      ],
      [
        `/api/v1/tasks/${id}/reviews`,
        { expectedRevision: rev, contentVersionId: d.currentContent!.id, subjectiveNote: '' },
      ],
      [
        `/api/v1/tasks/${id}/approvals`,
        { ...body, expectedRevision: rev, reviewCycleId: d.currentReview!.id },
      ],
      [`/api/v1/tasks/${id}/attempts`, { expectedRevision: rev }],
      [
        `/api/v1/tasks/${id}/attempt-retries`,
        {
          expectedRevision: rev,
          previousAttemptId: randomUUID(),
          restartTerminated: false,
          reason: '冻结校验',
        },
      ],
    ];
    // Approval request uses only its contract fields.
    delete commands[2]![1].channel;
    delete commands[2]![1].approvalId;
    for (const [url, payload] of commands) {
      const r = await api(page, 'POST', url, payload);
      expect(r.statusCode, r.body).toBe(423);
      expect(r.json().error.code).toBe('PUBLICATION_LOCKED');
    }
    expect(
      (await registerApi(page, { expectedVersion: 1, displayName: '禁止变更' })).statusCode,
    ).toBe(423);
    const config = (await api(page, 'GET', '/api/v1/config')).json().data;
    const { accountId, version, updatedBy, updatedAt, maxAutoRevisions, ...fields } = config;
    void accountId;
    void updatedBy;
    void updatedAt;
    void maxAutoRevisions;
    const changed = await api(page, 'PUT', '/api/v1/config', {
      ...fields,
      expectedVersion: version,
      reason: '冻结期间配置变更',
    });
    expect(changed.statusCode, changed.body).toBe(423);
    expect(await task(page, id)).toEqual(d);
    for (const [statement, params] of [
      [
        "UPDATE task_publication_operations SET snapshot=jsonb_set(snapshot,'{content,body}','\"被篡改\"'::jsonb) WHERE id=$1",
        [op.id],
      ],
      ['UPDATE task_publication_operations SET created_by=gen_random_uuid() WHERE id=$1', [op.id]],
      ['DELETE FROM task_publication_operations WHERE id=$1', [op.id]],
      ['UPDATE task_publication_dispatches SET dispatch_no=2 WHERE operation_id=$1', [op.id]],
      ['DELETE FROM task_publication_dispatches WHERE operation_id=$1', [op.id]],
    ] as const)
      await expect(client.query(statement, [...params])).rejects.toMatchObject({ code: '23514' });
    expect(await handoffCounts()).toEqual({ operations: 1, dispatches: 1, audits: 1 });
    expect((await task(page, id)).currentPublication).toEqual(op);
  });

  test('交接已提交但响应丢失，刷新读取原交接，不重复创建；提交前断网则原键显式重试', async ({
    page,
  }) => {
    const { id, path } = await readyHandoff(page);
    await page.goto('/tasks/' + id);
    let writes = 0;
    const keys: string[] = [];
    await page.route('**' + path, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      writes++;
      keys.push(route.request().headers()['idempotency-key']!);
      if (writes === 1) return route.abort('failed');
      const r = await route.fetch({ url: serverUrl + path });
      expect(r.status()).toBe(202);
      return route.abort('failed');
    });
    await page.getByRole('button', { name: '人工发布交接', exact: true }).click();
    await page.getByRole('button', { name: '确认创建交接并冻结文案', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试确认原交接', exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole('button', { name: '重试确认原交接', exact: true })).toBeEnabled();
    expect(writes).toBe(1);
    await page.getByRole('button', { name: '重试确认原交接', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '人工发布交接记录', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('冻结文案', { exact: true })).toBeVisible();
    expect(writes).toBe(2);
    expect(keys[0]).toBe(keys[1]);
    expect(await handoffCounts()).toEqual({ operations: 1, dispatches: 1, audits: 1 });
  });

  test('审计写入失败时交接、发送、锁和幂等结果全部回滚，原请求可恢复', async ({ page }) => {
    const { id, before, body, path } = await readyHandoff(page),
      key = randomUUID();
    await client.query(
      `CREATE FUNCTION fail_handoff_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='publication.handed_off' THEN RAISE EXCEPTION 'synthetic audit outage'; END IF; RETURN NEW; END $$`,
    );
    await client.query(
      'CREATE TRIGGER fail_handoff_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_handoff_audit()',
    );
    try {
      expect((await api(page, 'POST', path, body, key)).statusCode).toBe(503);
      expect(await handoffCounts()).toEqual({ operations: 0, dispatches: 0, audits: 0 });
      expect(await task(page, id)).toEqual(before);
    } finally {
      await client.query('DROP TRIGGER fail_handoff_audit ON audit_events');
      await client.query('DROP FUNCTION fail_handoff_audit()');
    }
    const restored = await api(page, 'POST', path, body, key);
    expect(restored.statusCode, restored.body).toBe(202);
    expect(restored.json().meta.replayed).toBe(false);
    expect(await handoffCounts()).toEqual({ operations: 1, dispatches: 1, audits: 1 });
  });

  async function activeHandoff(page: Page) {
    const ready = await readyHandoff(page);
    const r = await api(page, 'POST', ready.path, ready.body);
    expect(r.statusCode, r.body).toBe(202);
    const d: TaskDetail = r.json().data.task;
    const op = d.currentPublication!;
    const resultBody = {
      expectedRevision: d.task.revision,
      contentVersionId: op.contentVersionId,
      dispatchId: op.currentDispatchId,
      accountId: op.accountId,
      conclusion: 'published',
      evidenceIds: [],
      note: '人工打开微博逐字核对，账号正文一致。',
      url: 'https://weibo.com/1234567890/TestPost1',
      observedAccountUid: '1234567890',
      observedBody: op.snapshot.content.body,
      manualConfirmed: true,
    };
    return { ...ready, d, op, resultBody, resultPath: ready.path + '/' + op.id };
  }
  async function resultCounts() {
    return (
      await client.query(
        `SELECT (SELECT count(*)::int FROM task_publication_verifications) AS records,(SELECT count(*)::int FROM audit_events WHERE action IN ('publication.backfilled','publication.verified')) AS audits`,
      )
    ).rows[0];
  }

  test('结果回填完整闭环：操作人填写实际账号正文和链接，人工确认成功，刷新保留核实记录且任务只读', async ({
    page,
  }) => {
    const { id, op, resultBody } = await activeHandoff(page);
    await page.goto('/tasks/' + id);
    await page
      .getByLabel('微博单条链接', { exact: true })
      .fill(resultBody.url + '?from=synthetic#fragment');
    await page.getByLabel('实际发布账号 UID', { exact: true }).fill(resultBody.observedAccountUid);
    await page.getByLabel('实际发布正文', { exact: true }).fill(resultBody.observedBody);
    await page.getByLabel('核对说明或未发布原因', { exact: true }).fill(resultBody.note);
    await page.getByLabel('我已打开该条微博，核对实际账号和完整正文', { exact: true }).check();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page
      .locator('section[aria-labelledby="frozen-handoff-title"]')
      .screenshot({ path: test.info().outputPath('backfill-form-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page
      .locator('section[aria-labelledby="frozen-handoff-title"]')
      .screenshot({ path: test.info().outputPath('backfill-form-desktop.png') });
    await page.getByRole('button', { name: '提交结果回填', exact: true }).click();
    await expect(
      page.getByText('已人工核实发布成功 · 任务已结束，原文案保持只读。', { exact: true }),
    ).toBeVisible();
    const d = await task(page, id);
    expect(d.task.lifecycle).toBe('published');
    expect(d.task.publishedOperationId).toBe(op.id);
    expect(d.task.activePublishOperationId).toBeNull();
    expect(d.publication).toBe('published');
    const record = d.currentPublication!.verifications[0]!;
    expect(record).toMatchObject({
      kind: 'backfill',
      method: 'manual',
      actorId: memberId,
      requestedConclusion: 'published',
      conclusion: 'published',
      url: resultBody.url,
      observedBody: op.snapshot.content.body,
      observedContentHash: op.contentHash,
      mismatchNote: null,
      observedAccountUid: '1234567890',
      resultingStatus: 'published',
    });
    expect(d.currentPublication!.dispatches[0]).toMatchObject({
      status: 'published',
      url: resultBody.url,
      platformPostId: 'TestPost1',
    });
    expect(d.currentPublication!.dispatches[0]!.finishedAt).not.toBeNull();
    await page.reload();
    await page.getByText(/人工回填 · 发布且与批准版一致/).click();
    await expect(page.getByLabel('回填与核实记录', { exact: true })).toContainText(
      '确认方式：人工核实',
    );
    await expect(page.getByRole('button', { name: '提交结果回填', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '复制冻结文案', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('文案内容', { exact: true })).toBeDisabled();
    await page
      .locator('section[aria-labelledby="frozen-handoff-title"]')
      .screenshot({ path: test.info().outputPath('backfill-published.png') });
    expect(await resultCounts()).toEqual({ records: 1, audits: 1 });
    expect(agentCalls).toBe(0);
  });

  test('账号正文差异明确登记并保持锁定，追加核实可确认成功；成功后的矛盾证据只追加不撤销', async ({
    page,
  }) => {
    const { id, op, resultBody, resultPath } = await activeHandoff(page);
    const bad = {
      ...resultBody,
      observedAccountUid: '1234567891',
      observedBody: resultBody.observedBody + '多出的文字',
      note: '真实观察到账号正文差异',
    };
    let r = await api(page, 'POST', resultPath + '/backfills', bad);
    expect(r.statusCode, r.body).toBe(202);
    let d = await task(page, id);
    expect(d.publication).toBe('verification_required');
    expect(d.task.activePublishOperationId).toBe(op.id);
    expect(d.task.publishedOperationId).toBeNull();
    expect(d.task.lifecycle).toBe('open');
    expect(d.currentPublication!.verifications[0]!.mismatchNote).toContain(
      '实际发布账号 UID 与冻结账号不一致',
    );
    expect(d.currentPublication!.verifications[0]!.mismatchNote).toContain(
      '实际正文与批准原文不一致',
    );
    expect(d.currentPublication!.verifications[0]!.conclusion).toBe('unknown');
    await page.goto('/tasks/' + id);
    await expect(page.getByText(/差异登记：实际发布账号/)).toBeVisible();
    await expect(page.getByRole('button', { name: '提交人工核实', exact: true })).toBeEnabled();
    await expect(page.getByLabel('文案内容', { exact: true })).toBeDisabled();
    r = await api(page, 'POST', resultPath + '/verifications', {
      ...resultBody,
      expectedRevision: d.task.revision,
      note: '已打开正确微博重新核对，确认一致',
    });
    expect(r.statusCode, r.body).toBe(202);
    d = await task(page, id);
    expect(d.publication).toBe('published');
    const success = d.currentPublication!.dispatches[0];
    r = await api(page, 'POST', resultPath + '/verifications', {
      ...bad,
      expectedRevision: d.task.revision,
      note: '补充另一条不一致的证据',
      url: 'https://weibo.com/1234567891/OtherPost2',
    });
    expect(r.statusCode, r.body).toBe(202);
    d = await task(page, id);
    expect(d.publication).toBe('published');
    expect(d.task.lifecycle).toBe('published');
    expect(d.currentPublication!.dispatches[0]).toEqual(success);
    expect(d.currentPublication!.verifications).toHaveLength(3);
    expect(d.currentPublication!.verifications[2]!.mismatchNote).toContain(
      '与已确认的成功发布链接不一致',
    );
    await expect(
      client.query('DELETE FROM task_publication_verifications WHERE operation_id=$1', [op.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query(
        "UPDATE task_publication_verifications SET data=jsonb_set(data,'{note}','\"changed\"'::jsonb) WHERE operation_id=$1",
        [op.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await handoffCounts()).toEqual({ operations: 1, dispatches: 1, audits: 1 });
  });

  test('明确未发布须确认原交接停止才解锁，编辑新版本后保留旧交接历史；旧回填不能解除新交接锁', async ({
    page,
  }) => {
    const { id, op, resultPath, d: before } = await activeHandoff(page);
    const no = {
      expectedRevision: before.task.revision,
      contentVersionId: op.contentVersionId,
      accountId: op.accountId,
      dispatchId: op.currentDispatchId,
      conclusion: 'not_published',
      evidenceIds: [],
      note: '已联系全部操作人，确认尚未发布并停止原交接。',
      manualConfirmed: true,
      previousDispatchFenced: false,
    };
    expect((await api(page, 'POST', resultPath + '/backfills', no)).statusCode).toBe(422);
    expect(await task(page, id)).toEqual(before);
    await page.goto('/tasks/' + id);
    await page.getByLabel('回填结论', { exact: true }).selectOption('not_published');
    await page.getByLabel('核对说明或未发布原因', { exact: true }).fill(no.note);
    await page.getByLabel('我已明确核实本次交接尚未发布', { exact: true }).check();
    await page.getByLabel('我确认原交接已停止，相关人员不会再继续发布', { exact: true }).check();
    await page.getByRole('button', { name: '提交结果回填', exact: true }).click();
    await expect(page.getByLabel('文案内容', { exact: true })).toBeEditable();
    let d = await task(page, id);
    expect(d.publication).toBe('failed');
    expect(d.task.activePublishOperationId).toBeNull();
    expect(d.task.lifecycle).toBe('open');
    expect(d.currentPublication!.verifications[0]!.conclusion).toBe('not_published');
    const list = await api(page, 'GET', '/api/v1/tasks?publication=failed');
    expect(list.json().data.items[0].task.id).toBe(id);
    await page.getByLabel('文案内容', { exact: true }).fill('重新准备的一条正式测试文案。');
    await page.getByRole('button', { name: '保存新版本', exact: true }).click();
    await expect(page.getByTestId('content-version')).toHaveCount(2);
    await expect(page.getByLabel('历史人工交接', { exact: true })).toContainText('发布失败');
    d = await task(page, id);
    expect(d.publication).toBe('not_published');
    expect(d.currentPublication).toBeNull();
    await reviewApi(page, id);
    expect((await approveApi(page, id)).statusCode).toBe(201);
    d = await task(page, id);
    const next = await api(page, 'POST', `/api/v1/tasks/${id}/publications`, {
      expectedRevision: d.task.revision,
      accountId: d.account!.id,
      approvalId: d.currentApproval!.id,
      contentVersionId: d.currentContent!.id,
      contentHash: d.currentContent!.contentHash,
      channel: 'manual',
    });
    expect(next.statusCode, next.body).toBe(202);
    const after = await task(page, id);
    expect(
      (
        await api(page, 'POST', resultPath + '/backfills', {
          ...no,
          previousDispatchFenced: true,
          expectedRevision: after.task.revision,
          note: '迟到的旧交接声明',
        })
      ).statusCode,
    ).toBe(409);
    expect(await task(page, id)).toEqual(after);
    expect(after.task.activePublishOperationId).not.toBe(op.id);
    expect((await api(page, 'GET', resultPath)).json().data.operation.verifications).toHaveLength(
      1,
    );
  });

  test('回填校验拒绝主页外站伪造摘要、跨发送绑定、陈旧版本和未授权；未确认或不确定进入待核实', async ({
    page,
  }) => {
    const { id, op, resultBody, resultPath } = await activeHandoff(page);
    for (const url of [
      'https://weibo.com/u/1234567890',
      'https://evil.example/1234567890/TestPost1',
      'http://weibo.com/1234567890/TestPost1',
      'https://weibo.com/1234567890',
    ]) {
      const r = await api(page, 'POST', resultPath + '/backfills', { ...resultBody, url });
      expect(r.statusCode, r.body).toBe(422);
    }
    expect(
      (
        await api(page, 'POST', resultPath + '/backfills', {
          ...resultBody,
          observedContentHash: '0'.repeat(64),
        })
      ).statusCode,
    ).toBe(422);
    for (const bad of [
      { accountId: randomUUID() },
      { dispatchId: randomUUID() },
      { contentVersionId: randomUUID() },
      { expectedRevision: resultBody.expectedRevision - 1 },
    ])
      expect(
        (await api(page, 'POST', resultPath + '/backfills', { ...resultBody, ...bad })).statusCode,
      ).toBe(409);
    expect(
      (
        await api(page, 'POST', resultPath + '/backfills', {
          ...resultBody,
          evidenceIds: [randomUUID()],
        })
      ).statusCode,
    ).toBe(422);
    const otherTeam = (await client.query("INSERT INTO teams(name) VALUES('other') RETURNING id"))
      .rows[0].id;
    const other = (
      await client.query(
        "INSERT INTO tasks(team_id,title,original_request) VALUES($1,'other','other') RETURNING id",
        [otherTeam],
      )
    ).rows[0].id;
    expect(
      (
        await api(
          page,
          'POST',
          `/api/v1/tasks/${other}/publications/${op.id}/backfills`,
          resultBody,
        )
      ).statusCode,
    ).toBe(404);
    expect(await resultCounts()).toEqual({ records: 0, audits: 0 });
    const r = await api(page, 'POST', resultPath + '/backfills', {
      ...resultBody,
      manualConfirmed: false,
    });
    expect(r.statusCode, r.body).toBe(202);
    let d = await task(page, id);
    expect(d.publication).toBe('verification_required');
    const unknown = await api(page, 'POST', resultPath + '/verifications', {
      expectedRevision: d.task.revision,
      accountId: op.accountId,
      contentVersionId: op.contentVersionId,
      dispatchId: op.currentDispatchId,
      conclusion: 'unknown',
      evidenceIds: [],
      note: '当前无法判断是否发布',
    });
    expect(unknown.statusCode, unknown.body).toBe(202);
    d = await task(page, id);
    expect(d.task.activePublishOperationId).toBe(op.id);
    expect(d.currentPublication!.verifications).toHaveLength(2);
    const no = await api(page, 'POST', resultPath + '/verifications', {
      expectedRevision: d.task.revision,
      accountId: op.accountId,
      contentVersionId: op.contentVersionId,
      dispatchId: op.currentDispatchId,
      conclusion: 'not_published',
      evidenceIds: [],
      note: '所有操作人确认未发布，原交接已经停止',
      manualConfirmed: true,
      previousDispatchFenced: true,
    });
    expect(no.statusCode, no.body).toBe(202);
    expect((await task(page, id)).publication).toBe('failed');
  });

  test('回填并发重复及键过期不重复写证据或审计；审计故障时全部回滚后原请求可恢复', async ({
    page,
  }) => {
    const { id, resultBody, resultPath, d: before } = await activeHandoff(page),
      key = randomUUID();
    await client.query(
      `CREATE FUNCTION fail_result_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='publication.backfilled' THEN RAISE EXCEPTION 'synthetic outage'; END IF; RETURN NEW; END $$`,
    );
    await client.query(
      'CREATE TRIGGER fail_result_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_result_audit()',
    );
    try {
      expect((await api(page, 'POST', resultPath + '/backfills', resultBody, key)).statusCode).toBe(
        503,
      );
      expect(await resultCounts()).toEqual({ records: 0, audits: 0 });
      expect(await task(page, id)).toEqual(before);
    } finally {
      await client.query('DROP TRIGGER fail_result_audit ON audit_events');
      await client.query('DROP FUNCTION fail_result_audit()');
    }
    const replies = await Promise.all([
      api(page, 'POST', resultPath + '/backfills', resultBody, key),
      api(page, 'POST', resultPath + '/backfills', resultBody, key),
      api(page, 'POST', resultPath + '/backfills', resultBody),
    ]);
    for (const r of replies) expect(r.statusCode, r.body).toBe(202);
    expect(replies.filter((r) => r.json().meta.replayed === false)).toHaveLength(1);
    expect(await resultCounts()).toEqual({ records: 1, audits: 1 });
    expect((await task(page, id)).task.revision).toBe(before.task.revision + 1);
    expect(
      (
        await api(
          page,
          'POST',
          resultPath + '/backfills',
          { ...resultBody, note: 'different' },
          key,
        )
      ).json().error.code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    taskClock = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const late = await api(page, 'POST', resultPath + '/backfills', resultBody, key);
    expect(late.statusCode, late.body).toBe(202);
    expect(late.json().meta.replayed).toBe(true);
    expect(await resultCounts()).toEqual({ records: 1, audits: 1 });
  });

  test('回填断网刷新保留原请求，先查询再显式重试；提交成功响应丢失后读取原记录不重复提交', async ({
    page,
  }) => {
    const { id, resultPath, resultBody } = await activeHandoff(page);
    await page.goto('/tasks/' + id);
    const keys: string[] = [];
    await page.route('**' + resultPath + '/backfills', async (route) => {
      keys.push(route.request().headers()['idempotency-key']!);
      if (keys.length === 1) return route.abort('failed');
      const response = await route.fetch({ url: serverUrl + resultPath + '/backfills' });
      expect(response.status()).toBe(202);
      return route.abort('failed');
    });
    await page.getByLabel('微博单条链接', { exact: true }).fill(resultBody.url);
    await page.getByLabel('实际发布账号 UID', { exact: true }).fill(resultBody.observedAccountUid);
    await page.getByLabel('实际发布正文', { exact: true }).fill(resultBody.observedBody);
    await page.getByLabel('核对说明或未发布原因', { exact: true }).fill(resultBody.note);
    await page.getByLabel('我已打开该条微博，核对实际账号和完整正文', { exact: true }).check();
    await page.getByRole('button', { name: '提交结果回填', exact: true }).click();
    await expect(page.getByRole('button', { name: '查询回填结果', exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole('button', { name: '重试确认原回填', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '查询回填结果', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试确认原回填', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '重试确认原回填', exact: true }).click();
    await expect(
      page.getByText('已人工核实发布成功 · 任务已结束，原文案保持只读。', { exact: true }),
    ).toBeVisible();
    await page.reload();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(await resultCounts()).toEqual({ records: 1, audits: 1 });
  });

  async function failedHandoff(page: Page) {
    const ready = await activeHandoff(page);
    const no = {
      expectedRevision: ready.d.task.revision,
      accountId: ready.op.accountId,
      contentVersionId: ready.op.contentVersionId,
      dispatchId: ready.op.currentDispatchId,
      conclusion: 'not_published',
      evidenceIds: [],
      note: '确认尚未发布，已经通知操作人停止并关闭原交接。',
      manualConfirmed: true,
      previousDispatchFenced: true,
    };
    const r = await api(page, 'POST', ready.resultPath + '/backfills', no);
    expect(r.statusCode, r.body).toBe(202);
    const failed: TaskDetail = r.json().data.task;
    return {
      ...ready,
      failed,
      retryPath: ready.resultPath + '/retries',
      retryBody: {
        ...ready.body,
        expectedRevision: failed.task.revision,
        previousDispatchId: ready.op.currentDispatchId,
        reason: '已重新安排操作人执行人工发布。',
      },
    };
  }
  async function retryAuditCount() {
    return (
      await client.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE action='publication.retry_requested'",
      )
    ).rows[0].n;
  }

  test('同版本失败重交接：先只读确认再填写原因，复用快照与操作编号并重新锁定，保留发送和核实历史', async ({
    page,
  }) => {
    const { id, op, failed, resultBody, resultPath } = await failedHandoff(page);
    await page.goto('/tasks/' + id);
    const button = page.getByRole('button', { name: '重新人工交接', exact: true });
    await expect(button).toBeEnabled();
    await page
      .getByLabel('文案内容', { exact: true })
      .fill(op.snapshot.content.body + '未保存修改');
    await expect(button).toBeDisabled();
    await page.getByLabel('文案内容', { exact: true }).fill(op.snapshot.content.body);
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByRole('form', { name: '重新人工交接确认', exact: true })).toBeVisible();
    expect(await task(page, id)).toEqual(failed);
    expect(await retryAuditCount()).toBe(0);
    await expect(page.getByLabel('原批准文案（重新交接核对）', { exact: true })).toHaveValue(
      op.snapshot.content.body,
    );
    await page.getByRole('button', { name: '关闭重新交接确认', exact: true }).click();
    expect(await task(page, id)).toEqual(failed);
    await button.click();
    await page.getByLabel('本次重新交接原因', { exact: true }).fill('   ');
    await page.getByRole('button', { name: '确认重新交接并锁定文案', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('请填写本次重新交接原因');
    await page
      .getByLabel('本次重新交接原因', { exact: true })
      .fill('已再次核对原批准文案，安排人工发布');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page
      .getByRole('form', { name: '重新人工交接确认', exact: true })
      .screenshot({ path: test.info().outputPath('retry-confirm-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: '确认重新交接并锁定文案', exact: true }).click();
    await expect(page.getByLabel('文案内容', { exact: true })).toBeDisabled();
    const d = await task(page, id),
      next = d.currentPublication!;
    expect(d.publication).toBe('awaiting_manual');
    expect(d.task.lifecycle).toBe('open');
    expect(d.task.activePublishOperationId).toBe(op.id);
    expect(d.task.revision).toBe(failed.task.revision + 1);
    expect(next.id).toBe(op.id);
    expect(next.snapshot).toEqual(op.snapshot);
    expect(next.dispatches).toHaveLength(2);
    expect(next.dispatches[0]).toEqual(failed.currentPublication!.dispatches[0]);
    expect(next.verifications).toEqual(failed.currentPublication!.verifications);
    expect(next.dispatches[1]).toMatchObject({
      dispatchNo: 2,
      previousDispatchId: op.currentDispatchId,
      approvalId: op.snapshot.approval.id,
      reason: '已再次核对原批准文案，安排人工发布',
      startedBy: memberId,
      status: 'awaiting_manual',
      channel: 'manual',
    });
    await page.reload();
    await expect(page.getByLabel('发送交接历史', { exact: true })).toContainText('第 2 次人工交接');
    await expect(page.getByRole('button', { name: '复制冻结文案', exact: true })).toBeEnabled();
    await page
      .locator('section[aria-labelledby="frozen-handoff-title"]')
      .screenshot({ path: test.info().outputPath('retry-created.png') });
    expect(await handoffCounts()).toEqual({ operations: 1, dispatches: 2, audits: 1 });
    expect(await retryAuditCount()).toBe(1);
    const late = await api(page, 'POST', resultPath + '/backfills', {
      ...resultBody,
      expectedRevision: d.task.revision,
      note: '迟到的旧发送回填',
    });
    expect(late.statusCode, late.body).toBe(409);
    expect(await task(page, id)).toEqual(d);
    const success = await api(page, 'POST', resultPath + '/backfills', {
      ...resultBody,
      expectedRevision: d.task.revision,
      dispatchId: next.currentDispatchId,
    });
    expect(success.statusCode, success.body).toBe(202);
    const completed = await task(page, id);
    expect(completed.publication).toBe('published');
    expect(completed.currentPublication!.verifications).toHaveLength(2);
    expect(completed.currentPublication!.dispatches[0]).toEqual(
      failed.currentPublication!.dispatches[0],
    );
    expect(completed.currentPublication!.dispatches[1]!.status).toBe('published');
    expect(agentCalls).toBe(0);
  });

  test('同版本重交接并发、不同动作键及键过期均只创建一个后继；后续失败再重交接不能复活旧请求', async ({
    page,
  }) => {
    const { id, op, retryPath, retryBody, resultPath } = await failedHandoff(page),
      key = randomUUID();
    const replies = await Promise.all([
      api(page, 'POST', retryPath, retryBody, key),
      api(page, 'POST', retryPath, retryBody, key),
      api(page, 'POST', retryPath, retryBody),
    ]);
    for (const r of replies) expect(r.statusCode, r.body).toBe(202);
    expect(replies.filter((r) => !r.json().meta.replayed)).toHaveLength(1);
    let d = await task(page, id);
    const current = d.currentPublication!.currentDispatchId;
    const no = {
      expectedRevision: d.task.revision,
      accountId: op.accountId,
      contentVersionId: op.contentVersionId,
      dispatchId: current,
      conclusion: 'not_published',
      evidenceIds: [],
      note: '第二次交接仍未发布，已明确停止原操作',
      manualConfirmed: true,
      previousDispatchFenced: true,
    };
    expect((await api(page, 'POST', resultPath + '/backfills', no)).statusCode).toBe(202);
    const failedAgain = await task(page, id);
    expect(failedAgain.actions.retry_publish.allowed).toBe(true);
    taskClock = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const expired = await api(page, 'POST', retryPath, retryBody, key);
    expect(expired.statusCode, expired.body).toBe(202);
    expect(expired.json().meta.replayed).toBe(true);
    expect(await task(page, id)).toEqual(failedAgain);
    expect(
      (await api(page, 'POST', retryPath, { ...retryBody, reason: 'changed' }, key)).json().error
        .code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    const third = await api(page, 'POST', retryPath, {
      ...retryBody,
      previousDispatchId: current,
      expectedRevision: failedAgain.task.revision,
      reason: '明确结束第二次，第三次重新安排人员',
    });
    expect(third.statusCode, third.body).toBe(202);
    d = await task(page, id);
    expect(d.currentPublication!.dispatches.map((x) => x.dispatchNo)).toEqual([1, 2, 3]);
    const replay = await api(page, 'POST', retryPath, retryBody);
    expect(replay.statusCode).toBe(202);
    expect((await task(page, id)).currentPublication!.dispatches).toHaveLength(3);
    expect(await retryAuditCount()).toBe(2);
    expect(await handoffCounts()).toEqual({ operations: 1, dispatches: 3, audits: 1 });
    await expect(
      client.query(
        "INSERT INTO task_publication_dispatches(id,operation_id,dispatch_no,previous_dispatch_id,reason,approval_id,channel,status,started_by,started_at) VALUES(gen_random_uuid(),$1,99,$2,'duplicate',$3,'manual','awaiting_manual',$4,now())",
        [op.id, op.currentDispatchId, op.snapshot.approval.id, memberId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      client.query("UPDATE task_publication_dispatches SET reason='tampered' WHERE id=$1", [
        current,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('同版本重交接拒绝篡改绑定、陈旧 revision 和空原因，原审核或批准更新后即使重新批准也不能重交接', async ({
    page,
  }) => {
    const { id, op, retryPath, retryBody } = await failedHandoff(page);
    for (const change of [
      { accountId: randomUUID() },
      { contentVersionId: randomUUID() },
      { approvalId: randomUUID() },
      { contentHash: '0'.repeat(64) },
      { previousDispatchId: randomUUID() },
      { expectedRevision: retryBody.expectedRevision - 1 },
    ]) {
      const r = await api(page, 'POST', retryPath, { ...retryBody, ...change });
      expect(r.statusCode, r.body).toBe(409);
    }
    expect((await api(page, 'POST', retryPath, { ...retryBody, reason: '   ' })).statusCode).toBe(
      422,
    );
    expect(
      (await api(page, 'POST', retryPath, { ...retryBody, channel: 'official_api' })).statusCode,
    ).toBe(501);
    await page.goto('/tasks/' + id);
    await page.getByRole('button', { name: '重新人工交接', exact: true }).click();
    await page.getByLabel('本次重新交接原因', { exact: true }).fill('旧页面再次交接');
    await reviewApi(page, id);
    await page.getByRole('button', { name: '确认重新交接并锁定文案', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新人工交接', exact: true })).toBeDisabled();
    expect((await approveApi(page, id)).statusCode).toBe(201);
    let d = await task(page, id);
    expect(d.currentApproval!.id).not.toBe(op.snapshot.approval.id);
    expect(d.actions.retry_publish.allowed).toBe(false);
    expect(
      (await api(page, 'POST', retryPath, { ...retryBody, expectedRevision: d.task.revision }))
        .statusCode,
    ).toBe(409);
    const save = await api(page, 'POST', `/api/v1/tasks/${id}/content-versions`, {
      expectedRevision: d.task.revision,
      baseContentVersionId: d.currentContent!.id,
      body: '人工编辑新版本',
    });
    expect(save.statusCode, save.body).toBe(201);
    d = await task(page, id);
    expect(
      (await api(page, 'POST', retryPath, { ...retryBody, expectedRevision: d.task.revision }))
        .statusCode,
    ).toBe(409);
    expect(await retryAuditCount()).toBe(0);
    expect(await handoffCounts()).toEqual({ operations: 1, dispatches: 1, audits: 1 });
  });

  test('同版本重交接核对人工资格与可靠未发布证据，待人工、待核实和成功状态均不得新建发送', async ({
    page,
  }) => {
    const { id, retryPath, retryBody } = await failedHandoff(page);
    expect(
      (
        await registerApi(page, {
          expectedVersion: 1,
          manualPublishEnabled: false,
          manualAuthorizationConfirmed: false,
        })
      ).statusCode,
    ).toBe(200);
    let d = await task(page, id);
    expect(
      (await api(page, 'POST', retryPath, { ...retryBody, expectedRevision: d.task.revision }))
        .statusCode,
    ).toBe(409);
    // An isolated corruption probe proves that a failed status alone is insufficient.
    await client.query('TRUNCATE teams,idempotency_records,tasks CASCADE');
    teamId = (await client.query("INSERT INTO teams(name) VALUES('new test team') RETURNING id"))
      .rows[0].id;
    memberId = (
      await client.query(
        "INSERT INTO members(team_id,login,password_hash,display_name,role) VALUES($1,'browser.tasks',$2,'浏览器验收成员','operator') RETURNING id",
        [teamId, storedHash],
      )
    ).rows[0].id;
    await page.context().clearCookies();
    await page.evaluate(() => sessionStorage.clear());
    const fresh = await activeHandoff(page);
    const newBody = {
      ...fresh.body,
      expectedRevision: fresh.d.task.revision,
      previousDispatchId: fresh.op.currentDispatchId,
      reason: '状态边界验证',
    };
    const path = fresh.resultPath + '/retries';
    expect([409, 423]).toContain((await api(page, 'POST', path, newBody)).statusCode);
    await client.query("UPDATE task_publication_operations SET status='failed' WHERE id=$1", [
      fresh.op.id,
    ]);
    await client.query(
      "UPDATE task_publication_dispatches SET status='failed' WHERE operation_id=$1",
      [fresh.op.id],
    );
    await client.query('UPDATE tasks SET active_publish_operation_id=NULL WHERE id=$1', [fresh.id]);
    d = await task(page, fresh.id);
    expect(d.actions.retry_publish.reason).toContain('缺少原发送');
    expect((await api(page, 'POST', path, newBody)).statusCode).toBe(409);
    await client.query(
      "UPDATE task_publication_operations SET status='awaiting_manual' WHERE id=$1",
      [fresh.op.id],
    );
    await client.query(
      "UPDATE task_publication_dispatches SET status='awaiting_manual' WHERE operation_id=$1",
      [fresh.op.id],
    );
    await client.query('UPDATE tasks SET active_publish_operation_id=$1 WHERE id=$2', [
      fresh.op.id,
      fresh.id,
    ]);
    const unknown = await api(page, 'POST', fresh.resultPath + '/backfills', {
      ...fresh.resultBody,
      conclusion: 'unknown',
      note: '无法确定结果',
    });
    expect(unknown.statusCode).toBe(202);
    d = await task(page, fresh.id);
    expect([409, 423]).toContain(
      (await api(page, 'POST', path, { ...newBody, expectedRevision: d.task.revision })).statusCode,
    );
    expect(
      (
        await api(page, 'POST', fresh.resultPath + '/verifications', {
          ...fresh.resultBody,
          expectedRevision: d.task.revision,
        })
      ).statusCode,
    ).toBe(202);
    d = await task(page, fresh.id);
    expect(
      (await api(page, 'POST', path, { ...newBody, expectedRevision: d.task.revision })).statusCode,
    ).toBe(409);
    expect(await retryAuditCount()).toBe(0);
  });

  test('重新交接审计失败全部回滚，原动作标识恢复后只增加一次发送', async ({ page }) => {
    const { id, failed, retryPath, retryBody } = await failedHandoff(page),
      key = randomUUID();
    await client.query(
      `CREATE FUNCTION fail_retry_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='publication.retry_requested' THEN RAISE EXCEPTION 'synthetic outage'; END IF; RETURN NEW; END $$`,
    );
    await client.query(
      'CREATE TRIGGER fail_retry_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_retry_audit()',
    );
    try {
      expect((await api(page, 'POST', retryPath, retryBody, key)).statusCode).toBe(503);
      expect(await task(page, id)).toEqual(failed);
      expect(await retryAuditCount()).toBe(0);
      expect(await handoffCounts()).toEqual({ operations: 1, dispatches: 1, audits: 1 });
    } finally {
      await client.query('DROP TRIGGER fail_retry_audit ON audit_events');
      await client.query('DROP FUNCTION fail_retry_audit()');
    }
    const r = await api(page, 'POST', retryPath, retryBody, key);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().meta.replayed).toBe(false);
    expect(await retryAuditCount()).toBe(1);
    expect((await task(page, id)).currentPublication!.dispatches).toHaveLength(2);
  });

  test('重新交接断网刷新后先查询原操作，再显式使用原键确认；成功响应丢失不会重复交接', async ({
    page,
  }) => {
    const { id, retryPath } = await failedHandoff(page);
    await page.goto('/tasks/' + id);
    const keys: string[] = [];
    await page.route('**' + retryPath, async (route) => {
      keys.push(route.request().headers()['idempotency-key']!);
      if (keys.length === 1) return route.abort('failed');
      const r = await route.fetch({ url: serverUrl + retryPath });
      expect(r.status()).toBe(202);
      return route.abort('failed');
    });
    await page.getByRole('button', { name: '重新人工交接', exact: true }).click();
    await page.getByLabel('本次重新交接原因', { exact: true }).fill('恢复本次人工交接');
    await page.getByRole('button', { name: '确认重新交接并锁定文案', exact: true }).click();
    await expect(page.getByRole('button', { name: '查询重新交接结果', exact: true })).toBeEnabled();
    await page.reload();
    await expect(
      page.getByRole('button', { name: '重试确认原重新交接', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: '查询重新交接结果', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '重试确认原重新交接', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: '重试确认原重新交接', exact: true }).click();
    await expect(page.getByLabel('文案内容', { exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByLabel('发送交接历史', { exact: true })).toContainText('第 2 次人工交接');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(await retryAuditCount()).toBe(1);
    expect((await task(page, id)).currentPublication!.dispatches).toHaveLength(2);
  });
});
