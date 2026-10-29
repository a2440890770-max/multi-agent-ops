import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { createBusinessDatabase } from '../backend/src/database.ts';
import { bootstrapAdmin, BootstrapError } from '../backend/src/bootstrap-admin.ts';
import { validateBusinessTarget } from './migrations.mjs';

export function parseBootstrapArgs(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        login: { type: 'string' },
        team: { type: 'string', default: '运营团队' },
        'display-name': { type: 'string', default: '系统管理员' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch {
    throw new BootstrapError('命令参数无效；密码只能通过终端隐藏输入，不能放在命令参数中。');
  }
  if (!values.help && !values.login) throw new BootstrapError('请使用 --login 指定管理员账号。');
  return values;
}

async function readPassword(prompt) {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY)
    throw new BootstrapError('请在交互终端运行，密码将隐藏输入；不接受命令参数或管道中的密码。');
  const wasRaw = input.isRaw;
  input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    let overflow = false;
    const finish = (error) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      process.removeListener('SIGINT', onCancel);
      process.removeListener('SIGTERM', onCancel);
      input.setRawMode(wasRaw);
      // This CLI owns stdin; release its active handle between prompts and at completion.
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else if (overflow) reject(new BootstrapError('密码长度不能超过 256 个字符。'));
      else resolve(value);
      value = '';
    };
    const onCancel = () => finish(new BootstrapError('已取消，未执行初始化。'));
    const onEnd = () => finish(new BootstrapError('终端输入已结束，未执行初始化。'));
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') return onCancel();
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (char === '\u0015') value = '';
        else if (char >= ' ') {
          if (value.length + char.length > 256) overflow = true;
          else value += char;
        }
      }
    };
    input.on('data', onData);
    input.once('end', onEnd);
    process.once('SIGINT', onCancel);
    process.once('SIGTERM', onCancel);
    input.setRawMode(true);
    input.resume();
    process.stdout.write(prompt);
  });
}

async function main() {
  const options = parseBootstrapArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      '用法：npm run admin:bootstrap -- --login <账号> [--team <团队>] [--display-name <名称>]',
    );
    console.log('默认团队：运营团队；默认显示名称：系统管理员。密码在终端隐藏输入并二次确认。');
    return;
  }
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const url = validateBusinessTarget(process.env);
  const database = createBusinessDatabase(url.href);
  const credentials = { password: '', confirmation: '' };
  try {
    const role = await database.db.execute(sql`
      SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user
    `);
    if (!role.rows[0] || Object.values(role.rows[0]).some(Boolean))
      throw new BootstrapError('请使用非超级用户、无创建库或创建角色权限的业务角色执行初始化。');
    const existing = await database.db.execute(sql`SELECT 1 FROM public.members LIMIT 1`);
    if (existing.rowCount) throw new BootstrapError('已有成员，拒绝重复初始化或覆盖密码。');
    console.log(`目标业务库：${decodeURIComponent(url.pathname.slice(1))}；将创建首个管理员。`);
    credentials.password = await readPassword('管理员密码（隐藏输入）：');
    credentials.confirmation = await readPassword('再次输入密码（隐藏输入）：');
    if (credentials.password !== credentials.confirmation)
      throw new BootstrapError('两次密码不一致，未执行初始化。');
    const result = await bootstrapAdmin(database.db, {
      login: options.login,
      password: credentials.password,
      teamName: options.team,
      displayName: options['display-name'],
    });
    console.log(JSON.stringify({ initialized: true, ...result }, null, 2));
    console.log('管理员已创建；启动前后端并配置认证服务后，可在 /login 登录。');
  } finally {
    credentials.password = '';
    credentials.confirmation = '';
    await database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Driver errors may include SQL parameters; never print raw errors or stacks.
    console.error(
      error instanceof BootstrapError
        ? error.message
        : '初始化失败，未完成的事务已回滚；请检查数据库连接、表结构及业务角色权限。',
    );
    process.exitCode = 1;
  });
}
