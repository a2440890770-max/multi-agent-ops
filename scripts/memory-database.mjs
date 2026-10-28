import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnvironment, provisionDatabase, root, safeError } from './postgres-admin.mjs';

const path = fileURLToPath(new URL('../.env.memory', import.meta.url));
const action = process.argv[2];
if (!['setup', 'up', 'down', 'recreate'].includes(action))
  throw new Error('只支持 setup / up / down / recreate；不删除数据卷。');
if (action === 'down')
  throw new Error('记忆库与业务库共用实例；请在确认影响后使用 npm run db:down。');
loadEnvironment();
try {
  if (!process.env.DATABASE_URL) throw new Error('请先运行 npm run env:setup。');
  const business = new URL(process.env.DATABASE_URL);
  if (business.username === process.env.POSTGRES_USER)
    throw new Error(
      '旧业务 DATABASE_URL 使用管理员；请先按 memory.md 创建独立业务角色并迁移权限。',
    );
  if (!existsSync(path) && action === 'setup') {
    const password = randomBytes(24).toString('hex');
    const memory = new URL(business);
    memory.username = 'agent_memory';
    memory.password = password;
    memory.pathname = '/multi_agent_memory';
    writeFileSync(
      path,
      `# 与业务库同实例；专用非超级用户；不提交。OpenAI Key 配置在 .env 或进程环境。\nMEM0_POSTGRES_DB=multi_agent_memory\nMEM0_POSTGRES_USER=agent_memory\nMEM0_POSTGRES_PASSWORD=${password}\nMEM0_DATABASE_URL=${memory.href}\nMEM0_EMBEDDING_MODEL=text-embedding-3-small\nMEM0_EMBEDDING_DIMENSION=1536\nMEM0_COLLECTION=mem0_ops_openai_small_v1\nMEM0_HISTORY_PATH=artifacts/memory/history.sqlite\n`,
      { flag: 'wx', mode: 0o600 },
    );
    process.loadEnvFile(path);
    console.log('已创建 .env.memory；凭据未输出。');
  }
  if (!process.env.MEM0_DATABASE_URL)
    throw new Error('缺少记忆库配置，请运行 npm run memory:setup。');
  const memory = new URL(process.env.MEM0_DATABASE_URL);
  if (
    memory.hostname !== business.hostname ||
    (memory.port || '5432') !== (business.port || '5432') ||
    memory.pathname === business.pathname ||
    memory.username === business.username ||
    process.env.MEM0_POSTGRES_PORT ||
    process.env.MEM0_OLLAMA_URL
  )
    throw new Error(
      '旧记忆配置不符合同实例、独立数据库/角色要求；请按 memory.md 迁移，不会覆盖旧文件或删除旧卷。',
    );
  if (action === 'recreate') {
    if (process.env.CONFIRM_SHARED_DB_RECREATE !== '1')
      throw new Error(
        '重建将短暂中断业务库和记忆库；确认维护窗口后设置 CONFIRM_SHARED_DB_RECREATE=1。',
      );
    const result = spawnSync(
      'docker',
      [
        'compose',
        '--project-directory',
        root,
        '--env-file',
        '.env',
        '-f',
        'infra/docker-compose.yml',
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '120',
        '--force-recreate',
        'postgres',
      ],
      { cwd: root, stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error('共享 PostgreSQL 重建失败。');
  } else {
    const result = spawnSync(process.execPath, ['scripts/database.mjs', 'up'], {
      cwd: root,
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error('共享 PostgreSQL 启动失败。');
  }
  await provisionDatabase(process.env.MEM0_DATABASE_URL, { extension: true });
  console.log('同实例记忆数据库、专用角色及 vector 扩展已就绪；未调用嵌入 API。');
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
}
