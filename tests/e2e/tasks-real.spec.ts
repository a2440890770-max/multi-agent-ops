import { randomBytes } from 'node:crypto';
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
      tasks: new TaskService(database.db, () => new Date(), { stepDelayMs: 300 }),
      logging: false,
      checkDatabase: async () => ({ status: 'ready', database: 'connected' }),
      checkAgent: async () => {
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
});
